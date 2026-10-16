// Video delivery is independent from transcription: no ASR, no copywriting/history writes.
const fs = require('fs');
const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const { db, COLL } = require('./db');
const providers = require('./providers');
const { settleDecision } = require('./credit');
const { MAX_DURATION_SEC } = require('./consts');

// Read only MP4 box headers and mvhd, not a second full copy of a large video.
function durationFromFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const end = fs.fstatSync(fd).size;
    let duration = 0, hasVideo = false;
    function walk(start, limit, depth) {
      if (depth > 4) return;
      for (let at = start; at + 8 <= limit;) {
        const h = Buffer.alloc(16);
        if (fs.readSync(fd, h, 0, Math.min(16, limit - at), at) < 8) return 0;
        let size = h.readUInt32BE(0), header = 8;
        const type = h.toString('ascii', 4, 8);
        if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16; }
        if (size === 0) size = limit - at;
        if (!Number.isSafeInteger(size) || size < header || at + size > limit) return 0;
        if (type === 'mvhd') {
          const b = Buffer.alloc(32);
          if (size - header < 20 || fs.readSync(fd, b, 0, Math.min(32, size - header), at + header) < 20) return 0;
          const version = b[0];
          if (version !== 0 && version !== 1) return 0;
          if (version === 1 && size - header < 32) return 0;
          const scale = b.readUInt32BE(version ? 20 : 12);
          const units = version ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
          duration = scale && Number.isFinite(units) ? units / scale : 0;
        }
        if (type === 'hdlr' && size - header >= 12) {
          const handler = Buffer.alloc(12);
          if (fs.readSync(fd, handler, 0, 12, at + header) === 12 && handler.toString('ascii', 8, 12) === 'vide') hasVideo = true;
        }
        if (['moov', 'trak', 'mdia'].indexOf(type) >= 0) walk(at + header, at + size, depth + 1);
        at += size;
      }
      return 0;
    }
    walk(0, end, 0);
    return hasVideo ? duration : 0;
  } finally { fs.closeSync(fd); }
}

