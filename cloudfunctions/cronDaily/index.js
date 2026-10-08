// 云函数 cronDaily - 每日定时任务（PRD 6.3 会员到期 / 8.2 任务兜底 / 8.4 临时文件清理）
// 定时触发器：config.json（每天 00:05）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { db, cmd, COLL } = require('./_common/db');
const { RENEW_REMIND_DAYS } = require('./_common/consts');
const { defaultMembership } = require('./_common/user');

/** 1) 过期会员置 expired（PRD 6.3：到期恢复非会员计费） */
async function expireMembers() {
  const now = new Date();
  let total = 0;
  for (;;) {
    const r = await COLL
      .users()
      .where({
        'membership.status': 'active',
        'membership.expires_at': cmd().lt(now),
      })
      .limit(100)
      .get();
    if (!r.data || !r.data.length) break;
    for (const u of r.data) {
      const mem = Object.assign({}, u.membership, defaultMembership());
      mem.tier = 'none';
      mem.status = 'expired';
      mem.expires_at = u.membership.expires_at; // 保留最后到期时间供展示
      await COLL.users().doc(u._id).update({ data: { membership: mem } });
      total++;
    }
    if (r.data.length < 100) break;
  }
  return total;
}

/** 2) 到期前 3/1 天续费提醒（订阅消息；模板未配置则记录 skip） */
async function renewRemind() {
  const TEMPLATE_ID = process.env.RENEW_TEMPLATE_ID || '';
  if (!TEMPLATE_ID || TEMPLATE_ID.indexOf('your-') === 0) {
    return { sent: 0, skipped: 'RENEW_TEMPLATE_ID 未配置' };
  }
  const results = { sent: 0, skipped: 0 };
  for (const day of RENEW_REMIND_DAYS) {
    const lo = day * 24 * 3600 * 1000 - 60 * 1000;
    const hi = (day + 1) * 24 * 3600 * 1000;
    const nowTs = Date.now();
    // expires_at ∈ [now+lo, now+hi)
    const r = await COLL
      .users()
      .where({
        'membership.status': 'active',
        'membership.expires_at': cmd().gt(new Date(nowTs + lo)).and(cmd().lt(new Date(nowTs + hi))),
        'membership.tier': cmd().neq('unlimited'),
      })
      .limit(50)
      .get();
    for (const u of r.data || []) {
      // 防骚扰：上次提醒距今 > day-1 天才再发
      const last = u.membership.renew_reminded_at;
      const reminded = last && nowTs - new Date(last).getTime() < (day - 0.5) * 24 * 3600 * 1000;
      if (reminded) continue;
      try {
        const wxapi = require('./_common/wxapi');
        await wxapi.sendSubscribe(u.openid_gzh || u.openid_mini, TEMPLATE_ID, {
          thing1: { value: '极速视频文案提取' },
          thing2: { value: '会员将于 ' + day + ' 天后到期' },
          phrase3: { value: '续费提醒' },
          thing4: { value: '点此一键续费，续费不中断使用' },
        });
        await COLL.users().doc(u._id).update({
          data: { 'membership.renew_reminded_at': new Date() },
        });
        results.sent++;
      } catch (e) {
        results.skipped++;
        console.warn('[cron] 续费提醒失败', e.message);
      }
    }
  }
  return results;
}

/** 3) 临时文件清理（云存储 tmp/ 超 24h）：MVP 记录待清理数量；正式环境接 tcb 管理 API 删除 */
async function cleanupTmp() {
  // TODO(正式)：使用 tcb 管理端 API 列出 tmp/ 并删除 >24h 文件（PRD 8.4：转写后即删 + 兜底清理定时器）
  return { note: '临时文件删除需 tcb 管理 API，云函数内暂记录（可先在云开发控制台手动清理）' };
}

exports.main = async () => {
  const expired = await expireMembers();
  const remind = await renewRemind();
  const tmp = await cleanupTmp();
  return { ok: true, expired, renew_remind: remind, tmp };
};
