// pages/loading/loading.js - 提取中（本页只是「全局提取会话」的视图）
/* ⚠️⚠️ 状态机（轮询 / 平滑推帧 / 终态）**不在这里**，在 utils/extract-session.js ——
   因为用户可以从这里返回首页，任务必须继续跑（2026-09-28 需求）。
   本页职责只有三件：① 订阅会话把状态画出来；② 完成时跳结果页；③ 取消 / 返回首页。

   进度环配色（新稿 token：底环 --line、进度环 --brand） */
const sess = require('../../utils/extract-session');
const videoSession = require('../../utils/video-session');
const { toast } = require('../../utils/util');

const app = getApp();

const RING_TRACK = '#E8FAEF';
const RING_BAR = '#16854A';

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    navSafeRightRpx: 196,

    title: '',
    headSub: '',

    // 封面：本地视频 = 选片缩略图（即时）；链接视频 = 平台封面（轮询回传）。
    // 都没有才回落深色底 + ▶ 占位。
    cover: '',

    percent: 0,
    statusLabel: '解析中',
    stateTitle: '正在提取视频文案…',
    stateSub: '请勿退出，稍后自动跳转',

    steps: [],
    bothMode: false,
  },

  onLoad(options) {
    this._redirected = false;
    this._percent = 0;

    this.setData({ statusBarH: app.globalData.navStatusH || 0, navSafeRightRpx: app.globalData.navSafeRightRpx || 196 });

    // 登记「我在看进度」→ 终态弹窗 / 提示由本页或会话择一负责，不会双重弹
    sess.setViewer('loading', true);
    this._unsub = sess.subscribe((snap) => this.applySession(snap));
    this._videoUnsub = videoSession.subscribe(s => this.setData({ bothMode: s.mode === 'both' && s.phase !== 'idle' }));
    this.initCanvas();

    // ⚠️ 正常情况下**没有参数**：任务已由首页 sess.start() 发起，本页只是接管展示。
    //    （旧版是 loading 页自己接 url / mode 参数发起任务；改成会话后参数不再需要，
    //     保留 url 分支只为兼容「首页尚未更新完成」的中间态。）
    const params = options || {};
    if (params.mode === 'local' || params.url) {
      sess.start({
        mode: params.mode === 'local' ? 'local' : 'link',
        url: params.url ? decodeURIComponent(params.url) : '',
      });
      return;
    }
    if (sess.phase() === 'idle') {
      toast('当前没有进行中的提取');
      setTimeout(() => this.backHome(), 800);
    }
  },

  onUnload() {
    if (this._videoUnsub) this._videoUnsub();
    sess.setViewer('loading', false);
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
  },

  /* ---------- 会话 → 视图 ---------- */

  applySession(snap) {
    const patch = {};
    const simple = ['title', 'headSub', 'cover', 'statusLabel', 'stateTitle', 'stateSub'];
    simple.forEach((k) => {
      if (this.data[k] !== snap[k]) patch[k] = snap[k];
    });
    // 进度环是 canvas，重绘不需要过 setData；数字才需要
    this._percent = snap.percent;
    if (this.data.percent !== snap.percent) {
      patch.percent = snap.percent;
      this.drawRing(snap.percent);
    }
    if (JSON.stringify(this.data.steps) !== JSON.stringify(snap.steps)) patch.steps = snap.steps;
    if (Object.keys(patch).length) this.setData(patch);

    if (snap.phase === 'done' && !this._redirected) {
      this._redirected = true;
      const id = snap.resultId;
      setTimeout(() => {
        sess.reset(); // 结果页自带 id，会话可以收尾（首页按钮随之回到「立即提取」）
        wx.redirectTo({ url: id ? '/pages/result/result?id=' + id : '/pages/result/result' });
      }, 500);
    }
  },

  /* ---------- 进度环绘制 ---------- */

  initCanvas() {
    const query = wx.createSelectorQuery();
    query
      .select('#ringCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;
        const w = res[0].width;
        const h = res[0].height;

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        this.canvas = canvas;
        this.ctx = ctx;
        this.cw = w;
        this.ch = h;

        this.drawRing(Math.round(this._percent || 0));
      });
  },

  drawRing(percent) {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.cw;
    const h = this.ch;
    const cx = w / 2;
    const cy = h / 2;
    // 环几何随画布自适应：半径 = 0.9 × 半边长，环宽 = 0.1 × 半边长
    const base = Math.min(cx, cy);
    const lineW = base * 0.1;
    const r = base * 0.9;

    ctx.clearRect(0, 0, w, h);

    // 底环
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = lineW;
    ctx.strokeStyle = RING_TRACK;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 进度环（圆头，自 12 点顺时针）
    if (percent > 0) {
      const start = -Math.PI / 2;
      const end = start + (Math.PI * 2 * Math.min(percent, 100)) / 100;
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, end);
      ctx.lineWidth = lineW;
      ctx.strokeStyle = RING_BAR;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  },

  /* ---------- 操作 ---------- */

  /** 返回首页：⚠️ 只关页面，**不取消任务** —— 会话在后台接着跑，首页按钮显示进度 */
  backHome() {
    const pages = getCurrentPages ? getCurrentPages() : [];
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  cancel() {
    wx.showModal({
      title: this.data.bothMode ? '取消文案提取' : '取消提取',
      content: this.data.bothMode ? '仅取消文案提取，文案消耗按现有规则退回；视频提取和保存仍会继续，视频单独计费。' : '已消耗的积分会在取消后自动退回，确定取消？',
      confirmText: this.data.bothMode ? '取消文案' : '取消提取',
      cancelText: '继续等待',
      confirmColor: '#E5484D',
      success: (r) => {
        if (!r.confirm) return;
        sess.cancel();
        this.backHome();
      },
    });
  },
});
