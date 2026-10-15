// _common/credit.js - 计费与额度核心（PRD 6.3：非会员按时长阶梯扣积分 / 会员额度制 / 不限次档）
// 所有扣减走服务端权威（不信任客户端上报），事务保证余额与流水一致
const { db, cmd, COLL } = require('./db');
const { computeCost, MAX_USER_CONCURRENT } = require('./consts');

function now() {
  return new Date();
}

/**
 * 解析任务预结算：判断该任务由什么"支付"
 * @param {object} user   users 文档
 * @param {number} durationSec 视频时长（秒）
 * @returns {{ok:boolean, reason?:string, msg?:string, decision?:object}}
 *   decision: { payType:'unlimited'|'quota'|'credit', creditCost, quotaUsed }
 */
function settleDecision(user, durationSec) {
  const cost = computeCost(durationSec);
  if (!cost.allowed) {
    return { ok: false, reason: 'too_long', msg: '视频超过 30 分钟暂不支持' };
  }
  const mem = user.membership || {};
  const isActive = mem.tier && mem.tier !== 'none' && mem.status === 'active';

  if (isActive && mem.tier === 'unlimited') {
    return { ok: true, decision: { payType: 'unlimited', creditCost: 0, quotaUsed: 0 } };
  }

  if (isActive && mem.quota) {
    // 限次档：额度内免费（长视频计 2 次额度），不足则回退积分
    if (mem.quota.remaining >= cost.quotaUnits) {
      return {
        ok: true,
        decision: { payType: 'quota', creditCost: 0, quotaUsed: cost.quotaUnits },
      };
    }
  }

  // 非会员 / 会员额度不足 → 积分支付
  const balance = (user.credits && user.credits.balance) || 0;
  if (balance >= cost.creditCost) {
    return {
      ok: true,
      decision: { payType: 'credit', creditCost: cost.creditCost, quotaUsed: 0 },
    };
  }
  return {
    ok: false,
    reason: 'insufficient',
    msg: '积分不足，请先充值或开通会员（用得少就充值 5 元起，用得多就开会员 9.9/月 90 次或 19.9/月不限次）',
  };
}

/** 事务执行结算（入队后真正扣减），返回 decision 持久化到 task */
async function executeCharge(userId, durationSec) {
  const t = await db().startTransaction();
  try {
    const doc = await t.collection('users').doc(userId).get();
    const user = doc.data;
    if (!user) throw new Error('user_not_found');
    const r = settleDecision(user, durationSec);
    if (!r.ok) {
      await t.rollback();
      return r; // {ok:false,...}
    }
    const d = r.decision;
    const patch = {};

    if (d.payType === 'quota') {
      const q = user.membership.quota;
      patch.membership = Object.assign({}, user.membership, {
        quota: {
          monthly: q.monthly,
          total: q.total,
          used: (q.used || 0) + d.quotaUsed,
          remaining: Math.max(0, q.remaining - d.quotaUsed),
        },
      });
    } else if (d.payType === 'credit') {
      const bal = user.credits.balance;
      const creditsPatch = {
        balance: bal - d.creditCost,
        total_earned: user.credits.total_earned || 0,
        total_used: (user.credits.total_used || 0) + d.creditCost,
      };
      patch.credits = creditsPatch;
      // 记流水（会员额度任务不产生 credit_logs 消耗流水）
      await t.collection('credit_logs').add({
        data: {
          uid: userId,
          change: -d.creditCost,
          after_balance: bal - d.creditCost,
          source: 'consume',
          ref_id: '',
          note: '解析任务扣减（≤10min 5 / 10~30min 10）',
          ts: now(),
        },
      });
    }
    // unlimited: 无扣减
    patch.last_active_at = now();
    await t.collection('users').doc(userId).update({ data: patch });
    await t.commit();
    return { ok: true, decision: d };
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* ignore */ }
    throw e;
  }
}

/** 任务失败回滚（退还积分或额度，PRD 10.2 技术异常兜底） */
async function rollbackCharge(userId, decision) {
  if (!decision) return { ok: true };
  if (decision.payType === 'unlimited' || (decision.creditCost === 0 && decision.quotaUsed === 0)) {
    return { ok: true };
  }
  const t = await db().startTransaction();
  try {
    const doc = await t.collection('users').doc(userId).get();
    const user = doc.data;
    if (!user) throw new Error('user_not_found');
    const patch = {};
    if (decision.payType === 'credit' && decision.creditCost > 0) {
      const bal = user.credits.balance;
      patch.credits = {
        balance: bal + decision.creditCost,
        total_earned: user.credits.total_earned || 0,
        total_used: Math.max(0, (user.credits.total_used || 0) - decision.creditCost),
      };
      await t.collection('credit_logs').add({
        data: {
          uid: userId,
          change: decision.creditCost,
          after_balance: bal + decision.creditCost,
          source: 'refund',
          ref_id: '',
          note: '解析失败退还积分',
          ts: now(),
        },
      });
    } else if (decision.payType === 'quota' && decision.quotaUsed > 0) {
      const q = user.membership.quota;
      patch.membership = Object.assign({}, user.membership, {
        quota: {
          monthly: q.monthly,
          total: q.total,
          used: Math.max(0, (q.used || 0) - decision.quotaUsed),
          remaining: q.remaining + decision.quotaUsed,
        },
      });
    }
    await t.collection('users').doc(userId).update({ data: patch });
    await t.commit();
    return { ok: true };
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* ignore */ }
    return { ok: false, err: e };
  }
}

/** 单用户进行中任务数是否超限（并发 ≤ 3，PRD 6.3） */
async function countActiveTasks(uid) {
  const r = await COLL
    .tasks()
    .where({
      uid,
      status: cmd().in(['pending', 'downloading', 'transcribing', 'asr', 'llm']),
      // 与流水线10分钟截止时间一致：过期遗留任务不永久占用新任务名额。
      created_at: cmd().gt(new Date(Date.now() - 10 * 60 * 1000)),
    })
    .count();
  return r.total;
}

module.exports = {
  settleDecision,
  executeCharge,
  rollbackCharge,
  countActiveTasks,
  MAX_USER_CONCURRENT,
};
