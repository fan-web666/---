const uiFeedback = require('../../utils/feedback');
// pages/recharge/recharge.js - 充值积分（蓝湖稿 06recharge）
// 业务逻辑复用 Pixso 版（utils/api、utils/auth、config/*、云函数 action 名不变）
const pricing = require('../../config/pricing');
const config = require('../../config/index');
const { refreshUser, localUid } = require('../../utils/auth');
const { call, handleError } = require('../../utils/api');
const { toast, thousands } = require('../../utils/util');
const tracker = require('../../utils/tracker');

const app = getApp();

// 虚拟支付是否已就绪（config/index.js 的 pay.enabled，前置条件见那里的注释）
const PAY_READY = !!(config.pay && config.pay.enabled);

/* ---------- 首帧缓存：余额（2026-10-15） ----------
   用户：「进入各个页面的时候，界面的呈现都是稳定的状态」。
   ⚠️ 本页原先把余额写死在 data（`balance: 0, balanceText: '—'`）→ 冷启动时 globalData.user
      尚未恢复，`applyBalance` 直接 return → 首帧必是占位符，等 `refreshBalance()` 往返后才跳成真值。
   做法与首页 VIP 栏一致：把上次的渲染结果同步落本地，data 初值直接取缓存。
   归属判定用 `auth.localUid()`（内存态未就绪时回落本地快照）。 */
const BALANCE_CACHE_KEY = 'recharge_balance';

function readBalanceCache() {
  try {
    const c = wx.getStorageSync(BALANCE_CACHE_KEY);
    const uid = localUid();
    if (uid && c && typeof c === 'object' && c.uid === uid && typeof c.balance === 'number') return c;
  } catch (e) { /* 读失败 → 走默认空态 */ }
  return {};
}

function writeBalanceCache(patch) {
  try {
    const uid = localUid();
    if (!uid) return;
    wx.setStorageSync(BALANCE_CACHE_KEY, Object.assign({}, patch, { uid }));
  } catch (e) { /* 写失败不影响主流程 */ }
}

const CACHED_BALANCE = readBalanceCache();

/**
 * 取一个新鲜登录 code
 * ⭐ 下单前现取：服务端用它换会话密钥（虚拟支付的用户态签名 signature 要用），
 *    现换的密钥一定没过期，能避开 -15007「会话已过期」。
 */
function loginCode() {
  return new Promise((resolve) => {
    wx.login({
      success: (res) => resolve((res && res.code) || ''),
      fail: () => resolve(''),
    });
  });
}

