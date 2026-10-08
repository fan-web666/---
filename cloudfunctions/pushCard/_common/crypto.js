// _common/crypto.js - SHA1 / MD5（服务号服务器配置验签等）
const crypto = require('crypto');

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/**
 * 微信服务器配置验签：
 * signature = sha1( sort([token, timestamp, nonce]).join('') )
 * @returns {boolean}
 */
function verifyWechatSignature(token, signature, timestamp, nonce) {
  if (!signature || !timestamp || !nonce) return false;
  const arr = [token, timestamp, nonce].sort();
  return sha1(arr.join('')) === signature;
}

module.exports = { sha1, md5, verifyWechatSignature };
