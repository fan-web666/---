// _common/user.js - 用户建档 / 新人积分发放 / 双链路身份打通
// 唯一键：openid_mini（小程序）/ openid_gzh（服务号）；同主体开放平台绑定后可凭 unionid 归并（PRD 6.1/F-07）
const { db, cmd, COLL } = require('./db');
const { TRIAL_CREDIT } = require('./consts');
const { getContext } = require('./util');

/** 时间戳 */
function now() {
  return new Date();
}

/** 日志写入（credit_logs，事务内调用） */
async function addCreditLogTx(tx, doc) {
  await tx.collection('credit_logs').add({ data: doc });
}

/** 积分流水（直写，非事务路径用） */
async function addCreditLog(doc) {
  await COLL.creditLogs().add({ data: doc });
}

/**
 * 发放新人积分的字段补丁（事务 / 直写两条路径共用）
 * 用整对象替换而非增量算子，保证 trial 与 credits 一起落定。
 */
function buildGrantPatch(u) {
  const c = (u && u.credits) || {};
  return {
    trial: { granted: true, granted_at: now(), credit_total: TRIAL_CREDIT },
    credits: {
      balance: (c.balance || 0) + TRIAL_CREDIT,
      total_earned: (c.total_earned || 0) + TRIAL_CREDIT,
      total_used: c.total_used || 0,
    },
  };
}

/** 新人积分流水文档 */
function trialLogDoc(userId, afterBalance) {
  return {
    uid: userId,
    change: TRIAL_CREDIT,
    after_balance: afterBalance,
    source: 'trial',
    ref_id: '',
    note: '新用户一次性赠送 ' + TRIAL_CREDIT + ' 积分',
    ts: now(),
  };
}

function defaultMembership() {
  return {
    tier: 'none',
    status: 'expired',
    started_at: null,
    expires_at: null,
    quota: { monthly: 60, total: 0, used: 0, remaining: 0 },
    renew_reminded_at: null,
    source: '',
    order_id: '',
  };
}

function defaultUser(openidMini, openidGzh, unionid) {
  return {
    openid_gzh: openidGzh || '',
    openid_mini: openidMini || '',
    unionid: unionid || '',
    nickname: '',
    avatarUrl: '',
    credits: { balance: 0, total_earned: 0, total_used: 0 },
    trial: { granted: false, granted_at: null, credit_total: TRIAL_CREDIT },
    membership: defaultMembership(),
    recharge_summary: { last_amount: 0, last_credits: 0, total_recharged_credits: 0 },
    bind_at: now(),
    last_active_at: now(),
    created_at: now(),
  };
}

/** 按入口 openid 查找用户 */
async function findUser({ miniOpenid, gzhOpenid, unionid }) {
  const c = COLL.users();
  // 优先 unionid（双链路已打通）
  if (unionid) {
    const r = await c.where({ unionid }).limit(1).get();
    if (r.data && r.data.length) return r.data[0];
  }
  if (miniOpenid) {
    const r = await c.where({ openid_mini: miniOpenid }).limit(1).get();
    if (r.data && r.data.length) return r.data[0];
  }
  if (gzhOpenid) {
    const r = await c.where({ openid_gzh: gzhOpenid }).limit(1).get();
    if (r.data && r.data.length) return r.data[0];
  }
  return null;
}

/** 用 unionid 归并（当两个入口命中不同 user 时，把 gzh 用户数据并入 mini 主档）——MVP 简化：直接补写 openid/unionid */
async function mergeIdentity(user, { miniOpenid, gzhOpenid, unionid }) {
  const patch = {};
  if (unionid && !user.unionid) patch.unionid = unionid;
  if (miniOpenid && !user.openid_mini) patch.openid_mini = miniOpenid;
  if (gzhOpenid && !user.openid_gzh) patch.openid_gzh = gzhOpenid;
  if (Object.keys(patch).length) {
    patch.last_active_at = now();
    await COLL.users().doc(user._id).update({ data: patch });
  }
}

