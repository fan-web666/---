const uiFeedback = require('../../utils/feedback');
// pages/member/member.js - 会员中心（蓝湖稿 07membership）
// 业务逻辑复用 Pixso 版（utils/api、utils/auth、config/*、云函数 action 名不变）
const pricing = require('../../config/pricing');
const config = require('../../config/index');
const { refreshUser, localUid } = require('../../utils/auth');
const { call, handleError } = require('../../utils/api');
const { toast, membershipInfo } = require('../../utils/util');
const tracker = require('../../utils/tracker');

const app = getApp();

// 虚拟支付就绪开关（与充值页一致，读同一个 config 字段）
const PAY_READY = !!(config.pay && config.pay.enabled);

/* ---------- 首帧缓存：会员态（2026-10-15） ----------
   用户：「进入各个页面的时候，界面的呈现都是稳定的状态」。
   ⚠️ 本页头卡是「拉新文案 / 会员额度」两套完全不同的文案，原先写死拉新态 →
      冷启动时 globalData.user 尚未恢复，`applyMember` 直接 return → 首帧必显示"非会员"，
      云端回来后「非会员文案 → 会员文案」整块跳变，观感比占位符更突兀。
   做法：缓存上次的**渲染结果**（各文案字段），data 初值直接取缓存。
   归属判定用 `auth.localUid()`（内存态未就绪时回落本地快照）。 */
const MEMBER_CACHE_KEY = 'member_view';

function readMemberCache() {
  try {
    const c = wx.getStorageSync(MEMBER_CACHE_KEY);
    const uid = localUid();
    if (uid && c && typeof c === 'object' && c.uid === uid) return c;
  } catch (e) { /* 读失败 → 走默认拉新态 */ }
  return {};
}

function writeMemberCache(patch) {
  try {
    const uid = localUid();
    if (!uid) return;
    wx.setStorageSync(MEMBER_CACHE_KEY, Object.assign(readMemberCache(), patch, { uid }));
  } catch (e) { /* 写失败不影响主流程 */ }
}

const CACHED_MEMBER = readMemberCache();

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
// ⚠️ vip_unlimited 已下架（2026-10-15），故不再需要简称
const SHORT = {
  vip_month: '月卡',
  vip_quarter: '季卡',
  vip_year: '年卡',
};

/** 额度（积分）—— 一律从 pricing.MEMBER_PLANS 现取，不写死 */
const planQuota = (id) => Number(planOf(id).quotaTotal) || 0;
/** 额度折算的文案分钟数文本（现算：M = 积分 × 0.5） */
const planMinutes = (id) => pricing.minutesText(planOf(id).quotaTotal);

