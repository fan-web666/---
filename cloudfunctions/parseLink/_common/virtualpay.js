// _common/virtualpay.js - 微信小程序「虚拟支付」接入（签名 / 下单参数 / 查单 / 回调验签）
/**
 * 为什么必须走它：
 *   积分、会员都属于**虚拟商品**。微信规则：小程序内售卖虚拟商品只能用「小程序虚拟支付」，
 *   用普通微信支付（wx.requestPayment）被检测到会**封禁支付能力、甚至下架**；
 *   且自 2026-04-01 起要求**全终端（iOS / 安卓 / 鸿蒙 / Windows）**完成接入。
 *
 * 两种模式（同一 offerId 下可混用，靠 wx.requestVirtualPayment 的 mode 参数区分）：
 *   · short_series_coin  代币充值 —— 买 N 个支付代币，到账业务积分由订单 credits 独立确定，
 *                        1 元 = 10 支付代币（MP 后台「代币配置」的兑换比例必须与此一致，且**发布后不可改**）
 *                        → **任意金额天然支持**，充值页的「自定义金额」靠它
 *   · short_series_goods 道具直购 —— 买 MP 后台预先配好的道具，goodsPrice 必须与后台价格一致
 *                        → 会员套餐（月/季/年/不限次）走这条，后台「道具管理」里配 4 个
 *
 * 签名（官方伪代码，勿改）：
 *   paySig    = to_hex(hmac_sha256(appKey,     'requestVirtualPayment' + '&' + signData))
 *   signature = to_hex(hmac_sha256(sessionKey, signData))
 *   ⚠️⚠️ signData 必须**由服务端生成、端上原样透传**：签名与下单报文要逐字节一致，
 *        端上自己拼 JSON 极易因字段顺序 / 空格不同而报 -15005 / -15006 签名错误。
 *
 * 环境变量（云函数「配置 → 环境变量」）：
 *   VIRTUAL_PAY_READY=true          能力开关（缺省 false）
 *   VIRTUAL_PAY_OFFER_ID=...        MP → 虚拟支付 → 基本配置里的 offerId
 *   VIRTUAL_PAY_APPKEY=...          现网 AppKey（env=0 用）
 *   VIRTUAL_PAY_SANDBOX_APPKEY=...  沙箱 AppKey（env=1 用；⚠️ iOS 苹果支付**不支持沙箱**）
 *   VIRTUAL_PAY_ENV=0               0 现网 / 1 沙箱（缺省 0）
 *   MINI_APPSECRET=...              小程序 AppSecret（换 access_token 与会话密钥，必配）
 *   MINI_APPID=...                  可选；缺省时用调用上下文里的 APPID
 *
 * ⚠️ 未就绪时**绝不返回假支付参数**，一律明确失败（降级原则）。
 */
const https = require('https');
const crypto = require('crypto');
const { COLL } = require('./db');
const { env } = require('./providers');
const { getContext } = require('./util');
// 支付代币比例独立于业务积分；沿用已配置的 1 元 = 10 代币。

/** 基础库 wx.requestVirtualPayment 的固定 uri（签名口径） */
const WX_URI = 'requestVirtualPayment';

/**
 * 代币与人民币比例：1 元 = 10 代币
 * 支付代币与到账积分分开：每元仍购买 10 代币，订单按每元 20 业务积分发货；
 *    MP 后台「代币配置」的兑换比例也必须与此一致，且**发布后不可修改**。
 */
const COIN_PER_YUAN = 10;

const MODE_COIN = 'short_series_coin'; // 代币充值
const MODE_GOODS = 'short_series_goods'; // 道具直购

/* ---------------- 环境变量 ---------------- */

function envStr(key, def) {
  const v = env(key, def === undefined ? '' : def);
  return v === undefined || v === null ? '' : String(v).trim();
}

/** 0 现网 / 1 沙箱 */
function payEnv() {
  return envStr('VIRTUAL_PAY_ENV', '0') === '1' ? 1 : 0;
}

function offerId() {
  return envStr('VIRTUAL_PAY_OFFER_ID');
}

/** 按 env 取对应 AppKey —— 现网与沙箱是**两把不同的钥匙** */
function appKey() {
  return payEnv() === 1 ? envStr('VIRTUAL_PAY_SANDBOX_APPKEY') : envStr('VIRTUAL_PAY_APPKEY');
}

function paySwitchOn() {
  return envStr('VIRTUAL_PAY_READY', 'false') === 'true';
}

/** 是否具备下单条件：开关 + offerId + 对应 AppKey，三样齐备才算就绪 */
function payReady() {
  return paySwitchOn() && !!offerId() && !!appKey();
}

/** 给用户看的文案（不暴露技术细节） */
const NOT_READY_USER_MSG = '在线支付尚未开放，开放后可在此直接充值 / 开通会员';