/** 建档（含新人积分发放 100：首次绑定一次性发放） */
async function createUserWithTrial({ miniOpenid, gzhOpenid, unionid, referralCode }) {
  let u = defaultUser(miniOpenid, gzhOpenid, unionid);
  // 仅首次建档时记录邀请来源；旧用户不能事后补绑来领取奖励。
  if (miniOpenid && referralCode) u.referral_entry = { code: referralCode, state: 'pending' };
  if (miniOpenid) {
    // 首页刷新与 App 登录可能同时首访。固定档案 ID + 事务避免同一微信身份建两档，
    // 并保证首次邀请来源不会被后来的请求覆盖。历史档案仍由 findUser 查找沿用。
    const id = 'mini_' + require('crypto').createHash('sha256').update(miniOpenid).digest('hex');
    for (let attempt = 0; attempt < 4; attempt++) {
      const tx = await db().startTransaction();
      try {
        let existing;
        try { const r = await tx.collection('users').doc(id).get(); existing = r.data; }
        catch (e) { if (!/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|-502005/i.test(String(e.errMsg || e.message))) throw e; }
        if (existing) u = existing;
        else { const { _id, ...newData } = u; await tx.collection('users').doc(id).set({ data: newData }); u._id = id; }
        await tx.commit();
        break;
      } catch (e) {
        try { await tx.rollback(); } catch (_) {}
        if (attempt === 3 || !/conflict|transaction.*(?:fail|abort)|retry|duplicate/i.test(String(e.errMsg || e.message))) throw e;
      }
    }
  } else {
    const addRes = await COLL.users().add({ data: u });
    u._id = addRes._id;
  }

  // ⚠️ 发积分失败**绝不能让异常逃出去**。
  //    用户档案已在上一行落库，此处抛错会让 exports.main → ensureUserFromContext
  //    整条失败 → 前端 ensureLogin / refreshUser 都拿不到用户 → 首页积分恒显示 0；
  //    库里则留下一条 balance:0 / trial.granted:false 的"半成品"档案。
  //    这里只告警，交给 grantTrialCredits 的降级 + ensureUser 的补发自愈。
  try {
    await grantTrialCredits(u._id);
  } catch (e) {
    console.warn('[user] 建档后发放新人积分失败，留待下次补发', e && (e.errMsg || e.message));
  }

  const fresh = await COLL.users().doc(u._id).get();
  return (fresh && fresh.data) || u;
}

/**
 * 发放新人积分（幂等：trial.granted 防重）
 *
 * 优先走事务（余额 + 流水原子落定）；若当前环境/基础库不支持事务
 * （startTransaction 缺失、commit 失败等），**降级为直写** ——
 * 积分必须发出去，流水写失败只告警、不影响余额。
 * 否则会形成「档案已建 → 积分永远发不出 → 每次登录都抛错」的死结。
 */
async function grantTrialCredits(userId, force) {
  try {
    return await grantTrialCreditsTx(userId, force);
  } catch (e) {
    console.warn('[user] 事务发放积分失败，降级为直写', e && (e.errMsg || e.message));
    return await grantTrialCreditsPlain(userId, force);
  }
}

/** 事务路径 */
async function grantTrialCreditsTx(userId, force) {
  const t = await db().startTransaction();
  try {
    const doc = await t.collection('users').doc(userId).get();
    const u = doc && doc.data;
    if (!u || (!force && u.trial && u.trial.granted)) {
      await t.rollback();
      return { granted: false, via: 'tx' };
    }
    const patch = buildGrantPatch(u);
    await t.collection('users').doc(userId).update({ data: patch });
    await addCreditLogTx(t, trialLogDoc(userId, patch.credits.balance));
    await t.commit();
    return { granted: true, via: 'tx' };
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* ignore */ }
    throw e;
  }
}

/** 直写降级路径（余额必发；流水失败仅告警） */
async function grantTrialCreditsPlain(userId, force) {
  const doc = await COLL.users().doc(userId).get();
  const u = doc && doc.data;
  if (!u || (!force && u.trial && u.trial.granted)) return { granted: false, via: 'plain' };

  const patch = buildGrantPatch(u);
  await COLL.users().doc(userId).update({ data: patch });
  try {
    await addCreditLog(trialLogDoc(userId, patch.credits.balance));
  } catch (e) {
    console.warn('[user] 积分流水写入失败（余额已到账）', e && (e.errMsg || e.message));
  }
  return { granted: true, via: 'plain' };
}

