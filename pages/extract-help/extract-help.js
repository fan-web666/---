const pricing = require('../../config/pricing');

/* 费率示例行 —— 2026-10-15 计费改为「视频每 15 分钟 1 次 / 文案每 3 分钟 1 次」，
 * 时长分档从 2 档变成连续阶梯，故这里只列 4 个**代表性时长**，
 * 数字一律由 pricing.creditOf() 现算（与云端 computeCost 同口径），页面上不写死任何金额。 */
const FEE_SAMPLES = [
  { label: '≤3 分钟', sec: 3 * 60 },
  { label: '6 分钟', sec: 6 * 60 },
  { label: '15 分钟', sec: 15 * 60 },
  { label: '30 分钟', sec: 30 * 60 },
];

const feeRows = FEE_SAMPLES.map((r) => ({
  label: r.label,
  video: pricing.creditOf(r.sec, 'video'),
  text: pricing.creditOf(r.sec, 'text'),
  both: pricing.creditOf(r.sec, 'video') + pricing.creditOf(r.sec, 'text'),
}));

Page({
  data: {
    statusBarH: 0,
    navSafeRightRpx: 196,
    feeRows,
    unitText: '规则：视频每 15 分钟算 1 次，文案每 3 分钟算 1 次（不足按 1 次）。',
    memberText: '会员按 1 次 = 1 单位抵扣；单条超过 30 分钟暂不支持。',
  },
  onLoad() {
    const g = getApp().globalData;
    this.setData({ statusBarH: g.navStatusH || 0, navSafeRightRpx: g.navSafeRightRpx || 196 });
  },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },
});
