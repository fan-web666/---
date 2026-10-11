// _common/order.js - 订单发货（api 与 payNotify 共用，保证两条通道行为完全一致）
/**
 * 为什么单独一份：
 *   支付结果有**两条通道**抵达服务端 ——
 *     ① 端上 wx.requestVirtualPayment success → api#confirmOrder（查单确认）
 *     ② 微信服务器支付推送 → payNotify 云函数
 *   两条通道必须走**同一套发货逻辑**，否则「改一处漏一处」迟早出现金额 / 时长不一致。
 *
 * 幂等设计：
 *   发货前先把订单 pending → paid（**条件更新**），只有更新成功的那一次才真正发货。
 *   条件更新天然挡住「端上重复提交」「推送与查单同时到达」两类重复。
 *   ⚠️ 发货失败时订单**留在 paid**（不回滚）：钱已收，重试比退款安全；
 *      重试入口 = 用户再点一次支付结果确认，或推送通道重投。
 */
const { COLL } = require('./db');
const { track } = require('./track');
const { addRechargedCredits, grantMembership } = require('./user');
const { MEMBER_PLANS } = require('./consts');

/** 异常 → 一行可读文本（只用于日志与落库排查，不面向用户） */
function errText(e) {
  if (!e) return 'unknown';
  if (typeof e === 'string') return e;
  return String(e.msg || e.message || e.errMsg || e.code || 'unknown');
}

/**
 * 发货（幂等）
 * @param {object} order orders 文档，须含 _id / uid / type / status
 * @param {object} [extra] 合并进本次状态更新的附加字段（如 confirm_via / transaction_id）
 */
async function deliverOrder(order, extra) {
  if (!order || !order._id) return { ok: false, reason: 'order_not_found' };
  if (order.status === 'delivered') return { ok: true, duplicated: true };

  if (order.status === 'pending') {
    const upd = await COLL
      .orders()
      .where({ _id: order._id, status: 'pending' })
      .update({
        data: Object.assign(
          { status: 'paid', paid_at: new Date(), updated_at: new Date() },
          extra || {}
        ),
      });
    if (!upd.stats || !upd.stats.updated) {
      // 别人抢先处理了（重复请求 / 两条通道同时到达）
      return { ok: true, duplicated: true };
    }
  } else if (order.status !== 'paid') {
    return { ok: false, reason: 'bad_status:' + order.status };
  }

  try {
    if (order.type === 'recharge') {
      await addRechargedCredits(order.uid, order.credits, order._id, order.amount_cents);
    } else if (order.type === 'member') {
      await grantMembership(order.uid, MEMBER_PLANS[order.plan_id], order._id, order.amount_cents);
    } else {
      throw new Error('unknown_order_type:' + order.type);
    }
    await COLL.orders().doc(order._id).update({
      data: { status: 'delivered', delivered_at: new Date(), updated_at: new Date() },
    });
    await track({
      uid: order.uid,
      event: 'order_delivered',
      props: { order: order._id, type: order.type, amount_cents: order.amount_cents },
    });
    // 通知微信「已发货完成」（虚拟支付兜底接口）
    // ⭐ 必须自己吞异常：这一步失败若冒泡到下面的 catch，会把「已成功发货」误报成 deliver_failed
    let wxNotify = { ok: false };
    try {
      wxNotify = await notifyWxProvided(order);
    } catch (e) {
      console.error('[order] 通知微信「已发货」异常（不影响积分）', order._id, errText(e));
    }
    return { ok: true, delivered: true, wx_notified: !!wxNotify.ok };
  } catch (e) {
    const msg = errText(e);
    console.error('[order] 发货失败，订单留在 paid 待重试', order._id, msg);
    try {
      await COLL.orders().doc(order._id).update({
        data: { deliver_error: msg, updated_at: new Date() },
      });
    } catch (e2) {
      // 忽略：状态已推进到 paid，重试入口仍可用
    }
    return { ok: false, reason: 'deliver_failed', msg };
  }
}

/**
 * 尽力通知微信「已发货完成」（虚拟支付兜底接口，实现见 `_common/virtualpay.js#notifyProvideGoods`）
 *
 * 为什么需要：微信侧订单状态机 `1 已创建 → 2 已付待发 → 3 发货中 → 4 已发货`。
 *   我们只在自己库里发积分/开会员，**没回告微信** → 订单长期停在 3。
 *   官方要求走一次 `notify_provide_goods` 收尾（官方原话：正常靠推送返回成功即可，
 *   本接口用于推送不成功时**手动**把单改成已发货）。
 *
 * ⭐ 容错铁律：**失败绝不抛错、绝不影响积分到账**——积分已经发出去了，这只是微信侧的状态回告。
 *    结果落库（`wx_notified_at` / `wx_notify_error`）供事后用 `retryWxNotify` 补发。
 * ⭐ 幂等：微信侧对同一单重复通知无害，可安全重试。
 *
 * @param {object} order orders 文档，须含 `_id` / `out_trade_no`
 */
async function notifyWxProvided(order) {
  if (!order || !order._id) return { ok: false, reason: 'order_not_found' };
  if (!order.out_trade_no) return { ok: false, reason: 'no_out_trade_no' };
  // 惰性 require：避免 order ⇄ virtualpay 顶层相互加载，也只在真正要用时才付出加载成本
  let vpay;
  try {
    vpay = require('./virtualpay');
  } catch (e) {
    return { ok: false, reason: 'module_missing', msg: errText(e) };
  }
  try {
    await vpay.notifyProvideGoods({ outTradeNo: order.out_trade_no });
    try {
      await COLL.orders().doc(order._id).update({
        data: { wx_notified_at: new Date(), wx_notify_error: null, updated_at: new Date() },
      });
    } catch (e2) {
      // 落库失败不影响结论：微信那边已经收到了
    }
    return { ok: true };
  } catch (e) {
    const msg = errText(e);
    console.error('[order] 通知微信「已发货」失败（不影响积分）', order._id, msg);
    try {
      await COLL.orders().doc(order._id).update({
        data: { wx_notify_error: msg, updated_at: new Date() },
      });
    } catch (e2) {
      // 忽略：仅日志
    }
    return { ok: false, reason: 'wx_notify_failed', msg };
  }
}

/** 按业务订单号查订单（支付推送里只有 outTradeNo，没有内部 _id） */
async function findOrderByOutTradeNo(outTradeNo) {
  const t = String(outTradeNo || '');
  if (!t) return null;
  const r = await COLL.orders().where({ out_trade_no: t }).limit(1).get();
  return (r.data || [])[0] || null;
}

/**
 * 按订单号发货（推送通道入口）
 * ⭐ 用 out_trade_no 反查，**不依赖事件名**：微信推送的事件类型可能随渠道 / 版本不同，
 *    但只要订单号对得上、订单还没发货，就应该发货。
 */
async function deliverByOutTradeNo(outTradeNo, extra) {
  const order = await findOrderByOutTradeNo(outTradeNo);
  if (!order) return { ok: false, reason: 'order_not_found' };
  return deliverOrder(order, extra);
}

module.exports = {
  deliverOrder,
  notifyWxProvided,
  findOrderByOutTradeNo,
  deliverByOutTradeNo,
  errText,
};