function view(t) {
  return { taskId: t._id, status: t.status, stage: t.video_stage, percent: t.status === 'done' ? 100 : t.video_stage === 'download' ? 25 : 5,
    fileId: t.status === 'done' ? t.video_file_id : '', title: t.video_title || '', error: t.error_reason || (t.error && t.error.msg) || '', durationSec: t.duration_sec || 0 };
}
async function owned(user, id) {
  if (!/^video_[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('视频任务不存在');
  const r = await COLL.tasks().doc(id).get();
  const t = r.data;
  if (!t || t.uid !== user._id || t.extract_kind !== 'video') throw new Error('视频任务不存在');
  return Object.assign({}, t, { _id: id });
}
async function start(user, event) {
  const requestId = String(event.requestId || '');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new Error('请重新提交视频链接');
  const url = String(event.url || '').trim();
  if (!/^https?:\/\//i.test(url) || url.length > 3000) throw new Error('请使用视频分享链接');
  const platform = providers.detectPlatform(url);
  if (!providers.isSupportedPlatform(platform)) throw new Error('暂不支持此平台的视频提取');
  if (providers.useMock()) throw new Error('视频提取需要真实云服务，演示模式不能保存视频');
  const id = 'video_' + crypto.createHash('md5').update(user._id + ':' + requestId).digest('hex');
  const tx = await db().startTransaction();
  try {
    let existing;
    try { existing = (await tx.collection('tasks').doc(id).get()).data; }
    catch (e) { if (!/not exist|not found|不存在|DOCUMENT_NOT_FOUND/i.test(String(e.errMsg || e.message))) throw e; }
    if (existing) {
      if (existing.uid !== user._id || existing.source_url !== url) throw new Error('提交标识冲突，请重新提取');
      await tx.rollback(); return view(Object.assign({}, existing, { _id: id }));
    }
    // Early balance check; authoritative duration and deduction happen in the final transaction.
    const fresh = (await tx.collection('users').doc(user._id).get()).data;
    if (fresh.video_active_task) {
      let active;
      try { active = (await tx.collection('tasks').doc(fresh.video_active_task).get()).data; }
      catch (e) { if (!/not exist|not found|不存在|DOCUMENT_NOT_FOUND/i.test(String(e.errMsg || e.message))) throw e; }
      if (active && ['video_pending', 'video_working'].indexOf(active.status) >= 0 && Date.now() - new Date(active.created_at).getTime() < 10 * 60 * 1000) {
        throw new Error('已有视频正在提取，请完成当前任务后再试');
      }
    }
    const check = settleDecision(fresh, 1, 'video');
    if (!check.ok) throw new Error(check.msg);
    const task = { uid: user._id, source_url: url, source_platform: platform, extract_kind: 'video', status: 'video_pending',
      video_stage: 'resolve', charged: false, created_at: new Date(), updated_at: new Date() };
    await tx.collection('tasks').doc(id).set({ data: task });
    await tx.collection('users').doc(user._id).update({ data: { video_active_task: id } });
    await tx.commit(); return view(Object.assign({ _id: id }, task));
  } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
}

// Atomic task + balance + ledger commit makes network retries incapable of charging twice.
async function finish(user, id, token, fileId, seconds) {
  const tx = await db().startTransaction();
  try {
    const task = (await tx.collection('tasks').doc(id).get()).data;
    if (task.uid !== user._id || task.video_lease !== token || task.status !== 'video_working') throw new Error('视频任务已结束或由另一个请求接管');
    if (Date.now() - new Date(task.created_at).getTime() > 600000) throw new Error('视频提取超时，未扣除视频积分，请重新提取');
    if (task.charged) { await tx.rollback(); return task; }
    const u = (await tx.collection('users').doc(user._id).get()).data;
    const r = settleDecision(u, seconds, 'video');
    if (!r.ok) throw new Error(r.msg);
    const d = r.decision, patch = { last_active_at: new Date() };
    if (u.video_active_task === id) patch.video_active_task = '';
    if (d.payType === 'quota') {
      patch.membership = Object.assign({}, u.membership, { quota: Object.assign({}, u.membership.quota, {
        used: (u.membership.quota.used || 0) + d.quotaUsed, remaining: u.membership.quota.remaining - d.quotaUsed }) });
    } else if (d.payType === 'credit') {
      patch.credits = Object.assign({}, u.credits, { balance: u.credits.balance - d.creditCost, total_used: (u.credits.total_used || 0) + d.creditCost });
      await tx.collection('credit_logs').add({ data: { uid: user._id, change: -d.creditCost,
        after_balance: patch.credits.balance, source: 'consume', ref_id: id, note: '视频提取', ts: new Date() } });
    }
    await tx.collection('users').doc(user._id).update({ data: patch });
    const completed = { status: 'done', video_stage: 'ready', video_file_id: fileId, duration_sec: seconds,
      charged: true, credit_decision: d, updated_at: new Date(), video_lease: '', video_lease_until: 0 };
    await tx.collection('tasks').doc(id).update({ data: completed });
    await tx.commit(); return Object.assign(task, completed, { _id: id });
  } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
}
async function get(user, event) {
  let t = await owned(user, event.taskId);
  if (t.status === 'done' || t.status === 'failed') return view(t);
  if (Date.now() - new Date(t.created_at).getTime() > 600000) {
    await COLL.tasks().where({ _id: t._id, uid: user._id, status: t.status }).update({ data: {
      status: 'failed', error_reason: '视频提取超时，未扣除视频积分，请重新提取', video_lease: '', video_lease_until: 0, updated_at: new Date() } });
    return view(await owned(user, t._id));
  }
  const token = crypto.randomBytes(12).toString('hex');
  const tx = await db().startTransaction();
  try {
    t = Object.assign({ _id: event.taskId }, (await tx.collection('tasks').doc(event.taskId).get()).data);
    if (t.status === 'done' || t.status === 'failed' || Number(t.video_lease_until) > Date.now()) {
      await tx.rollback(); return view(t);
    }
    await tx.collection('tasks').doc(t._id).update({ data: { video_lease: token, video_lease_until: Date.now() + 90000, status: 'video_working' } });
    await tx.commit();
  } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
  let media, uploaded;
  try {
    if (t.video_stage === 'resolve') {
      const meta = await providers.resolveVideoSource(t.source_url, t.source_platform);
      if (meta.mock || !meta.url || !/^https?:\/\//i.test(meta.url)) throw new Error('此链接未返回可保存的视频');
      if (meta.durationSec > MAX_DURATION_SEC) throw new Error('视频超过 ' + MAX_DURATION_SEC / 60 + ' 分钟暂不支持');
      await COLL.tasks().where({ _id: t._id, uid: user._id, video_lease: token }).update({ data: {
        video_meta: meta, video_title: meta.title || '', video_stage: 'download', status: 'video_pending',
        video_lease: '', video_lease_until: 0, updated_at: new Date() } });
      return view(await owned(user, t._id));
    }
    media = await providers.downloadMedia(t.video_meta, t._id);
    const seconds = durationFromFile(media.path);
    if (!(seconds > 0)) throw new Error('无法确认视频时长或视频格式不支持，未扣除积分');
    if (seconds > MAX_DURATION_SEC) throw new Error('视频超过 ' + MAX_DURATION_SEC / 60 + ' 分钟暂不支持，未扣除积分');
    uploaded = await cloud.uploadFile({ cloudPath: 'video-delivery/' + t._id + '.mp4', fileContent: fs.createReadStream(media.path) });
    if (!uploaded.fileID) throw new Error('视频存储失败，请稍后重试');
    return view(await finish(user, t._id, token, uploaded.fileID, seconds));
  } catch (e) {
    // Failed extraction has not charged; album permission failure happens only on the phone, after completion.
    const patch = { status: 'failed', error_reason: String(e.message || e.errMsg || '视频提取失败'),
      video_lease: '', video_lease_until: 0, updated_at: new Date() };
    const changed = await COLL.tasks().where({ _id: t._id, uid: user._id, video_lease: token }).update({ data: patch });
    if (uploaded && uploaded.fileID && changed.stats && changed.stats.updated) {
      try { await cloud.deleteFile({ fileList: [uploaded.fileID] }); } catch (_) {}
    }
    return view(await owned(user, t._id));
  } finally { if (media) providers.removeMedia(media.path); }
}
async function saved(user, event) {
  const task = await owned(user, event.taskId);
  if (task.status !== 'done') throw new Error('视频尚未提取完成');
  if (task.video_file_id) {
    const r = await cloud.deleteFile({ fileList: [task.video_file_id] });
    const failure = (r.fileList || []).find(f => f.status !== 0);
    if (failure && !/not exist|not found/i.test(String(failure.errMsg))) throw new Error('视频临时文件清理未完成');
    await COLL.tasks().doc(task._id).update({ data: { video_file_id: '', video_album_saved_at: new Date() } });
  }
  return { ok: true };
}
module.exports = { start, get, saved, _internal: { durationFromFile, view, finish } };
