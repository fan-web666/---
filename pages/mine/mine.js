// pages/mine/mine.js - 「我的」（用户 2026-09-26 提供新设计截图，整页重构）
// ────────────────────────────────────────────────────────────────────────────
// 数据来源：
//   · 用户信息（昵称/头像/积分/会员）→ refreshUser()（action: getUser，沿用原实现）
//   · 三个统计 + 最近一条记录        → call('userStats')（本次新增的聚合 action，一次拿全）
// 降级原则：
//   · 云端聚合不可用（云函数未重传 / 集合未建）→ 统计显示「—」，**不显示 0**
//   · 无记录 → 空态文案，不显示假数据
//   · 原「订阅消息模板未配置 → 开关回弹」已随通知提醒行删除（2026-09-27）
const config = require('../../config/index');
const pricing = require('../../config/pricing');
const { call } = require('../../utils/api');
const { refreshUser } = require('../../utils/auth');
const {
  toast,
  thousands,
  shortNumber,
  platformName,
  normPlatform,
  durationText,
  timeLabel,
  membershipInfo,
} = require('../../utils/util');
const tracker = require('../../utils/tracker');
const thumbs = require('../../utils/history-thumbs');
const dashboard = require('../../utils/dashboard');

const app = getApp();

/**
 * 提取偏好（「提取偏好设置」行）
 * 值存本地，与提取结果页的分段控件默认视图联动：
 *   full       → 结果页默认停在「原文案」
 *   structured → 结果页默认停在「结构化整理」（也是没有偏好时的现状默认值）
 */
const PREF_KEY = 'copy_pref';
const PREF_OPTS = [
  { v: 'full', t: '全文文案' },
  { v: 'structured', t: '结构化整理' },
];

/* 注：原「通知提醒」开关的本地记录常量 NOTIFY_KEY 与 onToggleNotify 已于 2026-09-27 随该行删除 */

/**
 * 默认昵称（用户 2026-09-27：「昵称也可以写个默认的-参考截图」）
 * ⚠️ 只作**兜底显示**：云端没记录、用户也没设过时才用，**绝不写进云端**。
 */
const DEFAULT_NAME = '文案小林';

/**
 * 用户自己提交的昵称 / 头像的本地缓存 { nickname, avatarUrl }
 * ⚠️ 为什么本地也要存一份：① 云端 `saveProfile` 未重传 / 演示模式下，刚设好的头像昵称不能丢；
 *    ② 进页面立刻有值，不必等 `getUser` 往返（与首页积分缓存同一思路）。
 * ⚠️ 渲染时**云端优先、本地兜底** —— 云端返回空串时不能把本地刚设好的值冲掉
 *    （users 档案里没写过时 nickname / avatarUrl 恒为 ''）。
 */
const PROFILE_KEY = 'user_profile';

/**
 * 「设置头像昵称」引导条的展示标记（2026-10-14 新增）
 * ⚠️ 只在**首次**出现，用户关掉后**永久不再出现** → 用一个本地布尔标记即可，不必上云。
 * ⚠️ 与结果页的引导共用同一个 key（两处任一关掉，另一处也不再出现），避免重复打扰。
 */
const PROFILE_TIP_KEY = 'profile_tip_shown';

