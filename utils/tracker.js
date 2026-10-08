// utils/tracker.js - 轻量埋点（失败静默，不阻塞业务）
const { call } = require('./api');

function track(event, extra) {
  try {
    const app = getApp();
    if (!app || !app.globalData.cloudReady) return;
    call('track', { event, extra: extra || {} }).catch(() => {});
  } catch (e) {
    // 忽略
  }
}

module.exports = { track };
