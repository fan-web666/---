// Fixed, one-off campaign. Wallet and deterministic ledger are committed together.
const { db, cmd } = require('./db');
const crypto = require('crypto');
const CAMPAIGN = 'existing_users_50_20261013';
const CUTOFF = new Date('2026-10-13T10:14:03Z');
const AMOUNT = 50;
async function read(tx, collection, id) {
  try { return (await tx.collection(collection).doc(id).get()).data || null; }
  catch (e) {
    if (/DOCUMENT_NOT_EXIST|DOCUMENT_NOT_FOUND|document.*(?:not exist|not found)|-502005/i.test(String(e.errMsg || e.message))) return null;
    throw e;
  }
}
function eligible(user) {
  const stamp = user.created_at || user.bind_at;
  return !stamp || new Date(stamp).getTime() <= CUTOFF.getTime();
}
async function grant(uid) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tx = await db().startTransaction();
    try {
      const user = await read(tx, 'users', uid);
      const id = 'bonus_' + crypto.createHash('sha256').update(CAMPAIGN + ':' + uid).digest('hex');
      if (!user || !eligible(user)) { await tx.rollback(); return 'ineligible'; }
      if (user.welcome_bonus_20261013 || await read(tx, 'credit_logs', id)) { await tx.rollback(); return 'already_granted'; }
      const credits = Object.assign({}, user.credits, {
        balance: Number((user.credits || {}).balance || 0) + AMOUNT,
        total_earned: Number((user.credits || {}).total_earned || 0) + AMOUNT,
      });
      const ts = new Date();
      await tx.collection('users').doc(uid).update({ data: {
        credits, welcome_bonus_20261013: { campaign: CAMPAIGN, amount: AMOUNT, granted_at: ts },
      } });
      await tx.collection('credit_logs').doc(id).set({ data: {
        uid, change: AMOUNT, after_balance: credits.balance, source: 'campaign', ref_id: CAMPAIGN,
        note: '老用户福利：额外赠送50积分', ts,
      } });
      await tx.commit();
      return 'granted';
    } catch (e) {
      try { await tx.rollback(); } catch (_) {}
      if (attempt === 4 || !/conflict|transaction.*(?:fail|abort)|retry|duplicate|-502001/i.test(String(e.errMsg || e.message))) throw e;
    }
  }
}
async function report() {
  const result = await db().collection('credit_logs').where({ source: 'campaign', ref_id: CAMPAIGN }).count();
  return { campaign: CAMPAIGN, amount: AMOUNT, cutoff: CUTOFF.toISOString(), granted_users: result.total, granted_credits: result.total * AMOUNT };
}
async function batch(event) {
  const cursor = typeof event.cursor === 'string' ? event.cursor : '';
  let query = db().collection('users');
  if (cursor) query = query.where({ _id: cmd().gt(cursor) });
  const rows = (await query.orderBy('_id', 'asc').limit(20).get()).data || [];
  const outcomes = await Promise.all(rows.map(user => grant(user._id)));
  return Object.assign(await report(), {
    scanned: rows.length, added: outcomes.filter(x => x === 'granted').length,
    done: rows.length < 20, next_cursor: rows.length ? rows[rows.length - 1]._id : cursor,
  });
}
module.exports = { batch, report, grant, eligible, AMOUNT, CAMPAIGN };