/**
 * 确保用户存在（getOrCreate）。source: 'mini' | 'gzh'
 * 返回 { user }，user 缺失字段做兜底补齐
 */
async function ensureUser({ source, openid, unionid, referralCode }) {
  const miniOpenid = source === 'mini' ? openid : '';
  const gzhOpenid = source === 'gzh' ? openid : '';

  let user = await findUser({ miniOpenid, gzhOpenid, unionid });
  if (!user) {
    user = await createUserWithTrial({ miniOpenid, gzhOpenid, unionid, referralCode });
    return user;
  }
  // 已存在：补身份 + 兜底发放
  await mergeIdentity(user, { miniOpenid, gzhOpenid, unionid });
  if (needTrialGrant(user)) {
    try {
      await grantTrialCredits(user._id, isContradictory(user));
      const fresh = await COLL.users().doc(user._id).get();
      if (fresh && fresh.data) user = fresh.data;
    } catch (e) {
      // 补发失败也不能让登录失败 —— 否则首页永远拿不到用户
      console.warn('[user] 补发新人积分失败', e && (e.errMsg || e.message));
    }
  }
  return user;
}

/** 是否需要补发新人积分：从未发放（或发放失败） */
function needTrialGrant(user) {
  if (!user.trial || !user.trial.granted) return true;
  return isContradictory(user);
}

/**
 * 状态自相矛盾：trial.granted 已是 true，但累计获得为 0
 * —— 说明「标记已发放」与「积分实际到账」不一致（早期发放失败的遗留），需要强制补一次。
 * 补发后 total_earned 会变成 50，下次不再命中，因此不会重复发放。
 */
function isContradictory(user) {
  const c = user.credits || {};
  return !!(user.trial && user.trial.granted === true && (c.total_earned || 0) === 0);
}

/* ---------------- 虚拟支付支撑（会话密钥 / 订单发货） ---------------- */

/**
 * 保存会话密钥（session_key）
 * 用途：虚拟支付的**用户态签名** signature = to_hex(hmac_sha256(session_key, signData))
 * ⚠️ 只落服务端 users 文档，**绝不下发端上**。每次 wx.login 都会刷新；
 *    端上若遇到 -15007（session_key 过期），重新登录后再发起支付即可。
 * ⚠️ 云开发 getWXContext() 拿不到 session_key，只能靠 auth.code2Session（需配 AppSecret）。
 */
async function saveSessionKey(userId, sessionKey) {
  if (!userId || !sessionKey) return false;
  try {
    await COLL.users().doc(userId).update({
      data: { wx_session_key: String(sessionKey), wx_session_key_at: now() },
    });
    return true;
  } catch (e) {
    console.warn('[user] 会话密钥保存失败', e && (e.errMsg || e.message));
    return false;
  }
}

/** 取会话密钥（签发支付参数时用） */
function getSessionKey(user) {
  return (user && user.wx_session_key) || '';
}

/**
 * 加积分（通用入口 · 2026-09-28）
 *
 * 为什么要有：`addRechargedCredits` 是**充值专用**（会连带累加 recharge_summary.total_recharged_credits
 * 并对接订单状态机），给「测试补分 / 运营补偿」用会污染充值统计。这里是不碰充值摘要的纯加积分。
 *
 * ⚠️ 只负责加，幂等由调用方保证。
 */
