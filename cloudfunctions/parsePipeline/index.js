// 云函数 parsePipeline - 解析队列兜底 Worker
// 触发：定时触发器（config.json，每 1 分钟）或人工/事件触发
// 职责（PRD 8.2 不丢任务 / 断点重投）：
//   1) 扫描「未完成」的任务（pending / downloading / transcribing / asr / llm 且 20 秒没动过），
//      尽量在本次调用内把它们推到终态 —— 前端中途退出、云函数被中断的任务靠这里兜住
//   2) 运行中超过 90s 的 A 链路任务给用户回一条安抚消息（避免干等，PRD 10.1）
// ⚠️ 这里的中间状态列表必须与 _common/pipeline.js 的 rescanPending 保持一致，
//    漏掉一个状态 → 卡在那个状态的任务永远不会被兜底救活。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { db, cmd, COLL } = require('./_common/db');
const { runUntilDone } = require('./_common/pipeline');
const { TASK_STATUS } = require('./_common/consts');
const wxapi = require('./_common/wxapi');
const { env } = require('./_common/providers');

/** 未完成（需要继续推进）的任务状态集合 */
const IN_FLIGHT_STATUS = [
  TASK_STATUS.PENDING,
  TASK_STATUS.DOWNLOADING,
  TASK_STATUS.TRANSCRIBING,
  TASK_STATUS.TRANSCRIBING,
  TASK_STATUS.ASR,
  TASK_STATUS.LLM,
];

/** A 链路运行中超时的安抚（一次调用只处理，防刷屏按任务 attempt 记录） */
async function comfortOverdue() {
  const threshold = new Date(Date.now() - 90 * 1000);
  const r = await COLL
    .tasks()
    .where({
      channel: 'A',
      status: cmd().in(IN_FLIGHT_STATUS),
      updated_at: cmd().lt(threshold),
    })
    .limit(5)
    .get();
  for (const t of r.data || []) {
    try {
      if (t.userOpenid) {
        await wxapi.sendKfText(t.userOpenid, '还在解析中，稍等一下下～完成后会自动推给你 ⏳');
      }
      // 标记已安抚：updated_at 刷新避免重复发
      await COLL.tasks().doc(t._id).update({ data: { comforted_at: new Date(), updated_at: new Date() } });
    } catch (e) {
      console.warn('[parsePipeline] 安抚失败', e.message);
    }
  }
}

exports.main = async () => {
  // 1. 兜底重投 pending 任务
  const results = await runTaskScan();
  // 2. 安抚超时任务
  await comfortOverdue();
  return { ok: true, rescanned: results.length };
};

/** 单独抽出便于未来事件触发：把「卡住的任务」尽量推到终态 */
async function runTaskScan() {
  const olderThan = 20 * 1000;
  const threshold = new Date(Date.now() - olderThan);
  const r = await COLL
    .tasks()
    .where({
      status: cmd().in(IN_FLIGHT_STATUS),
      updated_at: cmd().lt(threshold),
    })
    .limit(5)
    .get();

  const out = [];
  const deadline = Date.now() + 40 * 1000; // 整体预算，留出余量避免函数超时
  for (const t of r.data || []) {
    if (Date.now() > deadline) break;
    const remain = Math.min(Math.max(3000, deadline - Date.now()), 20000);
    try {
      const res = await runUntilDone(t._id, remain);
      out.push({ taskId: t._id, ok: !!(res && res.ok), reason: (res && res.reason) || '' });
    } catch (e) {
      out.push({ taskId: t._id, ok: false, err: e && (e.msg || e.message) });
    }
  }
  return out;
}

module.exports = { main: exports.main };