/** 给运维看的排查线索（只写日志与埋点，不进用户提示） */
const NOT_READY_TIP =
  '虚拟支付未就绪：需在 MP「虚拟支付」完成开通与代币/道具配置，并在云函数配置 ' +
  'VIRTUAL_PAY_READY=true、VIRTUAL_PAY_OFFER_ID、VIRTUAL_PAY_APPKEY';

/* ---------------- 签名 ---------------- */

function hmacHex(key, msg) {
  return crypto.createHmac('sha256', String(key)).update(String(msg), 'utf8').digest('hex');
}

/** 支付签名（服务端持有 AppKey，证明请求由自家服务端发起） */
function paySig(signData) {
  return hmacHex(appKey(), WX_URI + '&' + signData);
}

/** 用户态签名（绑定当前用户，需其有效会话密钥） */
function userSig(signData, sessionKey) {
  return hmacHex(sessionKey, signData);
}

/** 回调验签：pay_event_sig = hex(hmac_sha256(appKey, event + '&' + payload)) */
function verifyEventSig(event, payload, sig) {
  const key = appKey();
  if (!key || !sig) return false;
  const expect = hmacHex(key, String(event) + '&' + String(payload));
  const got = String(sig);
  if (expect.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got));
  } catch (e) {
    return false;
  }
}

/* ---------------- 下单参数 ---------------- */

/**
 * 业务订单号
 * ⚠️ 微信要求：8~32 字符；只允许 数字 / 大小写字母 / _ - | * @ ；**不能以 _ 开头**；
 *    且**每单唯一、不可重复使用**（重复会报 -15002）
 */
function genOutTradeNo(prefix) {
  const t = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(5).toString('hex').toUpperCase();
  return (prefix || 'VP') + t + r; // 约 20~23 字符，落在合法区间
}

function toInt(v, def) {
  const n = Math.round(Number(v));
  return isFinite(n) && n > 0 ? n : def;
}

function attachStr(attach) {
  if (!attach) return '{}';
  return typeof attach === 'string' ? attach : JSON.stringify(attach);
}

/**
 * 代币充值 signData（mode = short_series_coin）
 * @param {number} coinAmount 购买的支付代币数量（不等于到账业务积分数）
 */
function buildCoinSignData({ coinAmount, outTradeNo, attach }) {
  return JSON.stringify({
    offerId: offerId(),
    buyQuantity: toInt(coinAmount, 1),
    env: payEnv(),
    currencyType: 'CNY',
    outTradeNo: String(outTradeNo),
    attach: attachStr(attach),
  });
}

/**
 * 道具直购 signData（mode = short_series_goods）
 * ⚠️ goodsPrice 单位「分」，且**必须与后台道具价格一致**，否则下单报 -15013
 */
function buildGoodsSignData({ productId, goodsPrice, buyQuantity, outTradeNo, attach }) {
  return JSON.stringify({
    offerId: offerId(),
    buyQuantity: toInt(buyQuantity, 1),
    env: payEnv(),
    currencyType: 'CNY',
    productId: String(productId || ''),
    goodsPrice: toInt(goodsPrice, 0),
    outTradeNo: String(outTradeNo),
    attach: attachStr(attach),
  });
}

/**
 * 打包成端上 wx.requestVirtualPayment 的完整参数
 * @param {string} mode MODE_COIN | MODE_GOODS
 */
function buildPayParams({ mode, signData, sessionKey }) {
  return {
    signData,
    paySig: paySig(signData),
    signature: userSig(signData, sessionKey),
    mode,
  };
}

/* ---------------- 微信接口调用 ---------------- */