const PLANS = {
  // ⚠️ 2026-10-16 v5（单余额双显示）：
  //   ① 价格一分没动，只把额度改成「积分」—— 396 / 1000 / 2720（会员 1 元 = 40 积分）；
  //   ② 卡面第一行 = 积分额度，第二行 = 折算的文案分钟（现算）—— 两者是**同一笔钱的两种说法**；
  //   ③ 「结转」**有前提** —— 只有继续续费才生效，到期不续费一律清零，故月卡这行保留该前提；
  //   ④ 不限次档（¥19.9/月）**已下架**，卡面与档位映射都已移除。
  month: { id: 'vip_month', tag: '轻量使用', unit: '/ 月', line1: planQuota('vip_month') + ' 积分', line2: '≈ ' + planMinutes('vip_month') + ' 分钟 · 续费可结转' },
  year: { id: 'vip_year', tag: '推荐', unit: '/ 年', line1: planQuota('vip_year') + ' 积分', line2: '≈ ' + planMinutes('vip_year') + ' 分钟文案' },
  quarter: { id: 'vip_quarter', name: '季度会员', line1: planQuota('vip_quarter') + ' 积分', line2: '≈ ' + planMinutes('vip_quarter') + ' 分钟文案' },
};

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    // 导航行右侧安全边距 rpx（避让微信胶囊，app.js 按真机算好；196 为兜底）
    navSafeRightRpx: 196,

    // 头卡（.group_1）文案：非会员 = 设计稿原话；会员 = 额度状态
    // ⚠️ 初值取上次已知值缓存（见文件上方说明），**不写死拉新文案** —— 否则冷启动首帧必「先拉新、后会员」
    heroTag: CACHED_MEMBER.heroTag || '高频用户更划算',
    heroTitle: CACHED_MEMBER.heroTitle || '每次灵感，都能及时收藏',
    heroSub: CACHED_MEMBER.heroSub || '会员额度内提取不扣积分',

    // 3 档（设计稿 3 档 + 用户要求补的年卡；不限次档 2026-10-15 已下架）
    planMonth: {},
    planYear: {},
    planQuarter: {},
    selectedPlan: 'vip_year',

    isMember: !!CACHED_MEMBER.isMember,
    // 设计稿 .text_28：「开通 ¥68 · 年卡」/ 会员时「一键续费 ¥68 · 年卡」
    //（onLoad 的 syncPayText 会按当前档位重算，缓存只负责首帧不跳变）
    payText: CACHED_MEMBER.payText || '开通 ¥68 · 年卡',

    // x-dialog 说明弹窗的统一状态（2026-09-27：替代原生 wx.showModal —— 原生正文对齐不可控）
    dlg: { show: false, title: '', content: '', confirmText: '知道了', cancelText: '', showCancel: false },
  },

  onLoad(options) {
    this.buildPlans();
    if (options && options.plan && planOf(options.plan).id) {
      // ⚠️ 只接受**在售档位**（vip_unlimited 已下架，历史卡片/链接可能还带着它）
      if (pricing.MEMBER_PLANS.some((p) => p.id === options.plan)) this.setData({ selectedPlan: options.plan });
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
      const patch = {
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
            : '剩余 ' + mem.remaining + ' 积分（≈ ' + pricing.minutesText(mem.remaining) + ' 分钟）'
          : '会员额度内提取不扣积分',
      };
      writeMemberCache(patch); // 写回缓存 → 下次进页面首帧即为正确态（不写的话冷启动必「先拉新、后会员」）
      this.setData(patch);
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
    // 「扣费规则」独立成段（2026-10-16 v5：视频 5/10 两档、文案 起步 2 + 每分钟 2）
    const unit = (pricing.CHARGE_RULES || []).map((r) => r.label + '：' + r.value).join('\n');
    const plans = (pricing.MEMBER_PLANS || [])
      .map((p) => {
        // 2026-10-15：原「月均 ¥X」改为「单次 ¥X」（现算）。不限次档没有分母 → 不追加。
        const u = pricing.unitPriceText(p);
        return p.name + ' ' + p.priceText + '（' + p.meta + (u ? ' · 单次 ' + u : '') + '）';
      })
      .join('\n');
    // 2026-09-27：原生 wx.showModal → 自建 x-dialog（正文强制左对齐）
    // 2026-10-15：加「单次怎么算」段；原「规则：」改「额度与续费：」以免与单次规则混淆
    // ⚠️ 正文较长，但 x-dialog__body 有 max-height:56vh + scroll-y，可滚动，不会溢出。
    this.openDialog({
      title: '会员说明',
      content: '档位：\n' + plans + '\n\n扣费规则：\n' + unit + '\n\n额度与续费：\n' + quota,
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

    // ⭐ 2026-10-15：调起微信支付**之前**，先让用户明确点头。
    //    ⚠️ 微信在 wx.requestVirtualPayment 内部自带「支付中…」「微信支付」两个过渡提示，
    //       端上没有任何参数能关掉（详见 .workbuddy/memory/DETAIL-虚拟支付.md）。
    //       加这道确认，是让那两个提示**只出现在用户已明确授权之后** ——
    //       用户点「一键续费」时屏幕上不会再冒出"支付中"，消除"点一下就强行扣款"的观感。
    this.openDialog(
      {
        title: '确认支付',
        content:
          (SHORT[plan.id] || plan.name) + ' ' + plan.priceText + ' · ' + plan.meta + '\n\n' +
          '点「确认支付」后才会调起微信支付；在微信收银台完成付款前，不会扣款。',
        confirmText: '确认支付',
        cancelText: '再想想',
        showCancel: true,
      },
      () => this.startPay(plan)
    );
  },

  /**
   * 真正下单并调起微信支付
   * ⭐ **只允许由 pay() 的确认回调进入**：pay() 必须以"弹确认框"收尾，绝不能直接走到支付。
   *    重构时务必保持这个边界（回归测试 error-message/confirm-before-pay 会守着）。
   */
  async startPay(plan) {
    tracker.track('member_pay_start', { plan: plan.id });

    let order = null;
    try {
      uiFeedback.showLoading({ title: '下单中', mask: true });
      const code = await loginCode();
      order = await call('createMemberOrder', { plan_id: plan.id, code });
      uiFeedback.hideLoading();
    } catch (e) {
      uiFeedback.hideLoading();
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
    uiFeedback.showLoading({ title: '确认开通中', mask: true });
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
      toast('开通成功', 'success');
    } else {
      uiFeedback.showModal({
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
