// _common/util.js - 云函数公共工具
const cloud = require('wx-server-sdk');

/** 统一成功返回 */
function ok(data) {
  return { code: 0, data: data === undefined ? null : data };
}

/** 统一失败返回 */
function err(msg, code) {
  return { code: code || 1, msg: msg || '操作失败' };
}

/** 获取调用上下文（openid/appid/unionid） */
function getContext() {
  try {
    const ctx = cloud.getWXContext();
    return {
      openid: ctx.OPENID || '',
      appid: ctx.APPID || '',
      unionid: ctx.UNIONID || '',
      source: ctx.SOURCE || '',
    };
  } catch (e) {
    return { openid: '', appid: '', unionid: '', source: '' };
  }
}

/** 简单 JSON 字符串 */
function toJson(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return '';
  }
}

function safeParse(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/** 时长上限检查文案 */
function durationRejectText(sec) {
  const m = Math.round((Number(sec) || 0) / 60);
  return '视频约 ' + m + ' 分钟，超过 30 分钟暂不支持；建议截取关键片段（10~30 分钟视频按双倍消耗）';
}

module.exports = { ok, err, getContext, toJson, safeParse, durationRejectText };