/* ---------- 首帧缓存：消除切页「先空后跳」的闪现（2026-09-27） ----------
   用户：「界面切换，比如从历史切换到我的，里面的数据总是要有一个闪现的过程，
        能不能不要每次点进去都要闪现，而是跟随页面自然呈现出来」

   ⭐ 根因（两条叠加）：
      ① tab 级页面用 **reLaunch** 切换（本项目无 tabBar）→ **每次都是全新页面实例**，
         onLoad 重跑、data 回到初值；
      ② 所有数据都要等 `refreshUser()` / `call('userStats')` 云函数往返（几百毫秒）回来才 setData
         → 页面早已画完 → 必然「先占位、后跳变」。
   ⭐ 修法（与首页 `VIPBAR_CACHE_KEY` 同一思路）：把**上次的渲染结果**同步落本地缓存，
      `data` 初值直接取缓存 → 首帧即正确值；云端回来若值有变，那是**平滑更新**而不是从空到有。
   ⚠️ 缓存的是**上次的真实值**，不是伪造值：首次安装 / 清缓存仍走 `'—'` 占位，绝不编 0。
   ⚠️ 缓存的是**渲染后的文本**（如 `totalText`），不做二次整形 —— 读时零计算、无依赖。
   ⚠️ 2026-09-28：左栏由「本月提取」改「累计提取」→ 键名 `monthText` 同步改 `totalText`，
      旧缓存里的 `monthText` 会被忽略、回落 `'—'`（首帧短暂占位，云端回来即覆盖，可接受）。 */
const MINE_CACHE_KEY = 'mine_view';

function readMineCache() {
  try {
    const c = wx.getStorageSync(MINE_CACHE_KEY);
    return c && typeof c === 'object' && c.uid === ((app.globalData.user || {})._id || '') ? c : {};
  } catch (e) {
    return {};
  }
}

function writeMineCache(patch) {
  try {
    wx.setStorageSync(MINE_CACHE_KEY, Object.assign(readMineCache(), patch, { uid: (app.globalData.user || {})._id || '' }));
  } catch (e) {
    /* 写失败不影响本次会话（data 里已经更新过了） */
  }
}

const CACHED_MINE = readMineCache();

/**
 * 取缓存值（无缓存时用 fallback）
 * ⚠️ **空串是合法缓存值**（如 `usageEmpty` 为空串 = 「有记录」态）→ 不能用 `||` 兜底，
 *    否则会把「有记录」错误地还原成空态文案。只认 `undefined` / `null` 为「没缓存」。
 */