function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // ⚠️⚠️⚠️ 真凶在这里（2026-09-29 定案）：Node 的 https.request 若**不显式设 Content-Length**，
    //   `req.write()` 会自动改用 `Transfer-Encoding: chunked`；而**微信服务器不支持 chunked 请求体**
    //   → 网关直接回 **HTTP 412 + 空 body**（不给 errcode、不进业务层，极易误判成「签名错 / 接口挂了」）。
    //   铁证：不带签名、假签名、真签名**三者同样 412**；`/cgi-bin/token` 因为是 GET 无 body 所以正常
    //   —— 差别只在「是否带 body」，与 pay_sig 完全无关。
    //   → 必须显式给 Content-Length（**字节数**，不是字符数）。
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }
    const req = https.request(
      {
        method: method || 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers,
        timeout: 12000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
        res.on('end', () => {
          const code = res.statusCode || 0;
          const where = (method || 'GET') + ' ' + u.pathname;
          const raw = Buffer.concat(chunks).toString('utf8');
          // ⚠️ 以下三类异常必须把 HTTP 细节带出来，否则只剩
          //    「Unexpected end of JSON input」这种零信息量的报错（2026-09-29 踩过）
          if (!raw.trim()) {
            const e = new Error(
              '微信接口返回空响应：HTTP ' +
                code +
                ' @ ' +
                where +
                (res.headers && res.headers.location ? '（疑似重定向 → ' + res.headers.location + '）' : '')
            );
            e.statusCode = code;
            e.headers = res.headers;
            e.raw = '';
            return reject(e);
          }
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            const e = new Error(
              '微信接口返回非 JSON：HTTP ' + code + ' @ ' + where + ' → ' + raw.slice(0, 300)
            );
            e.statusCode = code;
            e.headers = res.headers;
            e.raw = raw.slice(0, 1000);
            return reject(e);
          }
          if (code >= 300) {
            const e = new Error('微信接口 HTTP ' + code + ' @ ' + where + ' → ' + raw.slice(0, 300));
            e.statusCode = code;
            e.headers = res.headers;
            e.raw = raw.slice(0, 1000);
            return reject(e);
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('wx api timeout')));
    // body 允许直接传**已序列化的字符串**（签名要求「发出的 payload 与签名字符串一致」）；
    // ⚠️ 必须写与 Content-Length 完全相同的那个 payload 字符串（不重新 stringify、不触发 chunked）
    if (payload) req.write(payload);
    req.end();
  });
}

function miniAppid() {
  return envStr('MINI_APPID') || getContext().appid || '';
}

function miniSecret() {
  return envStr('MINI_APPSECRET');
}

/**
 * 小程序 access_token
 * ⚠️ 与服务号 access_token 是**两套**（wxapi.js 里那个是服务号的）→ 缓存单独用 _id='mini_token'
 */
async function miniToken(force) {
  const appid = miniAppid();
  const secret = miniSecret();
  if (!appid) {
    throw new Error(
      'MINI_APPID 缺失：环境变量未配且当前上下文无 appid（控制台「测试」调用即如此），无法调用微信接口'
    );
  }
  if (!secret) {
    throw new Error('MINI_APPSECRET 未配置（云函数环境变量），无法调用微信接口');
  }
  if (!force) {
    try {
      const r = await COLL.config().doc('mini_token').get();
      const d = r.data;
      if (d && d.access_token && d.expires_at > Date.now() + 300000) return d.access_token;
    } catch (e) {
      // 首次无缓存
    }
  }
  const res = await httpJson(
    'GET',
    'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' +
      encodeURIComponent(appid) +
      '&secret=' +
      encodeURIComponent(secret)
  );
  if (!res.access_token) throw new Error('获取小程序 access_token 失败: ' + JSON.stringify(res));
  try {
    await COLL.config().doc('mini_token').set({
      data: {
        access_token: res.access_token,
        expires_at: Date.now() + res.expires_in * 1000,
        updated_at: new Date(),
      },
    });
  } catch (e) {
    // 并发写失败忽略（token 仍在本次调用内有效）
  }
  return res.access_token;
}

/**
 * code2Session：用 wx.login 的 code 换 openid + **会话密钥**
 * ⚠️ 云开发 getWXContext() 只给 openid，**拿不到 session_key**；
 *    而虚拟支付的 signature 必须要它 → 只能显式调这个接口（所以必须配 AppSecret）
 */
async function code2Session(code) {
  const appid = miniAppid();
  const secret = miniSecret();
  if (!appid) {
    throw new Error('MINI_APPID 缺失（环境变量未配且上下文无 appid），无法换取会话密钥');
  }
  if (!secret) {
    throw new Error('MINI_APPSECRET 未配置（云函数环境变量），无法换取会话密钥');
  }
  if (!code) throw new Error('缺少 code');
  const res = await httpJson(
    'GET',
    'https://api.weixin.qq.com/sns/jscode2session?appid=' +
      encodeURIComponent(appid) +
      '&secret=' +
      encodeURIComponent(secret) +
      '&js_code=' +
      encodeURIComponent(code) +
      '&grant_type=authorization_code'
  );
  if (!res.session_key) throw new Error('code2Session 失败: ' + JSON.stringify(res));
  return { openid: res.openid || '', unionid: res.unionid || '', sessionKey: res.session_key };
}

