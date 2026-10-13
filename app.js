// app.js - 全局入口（蓝湖版 · 2026-09-26 新稿重做）
// 逻辑与 Pixso 版一致，仅视觉换新稿；云环境 / 登录流程沿用
const config = require('./config/index');
const { ensureLogin, restoreUser } = require('./utils/auth');
const tracker = require('./utils/tracker');
const referralEntry = require('./utils/referral-entry');

App({
  globalData: {
    user: null,
    cloudReady: false,
    systemInfo: null,
    // 自定义导航栏尺寸（页面 onLoad 读取）
    navStatusH: 0, // 状态栏高度 px
    navBarH: 44, // 标题栏高度 px
    menuRight: 0, // 胶囊左边缘距屏幕右边距离 px
    // ⭐ 导航行「右侧安全边距」rpx：动作按钮距页面右缘至少要留这么多，才不会被胶囊压住
    //    各页把它注入根节点的 --nav-safe-r，覆盖块的 padding-right 用 var() 取
    //    196rpx = iPhone 类机型（390pt）胶囊左边界 180.8rpx + 8px 间隙 15rpx，作为兜底默认值
    navSafeRightRpx: 196,
  },

  onLaunch(options) {
    // Restore the last confirmed identity synchronously, before page modules read their caches.
    restoreUser();
    referralEntry.capture(options);
    this.initCloud();
    this.fetchSystemInfo();
    this.watchDashboardChanges();
    this.ensureReady();
  },

  onShow(options) {
    if (referralEntry.capture(options) && this.globalData.cloudReady) this.ensureReady();
    require('./utils/dashboard').foreground(true);
  },
  onHide() { require('./utils/dashboard').foreground(false); },
  watchDashboardChanges() {
    const dashboard=require('./utils/dashboard');
    require('./utils/extract-session').subscribe(s=>{
      if(!['done','failed'].includes(s.phase))return;
      const key=(s.taskId||s.resultId||'')+s.phase;
      if(key!==this._dashboardCopyKey){this._dashboardCopyKey=key;dashboard.refresh(true);}
    });
    require('./utils/video-session').subscribe(s=>{
      if(!['ready','failed'].includes(s.phase))return;
      const key=s.taskId+s.phase;
      if(key!==this._dashboardVideoKey){this._dashboardVideoKey=key;dashboard.refresh(true);}
    });
  },

  initCloud() {
    try {
      if (!wx.cloud) {
        console.warn('[cloud] 基础库过低，请使用 2.2.3 及以上版本');
        return;
      }
      const env = config.cloudEnvId;
      const initOpt = { traceUser: true };
      if (env) initOpt.env = env;
      wx.cloud.init(initOpt);
      this.globalData.cloudReady = true;
      console.log('[cloud] 初始化完成 env=' + (env || '(默认)'));
    } catch (e) {
      console.warn('[cloud] 初始化失败', e);
      this.globalData.cloudReady = false;
    }
  },

  // 取状态栏 / 胶囊尺寸，供自定义导航栏使用
  fetchSystemInfo() {
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const statusH = win.statusBarHeight || 20;
      this.globalData.systemInfo = win;
      this.globalData.navStatusH = statusH;

      // 胶囊按钮位置（用于标题与胶囊对齐）
      const menu = wx.getMenuButtonBoundingClientRect
        ? wx.getMenuButtonBoundingClientRect()
        : null;
      if (menu && menu.width) {
        const winW = win.windowWidth || win.screenWidth || 375;
        this.globalData.menuRight = winW - menu.left;
        this.globalData.navBarH = (menu.top - statusH) * 2 + menu.height || 44;
        // ⭐ 导航行右侧安全边距（rpx）= 胶囊左边界到页面右缘的距离 + 8px 间隙
        //    微信建议自定义按钮与胶囊保持间距；8px 在 390pt 机型上 ≈ 15rpx
        //    ⚠️ 用 windowWidth 而非 screenWidth：rpx 基准是 windowWidth，
        //       两者在全面屏一致，但分屏/平板场景只有 windowWidth 对得上页面坐标
        this.globalData.navSafeRightRpx = Math.round(
          (winW - menu.left + 8) * (750 / winW)
        );
      }
    } catch (e) {
      // 忽略（保留 globalData 里的兜底默认值）
    }
  },

  ensureReady() {
    if (!this.globalData.cloudReady) return;
    ensureLogin()
      .then((user) => {
        if (!user) return; // Offline login must not erase the last confirmed display snapshot.
        this.globalData.user = user;
        require('./utils/dashboard').refresh(true);
        tracker.track('app_launch');
        // ⭐ 链路 A 结果回推（方案 D）：登录成功后立刻尝试把「待推送」的 A 链路文案发回服务号聊天窗口。
        //    必须由小程序端触发 —— 云调用自动鉴权的前提；云端（HTTP 触发）发会报 -501001。
        //    静默执行：不 await、失败不提示（结果始终在文案库，另有 pending_pushes 顶部提醒兜底）。
        this.pushPending();
      })
      .catch((err) => {
        console.warn('[app] ensureLogin 失败', err);
      });
  },

  /**
   * 把「待推送」的 A 链路结果推回服务号聊天窗口（方案 D）。
   * 触发点：onLaunch 登录后 / 「我的」页 onShow（可选，按需再加）。
   * ⚠️ 失败一律静默：这只是「补推」，不能影响任何主流程。
   */
  pushPending() {
    const { call } = require('./utils/api');
    return call('pushPending', { limit: 5 })
      .then((res) => {
        if (res && res.pushed) {
          console.log('[app] pushPending 已推送 ' + res.pushed + ' 条，失败 ' + res.failed);
        } else if (res && res.failed) {
          console.warn('[app] pushPending 全部失败', res.errors);
        }
        return res;
      })
      .catch((e) => {
        console.warn('[app] pushPending 异常（忽略）', e && e.message);
        return null;
      });
  },

  getUser() {
    return this.globalData.user;
  },
});
