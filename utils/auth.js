// utils/auth.js - 登录建档与用户信息
const { call } = require('./api');

const app = () => getApp();

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
  try {
    const user = await call('getUser', {});
    if (a) a.globalData.user = user;
    return user;
  } catch (e) {
    return (a && a.globalData.user) || null;
  }
}

/** 取本地缓存的用户（同步，不进网络） */
function currentUser() {
  const a = app();
  return (a && a.globalData.user) || null;
}

module.exports = { ensureLogin, refreshUser, currentUser };
