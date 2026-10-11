// pages/index/index.js - 首页 · 提取（蓝湖版）
// 业务逻辑复用 Pixso 版（utils/auth、config/pricing、云函数 action 名不变）
const pricing = require('../../config/pricing');
const { refreshUser } = require('../../utils/auth');
const {
  toast,
  platformName,
  detectPlatform,
  thousands,
  extractUrl,
  isValidUrl,
  membershipInfo,
} = require('../../utils/util');
const tracker = require('../../utils/tracker');
const sess = require('../../utils/extract-session');

const app = getApp();

/* ⭐⭐ 积分 / 会员栏「首帧值」缓存（2026-09-27 用户：「首页的积分数应该直接呈现，
   而不是先显示 0，然后再显示实际积分数」）
   ⚠️ 根因：`onShow → refresh()` 是**异步网络请求**，首帧若用写死初值，用户必然先看到一个
      **错误值**（0 / 未开通），几百毫秒后才跳成真实值 —— 观感就是「数字闪跳」。
   做法：把上次成功的展示值写入本地缓存，`data` 初始化时**同步**读回 → 首帧即正确值；
        接口返回后再校准（值相同时 setData 无视觉变化，真有变动才更新）。
   ⚠️ 缓存**同时存 `balance` 原始数值**：`precheckCredits()` 用 `this.data.balance > 0` 判断，
      若只缓存文本、数值仍从 0 起，会出现「屏幕显示 50、一点却说积分不足」的自相矛盾。
   ⚠️ 首次启动（无缓存）→ 文本用「—」占位，**不伪造 0**（项目约定：拿不到的数显示「—」）；
      用「—」而非空串，还兼有「保住 `.x-vipvalue` 行高、避免布局塌陷」的作用。
   ✅ 缓存过期风险可接受：即便缓存值偏大，云端扣费仍会二次校验（权威始终在云端）。 */
const VIPBAR_CACHE_KEY = 'idx_vipbar';

function readVipbarCache() {
  try {
    const c = wx.getStorageSync(VIPBAR_CACHE_KEY);
    if (c && typeof c === 'object') return c;
  } catch (e) { /* 读失败 → 走默认空态 */ }
  return {};
}

function writeVipbarCache(patch) {
  try {
    wx.setStorageSync(VIPBAR_CACHE_KEY, Object.assign(readVipbarCache(), patch));
  } catch (e) { /* 写失败不影响主流程 */ }
}

const CACHED_VIPBAR = readVipbarCache();

/** 秒 → 中文时长（45 秒 / 1 分 20 秒 / 3 分钟）· 本地视频「已选态」副标用 */
function durationText(sec) {
  const s = Math.round(sec || 0);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? m + ' 分 ' + r + ' 秒' : m + ' 分钟';
}

