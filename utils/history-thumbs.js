// Persistent thumbnail files. Only this cache's own files may be pruned.
const KEY = 'history_thumb_files_v1';
let files = {};
try { files = wx.getStorageSync(KEY) || {}; } catch (_) {}
const pending = new Map(), queue = []; let active = 0;
function key(uid, id) { return JSON.stringify([uid, id]); }
function persist() { try { wx.setStorageSync(KEY, files); } catch (_) {} }
function exists(path) { try { wx.getFileSystemManager().accessSync(path); return true; } catch (_) { return false; } }
function removeOwned(path) {
  if (typeof path !== 'string' || !path.startsWith(wx.env.USER_DATA_PATH + '/history-thumbs/')) return;
  try { wx.getFileSystemManager().unlinkSync(path); } catch (_) {}
}
function local(uid, id, source) {
  const k = key(uid, id), hit = files[k];
  if (hit && hit.source === source && exists(hit.path)) return hit.path;
  if (hit && !exists(hit.path)) { delete files[k]; persist(); }
  return '';
}
function filename(str) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < str.length; i++) { a = Math.imul(a ^ str.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ str.charCodeAt(i); }
  return (a >>> 0).toString(16) + '_' + (b >>> 0).toString(16);
}
function prune(keep) {
  const rows = Object.entries(files).sort((a, b) => b[1].at - a[1].at);
  let bytes = 0;
  for (let i = 0; i < rows.length; i++) {
    const [k, f] = rows[i]; bytes += f.bytes || 0;
    if ((i >= 120 || bytes > 32 * 1024 * 1024) && k !== keep) {
      removeOwned(f.path);
      delete files[k];
    }
  }
}
function download(source) {
  return new Promise((resolve, reject) => {
    if (/^cloud:\/\//.test(source)) wx.cloud.downloadFile({ fileID: source, success: r => resolve(r.tempFilePath), fail: reject });
    else if (/^https:\/\//.test(source)) wx.getImageInfo({ src: source, success: r => resolve(r.path), fail: reject });
    else exists(source) ? resolve(source) : reject(new Error('missing thumbnail'));
  });
}
function pump() {
  while (active < 3 && queue.length) {
    const job = queue.shift(); active++;
    (async () => {
      let result = '';
      try {
        const path = await download(job.source), fs = wx.getFileSystemManager();
        const dir = wx.env.USER_DATA_PATH + '/history-thumbs';
        try { fs.mkdirSync(dir, true); } catch (_) {}
        const dest = dir + '/' + filename(job.k + job.source) + '.jpg';
        fs.copyFileSync(path, dest);
        const old = files[job.k];
        files[job.k] = { path: dest, source: job.source, at: Date.now(), bytes: fs.statSync(dest).size || 0 };
        if (old && old.path !== dest) removeOwned(old.path);
        prune(job.k); persist(); result = dest;
      } catch (_) { /* Keep the visible image; cache failure is never a history failure. */ }
      finally { pending.delete(job.k); active--; job.resolve(result); pump(); }
    })();
  }
}
function warm(uid, id, source) {
  if (!uid || !id || !source) return Promise.resolve('');
  const ready = local(uid, id, source); if (ready) return Promise.resolve(ready);
  const k = key(uid, id); if (pending.has(k)) return pending.get(k);
  const promise = new Promise(resolve => queue.push({ k, source, resolve }));
  pending.set(k, promise); pump(); return promise;
}
module.exports = { local, warm };
