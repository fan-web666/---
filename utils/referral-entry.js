// 保存首次有效邀请来源；重试保持同一码，分享卡片 query 和海报 scene 均支持。
const KEY = 'pending_referral_code';
function normalize(s) { return typeof s === 'string' && /^Y[A-F0-9]{10}$/.test(s.trim().toUpperCase()) ? s.trim().toUpperCase() : ''; }
function capture(options) {
  const query = options && options.query || options || {};
  let code = normalize(query.ref || query.referralCode);
  if (!code && query.scene) {
    try { const scene = decodeURIComponent(query.scene); const m = scene.match(/(?:^|&)r=([^&]+)/); code = normalize(m && m[1]); } catch (_) {}
  }
  if (!code) return false;
  try { if (wx.getStorageSync(KEY)) return false; wx.setStorageSync(KEY, code); return true; } catch (_) { return false; }
}
function requestData() { try { const code = normalize(wx.getStorageSync(KEY)); return code ? { referralCode: code } : {}; } catch (_) { return {}; } }
function settle(state) { if (state && state !== 'pending') { try { wx.removeStorageSync(KEY); } catch (_) {} } }
module.exports = { capture, requestData, settle, normalize };
