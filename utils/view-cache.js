// Display snapshots are scoped to the authenticated account, never shared across users.
//
// ⚠️⚠️ 2026-10-15：改用 auth.localUid()，**不再直接依赖 globalData.user**。
//   原因：缓存读取发生在页面 data 初始化 / 模块顶层，彼时 globalData.user 可能尚未就绪
//   （冷启动 onLaunch 的恢复时机）→ 旧写法返回 '' → 与缓存里的 uid 不匹配 → **缓存被判定为
//   「别的账号」而整体丢弃** → 每次冷启动进页面都是「先占位、后跳变」。
//   localUid() 会在内存态未就绪时回落本地快照，任何时刻都能给出稳定标识。
// ⚠️ 惰性 require：auth.js 顶层 require ./api，api.js 函数内 require 本模块，顶层 require 会成环。
function uid() {
  try { return require('./auth').localUid(); } catch (_) { return ''; }
}
function read(name) {
  try { const c = wx.getStorageSync('view_' + name); return uid() && c && c.uid === uid() ? c.data : null; } catch (_) { return null; }
}
function write(name, data) {
  if (!uid()) return;
  try {
    wx.setStorageSync('view_' + name, { uid: uid(), data });
    if (name.startsWith('result_')) {
      const indexKey='view_result_index_v2_'+uid();
      const index=wx.getStorageSync(indexKey)||[];
      const entry={name,size:JSON.stringify({uid:uid(),data}).length*2};
      const next=[entry].concat(Array.isArray(index)?index.filter(k=>k&&typeof k.name==='string'&&k.name.startsWith('result_')&&k.name!==name):[]);
      // Keep details already supplied by history pages, bounded below wx's storage limit.
      let bytes=0;const keep=[];
      next.forEach(k=>{if(keep.length<200&&bytes+k.size<=4*1024*1024){keep.push(k);bytes+=k.size;}else if(wx.removeStorageSync)wx.removeStorageSync('view_'+k.name);});
      wx.setStorageSync(indexKey,keep);
    }
  } catch (_) {}
}
function patch(page, data) {
  const changed = {};
  Object.keys(data).forEach(k => { if (JSON.stringify(page.data[k]) !== JSON.stringify(data[k])) changed[k] = data[k]; });
  if (Object.keys(changed).length) page.setData(changed);
}
module.exports = { read, write, patch, uid };
