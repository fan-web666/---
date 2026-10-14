// pages/member/member.js - 会员中心（蓝湖稿 07membership）
// 业务逻辑复用 Pixso 版（utils/api、utils/auth、config/*、云函数 action 名不变）
const pricing = require('../../config/pricing');
const config = require('../../config/index');
const { refreshUser } = require('../../utils/auth');
const { call, handleError } = require('../../utils/api');
const { toast, membershipInfo } = require('../../utils/util');
const tracker = require('../../utils/tracker');

const app = getApp();

// 虚拟支付就绪开关（与充值页一致，读同一个 config 字段）
const PAY_READY = !!(config.pay && config.pay.enabled);

/** 取一个新鲜登录 code（服务端换会话密钥用，避开 -15007 会话过期） */
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

/* ---------- 档位视图模型 ----------
 * 价格统一从 pricing.MEMBER_PLANS 取（单一来源，改价只改 config + 云端 consts）；
 * 卡面文案按设计稿（设计稿写的是「¥9.9 / 月」这种带单位的样式，故拆成 priceText + unit）。 */
const planOf = (id) => pricing.MEMBER_PLANS.find((p) => p.id === id) || {};

// '¥19.9 / 月' → '¥19.9'
const priceOnly = (id) => String(planOf(id).priceText || '').split('/')[0].trim();

// 支付按钮里的档位简称（设计稿按钮宽 340rpx，文案要短）
const SHORT = {
  vip_month: '月卡',
  vip_quarter: '季卡',
  vip_year: '年卡',
  vip_unlimited: '不限次',
};

