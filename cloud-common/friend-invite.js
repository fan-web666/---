// One transaction owns the campaign slot, wallet and permanent identity ledger.
const { db } = require('./db');
const crypto = require('crypto');
const CAMPAIGN = 'friend_invite_campaign';
const REWARD = 10000;
function business(code, msg) { return { code, msg }; }
async function read(tx, name, id) {
  try { return (await tx.collection(name).doc(id).get()).data || null; }
  catch (e) {
    if (/DOCUMENT_NOT_EXIST|DOCUMENT_NOT_FOUND|document.*(?:not exist|not found)|-502005/i.test(String(e.errMsg || e.message))) return null;
    throw e;
  }
}
async function redeem(user, event) {
  const input = typeof event.code === 'string' ? event.code.trim() : '';
  if (!input || input.length > 64) throw business(400, '请输入有效的邀请码');
  for (let attempt = 0; attempt < 5; attempt++) {
    const tx = await db().startTransaction();
    try {
      const u = await read(tx, 'users', user._id);
      if (!u || !u.openid_mini) throw business(401, '请先登录后再兑换');
      const campaign = await read(tx, 'app_config', CAMPAIGN) || { code: 'YuXing2026', used: 0, limit: 30, enabled: true };
      if (input !== campaign.code) throw business(400, '邀请码无效，请检查后重试');
      const id = 'friend_' + crypto.createHash('sha256').update('mini:' + u.openid_mini).digest('hex');
      const existing = await read(tx, 'credit_logs', id);
      if (existing || u.friend_invite) {
        await tx.commit();
        return { status: 'already_redeemed', credits: u.credits, amount: REWARD };
      }
      const used = Number(campaign.used || 0);
      const limit = Math.min(30, Number(campaign.limit || 30));
      if (campaign.enabled === false || used >= limit) throw business(409, '本期亲友名额已用尽，请联系开发者申请新的邀请码');
      const credits = Object.assign({}, u.credits, {
        balance: Number((u.credits || {}).balance || 0) + REWARD,
        total_earned: Number((u.credits || {}).total_earned || 0) + REWARD,
      });
      const ts = new Date();
      // ⚠️⚠️ 事务里 `doc.get()` 的返回值**带 `_id`**（与普通查询不同！普通 doc.get() 不含，事务含），
      //    而 `set` 的 data **不允许出现 `_id`**，否则报：
      //      document.set:fail -501007 invalid parameters. 不能更新_id的值
      //    表现极具迷惑性：**第一个人能兑换，之后所有人都失败** ——
      //      因为文档不存在时走的是下面的默认对象（无 _id），set 顺带把文档创建了出来；
      //      从此每次 `read` 都能读到该文档（带 _id），于是全体卡死。
      //    `cloud-common/user.js:128` 用的是正确写法 `const { _id, ...newData } = u`，此处漏了，现补齐。
      const campaignData = Object.assign({}, campaign, { used: used + 1, updated_at: ts });
      delete campaignData._id;
      await tx.collection('app_config').doc(CAMPAIGN).set({ data: campaignData });
      await tx.collection('users').doc(u._id).update({ data: { credits, friend_invite: { code: campaign.code, amount: REWARD, redeemed_at: ts, expires_at: null } } });
      await tx.collection('credit_logs').doc(id).set({ data: {
        uid: u._id, change: REWARD, after_balance: credits.balance, source: 'friend_invite', ref_id: CAMPAIGN,
        note: '亲友邀请码兑换，赠送10000积分（永久有效）', expires_at: null, ts,
      } });
      await tx.commit();
      return { status: 'redeemed', credits, amount: REWARD };
    } catch (e) {
      try { await tx.rollback(); } catch (_) {}
      if (e.code || attempt === 4 || !/conflict|transaction.*(?:fail|abort)|retry|duplicate|-502001/i.test(String(e.errMsg || e.message))) throw e;
      await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
}
module.exports = { redeem, REWARD };
