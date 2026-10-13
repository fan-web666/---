const community = require('../../config/community');
const app = getApp();
Page({
  data: {
    statusBarH: 0,
    navSafeRightRpx: 196,
    qrImage: community.qrImage,
    expiresLabel: community.expiresLabel,
    qrExpired: false,
    saving: false,
    benefits: [
      { title: '积分活动', description: '活动通知与积分发放', icon: 'coins' },
      { title: '优惠通知', description: '优惠消息抢先知', icon: 'gift' },
      { title: '功能共创', description: '反馈需求与使用体验', icon: 'guide' },
      { title: '优先体验', description: '参与新功能优先体验', icon: 'video' },
    ],
  },
  onLoad() {
    this._gone = false;
    this.setData({ statusBarH: app.globalData.navStatusH || 0, navSafeRightRpx: app.globalData.navSafeRightRpx || 196 });
  },
  onShow() { this.setData({ qrExpired: Date.now() >= Date.parse(community.expiresAt) }); },
  onUnload() { this._gone = true; },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/mine/mine' });
  },
  previewQr() {
    wx.previewImage({ current: this.data.qrImage, urls: [this.data.qrImage] });
  },
  async saveQr() {
    if (this.data.saving || this.data.qrExpired) return;
    this.setData({ saving: true });
    try {
      // 相册 API 需要实际本地路径，先解析包内图片；保存完整原图，保留二维码静区。
      const image = await new Promise((resolve, reject) => wx.getImageInfo({ src: this.data.qrImage, success: resolve, fail: reject }));
      if (this._gone) return;
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: image.path, success: resolve, fail: reject }));
      if (!this._gone) wx.showToast({ title: '已保存，可用微信识别入群', icon: 'none' });
    } catch (e) {
      if (this._gone) return;
      const message = String(e && e.errMsg || e && e.message || '');
      if (/auth deny|authorize|permission|权限/i.test(message)) {
        wx.showModal({ title: '需要相册保存权限', content: '开启后即可保存群二维码，也可以点击二维码放大查看。', confirmText: '去设置', success: res => {
          if (res.confirm && !this._gone) wx.openSetting({ success: settings => {
            if (!this._gone && settings.authSetting && settings.authSetting['scope.writePhotosAlbum']) wx.showToast({ title: '已开启，请再次点击保存', icon: 'none' });
          } });
        } });
      } else if (!/cancel/i.test(message)) {
        wx.showToast({ title: '保存失败，请点击二维码放大查看', icon: 'none' });
      }
    } finally {
      if (!this._gone) this.setData({ saving: false });
    }
  },
});
