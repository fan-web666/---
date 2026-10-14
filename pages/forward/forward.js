// pages/forward/forward.js - 使用说明页（引导页 · 蓝湖稿 02serviceaccount）
// ⚠️ 2026-09-28：原「转发给服务号」链路已停用（微信「转发给朋友」列表不出现公众号/服务号）→
//    本页由「转发引导」改为**通用使用说明**：
//      · 视觉与结构**一个像素没动**，只替换文字（见 forward.wxml）；
//      · 主按钮由「去转发一条视频」改为「回首页开始提取」（`goHome`）；
//      · 旧函数 `openAccount` / `guideByName` / `copyAccount`（服务号相关）**保留不删**，
//        统一标注「已停用 · 留档」，避免误删将来要复用的降级逻辑。
const config = require('../../config/index');
const pricing = require('../../config/pricing');
const { toast } = require('../../utils/util');
const tracker = require('../../utils/tracker');

const app = getApp();

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    // 导航行右侧安全边距 rpx（避让微信胶囊，app.js 按真机算好；196 为兜底）
    navSafeRightRpx: 196,

    // ⚠️ 2026-09-28：页面正文已不再展示服务号名称（原「选择「xxx」」文案已换），
    //    保留 data 仅供下方「已停用」的降级逻辑兜底使用。
    accountName: config.serviceAccountName,

    // 「新人专享 N 积分」由定价表算，不写死数字
    // ⚠️ 2026-09-28 用户纠正：**不能说「第一次」**（那是新人权限，不是"首次行为"）；
    //    单位是**积分**不是「条视频」——原写法 50 积分 ÷ 最短档 5 分/条 ≈ 10 条，
    //    按"条数"承诺会把长视频用户坑了（10~30min 要扣 10 分，实际只能提 5 条）。
    trialCredit: pricing.TRIAL_CREDIT,

    // 视频教程（2026-10-12 新增，超出设计稿）
    // ⚠️ 视频存云存储（主包 ≤2MB 放不下 8MB 视频），fileID 配在 config/index.js
    // ⚠️ 未配置（空串）→ hasGuideVideo=false → 入口整块不渲染，绝不出现「点了没反应」的坏入口
    guideVideoFileId: String(config.guideVideoFileId || ''),
    hasGuideVideo: !!config.guideVideoFileId,
    videoShow: false,

    // x-dialog 说明弹窗的统一状态（2026-09-27：替代原生 wx.showModal —— 原生正文对齐不可控）
    dlg: { show: false, title: '', content: '', confirmText: '知道了', cancelText: '', showCancel: false },
  },

  onLoad() {
    this.setData({
      statusBarH: app.globalData.navStatusH || 0,
      navSafeRightRpx: app.globalData.navSafeRightRpx || 196,
    });
    tracker.track('forward_view');
  },

  /* ---------- 导航 ---------- */

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  /* ---------- 通用说明弹窗（x-dialog） ----------
   * 2026-09-27：原生 wx.showModal 的正文对齐由系统决定（**API 无对齐参数**，
   * Android 居中 / iOS 偏左 / 开发者工具又不同）→ 改用自建 <x-dialog>，正文统一左对齐。
   * 用法：this.openDialog({ title, content, confirmText, cancelText, showCancel }, onConfirm?)
   * ⚠️ 确认回调存在实例属性 _dlgConfirm 上（**不进 data**，避免无意义渲染）。 */

  openDialog(opts, onConfirm) {
    this._dlgConfirm = typeof onConfirm === 'function' ? onConfirm : null;
    this.setData({
      'dlg.show': true,
      'dlg.title': opts.title || '',
      'dlg.content': opts.content || '',
      'dlg.confirmText': opts.confirmText || '知道了',
      'dlg.cancelText': opts.cancelText || '',
      'dlg.showCancel': !!opts.showCancel,
    });
  },

  closeDialog() {
    this._dlgConfirm = null;
    this.setData({ 'dlg.show': false });
  },

  onDialogConfirm() {
    const cb = this._dlgConfirm;
    this._dlgConfirm = null;
    this.setData({ 'dlg.show': false });
    if (cb) cb();
  },

  onDialogCancel() {
    this._dlgConfirm = null;
    this.setData({ 'dlg.show': false });
  },

  /* ---------- 使用帮助（导航右侧 text_5） ----------
   * 2026-09-28：文案改「转发给服务号」→ 真实可用流程（复制链接 → 首页粘贴 → 立即提取）。
   * ⚠️ 步骤里**不点明「导入本地视频」这个入口名** —— 首页那张合并卡已写得很清楚，
   *    这里再教一遍属于重复（用户 2026-09-28 明确要求）。 */

  showHelp() {
    this.openDialog({
      title: '怎么用',
      content:
        '① 打开那条视频，点「转发」（抖音叫「分享」），在弹出面板最下方一行选「复制链接」；\n' +
        '② 回到小程序首页，把链接粘进输入框（点「粘贴」按钮可一键填入）；\n' +
        '③ 点「立即提取」，稍等片刻出结果；\n' +
        '④ 结果可复制、可编辑，自动存进历史记录。',
      confirmText: '知道了',
      cancelText: '',
      showCancel: false,
    });
  },

  /* ---------- 视频教程（2026-10-12 新增，超出设计稿） ----------
   * 文字三步看不明白 → 点开看一遍完整操作演示，并支持下载到相册。
   * ⚠️ 入口只在 config.guideVideoFileId 配好后才渲染（hasGuideVideo）——不出现坏入口。
   * 播放/下载/授权全在 <x-video-dialog> 内自理，本页只负责开关。 */

  openGuideVideo() {
    tracker.track('guide_video_open');
    this.setData({ videoShow: true });
  },

  closeGuideVideo() {
    this.setData({ videoShow: false });
  },

  /* ---------- 回首页（主按钮 text-wrapper_9） ----------
   * 2026-09-28：原 `openAccount()`（打开服务号主页 + 复制名称降级）随链路停用一并下线。
   * 首页才是两个**真实可用**入口的所在（粘贴链接 / 导入本地视频）—— 直接回去即可。
   * ⚠️ 页面栈只有本页时 navigateBack 会失败 → 回落 reLaunch，避免「点了没反应」。 */

  goHome() {
    tracker.track('guide_go_home');
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  /* ============================================================
   * 以下为「转发给服务号」链路的遗留代码（2026-09-28 停用）
   * ⚠️ **保留不删**（遵循项目「只做局部修改、不回退不删除」铁律）：
   *    `openAccount` / `guideByName` / `copyAccount` / onShareAppMessage 里的旧标题。
   *    相应地 `toast`、`config.serviceAccountName` / `serviceAccountGzhId` 仍被引用，
   *    require 与 data 不可删。
   *    将来若该链路重启（例如企业微信形态），这三个函数可直接复用。
   * ============================================================ */

  /** @deprecated 2026-09-28 停用：直接打开服务号主页
   * 需要：① 基础库 ≥ 3.7.10；② 服务号与小程序同主体或已建立关联；③ 公众号原始 ID。 */
  openAccount() {
    const name = this.data.accountName;
    const gzhId = config.serviceAccountGzhId;

    if (gzhId && wx.openOfficialAccountProfile) {
      tracker.track('forward_open_account', { mode: 'profile' });
      wx.openOfficialAccountProfile({
        username: gzhId,
        fail: () => this.guideByName(name),
      });
      return;
    }
    this.guideByName(name);
  },

  /** @deprecated 2026-09-28 停用：降级为「复制名称 + 微信搜一搜」引导 */
  guideByName(name) {
    tracker.track('forward_open_account', { mode: 'guide' });
    this.openDialog(
      {
        title: name,
        content:
          '在微信「搜一搜」里搜索该服务号并关注，之后在视频号点「分享 → 转发给朋友」选它，文案会自动回传。',
        confirmText: '复制名称',
        cancelText: '知道了',
        showCancel: true,
      },
      () => this.copyAccount()
    );
  },

  /** @deprecated 2026-09-28 停用：复制服务号名称 */
  copyAccount() {
    const name = this.data.accountName;
    wx.setClipboardData({
      data: name,
      success: () => toast('已复制服务号名称', 'success'),
    });
  },

  onShareAppMessage() {
    return {
      title: '视频文案提取，三步搞定',
      path: '/pages/forward/forward',
    };
  },

  /**
   * 分享到朋友圈。⚠️ 必须与 onShareAppMessage **同时存在**，朋友圈按钮才会亮（缺一则灰）。
   * 差异：无 path（只能分享当前页），用 query 传参；imageUrl 为 1:1。
   */
  onShareTimeline() {
    return {
      title: '视频文案提取，三步搞定',
    };
  },
});
