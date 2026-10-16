const pricing = require('../../config/pricing');

/* 费率示例行 —— 2026-10-16 v5 计费：视频 5/10 两档、文案 起步 2 积分 + 每分钟 2 积分。
 * 只列 4 个**代表性时长**，数字一律由 pricing.creditOf() 现算（与云端 computeCost 同口径），页面不写死金额。 */
const FEE_SAMPLES = [
  { label: '1 分钟', sec: 60 },
  { label: '5 分钟', sec: 5 * 60 },
  { label: '10 分钟', sec: 10 * 60 },
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
    unitText: '非会员扣积分：视频 ' + pricing.VIDEO_TIER_MIN + ' 分钟以内 ' + pricing.CREDIT_VIDEO_SHORT +
      ' 积分、' + pricing.VIDEO_TIER_MIN + '~30 分钟 ' + pricing.CREDIT_VIDEO_LONG +
      ' 积分；文案起步 ' + pricing.CREDIT_START_TEXT + ' 积分 + 每分钟 ' + pricing.CREDIT_PER_MIN_TEXT + ' 积分。',
    memberText: '会员额度以积分计量（1 元 = ' + pricing.CREDIT_PER_YUAN_MEMBER + ' 积分）；单条超过 30 分钟暂不支持。',
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
