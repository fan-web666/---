const pricing = require('../../config/pricing');
Page({
  data: { statusBarH: 0, navSafeRightRpx: 196, basic: pricing.CREDIT_BASIC, long: pricing.CREDIT_DOUBLE,
    bothBasic: pricing.CREDIT_BASIC * 2, bothLong: pricing.CREDIT_DOUBLE * 2, longDurationLabel: '超过10分钟' },
  onLoad() { const g = getApp().globalData; this.setData({ statusBarH: g.navStatusH || 0, navSafeRightRpx: g.navSafeRightRpx || 196 }); },
  goBack() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({ url: '/pages/index/index' }); },
});
