// 云函数 pushCard - 客服消息/订阅消息回推（PRD C-01/C-03/C-04/5.5 静默失败）
// 调用场景：A 链路解析成功推小程序卡片；静默失败(48h 窗口过期等)时用户进入小程序可触发补推
// 降级顺序：小程序卡片(miniprogrampage) → 文本卡片 → 订阅消息（PRD 12.5，模板需申请）
//
// ⚠️ 2026-09-28：本函数由**小程序端**调用 → 云调用自动鉴权成立 → 用 pushResultToUserDirect。
//    正式链路（receiveCallback 建任务）已改为「只标记待推送」，由 api#pushPending 推送。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { db, cmd, COLL } = require('./_common/db');
const { ok, err } = require('./_common/util');
const { pushResultToUserDirect } = require('./_common/pipeline');
const wxapi = require('./_common/wxapi');

/** 手动补推某条文案（小程序端在"有 N 条未推送"提醒处触发，或服务号侧下次互动补推） */
async function repushCopywriting({ id }) {
  if (!id) throw { code: 2, msg: '缺少参数' };
  const r = await COLL.copywritings().doc(id).get();
  const c = r.data;
  if (!c) throw { code: 3, msg: '内容不存在' };
  // 从 task 取 userOpenid
  let gzhOpenid = '';
  if (c.task_id) {
    try {
      const tr = await COLL.tasks().doc(c.task_id).get();
      gzhOpenid = tr.data && tr.data.userOpenid;
    } catch (e) {
      /* ignore */
    }
  }
  const task = { channel: c.channel, userOpenid: gzhOpenid };
  return pushResultToUserDirect(task, c);
}

/** 测试入口：向指定 openid 发文本 */
async function sendText({ openid, content }) {
  const res = await wxapi.sendKfText(openid, content);
  return { res };
}

exports.main = async (event) => {
  try {
    const type = (event && event.type) || 'repush';
    if (type === 'sendText') return ok(await sendText(event));
    if (type === 'repush') return ok(await repushCopywriting(event));
    return err('unknown type', 404);
  } catch (e) {
    return err((e && e.message) || '推送失败', 1);
  }
};
