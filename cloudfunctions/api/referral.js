// 推荐关系与积分必须在同一事务提交；任何失败都不降级为分步发奖。
const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const { db, cmd } = require('./_common/db');
const REWARD = 100;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function normalize(value) { const s = typeof value === 'string' ? value.trim().toUpperCase() : ''; return /^Y[A-F0-9]{10}$/.test(s) ? s : ''; }
async function read(tx, collection, id) {
  try { const r = await tx.collection(collection).doc(id).get(); return r.data || null; }
  catch (e) { if (/DOCUMENT_NOT_EXIST|document.*(?:not exist|not found)|-502005/i.test(String(e.errMsg || e.message))) return null; throw e; }
}
async function transaction(work) {
  for (let i = 0; i < 4; i++) {
    const tx = await db().startTransaction();
    try { const result = await work(tx); await tx.commit(); return result; }
    catch (e) { try { await tx.rollback(); } catch (_) {} if (i === 3 || !/conflict|transaction.*(?:fail|abort)|retry|duplicate/i.test(String(e.errMsg || e.message))) throw e; }
  }
}
async function ensureCode(user) {
  if (normalize(user.referral_code)) return user.referral_code;
  return transaction(async tx => {
    const u = await read(tx, 'users', user._id);
    if (!u) throw new Error('用户不存在');
    if (normalize(u.referral_code)) return u.referral_code;
    // 数据库文档 ID 唯一占位；事务同时锁住用户，保证每人只有一个稳定推荐码。
    for (let i = 0; i < 8; i++) {
      const code = 'Y' + hash(user._id + ':' + i).slice(0, 10).toUpperCase();
      const owner = await read(tx, 'referral_codes', code);
      if (owner && owner.uid !== user._id) continue;
      await tx.collection('referral_codes').doc(code).set({ data: { uid: user._id, created_at: new Date() } });
      await tx.collection('users').doc(user._id).update({ data: { referral_code: code } });
      return code;
    }
    throw new Error('推荐码生成失败，请重试');
  });
}
async function bindPending(user) {
  if (!user.referral_entry || user.referral_entry.state !== 'pending') return { state: 'ineligible', changed: false };
  return transaction(async tx => {
    const u = await read(tx, 'users', user._id);
    if (!u || !u.referral_entry || u.referral_entry.state !== 'pending') return { state: 'settled', changed: false };
    const code = normalize(u.referral_entry.code);
    const owner = code ? await read(tx, 'referral_codes', code) : null;
    const inviter = owner ? await read(tx, 'users', owner.uid) : null;
    // 用微信身份做唯一键，避免不同用户档案对同一微信账号重复计奖。
    const identity = u.openid_mini;
    if (!identity) throw new Error('缺少微信身份，无法绑定');
    const bindingId = hash('mini:' + identity);
    const existing = await read(tx, 'referral_bindings', bindingId);
    let state = existing ? 'already_bound' : (!inviter ? 'invalid' : (inviter._id === u._id || inviter.openid_mini === identity || (u.unionid && inviter.unionid === u.unionid) ? 'self' : 'bound'));
    const ts = new Date();
    if (state !== 'bound') {
      await tx.collection('users').doc(u._id).update({ data: { 'referral_entry.state': state, 'referral_entry.processed_at': ts } });
      return { state, changed: true };
    }
    const after = ((inviter.credits || {}).balance || 0) + REWARD;
    await tx.collection('referral_bindings').doc(bindingId).set({ data: { inviter_uid: inviter._id, invitee_uid: u._id, code, reward: REWARD, status: 'rewarded', created_at: ts } });
    await tx.collection('users').doc(u._id).update({ data: { 'referral_entry.state': 'bound', 'referral_entry.inviter_uid': inviter._id, 'referral_entry.processed_at': ts } });
    await tx.collection('users').doc(inviter._id).update({ data: { 'credits.balance': cmd().inc(REWARD), 'credits.total_earned': cmd().inc(REWARD), 'referral.invited_count': cmd().inc(1), 'referral.reward_total': cmd().inc(REWARD) } });
    await tx.collection('credit_logs').doc('referral_' + bindingId).set({ data: { uid: inviter._id, change: REWARD, after_balance: after, source: 'referral', ref_id: bindingId, note: '成功邀请一位新用户，奖励 100 积分', ts } });
    return { state: 'bound', changed: true };
  });
}
async function summary(user) {
  const code = await ensureCode(user);
  const r = await db().collection('users').doc(user._id).get();
  const stats = (r.data || {}).referral || {};
  return { code, invitedCount: stats.invited_count || 0, rewardTotal: stats.reward_total || 0, rewardPerUser: REWARD };
}
async function posterCode(user) {
  const code = await ensureCode(user);
  const result = await cloud.openapi.wxacode.getUnlimited({ scene: 'r=' + code, page: 'pages/index/index', checkPath: false, envVersion: 'release', width: 430 });
  if (!result.buffer || (result.errCode && result.errCode !== 0)) throw new Error('小程序码生成失败，请稍后再试');
  const upload = await cloud.uploadFile({ cloudPath: 'referrals/' + code + '.png', fileContent: result.buffer });
  return { code, fileID: upload.fileID };
}
module.exports = { normalize, ensureCode, bindPending, summary, posterCode, REWARD };
