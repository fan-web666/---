/**
 * 企业微信「微信客服」底层工具（自包含，不依赖项目其它 _common）
 *
 * 职责：回调签名 / AES 加解密 / access_token / kf.sync_msg
 *
 * ⚠️ 企业微信回调与微信公众平台（服务号）最大的差异：
 *    **强制 AES 加密**。收到的 POST body 是 <xml><Encrypt>…</Encrypt></xml>，
 *    必须用 EncodingAESKey 解密后才能看到明文；URL 校验时 echostr 同样是密文。
 */
const crypto = require('crypto');
const https = require('https');

// ============================================================
// 一、签名
// 企微：msg_signature = sha1( sort(token, timestamp, nonce, encrypt).join('') )
// ============================================================
function calcSignature(token, timestamp, nonce, encrypt) {
  const raw = [String(token), String(timestamp), String(nonce), String(encrypt || '')]
    .sort()
    .join('');
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

// ============================================================
// 二、AES-256-CBC
// EncodingAESKey 是 43 字符，补 '=' 后 base64 解码 = 32 字节 key
// IV = key 的前 16 字节
// 明文结构：random(16) + msg_len(4, 大端) + msg + receiveid
// ============================================================
function aesKeyBuf(encodingAESKey) {
  return Buffer.from(String(encodingAESKey || '').trim() + '=', 'base64');
}

function pkcs7Unpad(buf) {
  if (!buf || !buf.length) return buf;
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.slice(0, buf.length - pad);
}

function pkcs7Pad(buf) {
  const blockSize = 32;
  const pad = blockSize - (buf.length % blockSize) || blockSize;
  const padBuf = Buffer.alloc(pad, pad);
  return Buffer.concat([buf, padBuf]);
}

/** 解密 → { msg, receiveId } */
function decrypt(encodingAESKey, encryptedBase64) {
  const key = aesKeyBuf(encodingAESKey);
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let out = Buffer.concat([
    decipher.update(Buffer.from(String(encryptedBase64 || ''), 'base64')),
    decipher.final(),
  ]);
  out = pkcs7Unpad(out);
  const msgLen = out.readUInt32BE(16);
  const msg = out.slice(20, 20 + msgLen).toString('utf8');
  const receiveId = out.slice(20 + msgLen).toString('utf8');
  return { msg, receiveId };
}

/** 加密（回包/主动发消息时备用） */
function encrypt(encodingAESKey, msg, receiveId) {
  const key = aesKeyBuf(encodingAESKey);
  const iv = key.slice(0, 16);
  const msgBuf = Buffer.from(String(msg || ''), 'utf8');
  const ridBuf = Buffer.from(String(receiveId || ''), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const plain = pkcs7Pad(Buffer.concat([crypto.randomBytes(16), lenBuf, msgBuf, ridBuf]));
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

// ============================================================
// 三、HTTPS 请求
// ============================================================
function httpsJson(method, url, body) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('bad url: ' + url));
    }
    const data = body === undefined || body === null ? '' : JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + (u.search || ''),
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          data ? { 'Content-Length': Buffer.byteLength(data) } : {}
        ),
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            resolve({ _raw: text.slice(0, 2000), _status: res.statusCode });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('https timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// ============================================================
// 四、access_token（内存缓存，云函数实例内复用）
// ============================================================
const tkCache = { value: '', expireAt: 0 };

async function getAccessToken(corpId, secret) {
  const now = Date.now();
  if (tkCache.value && now < tkCache.expireAt) {
    return { token: tkCache.value, cached: true };
  }
  const url =
    'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' +
    encodeURIComponent(corpId) +
    '&corpsecret=' +
    encodeURIComponent(secret);
  const r = await httpsJson('GET', url);
  if (!r || !r.access_token) {
    const e = new Error('gettoken 失败');
    e.detail = r;
    throw e;
  }
  tkCache.value = r.access_token;
  tkCache.expireAt = now + (Number(r.expires_in || 7200) - 600) * 1000;
  return { token: r.access_token, cached: false };
}

// ============================================================
// 五、微信客服 API
// ============================================================
/**
 * 读取消息（客户发给客服的消息）。
 * ⚠️ 不带 cursor 时「从 3 天内最早的消息开始返回」—— 正是实测要的。
 *    token 可传可不传（不传有频率限制）。
 */
async function syncMsg(accessToken, opts) {
  const o = opts || {};
  const body = { limit: 1000 };
  if (o.token) body.token = o.token;
  if (o.cursor) body.cursor = o.cursor;
  if (o.openKfId) body.open_kfid = o.openKfId;
  if (o.voiceFormat !== undefined) body.voice_format = o.voiceFormat;
  return httpsJson(
    'POST',
    'https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=' + encodeURIComponent(accessToken),
    body
  );
}

/** 客服账号列表（排查用：确认 open_kfid 是否正确） */
async function accountList(accessToken) {
  return httpsJson(
    'POST',
    'https://qyapi.weixin.qq.com/cgi-bin/kf/account/list?access_token=' + encodeURIComponent(accessToken),
    { offset: 0, limit: 100 }
  );
}

// ============================================================
// 六、极简 XML 取值
// ⚠️ 与 receiveCallback#parseMessage 同一套写法：CDATA 与普通文本是两个**互斥必经分支**。
//    写成可选组 (?:...)? 会让正则优先跳过 → 全部取成空（本项目已踩过这个坑）。
// ============================================================
function pickTag(xml, tag) {
  const re = new RegExp(
    '<' + tag + '>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/' + tag + '>',
    'i'
  );
  const m = re.exec(String(xml || ''));
  if (!m) return '';
  return String(m[1] !== undefined ? m[1] : m[2] || '').trim();
}

/** 把明文 XML 全字段解析成对象（不依赖固定字段表） */
function parseAll(xml) {
  const out = {};
  const re = /<([A-Za-z_][A-Za-z0-9_]*)(?:\s[^>]*)?>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    if (m[1] !== 'xml') out[m[1]] = String(m[2] !== undefined ? m[2] : m[3] || '').trim();
  }
  return out;
}

module.exports = {
  calcSignature,
  decrypt,
  encrypt,
  parseAll,
  pickTag,
  httpsJson,
  getAccessToken,
  syncMsg,
  accountList,
};
