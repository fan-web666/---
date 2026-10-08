// 云函数 payNotify - 微信虚拟支付「支付结果推送」入口（发货的第二条通道）
/**
 * ⭐ 现用通道（官方推荐）：云开发「消息推送」直推云函数
 *   1) 开发者工具 →「云开发」→「设置」→「其他设置」→「消息推送」→ 推送模式选「云函数」
 *      → 「添加消息推送配置」：消息类型 `event`、事件类型勾
 *        `xpay_goods_deliver_notify`（道具发货）＋ `xpay_coin_pay_notify`（代币支付），
 *        云函数环境＝当前环境、云函数＝本函数
 *      ⛔ 不要勾 `xpay_subscribe_ios_refund_query_notify`（要求 3 秒内返回 IosRefundQueryResponse，本项目未实现）
 *   2) 云函数环境变量（与 api 同一套，缺一不可）：
 *        VIRTUAL_PAY_READY=true
 *        VIRTUAL_PAY_OFFER_ID / VIRTUAL_PAY_APPKEY / VIRTUAL_PAY_ENV
 *        MINI_APPSECRET
 *   官方文档：
 *   https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/wechatpay/virtual-payment-callback.html
 *
 * **直推报文形态**（扁平结构，**不带签名字段**）：
 *   { ToUserName, FromUserName, CreateTime, MsgType:'event', Event, OpenId, OutTradeNo, Env }
 * **应答**：{ ErrCode: 0, ErrMsg: 'success' }；返回非 0 微信按 2/4/8/16… 秒重试（最多 15 次）
 *
 * ⚠️ 直推为什么可以不验签，以及**为什么必须拒绝小程序端直调**：
 *   直推是**云开发内部调用**，报文无 `pay_event_sig` → 无法验签；
 *   而云函数默认**可被小程序端 `wx.cloud.callFunction` 直调** → 若不拦，
 *   任何用户都能伪造 `{ Event:'xpay_goods_deliver_notify', OutTradeNo:'自己刚下的未付订单' }` **白拿积分**。
 *   故：`wx.cloud.callFunction` **必带 OPENID**，官方推送 / 内部调用 / 控制台测试**不带**
 *   → 见 `isClientCall()`：带 OPENID 一律拒。应急可用 `PAY_NOTIFY_ALLOW_ANY_CALL=true` 临时放行。
 *
 * **备用通道（本项目当前未启用）**：HTTP 访问服务 + 微信后台「消息推送」填 URL。该形态**带签名** → 走验签分支。
 *   ⚠️ HTTP 访问路由**只能**在腾讯云 CloudBase 控制台建（`console.cloud.tencent.com/tcb` → 左侧「HTTP 访问」→「域名及路由」），
 *      微信云开发控制台**没有**该入口（函数列表/详情/版本与配置/设置/扩展能力 5 处均无）。
 *
 * 为什么必须有这条通道：
 *   端上的 wx.requestVirtualPayment success 回调**会丢**（微信异常退出、网络中断都会），
 *   只靠它必然出现「用户付了钱、积分没到账」。官方要求「支付推送」与「查单」至少实现一个，
 *   本项目两条都做：本函数负责推送，api#confirmOrder 负责查单，发货逻辑共用 _common/order.js。
 *
 * ⭐ 发货幂等由 _common/order.js 的「pending → paid 条件更新」保证：
 *    推送重投、与端上查单同时到达，都只会发货一次。
 *
 * 应答约定：处理成功 {"ErrCode":0,"ErrMsg":"success"}；验签失败/未就绪返回非 0，
 *          微信会按 2/4/8/16… 秒重试（最多 15 次）——重试安全，不会重复发货。
 *
 * ✅ 直推报文与应答口径已按官方文档落实（2026-09-29 核对）：
 *    扁平 JSON：ToUserName / FromUserName / CreateTime / MsgType / Event / OpenId / OutTradeNo / Env；
 *    应答：{ ErrCode: 0, ErrMsg: 'success' }（非 0 触发重试）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { env } = require('./_common/providers');
const { getContext } = require('./_common/util');
const vpay = require('./_common/virtualpay');
const { deliverByOutTradeNo } = require('./_common/order');
const { track } = require('./_common/track');

/** 这些事件只是「确认收到」，不发货（退款 / 投诉 / 风控另有处理流程） */
const IGNORE_EVENTS = [
  'xpay_refund_notify',
  'xpay_complaint_notify',
  'xpay_wxpay_callback_notify',
  // ⚠️ 若将来要勾选它，**必须**返回 IosRefundQueryResponse（3 秒内、含 evidence），本项目未实现 → 勿勾
  'xpay_subscribe_ios_refund_query_notify',
];

/** 调试期跳过验签（默认关闭；⚠️ 生产环境务必保持 false）——只影响 HTTP 通道，直推通道本来就无签名字段 */
const SKIP_VERIFY = env('PAY_NOTIFY_SKIP_VERIFY', 'false') === 'true';

/** 应急开关：临时允许小程序端直调本函数（默认 false；仅在安全闸误判时才置 true） */
const ALLOW_ANY_CALL = env('PAY_NOTIFY_ALLOW_ANY_CALL', 'false') === 'true';

/**
 * 是否「小程序端直调」（wx.cloud.callFunction）
 * ⭐ 判据：用户端直调**必带 OPENID**；云开发消息推送 / 内部调用 / 控制台「测试」**都不带**。
 *    作用：挡住「伪造 Event ＋ OutTradeNo 直接白拿积分」这条路径。
 */
function isClientCall() {
  try {
    return !!getContext().openid;
  } catch (e) {
    return false;
  }
}