/** 等待 n 毫秒（到账确认轮询用） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 设计稿 6 档分 3 行 2 列 → 切成二维数组供 wx:for 双层循环
const toRows = (list, cols) => {
  const rows = [];
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols));
  return rows;
};

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    // 导航行右侧安全边距 rpx（避让微信胶囊，app.js 按真机算好；196 为兜底）
    navSafeRightRpx: 196,

    // ⚠️ 初值取上次已知值缓存（见文件上方说明），**不写死 0 / '—'** —— 否则冷启动首帧必闪
    balance: CACHED_BALANCE.balance || 0,
    balanceText: CACHED_BALANCE.balanceText || '—',

    // 设计稿 .text_6「1 元 = N 积分」（N 取 pricing.CREDIT_PER_YUAN，现为 30）
    rate: pricing.CREDIT_PER_YUAN,

    // 设计稿 6 个金额档（3 行 × 2 列）
    presetRows: [],
    selectedAmount: pricing.RECHARGE_DEFAULT,

    customMin: pricing.CUSTOM_MIN,
    customMax: pricing.CUSTOM_MAX,
    customAmount: '',
    customCredits: 0,

    // 设计稿 .text-wrapper_13-1「短视频 ≤10 分钟仅扣 N 积分」
    basicCost: pricing.CREDIT_BASIC,

    payAmount: pricing.RECHARGE_DEFAULT,

    // x-dialog 说明弹窗的统一状态（2026-09-27：替代原生 wx.showModal —— 原生正文对齐不可控）
    dlg: { show: false, title: '', content: '', confirmText: '知道了', cancelText: '', showCancel: false },
  },

  onLoad() {
    this.applyBalance(app.globalData.user);
    this.setData({
      statusBarH: app.globalData.navStatusH || 0,
      navSafeRightRpx: app.globalData.navSafeRightRpx || 196,
    });
    this.buildRows(pricing.RECHARGE_DEFAULT);
  },

  onShow() {
    this.applyBalance(app.globalData.user);
    this.refreshBalance();
  },

  /* ---------- 档位渲染 ---------- */

  buildRows(selected) {
    // ⚠️ 外层循环必须给每行一个稳定 id：wx:key 不支持用索引变量名（写 wx:key="ri" 会失效并报警告）
    const rows = toRows(pricing.RECHARGE_PRESETS, 3).map((items, i) => ({
      id: 'row-' + i,
      items: items.map((p) => Object.assign({}, p, { selected: p.amount === selected })),
    }));
    this.setData({ presetRows: rows });
  },

  async refreshBalance() {
    if (!app.globalData.cloudReady) return;
    try {
      const user = await refreshUser();
      this.applyBalance(user);
    } catch (e) {
      // 静默：进页面自动加载，用户没主动操作
    }
  },
  applyBalance(user) {
    if (!user) return;
    const balance = (user.credits && user.credits.balance) || 0;
    const balanceText = thousands(balance);
    writeBalanceCache({ balance, balanceText }); // 写回缓存 → 下次进页面首帧即为正确值
    if (balance !== this.data.balance || balanceText !== this.data.balanceText) this.setData({ balance, balanceText });
  },

  /* ---------- 交互 ---------- */

  pickPreset(e) {
    const amount = Number(e.currentTarget.dataset.amount);
    this.buildRows(amount);
    this.setData({
      selectedAmount: amount,
      customAmount: '',
      customCredits: 0,
      payAmount: amount,
    });
    tracker.track('recharge_pick_preset', { amount });
  },

  onCustomInput(e) {
    const raw = e.detail.value || '';
    // 选自定义金额 → 6 档取消选中
    this.buildRows(0);
    this.setData({
      customAmount: raw,
      selectedAmount: 0,
      customCredits: Math.floor((Number(raw) || 0) * pricing.CREDIT_PER_YUAN),
      payAmount: Number(raw) || 0,
    });
  },

  onCustomBlur() {
    const v = Number(this.data.customAmount);
    if (!v) return;
    let fixed = 0;
    if (v < pricing.CUSTOM_MIN) fixed = pricing.CUSTOM_MIN;
    else if (v > pricing.CUSTOM_MAX) fixed = pricing.CUSTOM_MAX;
    if (!fixed) return;
    this.setData({
      customAmount: String(fixed),
      customCredits: fixed * pricing.CREDIT_PER_YUAN,
      payAmount: fixed,
    });
    toast(fixed === pricing.CUSTOM_MIN ? '最低 ' + fixed + ' 元' : '单次最高 ' + fixed + ' 元');
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

  /* ---------- 说明 / 协议 ---------- */

  showRules() {
    const rules = (pricing.CREDIT_RULES || [])
      .map((r) => r.duration + '：' + r.cost)
      .join('\n');
    // 2026-09-27：原生 wx.showModal → 自建 x-dialog（正文强制左对齐）
    this.openDialog({
      title: '充值规则',
      content:
        '1 元 = ' +
        pricing.CREDIT_PER_YUAN +
        ' 积分，充值后永久有效、不清零。\n\n提取扣费：\n' +
        rules +
        '\n\n新人首次建档赠送 ' +
        pricing.TRIAL_CREDIT +
        ' 积分。会员额度内的提取不扣积分。',
      confirmText: '知道了',
    });
  },

  showAgreement() {
    // 2026-09-27：原生 wx.showModal → 自建 x-dialog（正文强制左对齐）
    this.openDialog({
      title: '虚拟支付服务协议',
      content:
        '本服务为虚拟道具充值，积分用于小程序内的内容提取服务。积分一经充值不可转让；未使用部分可按平台规则申请退款。' +
        '当前小程序处于开发调试阶段，虚拟支付尚未开通，本页不会产生任何实际扣款。',
      confirmText: '知道了',
    });
  },

  /* ---------- 支付 ---------- */

  async pay() {
    const amount = Number(this.data.payAmount) || 0;

    if (amount < pricing.CUSTOM_MIN || amount > pricing.CUSTOM_MAX) {
      return toast('金额需在 ' + pricing.CUSTOM_MIN + '~' + pricing.CUSTOM_MAX + ' 元之间');
    }
    if (Math.abs(amount * 10 - Math.round(amount * 10)) > 1e-8) {
      return toast('充值金额请精确到 0.1 元，例如 1.2 元');
    }
    if (!app.globalData.cloudReady) {
      return toast('云环境未配置，暂时无法支付');
    }

    if (!PAY_READY) {
      // 未接入虚拟支付：给出明确提示，避免用户误解为已扣款
      // 2026-09-27：原生 wx.showModal → 自建 x-dialog（正文强制左对齐）
      this.openDialog({
        title: '支付功能开发中',
        content:
          '消费类与会员类属于虚拟商品，微信要求只能走「小程序虚拟支付」通道，目前正在接入中。' +
          '开通后可在此直接充值，积分实时到账。',
        confirmText: '知道了',
      });
      return;
    }

    // ⭐ 2026-10-15：调起微信支付**之前**，先让用户明确点头（与会员页同一套做法）。
    //    ⚠️ 微信在 wx.requestVirtualPayment 内部自带「支付中…」「微信支付」两个过渡提示，
    //       端上没有任何参数能关掉（详见 .workbuddy/memory/DETAIL-虚拟支付.md）。
    //       加这道确认，是让那两个提示**只出现在用户已明确授权之后**。
    const credits = Math.round(amount * pricing.CREDIT_PER_YUAN);
    this.openDialog(
      {
        title: '确认充值',
        content:
          '充值 ¥' + amount + '，获得 ' + credits + ' 积分\n\n' +
          '点「确认充值」后才会调起微信支付；在微信收银台完成付款前，不会扣款。',
        confirmText: '确认充值',
        cancelText: '再想想',
        showCancel: true,
      },
      () => this.startPay(amount)
    );
  },

  /**
   * 真正下单并调起微信支付
   * ⭐ **只允许由 pay() 的确认回调进入**：pay() 必须以"弹确认框"收尾，绝不能直接走到支付。
   *    重构时务必保持这个边界（回归测试会守着）。
   */
  async startPay(amount) {
    tracker.track('recharge_pay_start', { amount });

    // 下单：服务端生成 signData 并签名（端上只负责原样透传，避免签名与报文不一致）
    let order = null;
    try {
      uiFeedback.showLoading({ title: '下单中', mask: true });
      const code = await loginCode();
      order = await call('createRechargeOrder', { amount, code });
      uiFeedback.hideLoading();
    } catch (e) {
      uiFeedback.hideLoading();
      return handleError(e, '下单失败，请稍后重试');
    }

    // 拉起虚拟支付（充值走**代币模式**：任意金额都能下单，自定义金额才保得住）
    wx.requestVirtualPayment({
      signData: order.signData,
      paySig: order.paySig,
      signature: order.signature,
      mode: order.mode || 'short_series_coin',
      success: () => {
        tracker.track('recharge_pay_success', { amount });
        this.confirmArrival(order);
      },
      fail: (err) => {
        const msg = String((err && err.errMsg) || '');
        if (msg.indexOf('cancel') > -1) return; // 用户主动取消：静默
        if (err && err.errCode === -15007) {
          return toast('登录态已过期，请退出小程序重新进入后再试');
        }
        handleError(err, '支付失败，请稍后重试');
      },
    });
  },

  /**
   * 到账确认
   * ⭐ 端上的 success **不作为到账依据**：只把它当作「该去问一下服务端」的信号，
   *    由服务端查单确认后发货（幂等）。查单 + 微信推送两条通道，任一先到都会到账。
   */
  async confirmArrival(order) {
    uiFeedback.showLoading({ title: '确认到账中', mask: true });
    let delivered = false;
    try {
      for (let i = 0; i < 5 && !delivered; i++) {
        if (i) await sleep(900);
        const r = await call('confirmOrder', { order_id: order.orderId });
        delivered = !!(r && r.delivered);
        if (r && r.status === 'failed') break;
      }
    } catch (e) {
      // 确认失败不影响资金安全：微信推送通道仍会在后台补发货
    }
    uiFeedback.hideLoading();

    if (delivered) {
      toast('充值成功', 'success');
    } else {
      uiFeedback.showModal({
        title: '支付结果确认中',
        content: '已收到你的支付，积分正在到账。若稍后仍未更新，退出小程序重新进入即可。',
        showCancel: false,
        confirmText: '知道了',
      });
    }
    this.refreshBalance();
    require('../../utils/dashboard').refresh(true);
  },

  /* ---------- 导航 ---------- */

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' });
  },

  onShareAppMessage() {
    return { title: '把视频里的好文案，变成你的素材库，支持视频提取', path: '/pages/index/index' };
  },
});