const PLANS = {
  month: { id: 'vip_month', tag: '轻量使用', unit: '/ 月', line1: '每月 60 次', line2: '未用完可结转' },
  year: { id: 'vip_year', tag: '推荐', unit: '/ 年', line1: '720 次额度', line2: '平均 ¥5.7 / 月' },
  quarter: { id: 'vip_quarter', name: '季度会员', line1: '180 次额度', line2: '平均 ¥8.3 / 月' },
  unlimited: { id: 'vip_unlimited', name: '不限次会员', line1: '30 天不限次', line2: '不扣积分' },
};

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    // 导航行右侧安全边距 rpx（避让微信胶囊，app.js 按真机算好；196 为兜底）
    navSafeRightRpx: 196,

    // 头卡（.group_1）文案：非会员 = 设计稿原话；会员 = 额度状态
    heroTag: '高频用户更划算',
    heroTitle: '每次灵感，都能及时收藏',
    heroSub: '会员额度内提取不扣积分',

    // 4 档（设计稿 3 档 + 用户要求补的年卡）
    planMonth: {},
    planYear: {},
    planQuarter: {},
    planUnlimited: {},
    selectedPlan: 'vip_year',

    isMember: false,
    // 设计稿 .text_28：「开通 ¥68 · 年卡」/ 会员时「一键续费 ¥68 · 年卡」
    payText: '开通 ¥68 · 年卡',

    // x-dialog 说明弹窗的统一状态（2026-09-27：替代原生 wx.showModal —— 原生正文对齐不可控）
    dlg: { show: false, title: '', content: '', confirmText: '知道了', cancelText: '', showCancel: false },
  },

  onLoad(options) {
    this.buildPlans();
    if (options && options.plan && planOf(options.plan).id) {
      this.setData({ selectedPlan: options.plan });
    }
    this.setData({
      statusBarH: app.globalData.navStatusH || 0,
      navSafeRightRpx: app.globalData.navSafeRightRpx || 196,
    });
    this.syncPayText();
    this.applyMember(app.globalData.user);
  },

  onShow() {
    this.applyMember(app.globalData.user);
    this.refresh();
  },

  /* ---------- 档位 ---------- */

  buildPlans() {
    const withPrice = (p) => Object.assign({}, p, { priceText: priceOnly(p.id) });
    this.setData({
      planMonth: withPrice(PLANS.month),
      planYear: withPrice(PLANS.year),
      planQuarter: withPrice(PLANS.quarter),
      planUnlimited: withPrice(PLANS.unlimited),
    });
  },

  pickPlan(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || id === this.data.selectedPlan) return;
    this.setData({ selectedPlan: id });
    this.syncPayText();
    tracker.track('member_pick_plan', { plan: id });
  },

  syncPayText() {
    const plan = planOf(this.data.selectedPlan);
    if (!plan.id) return;
    const short = SHORT[plan.id] || plan.name;
    this.setData({
      payText: (this.data.isMember ? '一键续费 ' : '开通 ') + plan.priceText + ' · ' + short,
    });
  },

  /* ---------- 用户态 ---------- */

  async refresh() {
    if (!app.globalData.cloudReady) return;
    try {
      const user = await refreshUser();
      if (!user) return;
      this.applyMember(user);
    } catch (e) {
      // Background failure keeps the existing member view.
    }
  },
  applyMember(user) {
      if (!user) return;
      // ⚠️ 2026-09-29 修复：原实现读 `user.member.{active, expire_at, quota_total, used}` ——
      //    云端从不返回该形状（`userCenterSummary()` 给的是 `membership.{tier,status,expires_at,quota}`）
      //    → 买了会员本页仍停在拉新态。现统一走 `membershipInfo()`（utils/util.js 唯一实现）。
      const mem = membershipInfo(user);
      const isMember = mem.active;
      const plan = planOf(this.data.selectedPlan);

      // 节点不变，只换文案（设计稿画的是拉新态，会员态换成额度展示）
      this.setData(
        {
          isMember,
          payText: (isMember ? '一键续费 ' : '开通 ') + plan.priceText + ' · ' + (SHORT[plan.id] || plan.name),
          heroTag: isMember ? '会员生效中' : '高频用户更划算',
          heroTitle: isMember
            ? mem.tierText + ' · ' + (mem.daysText || '生效中')
            : '每次灵感，都能及时收藏',
          // 不限次档的 quota 是 null（与「未开通」同为 null）→ 必须靠 mem.unlimited 区分
          heroSub: isMember
            ? mem.unlimited
              ? '不限次提取，额度内不扣积分'
              : '剩余 ' + mem.remaining + ' / ' + mem.total + ' 次额度'
            : '会员额度内提取不扣积分',
        }
      );
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

  /* ---------- 说明 ---------- */

  showRules() {
    const quota = (pricing.QUOTA_RULES || []).map((r) => r.label + '：' + r.value).join('\n');
    const plans = (pricing.MEMBER_PLANS || [])
      .map((p) => p.name + ' ' + p.priceText + '（' + p.meta + '）')
      .join('\n');
    // 2026-09-27：原生 wx.showModal → 自建 x-dialog（正文强制左对齐）
    this.openDialog({
      title: '会员说明',
      content: '档位：\n' + plans + '\n\n规则：\n' + quota,
      confirmText: '知道了',
    });
  },

  /* ---------- 支付 ---------- */

  async pay() {
    const plan = planOf(this.data.selectedPlan);
    if (!plan.id) return;

    if (!app.globalData.cloudReady) {
      return toast('云环境未配置，暂时无法支付');
    }

    if (!PAY_READY) {
      // 2026-09-27：原生 wx.showModal → 自建 x-dialog（正文强制左对齐）
      this.openDialog({
        title: '支付功能开发中',
        content:
          '会员属于虚拟商品，微信要求只能走「小程序虚拟支付」通道，目前正在接入中。' +
          '开通后可在此直接开通会员，权益立即生效。',
        confirmText: '知道了',
      });
      return;
    }

    tracker.track('member_pay_start', { plan: plan.id });

    let order = null;
    try {
      wx.showLoading({ title: '下单中', mask: true });
      const code = await loginCode();
      order = await call('createMemberOrder', { plan_id: plan.id, code });
      wx.hideLoading();
    } catch (e) {
      wx.hideLoading();
      return handleError(e, '下单失败，请稍后重试');
    }

    // 会员走**道具模式**：后台「道具管理」里的 4 个道具 id 必须与 plan.id 一致、价格一致
    wx.requestVirtualPayment({
      signData: order.signData,
      paySig: order.paySig,
      signature: order.signature,
      mode: order.mode || 'short_series_goods',
      success: () => {
        tracker.track('member_pay_success', { plan: plan.id });
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
   * 权益确认
   * ⭐ 同充值页：端上 success 只当作「去问服务端」的信号，实际开通由服务端查单确认后执行。
   */
  async confirmArrival(order) {
    wx.showLoading({ title: '确认开通中', mask: true });
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
    wx.hideLoading();

    if (delivered) {
      toast('开通成功', 'success');
    } else {
      wx.showModal({
        title: '支付结果确认中',
        content: '已收到你的支付，会员权益正在开通。若稍后仍未生效，退出小程序重新进入即可。',
        showCancel: false,
        confirmText: '知道了',
      });
    }
    this.refresh();
    require('../../utils/dashboard').refresh(true);
  },

  /* ---------- 导航 ---------- */

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  goRecharge() {
    wx.navigateTo({ url: '/pages/recharge/recharge' });
  },

  onShareAppMessage() {
    return { title: '把视频里的好文案，变成你的素材库，支持视频提取', path: '/pages/index/index' };
  },
});