function okRes() {
  // ⭐ 官方口径：必须返回 ErrCode:0（ErrMsg 官方示例为 'success'）
  return { ErrCode: 0, ErrMsg: 'success' };
}

function failRes(msg) {
  return { ErrCode: 1, ErrMsg: String(msg || 'failed').slice(0, 120) };
}

/** 极简 XML 取值：只取首层 / 次层的简单标签（虚拟支付推送若为 XML 形态时兜底） */
function parseXmlFlat(xml) {
  const out = {};
  const re = /<([A-Za-z_][\w]*)>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (out[m[1]] === undefined) out[m[1]] = m[2];
  }
  return out;
}

/** 解析推送报文：JSON 优先，兼容 XML */
function parseBody(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  if (s.charAt(0) === '<') return parseXmlFlat(s);
  try {
    return JSON.parse(s);
  } catch (e) {
    return {};
  }
}

/** 从 header / query / body 里找 pay_event_sig（大小写与连字符都兼容） */
function pickSig(evt, bodyObj) {
  const want = 'payeventsig';
  const norm = (k) => String(k).toLowerCase().replace(/[_-]/g, '');
  const h = (evt && evt.headers) || {};
  for (const k of Object.keys(h)) {
    if (norm(k) === want) return h[k];
  }
  const q = (evt && evt.queryStringParameters) || {};
  for (const k of Object.keys(q)) {
    if (norm(k) === want) return q[k];
  }
  const b = bodyObj || {};
  for (const k of Object.keys(b)) {
    if (norm(k) === want) return b[k];
  }
  return '';
}

/**
 * 处理一条支付推送
 * @param {string} rawBody 原始报文体（验签必须用**原文**，不能是重新序列化后的字符串）
 * @param {object} evt 事件对象（HTTP 通道用它取 header/query 里的签名）
 * @param {boolean} [fromCloudPush] true＝云开发消息推送直推（报文无签名字段 → 免验签）
 */
async function handlePush(rawBody, evt, fromCloudPush) {
  const bodyObj = parseBody(rawBody);
  const ev = String(bodyObj.Event || bodyObj.event || '');
  const outTradeNo = String(bodyObj.OutTradeNo || bodyObj.out_trade_no || '');

  // 未就绪直接拒：宁可让微信重试，也不要在没配好的环境里乱发货
  if (!vpay.payReady()) return failRes('virtual pay not ready');

  // ⭐ 云开发直推通道不带 pay_event_sig → 免验签（可信性由 main 里的「拒绝小程序端直调」保证）；
  //    HTTP 通道仍照常验签
  if (!SKIP_VERIFY && !fromCloudPush) {
    const sig = pickSig(evt, bodyObj);
    if (!sig) return failRes('missing pay_event_sig');
    if (!vpay.verifyEventSig(ev, rawBody, sig)) {
      // ⚠️ 字段名 / 事件名口径与文档不符时这里会一直失败 → 看日志里的原始 body 对齐
      console.warn('[payNotify] 验签失败 event=%s body=%s', ev, String(rawBody).slice(0, 300));
      return failRes('bad signature');
    }
  }

  // 退款 / 投诉 / 风控：确认收到，但不发货
  if (IGNORE_EVENTS.indexOf(ev) >= 0) {
    await track({ event: 'pay_notify_ignored', props: { ev, outTradeNo } });
    return okRes();
  }

  if (!outTradeNo) return failRes('missing out_trade_no');

  // ⭐ 按订单号反查并发货，**不依赖事件名**：代币充值 / 道具发货的事件名可能不同，
  //    但只要订单号对得上、订单还没发货，就该发货（deliverOrder 幂等且只认 orders 表）
  const r = await deliverByOutTradeNo(outTradeNo, { confirm_via: 'push', push_event: ev });
  if (r.ok) return okRes();
  if (r.reason === 'order_not_found') {
    // 订单不存在（测试单 / 别的环境的单）：重试也没用，直接确认收到
    console.warn('[payNotify] 未找到订单 outTradeNo=%s event=%s', outTradeNo, ev);
    return okRes();
  }
  console.error('[payNotify] 发货失败 outTradeNo=%s reason=%s', outTradeNo, r.reason || r.msg);
  return failRes(r.reason || 'deliver failed');
}

exports.main = async (event) => {
  // ① HTTP 访问服务通道（备用，本项目当前未启用；该形态带签名 → 走验签）
  if (event && event.httpMethod) {
    if (String(event.httpMethod).toUpperCase() !== 'POST') {
      return { statusCode: 405, body: 'method not allowed' };
    }
    const r = await handlePush(event.body || '', event, false);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    };
  }

  // ② 云开发「消息推送 → 云函数」直推（现用通道）／ 控制台「测试」调试入口
  if (event && (event.Event || event.OutTradeNo || event.body || event.payload)) {
    // ⭐ 安全闸：带 OPENID ＝ 小程序端直调 → 拒绝
    //    （否则任何用户都能伪造 { Event:'xpay_goods_deliver_notify', OutTradeNo:'自己的未付订单' } 白拿积分）
    if (isClientCall() && !ALLOW_ANY_CALL) {
      console.warn(
        '[payNotify] 拒绝小程序端直调 event=%s outTradeNo=%s source=%s',
        String(event.Event || ''),
        String(event.OutTradeNo || ''),
        String(getContext().source || '')
      );
      return failRes('client call not allowed');
    }
    const raw = typeof event.body === 'string' ? event.body : JSON.stringify(event);
    return handlePush(raw, event, true);
  }

  return failRes('unsupported trigger');
};