function cachedOr(key, fallback) {
  const v = CACHED_MINE[key];
  return v === undefined || v === null ? fallback : v;
}

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    navSafeRightRpx: 196,

    // 用户卡（头像/昵称三层兜底：云端 → 本地缓存 → 默认值）
    avatarUrl: '',
    nickName: DEFAULT_NAME,
    // 「我的编号」= 用户ID 后 8 位 —— 用户可复制报给运营，运营在后台按用户ID模糊搜即可精确定位
    userCode: '',
    // 从没设过头像/昵称 → 显示一行轻提示（微信 2.27.1 起只有用户主动设置才拿得到）
    needsProfile: false,
    // 引导条：仅「没设过资料」且「从没关过」时出现一次（关掉后永久消失）
    showProfileTip: false,
    vipText: cachedOr('vipText', '开通会员'),

    // 昵称编辑弹层（2026-09-27 新增）
    nickEdit: false,
    nickInput: '',
    friendPopup: false,
    friendFull: false,
    friendCode: '',
    friendError: '',
    friendSubmitting: false,

    // 三栏统计（'—' = 云端没给，绝不伪造 0）
    // ⚠️ 初值一律取**上次渲染结果**缓存（见文件顶部「首帧缓存」）——
    //    写死 `'—'` / `'0'` 会让每次进页面都「先空后跳」。
    totalText: cachedOr('totalText', '—'),
    charsText: cachedOr('charsText', '—'),
    creditsText: cachedOr('creditsText', '—'),

    // 提取记录卡（2026-09-26 起改为**消费摘要入口** —— 点进去是「积分与订单」子页）
    usageCount: cachedOr('usageCount', 0),
    usageMain: cachedOr('usageMain', ''),
    usageSub: cachedOr('usageSub', ''),
    usageEmpty: cachedOr('usageEmpty', '还没有消耗记录，去首页试试'),

    // 设置
    copyPrefText: '结构化整理',
    memberRowText: cachedOr('memberRowText', '未开通'),

    version: realVersion(),
    accountName: config.serviceAccountName,

    // 通用说明弹窗（x-dialog）—— 2026-09-27「帮助与反馈」由原生 wx.showModal 迁过来（正文左对齐）
    dlg: { show: false, title: '', content: '', confirmText: '知道了', cancelText: '', showCancel: false },

    // 微信号弹窗（2026-09-28 新增）—— 「帮助与反馈」由说明文字改为「加我微信」卡片
    //   样式参考「知了随记」的「我的 › 联系开发者」（showWechatPopup）
    devWechat: config.developerWechat || '',
    wechatPopup: false,
  },

  onLoad() {
    const c = readMineCache();
    const cached = {creditsText:'—',vipText:'开通会员',memberRowText:'未开通',totalText:'—',charsText:'—',usageCount:0,usageMain:'',usageSub:'',usageEmpty:'还没有消耗记录，去首页试试'};
    ['creditsText','vipText','memberRowText','totalText','charsText','usageCount','usageMain','usageSub','usageEmpty'].forEach(k => { if (c[k] !== undefined) cached[k] = c[k]; });
    this.setData(cached);
    const pref = wx.getStorageSync(PREF_KEY) || '';
    const hit = PREF_OPTS.find((o) => o.v === pref) || PREF_OPTS[1];
    this.setData({
      statusBarH: app.globalData.navStatusH || 0,
      navSafeRightRpx: app.globalData.navSafeRightRpx || 196,
      copyPrefText: hit.t,
      version: realVersion(),
    });
    this.applyCachedProfile();
    this.applyUser(app.globalData.user);
    const stats=dashboard.read('stats');if(stats)this.applyStats(stats);
    this._dashboardOff=dashboard.subscribe((type,data)=>{if(type==='user')this.applyUser(data);else if(type==='stats')this.applyStats(data);});
    tracker.track('mine_view');
  },

  onShow() {
    this.applyUser(app.globalData.user);
    this.setData({ version: realVersion() });
    this.refresh();
  },

  /** 进页面自动加载：两条请求并发，任一失败都静默（用户没主动操作，不该弹 toast） */
  refresh() {
    return dashboard.refresh();
  },
  onUnload() { if(this._dashboardOff)this._dashboardOff(); },

  /* ---------- 数据整形 ---------- */

  applyUser(user) {
    if (!user) return;
    if (this._walletRevision) this._redeemedUser = user;
    const cached = readProfileCache() || {};
    const credits = (user.credits && user.credits.balance) || 0;
    const name = String(user.nickname || user.nick_name || '').trim();
    const mem = membershipInfo(user);

    // 「我的编号」= 用户ID 后 8 位（_id = 'mini_' + sha256(openid)，这里取末 8 位 hex）。
    // 用途：用户复制报给运营 → 运营在后台「用户ID」一搜即中（后台走正则模糊匹配，且大小写不敏感）。
    const userCode = String(user._id || '').slice(-8);
    // 云端与本地都没有头像/昵称 ⇒ 从没设过 → 显示一行轻提示（微信 2.27.1 起只能用户主动设置）
    const cloudAvatar = String(user.avatarUrl || '').trim();
    const needsProfile = !name && !cloudAvatar && !cached.nickname && !cached.avatarUrl;
    // 引导条：没设过资料 且 从没关过 → 只出现一次
    let tipShown = false;
    try { tipShown = !!wx.getStorageSync(PROFILE_TIP_KEY); } catch (e) { /* 隐私模式下按未显示处理 */ }
    const showProfileTip = needsProfile && !tipShown;

    // 2026-09-29 用户：「除了显示剩余天数，还要显示剩余次数」
    // ⚠️ 统一走 membershipInfo()（utils/util.js 唯一实现），本页不再自行解析 membership。
    // 胶囊「不限次」档不重复后缀（档位名里已含「不限次」），否则读作「不限次会员 · 剩余 30 天 · 不限次」
    const vipQuota = mem.unlimited ? '' : mem.quotaText;
    const vipText = mem.active
      ? mem.tierText +
        '\u00A0·\u00A0' +
        (mem.daysText || '生效中') +
        (vipQuota ? '\u00A0·\u00A0' + vipQuota : '')
      : '开通会员，提取更划算';
    const memberRowText = mem.active
      ? (mem.daysText || '生效中') + (mem.quotaText ? ' / ' + mem.quotaText : '')
      : '未开通';
    const avatarSource = pickAvatar(user, cached);
    const cachedAvatar = thumbs.local(user._id, 'profile-avatar', avatarSource);
    const avatarUrl = this._avatarSource === avatarSource && this.data.avatarUrl ? this.data.avatarUrl : cachedAvatar || avatarSource;
    this._avatarSource = avatarSource;

    const patch = {
      // ⚠️ 三层兜底：云端 → 本地缓存 → 默认头像/昵称。云端没写过时它恒为空串，
      //    不能让它把本地刚设好的值冲掉。
      avatarUrl,
      nickName: name || cached.nickname || DEFAULT_NAME,
      userCode,
      needsProfile,
      showProfileTip,
      creditsText: thousands(credits),
      // 间隔空格用真实不换行空格（\u00A0），不要写 HTML 实体
      vipText,
      memberRowText,
    };
    // ⭐ 只缓存**纯文本**的展示值 → 下次进页面首帧就正确，不再「先 0/未开通、后跳变」。
    //    ⚠️ 头像/昵称不在这里缓存：它们另有 PROFILE_KEY 的落盘机制（且头像可能是
    //       wxfile://tmp 临时路径，缓存下来下次启动反而失效）。
    writeMineCache({
      creditsText: patch.creditsText,
      vipText: patch.vipText,
      memberRowText: patch.memberRowText,
    });
    this.setData(patch);
    if (avatarSource) thumbs.warm(user._id, 'profile-avatar', avatarSource);
  },

  applyStats(s) {
    const patch = {
      // ⚠️ 云端聚合不可用时给的是 **null**（不是 0）→ 显示「—」
      // 2026-09-28 用户：「提取数据改成累计提取」→ 左栏改用 total（全时段条数，含软删），不再用 month_count
      totalText: s.total == null ? this.data.totalText : shortNumber(s.total),
      charsText: s.total_chars == null ? this.data.charsText : shortNumber(s.total_chars),
      // 提取记录卡：消费摘要（云端顺带在同一次 userStats 里给，省一次往返）
      ...(s.usage ? usageCard(s.usage) : {}),
    };
    // ⭐ 整包都是**渲染后的文本/数字** → 直接缓存，下次进页面首帧即为正确值
    writeMineCache(patch);
    this.setData(patch);
  },

  /* ---------- 交互 ---------- */

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  goCommunity() {
    wx.navigateTo({ url: '/pages/community/community' });
  },

  openFriendInvite() { this.setData({ friendPopup: true, friendFull: false, friendError: '', friendCode: '' }); },
  closeFriendInvite() { if (!this.data.friendSubmitting) this.setData({ friendPopup: false }); },
  onFriendCode(e) { this.setData({ friendCode: e.detail.value, friendError: '' }); },
  goFriendHelp() { wx.navigateTo({ url: '/pages/friend-help/friend-help' }); },
  friendContact() { this.setData({ friendPopup: false }); this.showHelp(); },
  friendRetry() { this.setData({ friendFull: false, friendError: '', friendCode: '' }); },
  async redeemFriendInvite() {
    if (this.data.friendSubmitting) return;
    const code = this.data.friendCode.trim();
    if (!code) { this.setData({ friendError: '请输入邀请码' }); return; }
    this.setData({ friendSubmitting: true, friendError: '' });
    try {
      const result = await call('redeemFriendInvite', { code });
      this._walletRevision = (this._walletRevision || 0) + 1;
      this._redeemedUser = Object.assign({}, app.globalData.user || {}, { credits: result.credits });
      app.globalData.user = this._redeemedUser;
      require('../../utils/auth').saveUser(this._redeemedUser);
      this.applyUser(this._redeemedUser);
      dashboard.refresh(true);
      this.setData({ friendPopup: false });
      wx.showModal({ title: result.status === 'already_redeemed' ? '你已兑换过' : '10000积分已到账',
        content: result.status === 'already_redeemed' ? '你已领取亲友赠送积分，无需重复兑换。积分永久有效。' : '已加入你的积分余额，可用于视频和文案提取，积分永久有效。', showCancel: false });
    } catch (e) {
      if (e.code === 409) this.setData({ friendFull: true });
      else this.setData({ friendError: e.message || '兑换结果暂未确认，请重试；不会重复领分或占用名额。' });
    } finally { this.setData({ friendSubmitting: false }); }
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' });
  },

  goRecharge() {
    wx.navigateTo({ url: '/pages/recharge/recharge' });
  },

  /**
   * 提取记录卡 → 「积分与订单」子页（用户 2026-09-26）
   * ⚠️ 这张卡原先跳文案库（goHistory）；现在改为跳消费明细子页 ——
   *    文案库仍可从底部 tabbar 进，不受影响。
   * ⚠️ 是**二级页**，用 navigateTo（区别于 tab 级页面的 reLaunch 口径）
   */
  goUsage() {
    wx.navigateTo({ url: '/pages/usage/usage' });
  },

  /* ---------- 头像 / 昵称（2026-09-27 用户：「"我的"界面里的头像位置和昵称目前点了没反应…
       应该支持获取微信头像和微信昵称」）----------
     ⚠️ 合规口径（绕不过去）：
        · 微信头像 → **只能**由 <button open-type="chooseAvatar"> 的 bindchooseavatar 拿；
        · 微信昵称 → **只能**由 <input type="nickname"> 的快捷填充拿。
        `wx.getUserProfile` / `wx.getUserInfo` 自基础库 2.27.1 起只返回灰色默认头像 +
        「微信用户」两个占位值 —— 再用就是无效调用（真机上什么都不弹），所以一条都没用。
     ⚠️ 落库顺序：**先本地生效 → 再尽力推云端**。云端不可用（saveProfile 未重传 / 演示模式）时
        也不能把用户刚设好的头像昵称丢掉。 */

  /** 进页面先铺本地缓存（云端还没回来 / 不可用时也立刻有值） */
  applyCachedProfile() {
    const c = readProfileCache();
    if (!c) return;
    const d = {};
    if (c.nickname) d.nickName = c.nickname;
    const a = pickAvatar(null, c);
    if (a) d.avatarUrl = a;
    if (Object.keys(d).length) this.setData(d);
  },

  /** 关闭「设置头像昵称」引导条 —— 记到本地，之后永久不再出现 */
  dismissProfileTip() {
    try { wx.setStorageSync(PROFILE_TIP_KEY, 1); } catch (e) { /* ignore */ }
    this.setData({ showProfileTip: false });
  },

  /** 复制「我的编号」—— 用户报给运营，用于在后台精确定位其账号 */
  copyUserCode() {
    const code = this.data.userCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '编号已复制', icon: 'none' }),
      fail: () => {},
    });
  },

  /** 选中微信头像（chooseAvatar 回调） */
  onChooseAvatar(e) {
    const temp = e && e.detail && e.detail.avatarUrl;
    if (!temp) return;

    // ① 临时路径此刻就能显示 → 先出画面，别让用户觉得「点了没反应」
    this.setData({ avatarUrl: temp });

    // ② 落盘成永久路径（wxfile://tmp_… 下次启动即失效，不落盘的头像只活一次）
    saveAvatarLocal(temp).then((local) => {
      const shown = local || temp;
      if (local) this.setData({ avatarUrl: local });

      // ③ 再尝试传云存储（换设备也能看到）；云环境不可用时**只留本地**，
      //    绝不把 wxfile:// 本地路径写进云端 —— 别的设备读不到，写了是脏数据。
      uploadAvatar(shown).then(
        (fileID) => {
          if (fileID) this.pushProfile({ avatarUrl: fileID, localAvatar: shown });
          else writeProfileCache({ localAvatar: shown });
        },
        () => writeProfileCache({ localAvatar: shown })
      );
    });
    tracker.track('mine_set_avatar');
  },

  /** 点昵称 → 开编辑弹层（层内是 <input type="nickname">，可一键填入微信昵称） */
  onEditNickname() {
    this.setData({ nickEdit: true, nickInput: this.data.nickName });
  },

  onNickInput(e) {
    this.setData({ nickInput: (e && e.detail && e.detail.value) || '' });
  },

  onNickCancel() {
    this.setData({ nickEdit: false });
  },

  onNickSave() {
    const n = String(this.data.nickInput || '').trim().slice(0, 20);
    if (!n) {
      toast('昵称不能为空');
      return;
    }
    this.setData({ nickEdit: false, nickName: n });
    this.pushProfile({ nickname: n });
    tracker.track('mine_set_nickname');
  },

  /**
   * 落库：先写本地缓存（下次进页面立刻有值），再尽力推云端 `saveProfile`
   * ⚠️ 云端失败**不弹错也不回滚** —— 用户没做错事，本地已经生效，只是换设备看不到。
   */
  pushProfile(patch) {
    writeProfileCache(patch);
    if (!app.globalData.cloudReady) return;

    const data = {};
    if (patch.nickname) data.nickname = patch.nickname;
    if (patch.avatarUrl) data.avatarUrl = patch.avatarUrl;
    if (!Object.keys(data).length) return;

    call('saveProfile', data)
      .then((user) => {
        if (user) this.applyUser(user);
      })
      .catch(() => {
        /* 云端未同步（api 云函数未重传）→ 本地已生效，等重传后再保存一次即可补上 */
      });
  },

  /* 注：原「通知提醒（订阅消息）」的 onToggleNotify 已于 2026-09-27 随该行删除。
     ⚠️ 恢复时需一并补回：mine.wxml 的图标行 + <switch>、mine.wxss 的 `.x-switch`、
        data 的 notifyOn、NOTIFY_KEY 常量，以及 config/index.js 的 subscribeTmplIds 模板 ID。
        云端 `cronDaily` 的发送能力未动（走环境变量 RENEW_TEMPLATE_ID，与端上开关独立）。 */

  /* ---------- 提取偏好 ---------- */

  onTapPref() {
    wx.showActionSheet({
      itemList: PREF_OPTS.map((o) => o.t),
      success: (r) => {
        const opt = PREF_OPTS[r.tapIndex];
        if (!opt) return;
        wx.setStorageSync(PREF_KEY, opt.v);
        this.setData({ copyPrefText: opt.t });
        toast('已设为「' + opt.t + '」');
      },
      fail: () => {
        /* 用户取消，无事发生 */
      },
    });
  },

  /* ---------- 帮助 / 隐私 ---------- */

  /* 通用说明弹窗（x-dialog）
   * 2026-09-27：原生 wx.showModal 的正文对齐由系统决定（**API 无对齐参数**）→ 改用自建
   * <x-dialog>，正文统一左对齐（与 forward / recharge / member 三页同一组件、同一口径）。
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

  /* 「帮助与反馈」→ 加我微信弹窗（2026-09-28 用户要求）
   * ⭐ 用户：「点击进去之后是我的微信号，方式可以参考 Card 笔记里『我的』界面的联系开发者」
   *   → 由原来的「三步说明」文字弹窗，改为「微信号 + 一键复制」卡片。
   *   ⚠️ 本页已有两个弹层（x-dialog / nickEdit），再塞第三种会打架；
   *     微信号弹窗**单独一组 class（x-wx-*）**，不与 x-dialog 复用，互不干扰。
   *   ⚠️ 微信号取自 config.developerWechat（与「知了随记」同一个号），不在代码里写死。 */
  showHelp() {
    if (!this.data.devWechat) {
      // 兜底：没配微信号 → 退回原说明弹窗，绝不显示空号
      this.openDialog({
        title: '帮助与反馈',
        content:
          '① 视频号转发：先关注「' + this.data.accountName + '」，再把视频转发给它即可；\n' +
          '② 粘贴链接：支持视频号 / 抖音 / 快手 / 小红书 / B 站；\n' +
          '③ 积分规则：' + pricing.CREDIT_BASIC + ' 积分可提取 1 条 ≤10 分钟视频，会员额度内不扣积分。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    this.setData({ wechatPopup: true });
  },

  hideWechatPopup() {
    this.setData({ wechatPopup: false });
  },

  onCopyWechat() {
    wx.setClipboardData({
      data: this.data.devWechat,
      success: () => {
        this.setData({ wechatPopup: false });
        toast('微信号已复制，去微信添加吧');
      },
      fail: () => toast('复制失败，请手动复制'),
    });
  },

  /** 用户协议与隐私政策：走微信官方的《小程序用户隐私保护指引》弹窗（基础库 2.32.3+） */
  openPrivacy() {
    if (wx.openPrivacyContract) {
      wx.openPrivacyContract({
        fail: () => toast('隐私协议打开失败，请稍后重试'),
      });
      return;
    }
    this.openDialog({
      title: '用户协议与隐私政策',
      content: '当前微信版本过低，请升级微信后在「小程序 › 右上角 › 隐私」中查看完整协议。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  /* ---------- tabbar（tab 级页面一律 reLaunch，全站动效统一） ---------- */

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  goHistory() {
    wx.reLaunch({ url: '/pages/history/history' });
  },

  onShareAppMessage() {
    return { title: '把视频里的好文案，变成你的素材库，支持视频提取', path: '/pages/index/index' };
  },
});

/* ---------- 昵称 / 头像：本地存储 + 云存储上传 ---------- */

/** 读本地缓存 { nickname, avatarUrl, localAvatar }（拿不到给 null） */
function readProfileCache() {
  try {
    const v = wx.getStorageSync(PROFILE_KEY);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

/** 合并写本地缓存（只覆盖传入的字段；空值不覆盖） */
function writeProfileCache(patch) {
  try {
    const next = Object.assign({}, readProfileCache() || {});
    if (patch.nickname) next.nickname = patch.nickname;
    if (patch.avatarUrl) next.avatarUrl = patch.avatarUrl;
    if (patch.localAvatar) next.localAvatar = patch.localAvatar;
    wx.setStorageSync(PROFILE_KEY, next);
  } catch (e) {
    /* 存储写失败不影响本次会话（data 里已经更新过了） */
  }
}

/**
 * 把 chooseAvatar 给的**临时路径**复制到本地用户目录（重启后仍可读）
 * ⚠️ 临时文件（wxfile://tmp_…）下次启动就失效 → 不落盘的头像只活一次
 * ⚠️ 落点跟随 utils/util.js 的缩略图约定：直接放 USER_DATA_PATH 根下，不建子目录
 * @returns {Promise<string>} 永久路径；失败给 ''（调用方回落临时路径）
 */
function saveAvatarLocal(tempPath) {
  return new Promise((resolve) => {
    try {
      const ext = (String(tempPath).match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
      const dest = wx.env.USER_DATA_PATH + '/avatar_' + Date.now() + ext;
      wx.getFileSystemManager().copyFile({
        srcPath: tempPath,
        destPath: dest,
        success: () => resolve(dest),
        fail: () => resolve(''),
      });
    } catch (e) {
      resolve('');
    }
  });
}

/**
 * 头像上传云存储（尽力而为）
 * ⚠️ cloudPath 带 `_<时间戳>` → 每次换头像都是新文件，避开 CDN 对同名文件的缓存
 * ⚠️ 云环境未配置（演示模式）直接 reject，由调用方降级为「只留本地」
 */
function uploadAvatar(filePath) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || !app.globalData.cloudReady) {
      reject(new Error('cloud_unready'));
      return;
    }
    const ext = (String(filePath).match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
    const uid = (app.globalData.user && app.globalData.user._id) || 'u';
    wx.cloud.uploadFile({
      cloudPath: 'avatars/' + uid + '_' + Date.now() + ext,
      filePath,
      success: (r) => resolve((r && r.fileID) || ''),
      fail: reject,
    });
  });
}

/**
 * 头像展示优先级：本地已落盘的文件（即时、离线可用）→ 云端 fileID → ''
 * ⚠️ 本地优先：刚设完头像立刻可见，不必等云存储回源（与历史页缩略图同一思路）
 * ⚠️ 必须先 `accessSync` 探活：换设备 / 清缓存后本地文件已不在，此时必须回落云端
 */
function pickAvatar(user, cached) {
  const c = cached || {};
  const local = String(c.localAvatar || '');
  if (local) {
    try {
      wx.getFileSystemManager().accessSync(local);
      return local;
    } catch (e) {
      /* 本地文件不在 → 走云端 */
    }
  }
  return String((user && user.avatarUrl) || c.avatarUrl || '');
}

/** 微信仅在正式版提供线上版本号；不使用本地配置冒充上传或发布版本。 */
function realVersion() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    const miniProgram = (info && info.miniProgram) || {};
    const env = miniProgram.envVersion;
    if (env === 'develop') return '开发版';
    if (env === 'trial') return '体验版';
    const v = typeof miniProgram.version === 'string' ? miniProgram.version.trim() : '';
    if (v) return /^v/i.test(v) ? v : 'v' + v;
    return '版本暂未获取';
  } catch (e) {
    return '版本暂未获取';
  }
}

/** ⚠️ 2026-09-29：原本页私有 `daysLeft()` 已删除 —— 会员解析（天数 + 次数）统一走
 *  `utils/util.js#membershipInfo()`（唯一实现），避免首页 / 会员中心 / 我的 三处口径漂移。 */

/**
 * 消费摘要 → 「提取记录」卡的内容（用户 2026-09-26）
 * ⚠️ 三个分支都**不编数字**：
 *    · usage 为 null（云端聚合不可用 / 云函数没重传）→ 文案说「暂不可用」
 *    · count 为 0 → 空态文案
 *    · month_credit / month_quota 拿不到 → 显示「—」
 * @param {{month_credit,month_quota,count,last}} u userStats.usage
 */
function usageCard(u) {
  if (!u) {
    return { usageCount: 0, usageMain: '', usageSub: '', usageEmpty: '消费明细暂不可用' };
  }
  const count = Number(u.count) || 0;
  if (!count) {
    return { usageCount: 0, usageMain: '', usageSub: '', usageEmpty: '还没有消耗记录，去首页试试' };
  }
  const mc = u.month_credit == null ? '—' : shortNumber(u.month_credit);
  const q = Number(u.month_quota) || 0;
  // 间隔空格用真实不换行空格（\u00A0），不要写 HTML 实体
  const main = '本月消耗 ' + mc + ' 积分' + (q ? '\u00A0·\u00A0会员额度 ' + q + ' 次' : '');

  const l = u.last || null;
  const sub = l
    ? '最近 ' +
      [
        platformName(normPlatform(l.platform)),
        l.duration_sec > 0 ? durationText(l.duration_sec) : '',
        timeLabel(l.ts),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return { usageCount: count, usageMain: main, usageSub: sub, usageEmpty: '' };
}