async function addCredits(userId, credits, opts) {
  const o = opts || {};
  const n = Math.round(Number(credits) || 0);
  if (!userId || !n) return { ok: false, reason: 'invalid_credits' };
  const source = o.source || 'manual';
  const note = o.note || '手动加积分';

  const apply = (readUser) => {
    const c = (readUser && readUser.credits) || {};
    const after = Math.max(0, (c.balance || 0) + n);
    return {
      after,
      patch: {
        credits: {
          balance: after,
          total_earned: (c.total_earned || 0) + (n > 0 ? n : 0),
          total_used: (c.total_used || 0) + (n < 0 ? -n : 0),
        },
        last_active_at: now(),
      },
    };
  };

  const logDoc = (after) => ({
    uid: userId,
    change: n,
    after_balance: after,
    source,
    ref_id: o.refId || '',
    note,
    ts: now(),
  });

  try {
    const t = await db().startTransaction();
    try {
      const doc = await t.collection('users').doc(userId).get();
      const u = doc && doc.data;
      if (!u) {
        await t.rollback();
        return { ok: false, reason: 'user_not_found' };
      }
      const { after, patch } = apply(u);
      await t.collection('users').doc(userId).update({ data: patch });
      await addCreditLogTx(t, logDoc(after));
      await t.commit();
      return { ok: true, after, via: 'tx' };
    } catch (e) {
      try { await t.rollback(); } catch (e2) { /* ignore */ }
      throw e;
    }
  } catch (e) {
    // 与「新人积分」同样的教训：余额必须落库，流水失败只告警、不整条抛错
    console.warn('[user] addCredits 事务失败，降级直写', e && (e.errMsg || e.message));
    const doc = await COLL.users().doc(userId).get();
    const u = doc && doc.data;
    if (!u) return { ok: false, reason: 'user_not_found' };
    const { after, patch } = apply(u);
    await COLL.users().doc(userId).update({ data: patch });
    try {
      await addCreditLog(logDoc(after));
    } catch (e2) {
      console.warn('[user] 积分流水写入失败（余额已到账）', e2 && (e2.errMsg || e2.message));
    }
    return { ok: true, after, via: 'plain' };
  }
}

/**
 * 充值到账：加积分 + 记流水 + 更新充值摘要
 *
 * ⚠️ 本函数**只负责加**，「不重复加」由调用方的订单状态机保证（见 api#deliverOrder）——
 *    发货前必须先把订单从 pending 原子改为 paid，改成功的那一次才调这里。
 * ⚠️ 与「新人积分」同样的教训：余额必须落库；只写流水失败要降级告警，不能整条抛错。
 */
async function addRechargedCredits(userId, credits, orderId, amountCents) {
  const n = Math.max(0, Math.round(Number(credits) || 0));
  if (!userId || n <= 0) return { ok: false, reason: 'invalid_credits' };
  const cents = Math.round(Number(amountCents) || 0);

  const apply = async (readUser, updater) => {
    const c = (readUser && readUser.credits) || {};
    const after = (c.balance || 0) + n;
    const rs = (readUser && readUser.recharge_summary) || {};
    await updater({
      credits: {
        balance: after,
        total_earned: (c.total_earned || 0) + n,
        total_used: c.total_used || 0,
      },
      recharge_summary: {
        last_amount: cents,
        last_credits: n,
        total_recharged_credits: (rs.total_recharged_credits || 0) + n,
      },
      last_active_at: now(),
    });
    return after;
  };

  try {
    const t = await db().startTransaction();
    try {
      const doc = await t.collection('users').doc(userId).get();
      const u = doc && doc.data;
      if (!u) {
        await t.rollback();
        return { ok: false, reason: 'user_not_found' };
      }
      const after = await apply(u, (patch) =>
        t.collection('users').doc(userId).update({ data: patch })
      );
      await addCreditLogTx(t, {
        uid: userId,
        change: n,
        after_balance: after,
        source: 'recharge',
        ref_id: orderId || '',
        note: '积分充值到账',
        ts: now(),
      });
      await t.commit();
      return { ok: true, after, via: 'tx' };
    } catch (e) {
      try { await t.rollback(); } catch (e2) { /* ignore */ }
      throw e;
    }
  } catch (e) {
    // 事务不可用 → 降级直写（余额必须到账，流水失败只告警）
    console.warn('[user] 充值到账事务失败，降级直写', e && (e.errMsg || e.message));
    const doc = await COLL.users().doc(userId).get();
    const u = doc && doc.data;
    if (!u) return { ok: false, reason: 'user_not_found' };
    const after = await apply(u, (patch) =>
      COLL.users().doc(userId).update({ data: patch })
    );
    try {
      await addCreditLog({
        uid: userId,
        change: n,
        after_balance: after,
        source: 'recharge',
        ref_id: orderId || '',
        note: '积分充值到账',
        ts: now(),
      });
    } catch (e2) {
      console.warn('[user] 充值流水写入失败（余额已到账）', e2 && (e2.errMsg || e2.message));
    }
    return { ok: true, after, via: 'plain' };
  }
}

