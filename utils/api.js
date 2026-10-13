// utils/api.js - 云函数统一调用封装（小程序端）
// 后端网关云函数名：api（按 action 分发）
const config = require('../config/index');
const { toast } = require('./util');

const FN_NAME = 'api';

/**
 * 把 wx.cloud.callFunction 的原始错误归类成可读提示。
 *
 * 原实现把所有失败一律压成 config.apiTimeoutTip（「网络开小差了」），
 * 于是「云函数没部署」「集合没建」「环境没就绪」全长得一样，排查时线索全丢。
 * 这里按 errMsg 关键字分流，让提示直接指向真因。
 *
 * @returns {{ kind: string, msg: string }}
 */
function describeCloudError(err) {
  if (!config.cloudEnvId) {
    return { kind: 'NO_ENV_ID', msg: '云环境未配置' };
  }
  const raw =
    String((err && (err.errMsg || err.message)) || '') +
    ' ' +
    String((err && err.errCode) || '');

  if (/FUNCTION_NOT_FOUND|function.*not.*found|FunctionName parameter/i.test(raw)) {
    return { kind: 'FN_NOT_FOUND', msg: '云函数尚未部署，请先上传云函数' };
  }
  if (/collection.*not.*exist|COLLECTION_NOT_EXIST/i.test(raw)) {
    return { kind: 'NO_COLLECTION', msg: '数据表尚未创建，请先在云开发控制台建集合' };
  }
  if (/env.*not.*exist|invalid scope|INVALID_ENV/i.test(raw)) {
    return { kind: 'ENV_NOT_READY', msg: '云环境尚未就绪，请稍后重试' };
  }
  if (/timeout|TIME_LIMIT|ESOCKETTIMEDOUT/i.test(raw)) {
    return { kind: 'TIMEOUT', msg: '请求超时，请稍后重试' };
  }
  if (/network|ERR_INTERNET|ERR_CONNECTION|请求失败/i.test(raw)) {
    return { kind: 'NETWORK', msg: config.apiTimeoutTip };
  }
  return { kind: 'UNKNOWN', msg: config.apiTimeoutTip };
}

/**
 * 调用业务网关
 * @param {string} action 业务动作
 * @param {object} data   业务参数
 * @returns {Promise<any>} code=0 时 resolve data，否则 reject {code,kind,msg,raw}
 */
function call(action, data) {
  const cache = require('./view-cache');
  const owner = cache.uid();
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      return reject(Object.assign(new Error('当前微信版本过低，请升级后使用'), { code: -2 }));
    }
    wx.cloud
      .callFunction({
        name: FN_NAME,
        data: Object.assign({ action }, require('./referral-entry').requestData(), data || {}),
        // ⚠️ 必须显式给足超时。getTask 不只是读状态，还会「顺带推进一步流水线」
        //    （服务端预算 30 秒）；若这一步刚好卡在下游请求的硬超时上（下载最长 45 秒），
        //    整个调用可能接近 50 秒。用默认超时的话，服务端还在正常干活，
        //    客户端就先报「网络开小差了」—— 用户看到的是假故障。
        config: { timeout: 60000 },
      })
      .then((res) => {
        const r = res && res.result;
        if (r && r.code === 0) {
          if (owner && owner === cache.uid() && r.data) {
            const save = d => { if(d && d._id) cache.write('result_' + d._id,d); };
            if (action === 'getCopywriting') save(r.data);
            if (action === 'listCopywritings') (r.data.list || []).forEach(row => save(row.detail));
            if (r.data.result_detail) save(r.data.result_detail);
            if (action === 'userStats' && r.data.latest) save(r.data.latest.detail);
            if (action === 'deleteCopywriting') cache.write('result_' + data.id,null);
          }
          if (r.data && r.data.referralEntryState) require('./referral-entry').settle(r.data.referralEntryState);
          resolve(r.data);
        } else {
          const msg = (r && r.msg) || '操作失败，请稍后重试';
          reject(Object.assign(new Error(msg), { code: r && r.code, raw: r }));
        }
      })
      .catch((err) => {
        const d = describeCloudError(err);
        reject(Object.assign(new Error(d.msg), { code: -1, kind: d.kind, raw: err }));
      });
  });
}

/**
 * 供页面 catch 统一提示
 * @param {*} err           错误对象
 * @param {string} fallback 兜底文案
 * @param {object} [opts]   { silent: true } 时只打日志、不弹 toast。
 *                          用于页面的「自动加载」（用户没做任何操作就发起的请求，
 *                          失败时弹模态提示很打扰）；用户主动操作仍应正常提示。
 */
function handleError(err, fallback, opts) {
  const msg = (err && err.message) || fallback || '出错了，请稍后重试';
  if (opts && opts.silent) {
    console.warn('[api] ' + msg, (err && err.raw) || err);
    return;
  }
  toast(msg);
}

module.exports = { call, handleError, FN_NAME };