Page({
  data: {
    // 自定义导航栏：状态栏占位高度（设计稿画了状态栏，真机自带，只占位不绘制）
    statusBarH: 0,
    navBarH: 44,
    navSafeRightRpx: 196,

    // 输入
    url: '',
    // ⭐ 提取按钮三态（2026-09-28 用户：「允许后台提取，回到首页时按钮要显示提取中 + 进度」）
    //    立即提取 / 提取中 28% / 查看提取结果 —— 状态源在 utils/extract-session.js
    extractBtn: '立即提取',
    extractPhase: 'idle',
    extractPercent: 0,
    // 已选本地视频（null = 未选）→ { path, meta }
    // ⚠️ 选完只回填、不跳转；真正的提取由「立即提取」统一触发（与粘贴链接路径一致，2026-09-27）
    localVideo: null,

    // 用户（积分 / 会员栏 · 两行式：上行是固定标签，下行取这两个值）
    // ⚠️ 初值取「上次已知值」缓存（见文件顶部说明），**不写死 0 / 未开通** —— 否则首帧必闪错误值
    balance: CACHED_VIPBAR.balance || 0,
    balanceText: CACHED_VIPBAR.balanceText || '—',
    member: !!CACHED_VIPBAR.member,
    memberValue: CACHED_VIPBAR.memberValue || '—',
    // 会员次数（2026-09-29 用户：「除了显示剩余天数，还要显示剩余次数」）
    // → 下行 = 大字「30 天」+ 小字「60 次」；不限次档为「不限次」，未开通为空串
    memberQuotaText: CACHED_VIPBAR.memberQuotaText || '',
  },

  goReferral() { wx.navigateTo({ url: '/pages/referral/referral' }); },

  onLoad() {
    this.setData({
      statusBarH: app.globalData.navStatusH || 0,
      navBarH: app.globalData.navBarH || 44,
      navSafeRightRpx: app.globalData.navSafeRightRpx || 196,
    });
    // ⭐ 订阅全局提取会话（2026-09-28）：用户从提取中页返回后任务仍在后台跑，
    //    本页按钮要实时显示「提取中 28%」，跑完显示「查看提取结果」
    this._unsub = sess.subscribe((snap, patch, event) => this.onSession(snap, event));
  },

  onShow() {
    this._visible = true;
    this.refresh();
  },

  onHide() {
    this._visible = false;
  },

  onUnload() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
  },

  /* ---------- 全局提取会话 → 按钮 ---------- */

  onSession(snap, event) {
    const text =
      snap.phase === 'running'
        ? '提取中 ' + snap.percent + '%'
        : snap.phase === 'done'
        ? '查看提取结果'
        : '立即提取';
    const patch = {};
    if (this.data.extractBtn !== text) patch.extractBtn = text;
    if (this.data.extractPhase !== snap.phase) patch.extractPhase = snap.phase;
    if (this.data.extractPercent !== snap.percent) patch.extractPercent = snap.percent;
    if (Object.keys(patch).length) this.setData(patch);
    // 后台提炼完成时提示一声（提取中页正开着的话由它跳结果页，这里不重复打扰）
    if (event === 'done' && this._visible && !sess.hasViewer('loading')) {
      toast('文案提取完成');
    }
  },

  /* ---------- 数据加载 ---------- */

  async refresh() {
    // 云环境未就绪：只展示 UI，不含任何假数据
    if (!app.globalData.cloudReady) return;
    try {
      const user = await refreshUser();
      if (user) this.applyUser(user);
    } catch (e) {
      // 静默：进页面自动加载，用户没主动操作
    }
  },

  applyUser(user) {
    if (!user) return;
    const credits = (user.credits && user.credits.balance) || 0;
    // ⚠️ 2026-09-29 修复：原实现读 `user.member.{active, expire_at}` —— 云端从不返回该形状
    //    （`userCenterSummary()` 给的是 `membership.{tier,status,expires_at,quota}`）
    //    → 买了会员首页仍恒显示「未开通」。现统一走 `membershipInfo()`（utils/util.js 唯一实现）。
    const mem = membershipInfo(user);
    // 两行式的下行大字：只放「值 + 单位」，标签「会员」在 WXML 里固定
    const balanceText = thousands(credits);
    const memberValue = mem.active ? (mem.daysLeft > 0 ? mem.daysLeft + ' 天' : '生效中') : '未开通';
    const memberQuotaText = mem.quotaText;
    // 写回缓存 → 下次进入首帧即为正确值（消除「0 → 实际积分」闪跳）
    writeVipbarCache({
      balance: credits,
      balanceText,
      member: mem.active,
      memberValue,
      memberQuotaText,
    });
    this.setData({
      balance: credits,
      balanceText,
      member: mem.active,
      memberValue,
      memberQuotaText,
    });
  },

  /* ---------- 输入 ---------- */

  onInput(e) {
    const url = e.detail.value || '';
    // 与本地视频互斥：开始填链接就清掉已选视频（两个来源同时存在会产生歧义）
    const patch = { url };
    if (url && this.data.localVideo) patch.localVideo = null;
    this.setData(patch);
  },

  readClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const text = (res.data || '').trim();
        if (!text) return toast('剪贴板是空的');
        const url = extractUrl(text) || text;
        const code = detectPlatform(url);
        this.setData({ url, localVideo: null }); // 与本地视频互斥（同 onInput）
        if (code) toast('已识别' + platformName(code) + '链接', 'success');
        else if (!isValidUrl(url)) toast('没识别出链接，请检查后重试');
      },
      fail: () => toast('读取剪贴板失败，请手动长按粘贴'),
    });
  },

  /* ---------- 本地视频 ---------- */

  // ⚠️⚠️ 2026-09-27 交互修正（用户提出）：本方法原来在选完文件后**直接** `navigateTo(loading)`，
  //    而 loading 页 onLoad 立刻 submitLocal() → 上传 + 建任务 + 扣积分，
  //    也就是说选错文件时**账已经扣了、没有反悔机会**；
  //    同时同卡内的「粘贴链接」路径却要先点「立即提取」——两条路径的确认机制不对称。
  //    现改为：选完**只回填已选信息、留在首页**，由「立即提取」统一触发两条路径。
  //    ⚠️ 不要再把 navigateTo 挪回这里。
  importVideo() {
    const useMedia = typeof wx.chooseMedia === 'function';
    const choose = useMedia ? wx.chooseMedia : wx.chooseVideo;
    if (typeof choose !== 'function') return toast('请升级微信后导入视频');
    choose.call(wx, {
      count: 1,
      mediaType: ['video'],
      ...(useMedia ? { sizeType: ['original'] } : { compressed: false }),
      sourceType: ['album'],
      maxDuration: pricing.MAX_DURATION_SEC,
      success: (res) => {
        const file = useMedia ? (res.tempFiles && res.tempFiles[0]) : res;
        if (!file || !file.tempFilePath) return toast('未获取到视频文件，请重新选择');
        const sizeMB = (file.size || 0) / 1024 / 1024;
        if (sizeMB > 100) return toast('视频超过 100MB，请换个更短的');
        const sec = file.duration || 0;
        if (sec > pricing.MAX_DURATION_SEC) return toast('视频超过 30 分钟暂不支持');

        tracker.track('home_import_local', { sizeMB: Math.round(sizeMB) });
        // 只记「已选」不跳转；真实路径等点「立即提取」时再交给 loading 页
        // ⚠️ chooseMedia **不返回原始文件名**（tempFilePath 是随机临时名，如 tmp_1a2b3c.mp4），
        //    所以已选态副标显示「大小 + 时长」——不伪造拿不到的信息。
        const hadUrl = !!(this.data.url || '').trim();
        this.setData({
          localVideo: {
            path: file.tempFilePath,
            // 原视频体积/时长用于上传显示与耗时诊断，不触发重新编码。
            sizeMB,
            durationSec: sec,
            // ⭐ 视频缩略图临时路径（chooseMedia 视频必带）：上传时转存到本地持久目录，
            //    列表 / 详情页直接拿它当封面 → 不再有「先黑图、再等首帧」的过程。
            //    拿不到就是空串，链路自动回落 <video> 首帧（见 utils/util.js 的注释）。
            thumb: file.thumbTempFilePath || '',
            meta: sizeMB.toFixed(1) + 'MB · ' + durationText(sec),
          },
          url: '', // 与链接互斥
        });
        // 链接被顺带清掉时要说明 —— 那是用户费力粘进来的内容，突然消失会困惑
        toast(hadUrl ? '已选择本地视频，原链接已清除' : '已选择本地视频', 'success');
      },
      fail: (e) => {
        if (!/cancel/i.test((e && e.errMsg) || '')) toast('无法读取相册视频，请检查相册权限或重新选择');
      },
    });
  },

  // 取消已选（已选态右侧「×」）
  clearLocalVideo() {
    this.setData({ localVideo: null });
  },

  /* ---------- 提取 ---------- */

  // 积分预检：返回 true = 可继续（非会员且余额为 0 → 弹窗引导充值）
  // 两条路径（链接 / 本地视频）共用同一份检查，避免只在其中一条上拦截
  precheckCredits() {
    if (this.data.member || this.data.balance > 0 || !app.globalData.cloudReady) return true;
    wx.showModal({
      title: '积分不足',
      content: '当前积分为 0，先充值或开通会员后再提取。',
      confirmText: '去充值',
      cancelText: '再看看',
      success: (r) => {
        if (r.confirm) wx.navigateTo({ url: '/pages/recharge/recharge' });
      },
    });
    return false;
  },

  // ⭐ 两条路径唯一的触发点：先看有没有已选本地视频，再退回链接输入
  // ⚠️⚠️ 2026-09-28 新增「后台提取」两分支：任务已在后台跑时本按钮只负责「去看进度」，
  //     **绝不重复提交**（会重复扣积分）。状态源 = utils/extract-session.js。
  startExtract() {
    const phase = sess.phase();

    // ① 已有任务在后台跑 → 只跳进度页（loading 页发现会话在跑就不再新建任务）
    if (phase === 'running') {
      wx.navigateTo({ url: '/pages/loading/loading' });
      return;
    }
    // ② 后台已经跑完 → 直接看结果，会话收尾（按钮回到「立即提取」）
    if (phase === 'done') {
      const id = sess.resultId();
      sess.reset();
      wx.navigateTo({ url: id ? '/pages/result/result?id=' + id : '/pages/result/result' });
      return;
    }

    // ③ 本地视频：与链接路径共用「立即提取」这一个确认动作
    if (this.data.localVideo) {
      if (!this.precheckCredits()) return;
      tracker.track('home_start_extract', { platform: 'local' });
      const v = this.data.localVideo;
      // ⚠️ 传对象（{ path, thumb }）而非裸路径 —— 会话要把 thumb 转存成列表封面
      sess.start({
        mode: 'local',
        path: v.path,
        thumb: v.thumb || '',
        sizeMB: v.sizeMB || 0,
        durationSec: v.durationSec || 0,
      });
      wx.navigateTo({
        url: '/pages/loading/loading',
        // 已开始 → 清掉已选态，返回首页时状态干净（不会像"还在等提取"）
        success: () => this.setData({ localVideo: null }),
      });
      return;
    }

    // ④ 链接
    const raw = (this.data.url || '').trim();
    if (!raw) return toast('请先粘贴视频链接，或导入本地视频');
    // 分享文案常夹口令（抖音、小红书），先抽链接再校验；裸域名放行（后端补协议）
    const url = extractUrl(raw) || raw;
    if (!isValidUrl(url)) return toast('链接格式不太对，请检查后再试');
    if (!this.precheckCredits()) return;

    tracker.track('home_start_extract', { platform: detectPlatform(url) });
    sess.start({ mode: 'link', url });
    wx.navigateTo({ url: '/pages/loading/loading' });
  },

  /* ---------- 跳转 ---------- */

  goForward() {
    wx.navigateTo({ url: '/pages/forward/forward' });
  },

  // 积分 / 会员栏两栏
  goRecharge() {
    wx.navigateTo({ url: '/pages/recharge/recharge' });
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' });
  },

  // tabbar 第二项「文案库」：无 tabBar 配置 → 用 reLaunch（switchTab 会失效）
  goLibrary() {
    wx.reLaunch({ url: '/pages/history/history' });
  },

  goMine() {
    wx.reLaunch({ url: '/pages/mine/mine' });
  },

  onShareAppMessage() {
    const code = app.globalData.user && app.globalData.user.referralCode;
    return {
      title: '把视频里的好文案，变成你的素材库',
      path: '/pages/index/index' + (code ? '?ref=' + encodeURIComponent(code) : ''),
    };
  },
});
