// Display snapshots are scoped to the authenticated account, never shared across users.
function uid() { return ((getApp().globalData || {}).user || {})._id || ''; }
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
