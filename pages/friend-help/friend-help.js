Page({
  data: { statusBarH: 0, navSafeRightRpx: 196 },
  onLoad() { const g = getApp().globalData; this.setData({ statusBarH: g.navStatusH || 0, navSafeRightRpx: g.navSafeRightRpx || 196 }); },
  goBack() { wx.navigateBack(); },
});