/**
 * 开通 / 续期会员
 *
 * ⚠️⚠️ 写出的 membership 结构必须能被 credit.js#settleDecision 认出，判据是：
 *      生效 → tier 非 'none' 且 status === 'active'；
 *      额度 → quota.remaining（限次档）；
 *      不限次 → tier === 'unlimited'（此时 **quota 置 null**，与「未开通」同为 null，靠 tier 区分）。
 * ⚠️ 到期不由这里管：cronDaily#expireMembers 每天把 expires_at 过期的置为 expired（PRD 6.3）。
 *
 * @param {object} plan MEMBER_PLANS 的档位对象
 */
async function grantMembership(userId, plan, orderId, amountCents) {
  const p = plan || {};
  if (!userId || !p.tier) return { ok: false, reason: 'invalid_plan' };
  const days = Math.max(1, Math.round(Number(p.durationDays) || 30));
  const unlimited = !!p.unlimited;
  const quotaTotal = unlimited ? 0 : Math.max(0, Math.round(Number(p.quotaTotal) || 0));

  const doc = await COLL.users().doc(userId).get();
  const u = doc && doc.data;
  if (!u) return { ok: false, reason: 'user_not_found' };

  const cur = u.membership || {};
  const curActive =
    !!cur.tier &&
    cur.tier !== 'none' &&
    cur.status === 'active' &&
    !!cur.expires_at &&
    new Date(cur.expires_at).getTime() > Date.now();

  let startedAt;
  let expiresAt;
  let quota;

  if (curActive && cur.tier === p.tier && !unlimited) {
    // 同档续期：时间顺延，未用完额度结转累加
    startedAt = cur.started_at || now();
    expiresAt = new Date(new Date(cur.expires_at).getTime() + days * 86400000);
    const q = cur.quota || {};
    quota = {
      monthly: p.quotaMonthly || q.monthly || 60,
      total: (q.total || 0) + quotaTotal,
      used: q.used || 0,
      remaining: (q.remaining || 0) + quotaTotal,
    };
  } else {
    // 新开通 / 换档：从当前时间重新起算（旧档剩余额度不结转，避免跨档口径混乱）
    startedAt = now();
    expiresAt = new Date(Date.now() + days * 86400000);
    quota = unlimited
      ? null
      : {
          monthly: p.quotaMonthly || 60,
          total: quotaTotal,
          used: 0,
          remaining: quotaTotal,
        };
  }

  const membership = {
    tier: p.tier,
    status: 'active',
    started_at: startedAt,
    expires_at: expiresAt,
    quota,
    renew_reminded_at: null,
    source: 'order',
    order_id: orderId || '',
  };

  await COLL.users().doc(userId).update({
    data: { membership, last_active_at: now() },
  });
  return { ok: true, membership, amountCents: Math.round(Number(amountCents) || 0) };
}

/** 便捷：小程序 callFunction 上下文内建档 */
async function ensureUserFromContext(options = {}) {
  const ctx = getContext();
  // ⚠️ 取不到 openid 时**必须直接失败**，不能拿空串去建档：
  //    否则 where({ openid_mini: '' }) 既查不到、又会新建，
  //    在 users 里堆出一批 openid_mini 为空的孤儿档案
  //    （典型场景：在云开发控制台「测试」里直接调业务 action —— 控制台调用没有用户身份）。
  if (!ctx.openid) {
    throw { code: 401, msg: 'login required：未取到 openid（该接口需从小程序端调用）' };
  }
  return ensureUser({ source: 'mini', openid: ctx.openid, unionid: ctx.unionid, referralCode: options.referralCode });
}

module.exports = {
  ensureUser,
  ensureUserFromContext,
  findUser,
  defaultUser,
  defaultMembership,
  grantTrialCredits,
  // 虚拟支付支撑
  saveSessionKey,
  getSessionKey,
  addCredits, // 通用加积分（不碰充值摘要）—— 测试补分 / 运营补偿用
  addRechargedCredits,
  grantMembership,
};
