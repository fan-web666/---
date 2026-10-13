// utils/auth.js - 登录建档与用户信息
const { call } = require('./api');

const app = () => getApp();
let refreshing = null;
const USER_SNAPSHOT = 'last_confirmed_user_v1';
function saveUser(user) { if(!user||!user._id)return;try{wx.setStorageSync(USER_SNAPSHOT,user);}catch(_){} }
function restoreUser() { try { const user=wx.getStorageSync(USER_SNAPSHOT);if(user&&user._id){app().globalData.user=user;return user;} } catch(_){} return null; }

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

module.exports = { ensureLogin, refreshUser, currentUser, restoreUser, saveUser };
