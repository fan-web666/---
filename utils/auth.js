// utils/auth.js - 登录建档与用户信息
const { call } = require('./api');

const app = () => getApp();
let refreshing = null;
const USER_SNAPSHOT = 'last_confirmed_user_v1';
function saveUser(user) { if(!user||!user._id)return;try{wx.setStorageSync(USER_SNAPSHOT,user);}catch(_){} }

/**
 * 同步恢复「上次确认过的身份」→ globalData.user（冷启动首帧用）。
 *
 * ⚠️⚠️ 2026-10-15 线上事故修复：**必须由调用方传入 App 实例**（app.js 里 `restoreUser(this)`）。
 *   原实现内部用 `getApp()`，而微信官方明确「不要在定义于 App() 内的函数中调用 getApp()」——
 *   在 `onLaunch` 期间该调用**不保证**返回实例（部分基础库返回 undefined）。
 *   一旦返回 undefined，这里的 `app().globalData` 会抛 TypeError → **被下面的 catch 静默吞掉** →
 *   `globalData.user` 始终为 null → **冷启动首帧所有页面的首帧缓存全部失效**
 *   （缓存归属判定要拿 `_id`，拿不到就被判成「换了账号」而丢弃）。
 *   症状：每次**冷启动**进小程序，首页积分/会员、我的页三栏统计都先显示占位符再跳变；
 *        切后台再回来（热启动，globalData 未丢）却正常。修复见 `localUid()`。
 */
function restoreUser(target) {
  try {
    const user = wx.getStorageSync(USER_SNAPSHOT);
    if (user && user._id) {
      const a = target || app();
      if (a && a.globalData) a.globalData.user = user;
      return user;
    }
  } catch (_) {}
  return null;
}

/**
 * ⭐ 本地用户标识 —— **缓存归属判定专用**（`view-cache` / 首页 VIP 栏 / 我的页 / 充值 / 会员）。
 *
 * 取值顺序：① `globalData.user._id`（已登录/已恢复，内存态，最快）
 *          ② 回落本地快照 `last_confirmed_user_v1._id`（**纯 storage 同步读，任何时刻可用**）
 *
 * ⚠️⚠️ 为什么要回落：缓存读取发生在**页面 `data` 初始化 / 模块顶层**，此时 `globalData.user`
 *   可能尚未就绪（`onLaunch` 的恢复失败、或页面模块早于 `onLaunch` 执行）。
 *   只认 ① 会让「同一台设备、同一个微信」的缓存被误判成「换了账号」而丢弃 → 首帧空白/占位。
 *   同一微信的 `_id` 恒定（`mini_` + sha256(openid)），且 storage 本身就跟微信账号走，
 *   故回落快照**不会串号**，只会在「本机从未登录过」时返回 ''（此时本就不该有缓存）。
 */
function localUid() {
  try {
    const a = app();
    if (a && a.globalData && a.globalData.user && a.globalData.user._id) return a.globalData.user._id;
    const u = wx.getStorageSync(USER_SNAPSHOT);
    return (u && u._id) || '';
  } catch (_) { return ''; }
}

/**
 * 静默登录：wx.login 拿 code → 云函数换 openid → 建档/取用户
 * 云环境未就绪时直接 resolve(null)，不阻塞页面
 */
function ensureLogin() {
  return new Promise((resolve, reject) => {
    const a = app();
    if (!a || !a.globalData.cloudReady) {
      return resolve(null);
    }
    wx.login({
      success: async (res) => {
        if (!res.code) {
          return resolve(null);
        }
        try {
          const user = await call('ensureUser', { code: res.code });
          if (a) a.globalData.user = user;
          saveUser(user);
          resolve(user);
        } catch (e) {
          reject(e);
        }
      },
      fail: () => resolve(null),
    });
  });
}

/** 刷新用户（积分 / 会员状态） */
async function refreshUser() {
  const a = app();
  if (!a || !a.globalData.cloudReady) return null;
  if (refreshing) return refreshing;
  const previous = a.globalData.user;
  refreshing = (async () => {
    try {
      const user = await call('getUser', {});
      // A confirmed gift/payment/account update during this request wins over an older response.
      if (a.globalData.user !== previous) return a.globalData.user || null;
      a.globalData.user = user;
      saveUser(user);
      return user;
    } catch (_) { return a.globalData.user || null; }
    finally { refreshing = null; }
  })();
  return refreshing;
}

/** 取本地缓存的用户（同步，不进网络） */
function currentUser() {
  const a = app();
  return (a && a.globalData.user) || null;
}

module.exports = { ensureLogin, refreshUser, currentUser, restoreUser, saveUser, localUid };
