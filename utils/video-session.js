// A separate, process-wide session: changing pages never restarts or duplicates video billing.
const api = require('./api');
const copy = require('./extract-session');
const KEY = 'video_extract_session_v1';
const listeners = new Set();
function emptyState() {
  return { phase: 'idle', percent: 0, label: '', mode: 'video', taskId: '', requestId: '', url: '', fileId: '', path: '', error: '', notice: '', copyPhase: 'idle', copyPercent: 0, copyId: '', cleaned: false };
}
let state = emptyState();
try { const saved = wx.getStorageSync(KEY); if (saved && saved.taskId) state = Object.assign(state, saved, { path: '', notice: '' }); } catch (_) {}
let running = false, saving = false, timer = null, foreground = false;
function snapshot() { return Object.assign({}, state); }
function emit(patch) {
  Object.assign(state, patch || {});
  try { wx.setStorageSync(KEY, Object.assign({}, state, { path: '', notice: '' })); } catch (_) {}
  listeners.forEach(fn => { try { fn(snapshot()); } catch (e) { console.warn('[video] view update skipped', e.message); } });
}
copy.subscribe((s, patch, event) => {
  if (state.mode !== 'both' || state.phase === 'idle') return;
  if (s.phase === 'idle' && state.copyPhase === 'done') return; // result page consumes the text session
  if (s.phase === 'idle' && state.copyPhase === 'running') { emit({ copyPhase: 'cancelled', copyPercent: 0 }); return; }
  emit({ copyPhase: s.phase, copyPercent: s.percent || 0, copyId: s.resultId || state.copyId });
});
function schedule() { clearTimeout(timer); timer = setTimeout(poll, 900); }
async function poll() {
  if (running || state.phase !== 'running' || !state.taskId) return;
  running = true;
  try {
    const task = await api.call('getVideoTask', { taskId: state.taskId });
    if (task.status === 'failed') { emit({ phase: 'failed', error: task.error || '视频提取失败，未扣除视频积分', notice: 'failed', label: '视频提取失败' }); return; }
    if (task.status === 'done') {
      emit({ phase: 'ready', percent: 70, fileId: task.fileId, label: '准备保存视频' });
      if (foreground) await save();
      return;
    }
    emit({ percent: task.percent || 5, label: task.stage === 'download' ? '正在提取视频' : '正在解析链接', error: '' });
  } catch (e) {
    // A lost response is not a failed job; re-query the same id, never create another charge.
    emit({ label: '连接暂未恢复，点此继续', error: e.message || '连接中断' });
    return;
  } finally { running = false; }
  schedule();
}
async function start(url, mode) {
  if (running || saving || state.phase === 'running' || state.phase === 'saving') return false;
  clearTimeout(timer);
  const requestId = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  emit({ phase: 'running', percent: 0, label: '正在提交', mode: mode || 'video', url, requestId,
    taskId: '', fileId: '', path: '', error: '', notice: '', cleaned: false, copyPhase: 'idle', copyPercent: 0, copyId: '' });
  running = true;
  try {
    const task = await api.call('startVideoExtract', { url, requestId });
    emit({ taskId: task.taskId });
    schedule();
    return true;
  } catch (e) {
    // Submission may have reached the server. Continue retries with this requestId.
    emit(e.code > 0 ? { phase: 'failed', label: '视频未开始提取', error: e.message, notice: 'failed' }
      : { phase: 'submit_retry', label: '提交未确认，点此重试', error: e.message || '网络暂不可用' });
    return false;
  } finally { running = false; }
}
async function retry() {
  if (running || saving) return;
  if (state.phase === 'submit_retry') {
    running = true;
    try {
      const task = await api.call('startVideoExtract', { url: state.url, requestId: state.requestId });
      emit({ taskId: task.taskId, phase: 'running', error: '' }); schedule();
    } catch (e) { emit(e.code > 0 ? { phase: 'failed', label: '视频未开始提取', error: e.message, notice: 'failed' } : { error: e.message, notice: 'submit_retry' }); }
    finally { running = false; }
  } else if (state.phase === 'running') { emit({ error: '' }); poll(); }
  else if (state.phase === 'ready' || state.phase === 'save_failed') { save(true); }
}
function native(method, options) { return new Promise((resolve, reject) => wx[method](Object.assign({}, options, { success: resolve, fail: reject }))); }
function download() {
  return new Promise((resolve, reject) => {
    const task = wx.cloud.downloadFile({ fileID: state.fileId, success: r => resolve(r.tempFilePath), fail: reject });
    if (task && task.onProgressUpdate) task.onProgressUpdate(r => emit({ percent: 70 + Math.floor((r.progress || 0) * .25), label: '下载到手机 ' + (r.progress || 0) + '%' }));
  });
}
async function save(fromTap) {
  if (saving || !foreground || !state.fileId || state.phase === 'saved') return;
  saving = true;
  emit({ phase: 'saving', label: '正在保存到相册', error: '', notice: '' });
  try {
    if (fromTap && wx.getSetting) {
      const settings = await native('getSetting', {});
      if (settings.authSetting && settings.authSetting['scope.writePhotosAlbum'] === false) {
        const result = await native('openSetting', {});
        if (!result.authSetting || !result.authSetting['scope.writePhotosAlbum']) throw new Error('尚未开启相册权限');
      }
    }
    let path = state.path;
    if (path && wx.getFileSystemManager) {
      try { wx.getFileSystemManager().accessSync(path); } catch (_) { path = ''; }
    }
    if (!path) { path = await download(); emit({ path }); }
    if (!path) throw new Error('视频下载未完成');
    await native('saveVideoToPhotosAlbum', { filePath: path });
    emit({ phase: 'saved', percent: 100, label: '已保存到相册', notice: 'saved' });
    acknowledgeSaved();
  } catch (e) {
    emit({ phase: 'save_failed', label: '视频已提取，尚未保存', error: e.message || e.errMsg || '保存未完成', notice: 'save_failed' });
  } finally { saving = false; }
}
function setForeground(value) {
  foreground = !!value;
  if (foreground) {
    if (state.phase === 'running') poll();
    else if (state.phase === 'ready') save();
    // App was closed mid-download/save; resume a completed server extraction, not a new charge.
    else if (state.phase === 'saving' && !saving) { emit({ phase: 'ready' }); save(); }
    else if (state.phase === 'saved') acknowledgeSaved();
  }
}
function acknowledgeSaved() {
  if (state.phase !== 'saved' || !state.taskId || state.cleaned) return;
  const id = state.taskId;
  api.call('videoSaved', { taskId: id }).then(() => {
    if (state.taskId === id && state.phase === 'saved') emit({ cleaned: true });
  }).catch(() => {}); // Cleanup can retry on the next foreground; it cannot turn a real save into failure.
}
function clearCompleted() {
  // Reset presentation only. Never discard an active job, an unconfirmed submission,
  // or a charged video that still needs to be saved to the album.
  if (running || saving || copy.phase() === 'running' || state.copyPhase === 'running') return false;
  if (state.phase !== 'saved' && state.phase !== 'failed') return false;
  clearTimeout(timer);
  timer = null;
  emit(emptyState());
  return true;
}
module.exports = { start, retry, save, snapshot, setForeground, clearCompleted,
  detachCopy() { if (state.mode === 'both') emit({ mode: 'video', copyPhase: 'idle', copyId: '' }); },
  subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
  consumeNotice() { const n = state.notice; if (n) emit({ notice: '' }); return n; },
  busy() { return running || saving || state.phase === 'running' || state.phase === 'saving'; },
};