/** 服务端 API 调用（uri 取接口路径，如 /xpay/query_order） */
async function callXpayApi(apiPath, body, sigUriOverride, keyOverride, forceToken) {
  // forceToken=true → 跳过本地缓存、强制重取 access_token
  //   ⚠️ 排查 HTTP 412 时必须能强制刷新：缓存里的失效旧 token 会伪装成「签名错」（2026-09-29）
  const token = await miniToken(!!forceToken);
  // ⚠️⚠️ 官方「签名避坑」：参与签名的 postBody 必须与**最终发出的 payload 字符串完全一致**，
  //      不能二次序列化。故此处只 stringify 一次拿到 postBody，把**同一个字符串**交给 httpJson
  //      —— 绝不能两边各写一次 JSON.stringify（2026-09-29 排查 HTTP 412 时修正）。
  const postBody = JSON.stringify(body || {});
  // sigUri 默认＝真实请求路径（如 /xpay/query_order）；可用第 3 参覆盖，供 sigProbe 试变体
  // 第 4 参 keyOverride：仅 sigProbe 用（免部署试不同 AppKey）；第 5 参 forceToken：跳过 token 缓存
  const sigKey = keyOverride ? String(keyOverride).trim() : appKey();
  const sig = hmacHex(sigKey, (sigUriOverride || apiPath) + '&' + postBody);
  const url =
    'https://api.weixin.qq.com' +
    apiPath +
    '?access_token=' +
    encodeURIComponent(token) +
    '&pay_sig=' +
    sig;
  return httpJson('POST', url, postBody);
}

/**
 * 查询现金订单（发货前的服务端确认，防端上伪造 success）
 * ⚠️ 部署前请对照官方「服务器 API › 查询创建的订单」核对 body 字段名与返回结构
 *    （本项目按 openid / out_trade_no / env 三个字段实现）
 */
async function queryOrder({ outTradeNo, openid, sigUri, appKeyOverride, envOverride, forceToken }) {
  // ⚠️⚠️ 官方 /xpay/query_order 的请求体字段是 **`order_id`**（值＝下单时 signData 里的 outTradeNo），
  //      没有 `out_trade_no` 这个字段 —— 写错会报 268490002「请求参数字段错误」→ 查单恒失败 → 积分不到账。
  // 字段顺序对齐官方/社区实证（openid → env → order_id）——防止服务端按固定顺序重组后验签
  // envOverride / appKeyOverride / forceToken 仅供 sigProbe 诊断用；正常调用不传
  const envMode =
    envOverride === undefined || envOverride === null ? payEnv() : Number(envOverride) === 1 ? 1 : 0;
  const keyOverride =
    appKeyOverride === undefined || appKeyOverride === null || String(appKeyOverride) === ''
      ? envMode === 1
        ? envStr('VIRTUAL_PAY_SANDBOX_APPKEY')
        : envStr('VIRTUAL_PAY_APPKEY')
      : String(appKeyOverride).trim();
  return callXpayApi(
    '/xpay/query_order',
    {
      openid: openid || '',
      env: envMode,
      order_id: outTradeNo,
    },
    sigUri,
    keyOverride,
    forceToken
  );
}

/**
 * 通知微信「已发货完成」（虚拟支付服务端接口 `notify_provide_goods`）
 *
 * ⚠️ 官方口径（2026-09-29 核对）：
 *   「通知已经发货完成（**只能通知现金单**），正常通过 xpay_goods_deliver_notify 消息推送返回成功
 *     就不需要调用这个 api 接口。**这个接口用于异常情况推送不成功时手动将单改成已发货状态**」
 *   → 即它是**兜底接口**：不调用不影响用户积分，但微信侧订单会长期停在 status=3「发货中」，
 *     影响后台订单状态、对账与退款链路。
 *
 * 请求体：`order_id`（＝下单时的 outTradeNo）与 `wx_order_id` **二选一**，`env` 必填。
 *   本项目 orders 表始终有 out_trade_no，故固定走 order_id，无需 wx_order_id。
 * 返回：无（成功即 200 + 空/{}）；失败按通用错误码返回。
 */
async function notifyProvideGoods({ outTradeNo, wxOrderId, envOverride }) {
  const envMode =
    envOverride === undefined || envOverride === null ? payEnv() : Number(envOverride) === 1 ? 1 : 0;
  const body = {};
  // 二选一：优先我方单号（一定有）；缺了才退回微信内部单号。字段顺序对齐官方列举顺序
  if (outTradeNo) body.order_id = String(outTradeNo);
  else if (wxOrderId) body.wx_order_id = String(wxOrderId);
  else throw new Error('notifyProvideGoods 需要 outTradeNo 或 wxOrderId');
  body.env = envMode;
  return callXpayApi('/xpay/notify_provide_goods', body);
}

module.exports = {
  COIN_PER_YUAN,
  MODE_COIN,
  MODE_GOODS,
  NOT_READY_USER_MSG,
  NOT_READY_TIP,
  payEnv,
  offerId,
  appKey,
  payReady,
  paySwitchOn,
  hmacHex,
  paySig,
  userSig,
  verifyEventSig,
  genOutTradeNo,
  buildCoinSignData,
  buildGoodsSignData,
  buildPayParams,
  miniAppid,
  miniSecret,
  miniToken,
  code2Session,
  httpJson,
  callXpayApi,
  queryOrder,
  notifyProvideGoods,
};
