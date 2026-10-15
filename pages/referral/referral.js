const { call, handleError } = require('../../utils/api');
const { toast } = require('../../utils/util');
const app = getApp();
const cache = require('../../utils/view-cache');
Page({
  data: { statusBarH: 0, navBarH: 44, navSafeRightRpx: 196, code: '', invitedCount: '—', rewardTotal: '—', loading: true, error: '', posterBusy: false, nickname: '', ...(cache.read('referral') || {}) },
  onLoad() { const c=cache.read('referral'); cache.patch(this,c||{code:'',invitedCount:'—',rewardTotal:'—',loading:true,error:''});this._cached=!!c;this._owner=cache.uid();this.setData({ statusBarH: app.globalData.navStatusH || 0, navBarH: app.globalData.navBarH || 44, navSafeRightRpx: app.globalData.navSafeRightRpx || 196 }); wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] }); },
  onShow() { this.syncNickname(); this.load(); },
  async load() { if (this._loading) return; this._loading = true; if(!this._cached)this.setData({ loading: true, error: '' }); try { const s = await call('referralSummary'); if(this._disposed||cache.uid()!==this._owner)return;const p={ code:s.code,invitedCount:s.invitedCount,rewardTotal:s.rewardTotal,loading:false,error:'' };cache.patch(this,p);cache.write('referral',p);this._cached=true; } catch (e) { if(!this._cached&&!this._disposed)this.setData({ error:e.message||'加载失败' }); } finally { this._loading=false;if(!this._disposed)cache.patch(this,{loading:false}); } },
  onUnload() { this._disposed=true; },
  goBack() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({ url: '/pages/index/index' }); },
  /**
   * 取当前昵称，用于邀请页「署名」（2026-10-14）
   * 目的：**给昵称一个用处** —— 邀请场景是用户有动机做的事（得积分），署名需要昵称，动机自然成立。
   * ⚠️ 昵称设置率天然很低（微信 2.27.1 起只能用户主动设置），所以这里**只读本地、不请求云端**：
   *    本地缓存优先 → globalData 兜底；都没有就显示「去设置」引导。
   */
  syncNickname() {
    try {
      const c = wx.getStorageSync('user_profile') || {};
      const u = app.globalData.user || {};
      const n = String(c.nickname || u.nickname || '').trim();
      if (n !== this.data.nickname) this.setData({ nickname: n });
    } catch (e) { /* 拿不到就不显示署名，不影响邀请主流程 */ }
  },
  /** 去「我的」页设置昵称（无 tabBar 配置，照 index.js#goMine 用 reLaunch） */
  goSetProfile() { wx.reLaunch({ url: '/pages/mine/mine' }); },
  copyCode() { if (!this.data.code) return toast('推荐码尚未加载，请稍后重试'); wx.setClipboardData({ data: this.data.code }); },
  onShareAppMessage() { return { title: '视频一键转文案，整理你的灵感素材库', path: '/pages/index/index' + (this.data.code ? '?ref=' + encodeURIComponent(this.data.code) : '') }; },
  // 分享到朋友圈：无 path，邀请码只能走 query；与 onShareAppMessage 并存才点亮按钮
  onShareTimeline() { return { title: '视频一键转文案，整理你的灵感素材库', query: this.data.code ? 'ref=' + encodeURIComponent(this.data.code) : '' }; },
  async createPoster() {
    if (!this.data.code || this.data.posterBusy) return;
    this.setData({ posterBusy: true }); wx.showLoading({ title: '正在生成海报', mask: true });
    try {
      const r = await call('referralPosterCode');
      const downloaded = await wx.cloud.downloadFile({ fileID: r.fileID });
      const file = downloaded.tempFilePath;
      const canvas = await new Promise((resolve, reject) => this.createSelectorQuery().select('#referralPoster').fields({ node: true, size: true }).exec(x => x[0] && x[0].node ? resolve(x[0].node) : reject(new Error('当前微信版本不支持海报，请升级后重试'))));
      canvas.width = 1080; canvas.height = 1440;
      const ctx = canvas.getContext('2d');
      const codeImage = canvas.createImage(); await new Promise((resolve, reject) => { codeImage.onload = resolve; codeImage.onerror = reject; codeImage.src = file; });
      const bg = ctx.createLinearGradient(0, 0, 1080, 1440); bg.addColorStop(0, '#FFFFFF'); bg.addColorStop(1, '#E8FAEF'); ctx.fillStyle = bg; ctx.fillRect(0, 0, 1080, 1440);
      ctx.fillStyle = '#1B2620'; ctx.font = 'bold 38px sans-serif'; ctx.fillText('予行 · 文案快提', 86, 122);
      ctx.font = 'bold 76px sans-serif'; ctx.fillText('把视频里的好文案', 86, 300); ctx.fillStyle = '#16854A'; ctx.fillText('收进你的素材库', 86, 408);
      ctx.fillStyle = '#79817D'; ctx.font = '30px sans-serif'; ctx.fillText('无广告 · 快速提取 · 结构化整理', 86, 496);
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(86, 576, 908, 744);
      ctx.drawImage(codeImage, 325, 618, 430, 430);
      ctx.textAlign = 'center'; ctx.fillStyle = '#16854A'; ctx.font = 'bold 34px sans-serif'; ctx.fillText('微信扫码，开始提取', 540, 1110);
      ctx.fillStyle = '#1B2620'; ctx.font = 'bold 30px sans-serif'; ctx.fillText('专属推荐码 ' + r.code, 540, 1182);
      ctx.fillStyle = '#79817D'; ctx.font = '25px sans-serif'; ctx.fillText('首次进入自动绑定推荐来源', 540, 1240);
      const output = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, fileType: 'png', success: resolve, fail: reject }, this));
      wx.hideLoading(); wx.previewImage({ current: output.tempFilePath, urls: [output.tempFilePath] });
    } catch (e) { handleError(e, '生成海报失败，请稍后重试'); } finally { wx.hideLoading(); this.setData({ posterBusy: false }); }
  },
});
