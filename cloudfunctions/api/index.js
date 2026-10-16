// 云函数 api - 小程序业务网关（按 action 分发；云函数内自动获取 openid，服务端权威计费）
// 调用方：小程序端 utils/api.js（wx.cloud.callFunction name:'api'）
const cloud = require('wx-server-sdk');
const referral = require('./referral');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { db, cmd, COLL } = require('./_common/db');
const { ok, err, getContext } = require('./_common/util');
const { ensureUserFromContext, saveSessionKey, getSessionKey, addCredits } = require('./_common/user');
const { deliverOrder, findOrderByOutTradeNo, notifyWxProvided } = require('./_common/order');
const { track } = require('./_common/track');
const providers = require('./_common/providers');
const videoExtract = require('./_common/video-extract');
const friendInvite = require('./_common/friend-invite');
const welcomeBonus = require('./_common/welcome-bonus');
const copySearch = require('./_common/copy-search');
const vpay = require('./_common/virtualpay');
const { md5 } = require('./_common/crypto');
const { runUntilDone } = require('./_common/pipeline');
const { countActiveTasks, rollbackCharge } = require('./_common/credit');
const {
  TASK_STATUS,
  DUP_WINDOW_MS,
  MAX_USER_CONCURRENT,
  MEMBER_PLANS,
  RECHARGE_PRESETS,
  CREDIT_PER_YUAN,
  CUSTOM_MIN_YUAN,
  CUSTOM_MAX_YUAN,
  DB_COLLECTIONS,
  TRIAL_CREDIT,
} = require('./_common/consts');

const PAGE_SIZE = 20;

/** 从混杂文本（带口令 / 分享文案）里抽 http 链接 */
function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s，,。、"'）)】\]]+/i);
  return m ? m[0] : '';
}

/**
 * 规整用户粘贴的分享内容 → 可用 URL
 * 1) 先抽 http(s) 链接（分享文案里常夹口令）
 * 2) 抽不到但整段是裸域名/短链（channels.weixin.qq.com/xxx）时自动补 https://
 *    —— 视频号某些入口「复制链接」给的就是不带协议头的裸域名，
 *       前端 isValidUrl 放行了、后端原来只认 ^https?:// 会直接拒，用户看到的就是「提取失败」。
 */
function normalizeShareUrl(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  const found = extractUrl(t);
  if (found) return found.replace(/[，,。、"'）)】\]]+$/, '');
  // 裸域名行：先剥掉尾部中文标点 / 空白，再判断
  t = t.replace(/[，,。、"'）)】\]\s]+$/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s，,。、"'）)】\]]*)?$/i.test(t)) return 'https://' + t;
  return t;
}

/** 取域名（埋点 / 日志用，不把完整链接写进事件表） */
function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// 任务状态 → 前端进度阶段（前端 applyStage 只认 parse | asr | format | done | failed）
// 状态语义（见 _common/pipeline.js）：
//   pending=取源 → downloading=下载视频 → transcribing=字幕/转写 → asr=结构化 → done
// 前端只有三步，所以下载与转写合并映射到第 2 步「提取字幕 / 识别语音」。
const STAGE_BY_STATUS = {
  pending: 'parse',
  downloading: 'asr',
  transcribing: 'asr',
  asr: 'format',
  llm: 'format',
  done: 'done',
  failed: 'failed',
};
const PERCENT_BY_STATUS = {
  pending: 10,
  downloading: 40,
  transcribing: 55,
  asr: 80,
  llm: 85,
  done: 100,
  failed: 100,
};

// 单次 getTask 内允许推进流水线的最长时间（毫秒）。
// 每次轮询都会把任务往前推一步，推不完下次轮询继续 —— 这样云函数单次调用不会超时，
// 而前端表现上「一直在动」。
// ⚠️ 必须明显小于「小程序端调用云函数的超时」与「云函数执行超时」：
//    最坏情况是这一步刚好卡在下游请求的硬超时上（下载 45 秒），加上收尾写库，
//    整个调用要能稳稳落在 60 秒以内，否则前端拿不到响应、错误也看不到。
// ⭐ 2026-09-29 提速：30s → 40s。取源+下载+转写+整理 ≈ 45s，30s 预算会让「转写」跑完后
//    预算耗尽、被迫在最贵的时刻断掉，多花一次「客户端轮询 × 一次冷启动」才把「整理」跑完。
//    40s 下：转写 32s 结束时仍在预算内 → 同一次调用内接着跑整理（+13s）→ 短视频一次轮询跑完。
//    最坏情况仍只多跑「一步」，落在 60s 以内（转写最慢时预算先耗尽，天然不会启动下一步）。
const GETTASK_ADVANCE_MS = 40000;

/** 登录建档（幂等）：返回用户摘要 */
async function ensureUser() {
  const user = await ensureUserFromContext();
  return userCenterSummary(user);
}

/** 摘要（不下发内部字段） */
function userCenterSummary(user) {
  const mem = user.membership || {};
  const isActive = mem.tier && mem.tier !== 'none' && mem.status === 'active';
  return {
    _id: user._id,
    nickname: user.nickname || '',
    avatarUrl: user.avatarUrl || '',
    credits: user.credits || { balance: 0, total_earned: 0, total_used: 0 },
    trial: user.trial || { granted: false, credit_total: TRIAL_CREDIT },
    membership: {
      tier: isActive ? mem.tier : 'none',
      status: mem.status || 'expired',
      expires_at: mem.expires_at || null,
      unlimited: mem.tier === 'unlimited' && isActive,
      quota: isActive && mem.quota ? mem.quota : null,
      // 展示用：到期前 3 天内显示续费提醒
      need_renew: !!(
        isActive &&
        mem.expires_at &&
        mem.expires_at.getTime() - Date.now() < 3 * 24 * 3600 * 1000
      ),
    },
    pending_pushes: user.pending_pushes || 0,
    referralCode: user.referral_code || '',
    referralEntryState: user.referral_entry ? user.referral_entry.state : 'ineligible',
  };
}

/** 文案库列表（分页 20/页，软删过滤） */
async function listCopywritings(user, { page, keyword, platform }) {
  const p = Math.max(1, Number(page) || 1);
  const cond = copySearch.condition(db(), cmd(), user._id, keyword, platform);
  // total 用于前端判「还有没有下一页」（前端把 total 当未筛选总数用）
  const cnt = await COLL.copywritings().where(cond).count();
  const total = cnt.total || 0;
  const r = await COLL
    .copywritings()
    .where(cond)
    .orderBy('created_at', 'desc')
    .skip((p - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .get();
  const list = (r.data || []).map(c => {
    const detail = shapeCopywriting(c);
    return Object.assign(stripContent(c), { detail, search_snippet: copySearch.snippet(detail, keyword) });
  });
  return { list, total, page: p, hasMore: p * PAGE_SIZE < total };
}

/**
 * 「我的」页统计（用户 2026-09-26 新「我的」界面需要三个数字 + 最近一条）
 * - month_count：本月提取条数（created_at ≥ 当月 1 日 00:00，按云函数所在时区）
 * - total_chars：累计字数（char_count 求和，全时段）
 * - total      ：归档总数
 * - latest     ：最近一条（列表项同款形状，供「提取记录」卡直接用，省一次调用）
 *
 * ⭐⭐ 统计口径（2026-09-27 用户明确要求）：
 *    「提取条数 / 累计字数」= 用户**成功提取过的全部记录**，**含用户后来删掉的**。
 *    用户原话：「删除的提取记录也需要考虑进去，它是所有记录的总呈现」。
 *    ⚠️ 历史页的「删除」是**软删**（`copywritings.deleted = true`，保留 7 天）——
 *       所以这里的统计**不能带 `deleted: false` 条件**，否则删一条就少算一条。
 *       历史**列表**仍然只列未删除的（见 listCopywritings），两处口径**故意不同**，
 *       因为「我的」上这两个数表达的是「累计产出」，不是「当前存了多少条」。
 *    ⚠️ 与 `latest` 分开：软删的记录不该被当作「最近一条」回显，故 latest 仍只看未删除。
 *
 * ⭐ 用聚合在云端算，不把整表拉回函数内存。聚合不可用时降级为「只给总数」，
 *    两个统计值保持 null —— 端上显示「—」，**绝不伪造 0**（降级原则：宁可空态不造假）
 */
async function userStats(user) {
  const uidOnly = { uid: user._id }; // 统计口径：全部记录（含软删）
  const visible = { uid: user._id, deleted: false }; // 列表/最近一条口径：未删除
  const coll = COLL.copywritings();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const out = { month_count: null, total_chars: null, total: 0, latest: null, usage: null };

  // 最近一条（与 listCopywritings 的列表项同形状；只看未删除）
  try {
    const r = await coll.where(visible).orderBy('created_at', 'desc').limit(1).get();
    const first = (r.data || [])[0];
    out.latest = first ? Object.assign(stripContent(first), { detail: shapeCopywriting(first) }) : null;
  } catch (e) { /* 集合尚未创建等：交给上层报错，不让统计拖垮整页 */ }

  try {
    const $ = db().command.aggregate;
    const all = await coll
      .aggregate()
      .match(uidOnly)
      .group({ _id: null, total: $.sum(1), chars: $.sum($.ifNull(['$char_count', 0])) })
      .end();
    const row = (all.list || [])[0] || {};
    out.total = row.total || 0;
    out.total_chars = row.chars || 0;

    const mon = await coll
      .aggregate()
      .match(Object.assign({}, uidOnly, { created_at: cmd().gte(monthStart) }))
      .group({ _id: null, total: $.sum(1) })
      .end();
    out.month_count = ((mon.list || [])[0] || {}).total || 0;
  } catch (e) {
    // 聚合不可用（SDK 版本 / 索引 / 权限）→ 保底给总数，其余留 null
    try {
      const c = await coll.where(uidOnly).count();
      out.total = c.total || 0;
    } catch (e2) { /* ignore */ }
  }

  // 「提取记录」卡 2026-09-26 起改为消费摘要入口（点进去是「积分与订单」子页）
  // → 顺带把消耗汇总 + 最近一条消耗一起给端上，省一次往返
  try {
    const us = await usageSummary(user._id, monthStart);
    const u = {
      month_credit: us.month_credit,
      total_credit: us.total_credit,
      month_quota: us.month_quota,
      total_quota: us.total_quota,
      count: us.total_count,
      last: null,
    };
    const r = await COLL
      .tasks()
      .where({ uid: user._id, usage_hidden: cmd().neq(true) })
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    const t0 = (r.data || []).filter((t) => t.usage_hidden !== true)[0];
    if (t0) u.last = shapeUsage(t0);
    out.usage = u;
  } catch (e) {
    /* 拿不到 → 端上显示「—」，不伪造 0 */
  }

  return out;
}

/** 列表项剥离大字段（content 大 JSON 不回传，点详情再拉） */
function stripContent(c) {
  return {
    _id: c._id,
    channel: c.channel,
    source_platform: c.source_platform,
    video_title: c.video_title,
    cover_url: c.cover_url || '',
    // 本地视频：云存储 fileID（列表页用它给 <video> 显示首帧当封面）。
    // 平台视频的 CDN 直链不回传 —— 它带签名时效与防盗链，列表页既用不上也不该外露。
    local_video_id: /^cloud:\/\//.test(c.video_url || '') ? c.video_url : '',
    duration_sec: c.duration_sec || 0,
    char_count: c.char_count || 0,
    status: c.status || 'ok',
    push_state: c.push_state || 'none',
    mock: !!c.mock,
    created_at: c.created_at,
  };
}

/**
 * 从老数据的 full_markdown 里剥出「## 口播原文」之后的正文
 * 仅用于 content 是对象、但没单独存 transcript 的历史记录
 */
function pickLegacyTranscript(md) {
  if (!md) return '';
  const parts = String(md).split(/^#{1,3}\s*口播原文\s*$/m);
  return parts.length > 1 ? String(parts[1] || '').trim() : '';
}

/**
 * 详情出参整形
 * ⭐ 结构化整理 与 口播原文 **必须分字段回传**，前端才能分 tab 展示
 *    （曾把两者拍平成一段 full_markdown，结果在同一个框里混排）
 * - `structured` = { title, hook, highlights[], points[{type,title,text}] } 整理层（辅助视图）
 * - `transcript` = 逐字稿 事实层（PRD 1.3，不删改）
 * - `content`    = 保留原有语义（编辑版优先，否则 full_markdown）→ 历史页「复制全文」/ 分享沿用
 * ⚠️ 前端读 source_url，库里存的是 video_url，也要在这层转。
 * ⚠️ 用户编辑版单独存 content_edited，**原始 content 对象一字不动**。
 */
function shapeCopywriting(c) {
  const raw = c.content;
  const isStr = typeof raw === 'string';
  const obj = raw && typeof raw === 'object' ? raw : {};
  const edited = c.content_edited;
  const hasEdited = edited != null && edited !== '';

  // ---- 原文案（事实层）----
  let transcript = isStr ? String(raw) : String(obj.transcript || '');
  if (!transcript && !isStr) transcript = pickLegacyTranscript(obj.full_markdown);
  if (hasEdited) transcript = edited; // 用户改过就以改过的为准

  // ---- 结构化整理（辅助视图）----
  const points = Array.isArray(obj.points)
    ? obj.points
        .filter((p) => p != null && p !== '')
        .map((p) =>
          typeof p === 'string'
            ? { type: 'point', title: '', text: p }
            : { type: p.type || 'point', title: p.title || '', text: p.text || '' }
        )
        .filter((p) => p.text || p.title)
    : [];
  const highlights = Array.isArray(obj.highlights)
    ? obj.highlights.map((h) => String(h).trim()).filter(Boolean)
    : [];
  const structured = {
    title: c.doc_title || c.video_title || '',
    hook: String(obj.hook || '').trim(),
    highlights,
    points,
  };

  // ---- 兼容字段 ----
  const legacy = isStr ? String(raw) : obj.full_markdown || obj.transcript || '';

  return {
    _id: c._id,
    channel: c.channel || 'B',
    source_platform: c.source_platform || '',
    video_title: c.video_title || '',
    doc_title: c.doc_title || '',
    cover_url: c.cover_url || '',
    // 本地视频：云存储 fileID（结果页缩略块靠 <video> 显示首帧当代封面，与列表页同判据）
    // ⚠️ 结果页与文案库列表要显示同一个封面 → 这两处的判据必须一致，改一处必须同步另一处
    local_video_id: /^cloud:\/\//.test(c.video_url || '') ? c.video_url : '',
    duration_sec: c.duration_sec || 0,
    elapsed_sec: c.elapsed_sec || 0,
    char_count: c.char_count || 0,
    status: c.status || 'ok',
    segments: Array.isArray(c.segments) ? c.segments : [],
    keep_timeline: !!c.keep_timeline,
    // ⭐ 分开回传
    structured,
    transcript,
    // 保留：完整 Markdown 纯文本（历史页复制 / 分享 / 旧前端兼容）
    content: String(hasEdited ? edited : legacy || ''),
    source_url: c.video_url || c.source_url || '',
    mock: !!c.mock,
    edited: !!c.edited,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

/** 详情（校验归属） */
async function getCopywriting(user, { id }) {
  if (!id) throw { code: 2, msg: '缺少参数' };
  const r = await COLL
    .copywritings()
    .where({ _id: id, uid: user._id, deleted: false })
    .limit(1)
    .get();
  if (!r.data || !r.data.length) {
    throw { code: 3, msg: '内容不存在或已删除' };
  }
  return shapeCopywriting(r.data[0]);
}

/**
 * 保存编辑后的文案全文（前端传的是纯文本）
 * 写 content_edited，不动原始 content 对象；同步刷新字数与时间戳
 */
async function updateCopywriting(user, { id, content }) {
  if (!id) throw { code: 2, msg: '缺少参数' };
  const text = content == null ? '' : String(content);
  const r = await COLL
    .copywritings()
    .where({ _id: id, uid: user._id })
    .update({
      data: {
        content_edited: text,
        char_count: text.replace(/\s/g, '').length,
        edited: true,
        updated_at: new Date(),
      },
    });
  if (!r.stats || !r.stats.updated) throw { code: 3, msg: '内容不存在或已删除' };
  return { _id: id, updated: true, content: text };
}

/** 清空文案库（软删：只打 deleted 标记，行不物理删除）
 *  ⚠️ 2026-09-29 用户：「没做 7 天内可恢复这个功能，取消这部分说明」
 *     该软删是**数据安全网**，不是对用户承诺的功能 —— **UI 文案一律不得写「可恢复」**。 */
async function clearCopywritings(user) {
  const r = await COLL
    .copywritings()
    .where({ uid: user._id, deleted: false })
    .update({ data: { deleted: true, updated_at: new Date() } });
  return { cleared: (r.stats && r.stats.updated) || 0 };
}

/** 删除（软删 7 天，PRD 8.2/8.4） */
async function deleteCopywriting(user, { id }) {
  if (!id) throw { code: 2, msg: '缺少参数' };
  const r = await COLL
    .copywritings()
    .where({ _id: id, uid: user._id })
    .update({ data: { deleted: true, updated_at: new Date() } });
  return { deleted: r.stats.updated > 0 };
}

/**
 * 任务查询（前端轮询进度用。⚠️ 2026-09-28 起轮询方已从 pages/loading 挪到
 * utils/extract-session.js —— 用户返回首页后任务仍要在后台跑，间隔 800ms）
 * 入参兼容 task_id / taskId；出参对齐前端：stage / percent / copywriting_id / cover
 */
async function getTask(user, { taskId, task_id }) {
  const id = taskId || task_id;
  if (!id) throw { code: 2, msg: '缺少参数' };

  const findTask = async () => {
    const r = await COLL
      .tasks()
      .where({ _id: id, uid: user._id })
      .limit(1)
      .get();
    return r.data && r.data.length ? r.data[0] : null;
  };

  let t = await findTask();
  if (!t) throw { code: 3, msg: '任务不存在' };
  if (t.extract_kind === 'video') throw { code: 3, msg: '请使用视频提取进度接口' };

  // ⚠️ 前端轮询即「心跳」：每次 getTask 顺带把流水线推进一步。
  //    真实链路（取源 → 下载 → 转写 → 整理）串起来远超云函数单次超时上限，
  //    所以拆成多步、由轮询驱动。跑不完的部分下次轮询接着跑（状态已落库，可续跑）。
  if (t.status !== TASK_STATUS.DONE && t.status !== TASK_STATUS.FAILED) {
    // ⭐⭐ 2026-09-29 提速：第三个参数 1 = **每次轮询只推进一个成功步骤就返回**。
    //    原来一次调用把「取源→下载→转写→整理」全跑完（约 40 秒）才回响应，
    //    前端这 40 秒完全收不到中间状态 → 界面死死停在第一步「视频解析」，
    //    用户只看到「卡了 40 秒」，反而看不出真实耗时分布。
    //    现在每一步都会回一次响应：进度条真的在走，卡在哪一环一眼可见。
    //    ⚠️ 只影响前端轮询这条路径；cronDaily 兜底仍用不限步数的调用把任务推完。
    // 本地取源和跳过预下载都是短步骤，合并返回，省去一次轮询往返；ASR仍单独执行。
    const maxSteps = t.file_id && t.status === TASK_STATUS.PENDING ? 2 : 1;
    await runUntilDone(id, GETTASK_ADVANCE_MS, maxSteps).catch((e) =>
      console.warn('[api] getTask 推进任务异常', e && (e.msg || e.message))
    );
    const t2 = await findTask();
    if (t2) t = t2;
  }

  let resultDetail = null;
  if (t.status === TASK_STATUS.DONE && t.result_id) {
    try { resultDetail = await getCopywriting(user, { id: t.result_id }); } catch (_) {}
  }
  return {
    result_detail: resultDetail,
    task_id: t._id,
    status: t.status,
    stage: STAGE_BY_STATUS[t.status] || 'parse',
    percent: PERCENT_BY_STATUS[t.status],
    copywriting_id: t.result_id || '',
    video_title: t.video_title || '',
    // ⭐ 封面缩略图（2026-09-28）：提取中页要显示真实封面，不能一直是一块黑。
    //    取源那一步就把平台封面写进了 task.resolved.cover（见 _common/pipeline.js），
    //    归档后另有 cover_url（cloud:// fileID，永久）；这里优先给即时可用的那个。
    cover: (t.resolved && t.resolved.cover) || t.cover_url || '',
    error: t.error || null,
    // 前端 fail() 读 res.msg 作为报错文案。t.error 是 { reason, msg } 对象，
    // 原实现直接整对象转字符串，会渲染成 "[object Object]"，这里按字段取。
    msg: t.error ? (t.error.msg || t.error.reason || '解析失败') : '',
    // 最近一次「可重试」错误的原文（超时/中断等）。任务最终失败时用它给出更具体的原因，
    // 平时也可在开发者工具里核对流水线卡在哪一环。
    last_error: (t.step_meta && t.step_meta.last_error) || '',
    step_tries: (t.step_meta && t.step_meta.tries) || 0,
    channel: t.channel,
    duration_sec: t.duration_sec || 0,
    // 分步耗时（毫秒）：取源 / 下载 / 转写 / 结构化。前端暂不展示，开发者工具里可直接看
    timing: t.timing || null,
    updated_at: t.updated_at,
    created_at: t.created_at,
  };
}

/** 取消任务（前端退出提取页时调用）。取消页提示「已消耗的积分会自动退回」，这里必须真的退。 */
async function cancelTask(user, { task_id, taskId }) {
  const id = task_id || taskId;
  if (!id) throw { code: 2, msg: '缺少参数' };

  const found = await COLL
    .tasks()
    .where({ _id: id, uid: user._id })
    .limit(1)
    .get();
  const task = found.data && found.data[0];
  if (!task) throw { code: 3, msg: '任务不存在' };

  // 已进终态就什么都不做（幂等：前端可能连点两次，或与轮询撞上）
  if (task.status === TASK_STATUS.DONE || task.status === TASK_STATUS.FAILED) {
    return { task_id: id, cancelled: true, already_finished: true };
  }

  const r = await COLL
    .tasks()
    .where({ _id: id, uid: user._id })
    .update({
      data: {
        status: TASK_STATUS.FAILED,
        // ⚠️ 必须是对象：前端按 t.error.msg / t.error.reason 取值，
        //    直接写字符串会让失败原因渲染不出来。
        error: { reason: 'cancelled_by_user', msg: '已取消提取' },
        refunded: !!task.charged,
        phase_started_at: new Date(0), // 释放步骤租约
        updated_at: new Date(),
      },
    });
  if (!r.stats || !r.stats.updated) throw { code: 3, msg: '任务不存在' };

  if (task.charged && task.credit_decision) {
    await rollbackCharge(task.uid || user._id, task.credit_decision).catch((e) =>
      console.warn('[api] 取消退还积分失败', e && (e.msg || e.message))
    );
  }
  try {
    providers.removeMedia(task.media_path);
  } catch (e) {
    /* ignore */
  }

  return { task_id: id, cancelled: true };
}

/** 同日同源去重（PRD R-05）：命中回档上次结果，不重复扣积分 */
async function findDupCopywriting(userId, hashKey) {
  const since = new Date(Date.now() - DUP_WINDOW_MS);
  const r = await COLL
    .copywritings()
    .where({
      uid: userId,
      deleted: false,
      dedup_key: hashKey,
      created_at: cmd().gt(since),
    })
    .orderBy('created_at', 'desc')
    .limit(1)
    .get();
  return r.data && r.data.length ? r.data[0] : null;
}

/**
 * 发起解析（B 链路；前端 loading.js submitLink / submitLocal 调用）
 * 支持两条入参：{ url } 跨平台链接；{ file_id, source:'local' } 本地视频上传
 * 出参对齐前端：task_id / copywriting_id / video_title
 * 行为：平台识别 → 当日去重 → 并发检查 → 建任务 → 即时尝试解析（其余交由 parsePipeline 兜底）
 */
async function parseLink(user, event) {
  const rawUrl = String((event && (event.url || event.shareUrl)) || '').trim();
  const fileId = String((event && event.file_id) || '').trim();
  const isLocal = !!fileId;
  // ⭐ 2026-10-15：本地视频封面（客户端把选片缩略图传到云存储 tmp/<requestId>.jpg 后的 fileID）。
  //    落库进 copywritings.cover_url → 历史 / 结果页有真封面，换设备、清缓存后都还在。
  //    只认 cloud:// 且限长，别的值一律丢弃（防脏数据写进封面字段）。
  const rawCover = String((event && event.cover_file_id) || '').trim();
  const coverFileId = /^cloud:\/\//.test(rawCover) && rawCover.length <= 512 ? rawCover : '';

  // 链接常混着口令 / 分享文案（抖音、小红书尤甚），兜底再抽一次；裸域名自动补协议头
  const url = isLocal ? '' : normalizeShareUrl(rawUrl);

  if (!isLocal && !/^https?:\/\//i.test(url)) {
    throw {
      code: 2,
      msg: '没找到链接，请粘贴完整的视频分享链接（支持：' + providers.SUPPORTED_PLATFORM_TEXT + '）',
    };
  }

  const platform = isLocal ? 'local' : providers.detectPlatform(url);

  // ⚠️ 未识别平台不再硬拒。
  //    各平台域名变体极多（视频号有 channels / finder / mp / wxaurl / v.qq 等多套），
  //    原实现识别不到就抛「只支持抖音与视频号」，会把真实视频号链接误杀。
  //    现在照常入队，能否取到源由取源环节判定（PRD 12.10 按适配器扩展）。
  if (!isLocal && !providers.isSupportedPlatform(platform)) {
    console.warn('[api] 未识别平台，按通用方式尝试：', platform, hostOf(url));
    await track({
      uid: user._id,
      event: 'extract_platform_unknown',
      props: { source_platform: platform, url_host: hostOf(url) },
    });
  }

  // 去重（仅链接链路；本地文件没有稳定 hash）
  const hashKey = isLocal ? '' : md5(url.replace(/[?#].*$/, ''));
  if (hashKey) {
    const dup = await findDupCopywriting(user._id, hashKey);
    if (dup) {
      await track({
        uid: user._id,
        event: 'extract_dup_hit',
        props: { source_platform: platform },
      });
      return {
        duplicated: true,
        task_id: '',
        copywriting_id: dup._id,
        video_title: dup.video_title || '',
        hint: '这条你之前提取过，点击查看上次结果',
      };
    }
  }

  // 稳定提交ID按用户隔离；丢失响应/重试复用已建任务，不重复扣费。
  const requestId = String((event && event.request_id) || '');
  const submissionId = /^[a-zA-Z0-9_-]{8,100}$/.test(requestId)
    ? 'submit_' + md5(user._id + ':' + requestId) : '';
  const existing = submissionId ? await readSubmission(user._id, submissionId) : null;
  if (existing) return submissionResponse(existing);

  // 并发上限（PRD 6.3：单用户同时 ≤3 个任务）
  const active = await countActiveTasks(user._id);
  if (active >= MAX_USER_CONCURRENT) {
    throw { code: 2, msg: '正在解析的任务有点多，请稍等片刻再试' };
  }

  // 建任务（pending 先落库，防丢，PRD 8.2）
  const ctx = getContext() || {};
  let addRes;
  try {
    addRes = await COLL.tasks().add({
    data: {
      ...(submissionId ? { _id: submissionId, request_id: requestId } : {}),
      uid: user._id,
      userOpenid: ctx.OPENID || '',
      channel: 'B',
      msg_id: '',
      share_url: isLocal ? '' : url,
      video_url: isLocal ? '' : url,
      file_id: fileId,
      // 本地视频封面 fileID（归档时写进 copywritings.cover_url，见 cloud-common/pipeline.js）
      cover_file_id: coverFileId,
      // 客户端诊断字段不参与计费、权限或识别决策。
      client_timing: isLocal ? {
        upload_ms: Math.min(3600000, Math.max(0, Number(event.client_timing && event.client_timing.upload_ms) || 0)),
        original_bytes: Math.min(104857600, Math.max(0, Number(event.client_timing && event.client_timing.original_bytes) || 0)),
        reencoded: !!(event.client_timing && event.client_timing.reencoded),
        prepare_ms: Math.min(60000, Math.max(0, Number(event.client_timing && event.client_timing.prepare_ms) || 0)),
        upload_bytes: Math.min(104857600, Math.max(0, Number(event.client_timing && event.client_timing.upload_bytes) || 0)),
        audio_only: !!(event.client_timing && event.client_timing.audio_only),
      } : {},
      source_platform: platform,
      dedup_key: hashKey,
      status: TASK_STATUS.PENDING,
      attempt_log: [],
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  } catch (e) {
    // 同一提交并发写入时，数据库唯一 _id 保证只有一个任务。
    const raced = submissionId ? await readSubmission(user._id, submissionId) : null;
    if (raced) return submissionResponse(raced);
    throw e;
  }

  await track({
    uid: user._id,
    event: isLocal ? 'extract_local' : 'extract_link',
    props: { source_platform: platform },
  });

  // ⚠️ 这里**不跑**流水线：只入队。
  //    真实链路的单步（下载 / 转写 / 整理）就可能耗时几十秒，塞进这里必然拖垮本次调用。
  //    推进交给前端轮询 getTask（每次推进一步），另有 parsePipeline 定时器兜底，
  //    服务号回调走 runUntilDone 一次跑完。任务已落库，任何一处中断都能续跑。
  return {
    task_id: addRes._id,
    duplicated: false,
    status: 'pending',
    platform,
  };
}

async function readSubmission(uid, id) {
  const r = await COLL.tasks().where({ _id: id, uid }).limit(1).get();
  return r.data && r.data[0];
}
function submissionResponse(t) {
  return { task_id: t._id, status: t.status, duplicated: false, platform: t.source_platform, copywriting_id: t.result_id || '' };
}

/**
 * 虚拟支付就绪自检（2026-09-29 新增）
 *
 * 为什么必须单列：`vpay.payReady()` **只校验 VIRTUAL_PAY_READY / OFFER_ID / APPKEY 三个**，
 *   **不校验 MINI_APPSECRET**。少了它 → 支付参数照发（用户能付钱），
 *   但服务端「查单确认」会静默失败（`miniToken()` 抛 `MINI_APPSECRET 未配置`）
 *   → 钱收了、积分不到账。本次事故正是如此，故把这一项补进自检。
 *
 * ⚠️ 只回显「有 / 无」布尔值，**绝不回显任何密钥内容**。
 */
/**
 * 密钥「卫生」检查（2026-09-29 · 排查 HTTP 412 时加）
 *
 * ⚠️⚠️ 仍然只回显**结构信息**（长度 / 首尾空白数 / 内部空白 / 是否十六进制），**绝不回显密钥本身**。
 * ⚠️ 曾误判（2026-09-29 定案纠正）：412 **不是**「AppKey 带尾随空白 / 密钥错」造成的，也不是签名问题
 *    —— 真因是 `httpJson` 发 POST 时未设 `Content-Length` → Node 改用 `Transfer-Encoding: chunked`
 *    → **微信服务器不支持 chunked 请求体** → 网关前置拦截回 HTTP 412 空 body（详见 `_common/virtualpay.js#httpJson`）。
 *    本卫生检查仍保留：密钥长度/空白异常会导致**真签名错**，但那会返回 JSON 错误码 `268490003`，不是 412。
 */
function keyHygiene(v) {
  if (!v) return { present: false };
  const s = String(v);
  const t = s.trim();
  return {
    present: true,
    len: s.length,
    trimDiff: s.length - t.length, // >0 ＝ 首尾有空白/换行 → 必致 412
    hasInnerSpace: /\s/.test(t), // 内部含空白 → 可疑
    hexLike: /^[0-9a-fA-F]+$/.test(t), // 微信 AppKey / AppSecret 均为十六进制串
  };
}

function virtualPayStatus() {
  const envMode = vpay.payEnv(); // 0 现网 / 1 沙箱
  const hasReady = vpay.paySwitchOn();
  const hasOffer = !!vpay.offerId();
  const hasAppKey = !!vpay.appKey();
  const hasSecret = !!providers.env('MINI_APPSECRET', '');
  // ⚠️ 控制台「测试」调用时上下文没有 appid → 必须靠 MINI_APPID 环境变量兜底
  const hasAppid = !!vpay.miniAppid();
  const akHealth = keyHygiene(vpay.appKey());
  const asHealth = keyHygiene(providers.env('MINI_APPSECRET', ''));
  const missing = [];
  if (!hasReady) missing.push('VIRTUAL_PAY_READY');
  if (!hasOffer) missing.push('VIRTUAL_PAY_OFFER_ID');
  if (!hasAppKey) missing.push(envMode === 1 ? 'VIRTUAL_PAY_SANDBOX_APPKEY' : 'VIRTUAL_PAY_APPKEY');
  if (!hasSecret) missing.push('MINI_APPSECRET');
  if (!hasAppid) missing.push('MINI_APPID');
  // 首尾有空白 → 签名必错 → /xpay/* 回 412
  const dirty = [
    akHealth.trimDiff ? 'VIRTUAL_PAY_APPKEY' : '',
    asHealth.trimDiff ? 'MINI_APPSECRET' : '',
  ].filter(Boolean);
  const notes = [];
  if (!(hasSecret && hasAppid)) {
    notes.push(
      '查单确认必失败（钱收了、积分不到账）。缺：' +
        [!hasAppid ? 'MINI_APPID' : '', !hasSecret ? 'MINI_APPSECRET' : ''].filter(Boolean).join(' / ') +
        '；控制台场景 AppID 也要显式配（上下文无 appid 可回落）'
    );
  }
  if (dirty.length) {
    notes.push(
      '⚠️ ' +
        dirty.join(' / ') +
        ' 首尾含空白或换行（trimDiff>0）→ HMAC 签名必不一致 → /xpay/* 回 HTTP 412。请删掉后重新复制粘贴，勿手打'
    );
  }
  return {
    virtualPay: missing.length
      ? '未就绪 → 缺：' + missing.join(' / ') + '（补齐后需「重新部署」本函数才生效）'
      : '已就绪：READY / OfferID / AppKey / AppSecret / AppID 齐全（env=' + envMode + '，0=现网 1=沙箱）',
    virtualPayDetail: Object.assign(
      {
        env: envMode,
        ready: hasReady,
        offerId: hasOffer,
        appKey: hasAppKey,
        appSecret: hasSecret,
        appId: hasAppid,
        appKeyHealth: akHealth,
        appSecretHealth: asHealth,
        missing,
      },
      notes.length ? { note: notes.join(' ｜ ') } : {}
    ),
  };
}

/** 能力自检（控制台排查用，绕开用户校验） */
async function providerStatus() {
  const s = providers.providerStatus();
  return Object.assign(
    {
      ok: true,
      extractionRevision: { gateway: '20261011-speed-r4', pipeline: require('./_common/pipeline').REVISION || 'legacy' },
      hint:
        s.mode.indexOf('演示') > -1
          ? '当前仍是演示模式：请在云函数环境变量配置 PARSE_API_URL / DEEPSEEK_API_KEY 后重新部署 api'
          : '已切到真实模式',
    },
    s,
    virtualPayStatus()
  );
}

/**
 * 测试补分 / 运营补偿（运维 action，绕开用户校验 · 2026-09-28）
 *
 * 用法：**微信云开发控制台** → 云函数 → `api` → 「云端测试」→ 入参（任选一种定位方式）
 *   ① 按 _id（最可靠，2026-09-28 起推荐）：
 *      {"action":"grantCredits","uid":"<users._id>","amount":200}
 *   ② 按 openid：
 *      {"action":"grantCredits","openid":"<openid_mini>","amount":200}
 *   ③ 都不传 → 取 users 里**最近活跃的一条**（测试机只有自己，最省事）：
 *      {"action":"grantCredits","amount":200}
 *   - amount 为负 → 扣分（也记流水，便于把测试数据抹平）
 *
 * ⚠️ 为什么加了 ①③ 两种定位方式（2026-09-28 排障）：
 *   实测 `where({openid_mini: 'xxx'}).limit(1).get()` 查不到明明存在的用户
 *   （`diag` 显示该用户就在表里、openid_mini 掩码完全对得上），
 *   且同一 SDK 里 `where({status}).limit(50).get()` 在 tasks 上是正常工作的 ——
 *   极可能是 users 集合缺索引 / 权限差异导致的静默查空。
 *   → 兜底：优先 `doc(_id)` 直取，再退化为「拉一批在内存里比对」，
 *     彻底绕开 where 的匹配行为。
 *
 * ⚠️⚠️ 安全边界（务必保持）：
 *   ① 这只在**云开发控制台**里能调到；小程序端调不了（见下方 source 校验），
 *      否则任何用户都能自己刷积分；
 *   ② 所有变动都写 `credit_logs` 流水（source=manual），账目可追溯、可对账；
 *   ③ 正式运营前建议整段删除，或改为「只允许特定测试 openid」。
 */
async function grantCredits(event) {
  const e = event || {};
  const amount = Math.round(Number(e.amount != null ? e.amount : e.credits) || 0);
  if (!amount) throw { code: 2, msg: 'amount 不能为 0' };
  if (Math.abs(amount) > 100000) throw { code: 2, msg: 'amount 过大（上限 10 万）' };

  const ctx = getContext() || {};
  const fromMini = ctx.source === 'wx_client' || ctx.source === 'wx_devtools';
  const openid = e.openid || (fromMini ? ctx.openid : '');

  // 前端调用只能给自己加（防刷）；控制台调用才允许指定 openid / uid
  if (fromMini && e.openid && e.openid !== ctx.openid) {
    throw { code: 403, msg: '小程序端只能给自己发放积分' };
  }

  const how = await resolveTargetUser(e, openid, fromMini);
  const u = how.user;
  if (!u) throw { code: 3, msg: how.reason };

  const res = await addCredits(u._id, amount, {
    source: 'manual',
    note: e.note || '测试补分',
    refId: 'manual:' + (e.by || 'console'),
  });
  if (!res.ok) throw { code: 4, msg: res.reason || '加积分失败' };

  return {
    ok: true,
    matched_by: how.matched_by,
    openid: u.openid_mini || openid,
    uid: u._id,
    nickname: u.nickname || '',
    amount,
    balance_before: res.after - amount,
    balance_after: res.after,
    via: res.via,
    hint: '已写入 credit_logs 流水；端上「积分与订单」页可核对',
  };
}

/**
 * 签名探针（运维 action · 2026-09-29 新增，专治 `/xpay/*` 的 HTTP 412）
 *
 * 原理：拿一个**根本不存在的 order_id** 去调 `/xpay/query_order` ——
 *   · 签名正确 → 微信返回正常 JSON（「订单不存在」之类），HTTP 200；
 *   · 签名错误 → 微信网关直接回 **HTTP 412**，且 body 为空、不给 errcode。
 * 于是**不需要真实订单、也不会误发货**，就能一刀切开「是签名错还是订单问题」。
 *
 * 同时把 `uri` 的两种写法（带 / 不带前导斜杠）都试一遍，**一轮定音**，避免反复部署。
 */
async function sigProbe(event) {
  const e = event || {};

  // ① 先**强制重取** access_token（跳过缓存）
  //    ⚠️ 412 的两大嫌疑之一就是「缓存里躺着失效的旧 token」——token 未变却过期的场景无法靠缓存自证
  let freshToken = '';
  let tokenInfo;
  try {
    freshToken = await vpay.miniToken(true);
    tokenInfo = { step: 'cgi-bin/token（强制重取）', ok: true, len: String(freshToken).length, tail: String(freshToken).slice(-6) };
  } catch (err) {
    tokenInfo = {
      step: 'cgi-bin/token（强制重取）',
      ok: false,
      http: (err && err.statusCode) || 0,
      error: describeError(err),
      raw: (err && err.raw) || '',
      hint: '连 token 都拿不到 → 与签名无关，是 appid/secret 或 IP 白名单/账号权限被拦',
    };
  }

  // ② 借一个真实 openid（空 openid 会引入无关的参数错误，干扰判断）
  let openid = String(e.openid || '').trim();
  let sampleOrder = '';
  if (!openid) {
    try {
      const r = await COLL.orders().orderBy('created_at', 'desc').limit(1).get();
      const o = (r.data || [])[0];
      if (o) {
        sampleOrder = o.out_trade_no || '';
        const u = await COLL.users().doc(o.uid).get();
        openid = (u && u.data && u.data.openid_mini) || '';
      }
    } catch (err) {
      // 忽略：下面用 openid_matched 暴露
    }
  }

  // ③ 矩阵：env(现网/沙箱) × uri(带/不带前导斜杠)
  //    可选传 {"action":"sigProbe","appKey":"..."} —— **免重新部署**就能试不同钥匙
  const bogus = 'PROBE' + Date.now();
  const keyOverride = e.appKey ? String(e.appKey).trim() : '';
  const envs =
    e.env === undefined || e.env === null
      ? [vpay.payEnv(), vpay.payEnv() === 1 ? 0 : 1]
      : [Number(e.env) === 1 ? 1 : 0];
  const uris = [
    { tag: '带斜杠', uri: '/xpay/query_order' },
    { tag: '无斜杠', uri: 'xpay/query_order' },
  ];
  const matrix = [];
  for (let i = 0; i < envs.length; i++) {
    for (let j = 0; j < uris.length; j++) {
      const tag = (envs[i] === 1 ? '沙箱' : '现网') + '·' + uris[j].tag;
      try {
        const r = await vpay.queryOrder({
          outTradeNo: bogus,
          openid: openid,
          sigUri: uris[j].uri,
          appKeyOverride: keyOverride,
          envOverride: envs[i],
          forceToken: false, // token 已在①刷新
        });
        matrix.push(tag + ' → ✅ 通过（微信回了正常 JSON）：' + JSON.stringify(r).slice(0, 120));
      } catch (err) {
        const code = (err && err.statusCode) || 0;
        matrix.push(
          tag + ' → ' + (code === 412 ? '❌ 412 网关拦截' : '⚠️ HTTP ' + code + '：' + describeError(err).slice(0, 80))
        );
      }
    }
  }

  // ④ 对照组：不带 pay_sig / 带「全 0 假 pay_sig」
  //    目的＝判定「HTTP 412」究竟等不等于「签名被拒」：
  //    · 只有真签名 412、假签名回 JSON → 412 就是签名关 ⇒ 签名格式对、值不对 ⇒ **AppKey 值错**
  //    · 三种情形全 412 → 412 是**无条件前置拦截** ⇒ 与签名无关（账号虚拟支付权限 / IP 白名单）
  const control = {};
  if (tokenInfo.ok && openid) {
    const baseUrl = 'https://api.weixin.qq.com/xpay/query_order?access_token=' + encodeURIComponent(freshToken);
    const bodyStr = JSON.stringify({ openid: openid, env: vpay.payEnv(), order_id: bogus });
    const cases = [
      { key: 'no_sig', name: '不带 pay_sig', qs: '' },
      { key: 'bad_sig', name: '假 pay_sig（64个0）', qs: '&pay_sig=' + new Array(65).join('0') },
    ];
    for (let i = 0; i < cases.length; i++) {
      try {
        const r = await vpay.httpJson('POST', baseUrl + cases[i].qs, bodyStr);
        control[cases[i].key] = cases[i].name + ' → ✅ HTTP200：' + JSON.stringify(r).slice(0, 160);
      } catch (err) {
        const code = (err && err.statusCode) || 0;
        control[cases[i].key] =
          cases[i].name +
          ' → HTTP' +
          code +
          '：' +
          describeError(err) +
          (err && err.raw ? ' | raw=' + String(err.raw).slice(0, 200) : '');
      }
    }
  }

  const passed = matrix.filter((s) => s.indexOf('✅') >= 0).length;

  return {
    ok: true,
    token: tokenInfo,
    appKeyHealth: keyHygiene(keyOverride || vpay.appKey()),
    appKeySource: keyOverride ? '本次请求参数（覆盖）' : '云函数环境变量',
    appSecretHealth: keyHygiene(providers.env('MINI_APPSECRET', '')),
    env: vpay.payEnv(),
    offerId_present: !!vpay.offerId(),
    openid_matched: !!openid,
    passed: passed,
    matrix: matrix,
    control: control,
    how_to_read:
      '⭐ 2026-09-29 已定案：全 412（含不带签名 / 假签名）＝**网关拒收 chunked 请求体**，与签名、AppKey 值均无关；' +
      '根因＝httpJson 发 POST 未设 Content-Length → Node 改用 Transfer-Encoding: chunked → 已修（见 _common/virtualpay.js#httpJson）。' +
      '修后若仍 412 再看：① token 那步失败 → appid/secret 或 IP 白名单；② 只有「沙箱」行通过 → 配的是沙箱钥匙；' +
      '③ 只有 A_slash 通过 → uri 需带前导斜杠；④ 某行返回 JSON 且 errcode=268490003 → 那才是真·签名错（AppKey 值不对）。',
  };
}

/**
 * 补单（运维 action，绕开「确保用户」）
 *
 * 用途：端上没到账 / 推送丢失时，把**已支付**的订单补发货（走 deliverOrder，幂等不重复）。
 *
 * 三种用法：
 *   ① { action:'fixOrder' }                              → 扫最近 30 笔未完成订单，逐笔查单补发（推荐）
 *   ② { action:'fixOrder', out_trade_no:'RCxxxx' }        → 只补指定订单（也可传 order_id）
 *   ③ { action:'fixOrder', order_id:'xxxx', force:true }  → 跳过查单直接发货（测试期救急）
 *
 * ⚠️ /xpay/query_order 需要 openid → 从 users 表按 order.uid 取 openid_mini。
 * ⚠️ 返回里的 `query_raw` 是查单接口的原始返回，用来对齐 isOrderPaid 的字段口径。
 */
async function fixOrder(event) {
  const e = event || {};
  const outTradeNo = String(e.out_trade_no || '').trim();
  const orderId = String(e.order_id || '').trim();
  const force = e.force === true;

  /** 单笔：查单（或强制）→ 发货 */
  const one = async (order) => {
    if (!order) return { ok: false, reason: 'order_not_found' };
    const base = {
      order_id: order._id,
      out_trade_no: order.out_trade_no,
      type: order.type,
      status: order.status,
      amount_cents: order.amount_cents,
      credits: order.credits,
    };
    if (order.status === 'delivered') {
      return Object.assign(base, { ok: true, skipped: 'already_delivered' });
    }

    // 取用户 openid（/xpay/query_order 必填）
    let openid = '';
    try {
      const u = await COLL.users().doc(order.uid).get();
      openid = (u && u.data && u.data.openid_mini) || '';
    } catch (err) {
      // 取不到就留空，交给查单报错暴露
    }

    let q = null;
    let qErr = '';
    if (!force) {
      try {
        q = await vpay.queryOrder({ outTradeNo: order.out_trade_no, openid });
      } catch (err) {
        qErr = describeError(err);
        // ⚠️ 空响应/非 JSON/异常 HTTP 码时把原始细节带出来，否则只剩一句
        //    「Unexpected end of JSON input」，看不出是 token 那步还是查单那步（2026-09-29 踩过）
        if (err && (err.statusCode || err.raw !== undefined)) {
          qErr +=
            ' | http=' + (err.statusCode || '?') + ' | raw=' + (err.raw ? String(err.raw).slice(0, 500) : '(空)');
        }
      }
    }
    const paid = force || isOrderPaid(q);
    if (!paid) {
      return Object.assign(base, {
        ok: false,
        reason: qErr ? 'query_failed' : 'not_paid',
        openid_matched: !!openid,
        query_error: qErr,
        query_raw: q,
        hint: '若确认钱已付但查单异常，可加 force:true 强制补发',
      });
    }

    const r = await deliverOrder(order, { confirm_via: force ? 'ops_force' : 'ops_query' });
    return Object.assign(base, {
      ok: true,
      delivered: !!r.delivered,
      duplicated: !!r.duplicated,
      openid_matched: !!openid,
      query_raw: q,
      force,
    });
  };

  // ① 指定订单
  if (orderId || outTradeNo) {
    let order = null;
    if (orderId) {
      const d = await COLL.orders().doc(orderId).get().catch(() => null);
      order = d && d.data;
    } else {
      order = await findOrderByOutTradeNo(outTradeNo);
    }
    return await one(order);
  }

  // ② 不传参数 → 扫最近未完成订单
  const lim = Math.min(Math.max(Number(e.limit) || 30, 1), 100);
  let list = [];
  try {
    const r = await COLL
      .orders()
      .where({ status: cmd().in(['pending', 'paid']) })
      .orderBy('created_at', 'desc')
      .limit(lim)
      .get();
    list = (r && r.data) || [];
  } catch (err) {
    throw { code: 3, msg: '查询 orders 失败：' + describeError(err) };
  }
  if (!list.length) {
    return { ok: true, scanned: 0, delivered: 0, results: [], hint: '没有 pending/paid 状态的订单' };
  }

  const results = [];
  for (const o of list) {
    try {
      results.push(await one(o));
    } catch (err) {
      results.push({ order_id: o._id, out_trade_no: o.out_trade_no, ok: false, reason: describeError(err) });
    }
  }
  return {
    ok: true,
    scanned: list.length,
    delivered: results.filter((x) => x.delivered).length,
    results,
  };
}

/**
 * 补通知微信「已发货完成」（运维 action，绕开「确保用户」）
 *
 * 用途：发货时通知微信失败（网络抖动 / 历史遗留的 412 时期订单）→ 微信侧订单一直停在
 *       `status: 3`「发货中」，不会转 `4`「已发货」。本 action 扫描 `status='delivered'`
 *       且 `wx_notified_at` 缺失的订单，逐笔补通知。
 *
 * ⭐ 只改**微信侧**订单状态，**绝不触碰积分 / 会员**。幂等，可重复跑。
 * 用法：`{"action":"retryWxNotify"}`（可加 `{"limit":100}`）
 */
async function retryWxNotify(event) {
  const e = event || {};
  const lim = Math.min(Math.max(Number(e.limit) || 50, 1), 100);
  let list = [];
  try {
    const r = await COLL.orders().where({ status: 'delivered' }).orderBy('created_at', 'desc').limit(lim).get();
    list = (r && r.data) || [];
  } catch (err) {
    throw { code: 3, msg: '查询 orders 失败：' + describeError(err) };
  }
  const todo = list.filter((o) => o.out_trade_no && !o.wx_notified_at);
  if (!todo.length) {
    return {
      ok: true,
      scanned: list.length,
      retried: 0,
      succeeded: 0,
      results: [],
      hint: list.length ? '已发货订单均已通知过微信，无需补发' : '没有 status=delivered 的订单',
    };
  }
  const results = [];
  for (const o of todo) {
    try {
      const r = await notifyWxProvided(o);
      results.push(
        r.ok
          ? { order_id: o._id, out_trade_no: o.out_trade_no, ok: true }
          : { order_id: o._id, out_trade_no: o.out_trade_no, ok: false, reason: r.reason, msg: r.msg }
      );
    } catch (err) {
      results.push({ order_id: o._id, out_trade_no: o.out_trade_no, ok: false, reason: describeError(err) });
    }
  }
  return {
    ok: true,
    scanned: list.length,
    retried: todo.length,
    succeeded: results.filter((x) => x.ok).length,
    results,
  };
}

/**
 * 定位目标用户：_id 直取 → openid 内存比对 → 最近活跃的一条
 * ⚠️ 刻意**不用 where 精确匹配**（实测会静默查空，见 grantCredits 注释）
 */
async function resolveTargetUser(e, openid, fromMini) {
  // ① _id 直取（控制台里从 diag / 数据库直接复制过来，最可靠）
  if (e.uid) {
    const d = await COLL.users().doc(String(e.uid)).get();
    if (d && d.data) return { user: d.data, matched_by: 'uid' };
    return { user: null, reason: '按 _id 没找到用户：' + e.uid };
  }

  // ② 拉一批用户在内存里比对 openid（绕开 where 的匹配行为）
  let list = [];
  try {
    const r = await COLL.users().orderBy('last_active_at', 'desc').limit(100).get();
    list = (r && r.data) || [];
  } catch (err) {
    // orderBy 可能因缺索引失败 → 退化为无排序拉取
    try {
      const r2 = await COLL.users().limit(100).get();
      list = (r2 && r2.data) || [];
    } catch (err2) {
      return { user: null, reason: '查询 users 失败：' + describeError(err2) };
    }
  }

  const want = String(openid || '').trim();
  if (want) {
    const hit = list.find((x) => String(x.openid_mini || '') === want);
    if (hit) return { user: hit, matched_by: 'openid' };
    return {
      user: null,
      reason:
        '没找到该 openid 的用户（表里共 ' +
        list.length +
        ' 条；可改用 {"action":"grantCredits","uid":"..."} 或干脆不传 openid 取最近活跃的一条）',
    };
  }

  // ③ 都没传：小程序端从上下文取；控制台则取最近活跃的一条
  const cid = fromMini ? ctxOpenid() : '';
  if (cid) {
    const hit = list.find((x) => String(x.openid_mini || '') === cid);
    if (hit) return { user: hit, matched_by: 'ctx_openid' };
  }
  if (!list.length) return { user: null, reason: 'users 表是空的，先去小程序里登录一次建档' };
  const latest = list
    .slice()
    .sort((a, b) => new Date(b.last_active_at || b.created_at || 0) - new Date(a.last_active_at || a.created_at || 0))[0];
  return { user: latest, matched_by: 'latest_active' };
}

function ctxOpenid() {
  const c = getContext() || {};
  // ⚠️ getContext() 返回的是**小写** openid（见 _common/util.js）—— 写成 OPENID 会恒取空
  return c.openid || '';
}

/**
 * 耗时诊断（控制台排查用，绕开用户校验）
 * 用法：云开发控制台 → 云函数 → api → 「测试」→ 入参 {"action":"timingReport","limit":10}
 * 把最近 N 个已完成任务的分步耗时拉成一张表，看清「慢在哪一段」。
 * ⚠️ 刻意不用 orderBy（where 等值 + 另一字段排序会要求复合索引），改为取一批后在内存排序。
 */
async function timingReport(event) {
  const limit = Math.min(Math.max(Number((event && event.limit) || 10), 1), 30);
  const tasks = COLL.tasks();
  const filter = { extract_kind: cmd().neq('video') };
  if (!(event && event.include_incomplete)) filter.status = TASK_STATUS.DONE;
  const query = tasks.where(filter);
  const r = await query.orderBy('updated_at', 'desc').limit(limit).get();
  const list = (r.data || [])
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    .slice(0, limit);

  const s1 = (ms) => Math.round(((ms || 0) / 1000) * 10) / 10;
  const rows = list.map((t) => {
    const tm = t.timing || {};
    const ms = (k) => (tm[k] && tm[k].ms) || 0;
    const dl = tm.download || {};
    const tr = tm.transcribe || {};
    return {
      task_id: t._id,
      status: t.status,
      source_platform: t.source_platform,
      created_at: t.created_at,
      updated_at: t.updated_at,
      error_reason: t.error && t.error.reason || '',
      title: t.video_title || '',
      duration_sec: t.duration_sec || 0,
      text_source: t.text_source || '',
      total_s: s1(tm.total_ms),
      client_upload_s: s1(t.client_timing && t.client_timing.upload_ms),
      client_prepare_s: s1(t.client_timing && t.client_timing.prepare_ms),
      client_upload_bytes: Number(t.client_timing && t.client_timing.upload_bytes) || 0,
      client_audio_only: !!(t.client_timing && t.client_timing.audio_only),
      including_upload_s: s1((tm.total_ms || 0) + ((t.client_timing && t.client_timing.upload_ms) || 0) + ((t.client_timing && t.client_timing.prepare_ms) || 0)),
      resolve_s: s1(ms('resolve')),
      download_s: s1(ms('download')),
      transcribe_s: s1(ms('transcribe')),
      structure_s: s1(ms('structure')),
      // 下载细节：parallel=走了分片并发；skipped=有字幕直接跳过下载
      parallel: !!dl.parallel,
      cached: !!dl.cached,
      skipped: dl.skipped || '',
      // ⚠️ 跨实例重下的信号：转写步既没命中 /tmp、也没走云存储中转 = 又下一次
      redownload: !dl.skipped && !!dl.ms && tr.media_cached === false && !tr.media_relay,
      media_fetch_s: s1(tr.media_fetch_ms),
      media_fetch_mode: tr.media_fetch_mode || '',
      // ⭐ 字幕抓取耗时（2026-09-29 提速实证：这里曾是最大的黑洞 —— 转写步 31.3s 里 ASR 只 3.1s）
      subtitle_s: s1(tr.subtitle_ms),
      asr_s: s1(tr.asr_ms),
      llm_s: s1((tm.structure && tm.structure.llm_ms) || 0),
      // ⭐ ASR 提速排查（2026-09-29）：把 31 秒拆成「上行」与「服务端」
      //   asr_upload 大 → 云函数上行带宽被节流（对策：减小上传体积 / 换直传）
      //   asr_wait   大 → 服务端排队或推理慢（对策：换 ASR 服务商 / 保活预热）
      asr_upload_s: s1(tr.asr_upload_ms),
      asr_wait_s: s1(tr.asr_wait_ms),
      // ⭐ 模型与尝试次数：不同 ASR 模型算力池延迟差异极大（实测 2s vs 75s），
      //    看这一列就能确认「不快」是模型问题还是别的。
      asr_model: tr.asr_model || '',
      asr_attempts: tr.asr_attempts || 0,
      asr_retry_s: s1(tr.asr_retry_ms),
      asr_attempt_log: tr.asr_attempt_log || [],
      media_bytes: tr.asr_bytes || tr.media_bytes || 0,
      // ⭐ 音频轨抽取的收益（2026-09-29 提速）：原始体积 → 实际上传体积。
      //    audio_sent ≈ 0 说明这一步没生效（文件太小 / 非 AAC / 抽取失败），仍是整片上传。
      audio_from: tr.asr_audio_from || 0,
      audio_sent: tr.asr_audio_sent || 0,
      audio_extract_ms: tr.asr_audio_ms || 0,
      // 该任务走过的「可重试失败」次数（>0 说明墙钟被重试拉长）
      retries: t.step_retries || 0,
      // total 是「建单 → 完成」的**真实墙钟**；减去四步之和 = 轮询间隔 / 重试 / 冷启等未归因时间
      overhead_s: s1(
        Math.max(
          0,
          (tm.total_ms || 0) -
            (ms('resolve') + ms('download') + ms('transcribe') + ms('structure'))
        )
      ),
    };
  });

  const avg = (key) => {
    // 进行中任务只有部分阶段耗时，不能混入完成任务的平均总耗时。
    const arr = rows.filter((x) => x.status === TASK_STATUS.DONE).map((x) => Number(x[key]) || 0);
    if (!arr.length) return 0;
    return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
  };

  return {
    diagnostic_revision: '20261011-speed-r4',
    average_scope: 'completed_tasks_only',
    count: rows.length,
    avg_s: {
      total: avg('total_s'),
      resolve: avg('resolve_s'),
      download: avg('download_s'),
      transcribe: avg('transcribe_s'),
      structure: avg('structure_s'),
      subtitle: avg('subtitle_s'),
      asr_upload: avg('asr_upload_s'),
      asr_wait: avg('asr_wait_s'),
      overhead: avg('overhead_s'),
    },
    redownload_count: rows.filter((x) => x.redownload).length,
    parallel_count: rows.filter((x) => x.parallel).length,
    skipped_count: rows.filter((x) => x.skipped).length,
    retry_total: rows.reduce((a, x) => a + (x.retries || 0), 0),
    hint:
      '① asr_upload 大 → 上行带宽被节流（减小上传体积）；asr_wait 大 → 服务端排队慢（换 ASR / 预热）。' +
      '② overhead 大 → 时间花在轮询间隔/重试/冷启，不在业务步骤里。' +
      '③ redownload_count > 0 说明存在跨实例重下，可把 MEDIA_RELAY_MIN_MS 设为 25000 开启云存储中转。',
    rows,
  };
}

/* ---------------- 虚拟支付（积分充值 / 开通会员） ----------------
 *
 * 为什么用它：积分与会员都是**虚拟商品**，小程序内只能用 wx.requestVirtualPayment 收款，
 * 用普通微信支付会被判违规（详见 _common/virtualpay.js 顶部说明）。
 *
 * 两条通道保证不丢单：
 *   ① 端上支付成功 → confirmOrder（本文件）：服务端**查单确认**后再发货
 *   ② 微信服务器推送 → payNotify 云函数：同样调用 deliverOrder（幂等，重复触发无副作用）
 *
 * ⚠️ 端上的 success 回调**不作为发货依据**：它可能被伪造，也可能因微信异常退出而丢失。
 */

/** 查单接口不可用时是否信任端上 success（应急开关；正式环境应把推送通道配好，保持 false） */
const TRUST_CLIENT_SUCCESS = providers.env('VIRTUAL_PAY_TRUST_CLIENT', 'false') === 'true';

/**
 * 判断查单结果是否「已支付」
 * ⚠️ /xpay/query_order 的返回结构请以官方「服务器 API」文档为准；
 *    这里对常见形态做了兼容取值，字段名对不上时请按文档调整。
 */
function isOrderPaid(q) {
  if (!q || typeof q !== 'object') return false;
  if (Number(q.errcode || 0) !== 0) return false;
  const o = q.order || q.order_info || q.data || q;
  // ⚠️ 官方 /xpay/query_order 的 order.status 是**数字枚举**（不是字符串）：
  //    0 初始化 / 1 创建成功(**未支付**) / 2 已支付待发货 / 3 发货中 / 4 已发货 /
  //    5 已退款 / 6 已关闭 / 7 退款失败 / 8 用户退款完成 / 9 回收广告金 / 10 分账回退
  //    → 只有 2/3/4 该发货；**1 绝不能当"已付"**（否则未付款也会发货）。
  //    （旧版把 '1' 也算已付，是个假阳性隐患，2026-09-29 修正）
  const raw =
    o.status != null
      ? o.status
      : o.order_status != null
      ? o.order_status
      : o.trade_state != null
      ? o.trade_state
      : o.state;
  const st = String(raw == null ? '' : raw).toUpperCase();
  if (st) {
    if (st === '2' || st === '3' || st === '4') return true;
    if (/^\d+$/.test(st)) return false; // 其余数字状态（0/1/5/6/7/8/9/10）一律不发货
    return st === 'PAID' || st === 'SUCCESS' || st === 'DELIVERED';
  }
  // 退化判据：拿到支付单号 / 支付时间即认为已付
  return !!(o.transaction_id || o.transactionId || o.paid_time || o.pay_time);
}

/**
 * 取本次可用的会话密钥
 * ⭐ 优先用端上刚给的 code 现换（最新、最可靠，能避开 -15007 会话过期），
 *    换不到再退回库里存的上一次结果。
 */
async function resolveSessionKey(user, code) {
  if (code) {
    try {
      const s = await vpay.code2Session(code);
      if (s && s.sessionKey) {
        await saveSessionKey(user._id, s.sessionKey);
        return s.sessionKey;
      }
    } catch (e) {
      console.warn('[api] code2Session 失败，回退库中会话密钥', describeError(e));
    }
  }
  return getSessionKey(user);
}

/** 下单前置：支付能力 + 金额范围 + 会话密钥 */
async function precheckPay(user, { code, amountYuan }) {
  if (!vpay.payReady()) {
    throw { code: 501, msg: vpay.NOT_READY_USER_MSG, tip: vpay.NOT_READY_TIP };
  }
  if (amountYuan !== undefined) {
    const yuan = Number(amountYuan) || 0;
    if (!(yuan > 0)) throw { code: 2, msg: '请选择充值金额' };
    if (yuan < CUSTOM_MIN_YUAN || yuan > CUSTOM_MAX_YUAN) {
      throw {
        code: 2,
        msg: '充值金额需在 ' + CUSTOM_MIN_YUAN + '~' + CUSTOM_MAX_YUAN + ' 元之间',
      };
    }
  }
  const sessionKey = await resolveSessionKey(user, code);
  if (!sessionKey) {
    throw { code: 401, msg: '登录态已失效，请退出小程序重新进入后再试', tip: 'session_key 缺失' };
  }
  return sessionKey;
}

/**
 * 充值下单（**代币模式** short_series_coin）
 * 端上 recharge.js#pay → 本函数 → wx.requestVirtualPayment
 *
 * 代币数量 = 金额 × COIN_PER_YUAN（1 元 = 10 支付代币），MP 后台代币兑换比例必须同值。
 * ⭐ 选代币模式的原因：**任意金额都能下单**，充值页的「自定义金额」才保得住。
 */
async function createRechargeOrder(user, { amount, code }) {
  const yuan = Math.round((Number(amount) || 0) * 100) / 100;
  if (Math.abs(yuan * vpay.COIN_PER_YUAN - Math.round(yuan * vpay.COIN_PER_YUAN)) > 1e-8) {
    throw { code: 2, msg: '充值金额请精确到 0.1 元，例如 1.2 元' };
  }
  const sessionKey = await precheckPay(user, { code, amountYuan: yuan });

  const coins = Math.round(yuan * vpay.COIN_PER_YUAN);
  const credits = Math.round(yuan * CREDIT_PER_YUAN);
  const amountCents = Math.round(yuan * 100);
  const outTradeNo = vpay.genOutTradeNo('RC');

  const addRes = await COLL.orders().add({
    data: {
      uid: user._id,
      type: 'recharge',
      status: 'pending',
      amount_cents: amountCents,
      credits,
      credit_rate: CREDIT_PER_YUAN,
      pay_coins: coins,
      out_trade_no: outTradeNo,
      pay_mode: vpay.MODE_COIN,
      env: vpay.payEnv(),
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  await track({
    uid: user._id,
    event: 'recharge_order_created',
    props: { amount: yuan, order: addRes._id },
  });

  const signData = vpay.buildCoinSignData({
    coinAmount: coins,
    outTradeNo,
    // ⚠️ attach 会原样透传到支付推送，发货靠它定位订单
    attach: { orderId: addRes._id },
  });

  return Object.assign(
    { orderId: addRes._id, outTradeNo, amountCents, coins, credits, mode: vpay.MODE_COIN },
    vpay.buildPayParams({ mode: vpay.MODE_COIN, signData, sessionKey })
  );
}

/**
 * 会员下单（**道具模式** short_series_goods）
 * ⚠️ MP 后台「道具管理」里原本配了 4 个道具，ID 与 MEMBER_PLANS 的键一致
 *    （vip_month / vip_quarter / vip_year / vip_unlimited），
 *    且道具价格（分）必须与 priceCents 完全一致，否则下单报 -15013。
 *    ⭐ 2026-10-15：vip_unlimited 已**下架**（详情见 consts.js#MEMBER_PLANS），
 *       后台道具可以留着不动（存量用户还认它），但**新购一律在这里拦掉**。
 */
async function createMemberOrder(user, { plan_id, code }) {
  const plan = MEMBER_PLANS[plan_id];
  if (!plan) throw { code: 2, msg: '套餐不存在' };
  if (plan.offShelf) throw { code: 2, msg: '该套餐已下架，请选择月卡 / 季卡 / 年卡' };
  const sessionKey = await precheckPay(user, { code });

  const outTradeNo = vpay.genOutTradeNo('MB');
  const addRes = await COLL.orders().add({
    data: {
      uid: user._id,
      type: 'member',
      status: 'pending',
      plan_id: plan.id,
      tier: plan.tier,
      amount_cents: plan.priceCents,
      duration_days: plan.durationDays,
      out_trade_no: outTradeNo,
      pay_mode: vpay.MODE_GOODS,
      env: vpay.payEnv(),
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  await track({
    uid: user._id,
    event: 'member_order_created',
    props: { plan: plan_id, order: addRes._id },
  });

  const signData = vpay.buildGoodsSignData({
    productId: plan.id,
    goodsPrice: plan.priceCents,
    buyQuantity: 1,
    outTradeNo,
    attach: { orderId: addRes._id },
  });

  return Object.assign(
    { orderId: addRes._id, outTradeNo, amountCents: plan.priceCents, mode: vpay.MODE_GOODS },
    vpay.buildPayParams({ mode: vpay.MODE_GOODS, signData, sessionKey })
  );
}

/**
 * 支付结果确认（端上 wx.requestVirtualPayment success 后调用）
 * - 订单已是 delivered → 直接回执，不重复发货
 * - 订单仍是 pending → 服务端查单确认；查不到就**不发货**，留给推送通道
 * - 订单是 paid（上次发货失败）→ 借这次机会重试发货
 */
async function confirmOrder(user, { order_id }) {
  const id = String(order_id || '');
  if (!id) throw { code: 2, msg: '缺少订单号' };

  const doc = await COLL.orders().doc(id).get();
  const order = doc && doc.data;
  if (!order || order.uid !== user._id) throw { code: 403, msg: '订单不存在' };
  if (order.status === 'delivered') return { status: 'delivered', delivered: true };
  if (order.status !== 'pending' && order.status !== 'paid') {
    return { status: order.status, delivered: false };
  }

  let paid = order.status === 'paid';
  if (!paid) {
    let verified = false;
    try {
      // ⚠️⭐ 必须带 openid：微信 /xpay/query_order 的 openid 是**必填项**。
      //    此前漏传（body 里 openid 为空串）→ 查单恒失败 → 支付成功后不发货、积分不到账。
      //    2026-09-29 真机实测：充值 5 元 + 1 元，钱已扣、积分未到，根因即此。
      const q = await vpay.queryOrder({
        outTradeNo: order.out_trade_no,
        openid: user.openid_mini || '',
      });
      verified = true;
      paid = isOrderPaid(q);
    } catch (e) {
      console.warn('[api] 查单失败，订单留在 pending 等推送通道', id, describeError(e));
    }
    if (!verified && TRUST_CLIENT_SUCCESS) paid = true;
  }
  if (!paid) return { status: 'pending', delivered: false };

  const r = await deliverOrder(order, { confirm_via: 'query' });
  return { status: r.delivered ? 'delivered' : 'paid', delivered: !!r.delivered };
}

/** 积分流水（分页） */
async function creditLogs(user, { page }) {
  const p = Math.max(1, Number(page) || 1);
  const r = await COLL
    .creditLogs()
    .where({ uid: user._id })
    .orderBy('ts', 'desc')
    .skip((p - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .get();
  const list = (r.data || []).map((l) => ({
    change: l.change,
    after_balance: l.after_balance,
    source: l.source,
    note: l.note || '',
    ts: l.ts,
  }));
  return { list, page: p, hasMore: list.length === PAGE_SIZE };
}

/* ============================================================
 *  消费流水与订单（用户 2026-09-26：「我的 › 提取记录」改为独立的
 *  「积分与订单」子页，用于追溯积分消耗与会员额度消耗）
 *
 *  ⚠️ 主表是 tasks，**不是** copywritings：
 *     · copywritings（历史文案）里没有任何计费字段 —— 扣了多少积分 /
 *       用掉多少会员额度积分，只写在 tasks.credit_decision
 *       { payType:'unlimited'|'quota'|'credit', creditCost, quotaUsed }
 *     · credit_logs（积分流水）**只记积分**：会员额度消耗不写流水，
 *       所以额度追溯也只能从 tasks 拿
 *     · 以 tasks 为主表还有个好处：用户在历史页删掉文案后，消费追溯依然完整
 *       （这正是用户拍板「以服务端计费流水为准」的原因）
 *
 *  ⚠️ 已退还（refunded=true）的**不计入消耗汇总** —— 失败任务的钱已经还回去了，
 *     算进去会重复计数。
 *  ⚠️ 本页「删除」= 只写 usage_hidden:true 把该条流水对当前用户隐藏，
 *     **不动历史文案**（用户拍板：「只从本页移除」）。
 * ============================================================ */

/** task → 消费流水视图模型 */
function shapeUsage(t) {
  const d = t.credit_decision || null;
  const st = String(t.status || '');
  const refunded = !!t.refunded;
  let result = 'doing'; // pending / downloading / transcribing / asr / llm 都算「处理中」
  if (st === TASK_STATUS.DONE) result = 'ok';
  else if (st === TASK_STATUS.FAILED) result = 'failed';
  return {
    _id: t._id,
    platform: t.source_platform || 'other',
    extract_kind: t.extract_kind === 'video' ? 'video' : 'text',
    duration_sec: Number(t.duration_sec) || 0,
    title: t.video_title || '',
    pay_type: d ? d.payType : '',
    credit_cost: d ? Number(d.creditCost) || 0 : 0,
    quota_used: d ? Number(d.quotaUsed) || 0 : 0,
    // charged=false → 还没走到扣费那一步（pending 阶段的任务）
    charged: !!t.charged,
    result,
    refunded,
    ts: t.created_at || t.updated_at || null,
  };
}

/**
 * 消耗汇总（聚合；退还的不计入）
 * ⚠️ 聚合不可用时**抛错**，由调用方决定降级 —— 端上显示「—」，绝不伪造 0
 */
async function usageSummary(uid, monthStart) {
  const $ = db().command.aggregate;
  const creditOf = $.cond({
    if: $.eq(['$refunded', true]),
    then: 0,
    else: $.ifNull(['$credit_decision.creditCost', 0]),
  });
  const quotaOf = $.cond({
    if: $.eq(['$refunded', true]),
    then: 0,
    else: $.ifNull(['$credit_decision.quotaUsed', 0]),
  });
  const coll = COLL.tasks();
  const agg = (match) =>
    coll
      .aggregate()
      .match(match)
      .group({ _id: null, credit: $.sum(creditOf), quota: $.sum(quotaOf), count: $.sum(1) })
      .end();

  const out = { month_credit: 0, total_credit: 0, month_quota: 0, total_quota: 0, month_count: 0, total_count: 0 };
  const all = await agg({ uid });
  const a = (all.list || [])[0] || {};
  out.total_credit = a.credit || 0;
  out.total_quota = a.quota || 0;
  out.total_count = a.count || 0;

  const mon = await agg({ uid, created_at: cmd().gte(monthStart) });
  const m = (mon.list || [])[0] || {};
  out.month_credit = m.credit || 0;
  out.month_quota = m.quota || 0;
  out.month_count = m.count || 0;
  return out;
}

/**
 * 消费明细（分页）+ 汇总 + 会员额度 + 订单，一次返回
 * 分页 20/页，与文案库一致
 */
async function listUsage(user, { page }) {
  const p = Math.max(1, Number(page) || 1);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const out = { list: [], page: p, total: 0, hasMore: false, summary: null, quota: null, tier: 'none', orders: [] };

  // ── ① 流水列表：隐藏的不显示
  const cond = { uid: user._id, usage_hidden: cmd().neq(true) };
  try {
    const cnt = await COLL.tasks().where(cond).count();
    out.total = cnt.total || 0;
    const r = await COLL
      .tasks()
      .where(cond)
      .orderBy('created_at', 'desc')
      .skip((p - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get();
    // 再过滤一遍：neq 对「字段不存在」的行为在不同版本上不完全一致，双保险
    out.list = (r.data || []).filter((t) => t.usage_hidden !== true).map(shapeUsage);
    out.hasMore = p * PAGE_SIZE < out.total;
  } catch (e) {
    // 复合索引缺失 / 集合异常 → 保底：只按 uid 取一批在内存排序，不让整页打不开
    try {
      const r = await COLL.tasks().where({ uid: user._id }).limit(100).get();
      const all = (r.data || [])
        .filter((t) => t.usage_hidden !== true)
        .map(shapeUsage)
        .sort((x, y) => new Date(y.ts || 0) - new Date(x.ts || 0));
      out.total = all.length;
      out.list = all.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
      out.hasMore = (p - 1) * PAGE_SIZE + out.list.length < all.length;
    } catch (e2) {
      /* 集合尚未创建：保持空态，不抛（否则整页打不开） */
    }
  }

  // ── ② 汇总（失败 → summary 保持 null，端上显示「—」）
  try {
    out.summary = await usageSummary(user._id, monthStart);
  } catch (e) {
    /* 保持 null */
  }

  // ── ③ 会员额度（users 文档；没开会员 / 无额度字段 → null）
  //      ⚠️ 「未开通」与「不限次档」的 quota 都是 null → 必须再带一个 tier 让端上区分
  const mem = user.membership || {};
  const memActive = !!(mem.tier && mem.tier !== 'none' && mem.status === 'active');
  out.tier = memActive ? mem.tier : 'none';
  const q = memActive ? mem.quota || null : null;
  out.quota = q
    ? {
        used: Number(q.used) || 0,
        total: Number(q.total) || 0,
        remaining: Number(q.remaining) || 0,
        monthly: Number(q.monthly) || 0,
      }
    : null;

  // ── ④ 订单（充值 / 会员；虚拟支付未接入时通常为空）
  try {
    const r = await COLL
      .orders()
      .where({ uid: user._id })
      .orderBy('created_at', 'desc')
      .limit(20)
      .get();
    out.orders = (r.data || []).map((o) => ({
      _id: o._id,
      type: o.type || 'recharge',
      status: o.status || 'pending',
      amount_cents: Number(o.amount_cents) || 0,
      credits: Number(o.credits) || 0,
      plan_id: o.plan_id || '',
      tier: o.tier || '',
      duration_days: Number(o.duration_days) || 0,
      ts: o.created_at || null,
    }));
  } catch (e) {
    /* 空订单 */
  }

  return out;
}

/**
 * 从本页移除一条消费流水
 * ⚠️ 只写 usage_hidden（不动 copywritings）—— 用户拍板「只从本页移除」
 * where 同时带 uid：只能改自己的任务
 */
async function hideUsage(user, { task_id }) {
  const id = String(task_id || '').trim();
  if (!id) throw { code: 2, msg: '参数缺失' };
  const r = await COLL
    .tasks()
    .where({ _id: id, uid: user._id })
    .update({ data: { usage_hidden: true, updated_at: new Date() } });
  const updated = (r.stats && r.stats.updated) || 0;
  if (!updated) throw { code: 3, msg: '记录不存在或已移除' };
  return { ok: true };
}

/** 意见反馈（T-04；落 events 便于检索） */
async function submitFeedback(user, { content }) {
  const text = (content || '').trim();
  if (!text) throw { code: 2, msg: '请填写反馈内容' };
  if (text.length > 500) throw { code: 2, msg: '反馈请控制在 500 字内' };
  await track({ uid: user._id, event: 'feedback', props: { content: text } });
  return { ok: true };
}

/** 埋点 */
async function doTrack(user, { event, props }) {
  await track({ uid: user._id || '', event: event || '', props: props || {} });
  return { ok: true };
}

/* ============================================================
 *  异常 → 用户可读文案
 * ============================================================
 *
 * ⚠️ 原实现是 `err((e && e.message) || '操作失败', code)`，只读 message 字段。
 *    但本项目里两类异常**压根没有 message**：
 *      ① 业务代码 `throw { code, msg }`  —— 裸对象字面量
 *      ② 微信云 SDK 抛的 `{ errCode, errMsg }` —— 同样是裸对象
 *    结果：无论真因是什么，用户一律看到「操作失败」，排查线索全丢
 *    （曾把「数据表尚未创建」「平台暂不支持」都显示成「操作失败」）。
 *
 * 取值优先级：业务 msg > Error.message > SDK errMsg 归类 > 兜底
 */
function describeError(e) {
  if (!e) return '操作失败，请稍后重试';
  if (typeof e === 'string') return e;

  // ① 业务错误（throw { code, msg }）—— 最精确，优先
  if (e.msg) return String(e.msg);
  // ② Error 实例
  if (e.message) return String(e.message);

  // ③ 微信云 SDK 的 { errCode, errMsg }：归类后给可执行提示，不把英文原文抛给用户
  const raw = String(e.errMsg || '');
  if (/collection.*not.*exist/i.test(raw)) {
    return '数据表尚未创建：需先在云开发控制台建 users / copywritings / tasks 等集合（可用 initDb 一键建）';
  }
  if (/permission denied|PERMISSION_DENIED|-502003/i.test(raw)) {
    return '数据表权限不足，请把集合权限设为「仅管理端可读写」';
  }
  if (/database.*not.*exist|env.*not.*exist|invalid scope/i.test(raw)) {
    return '云环境或数据库尚未就绪，请稍后重试';
  }
  if (/timeout|TIME_LIMIT/i.test(raw)) {
    return '服务处理超时，请稍后重试';
  }
  if (raw) return '服务异常：' + raw.slice(0, 120);

  return '操作失败，请稍后重试';
}

/* ============================================================
 *  数据库初始化（运维用，幂等）
 * ============================================================
 *
 * 微信云数据库不会自动建集合，未建时任何读写都会抛
 * `{ errCode: -502005, errMsg: 'database collection not exists' }`。
 * 这个 action 让部署后可以**一键建齐 7 个集合**，不必去控制台手点。
 *
 * 调用方式：云开发控制台 → 云函数 → api → 「测试」→ 入参 {"action":"initDb"}
 * 幂等：已存在的集合跳过；**只建集合，不碰任何已有数据**。
 * ⚠️ 索引仍需在控制台手动加（云 SDK 不提供建索引接口），但没索引不影响功能。
 */
async function initDb() {
  const names = Object.values(DB_COLLECTIONS);
  const created = [];
  const existed = [];
  const failed = [];

  for (const name of names) {
    try {
      await db().createCollection(name);
      created.push(name);
    } catch (e) {
      const raw = String((e && (e.errMsg || e.message)) || '');
      // ⚠️ 微信云 SDK 报「已存在」用的**不是** -502002，而是 -501001，
      //    errMsg 形如：resource system error. [ResourceUnavailable.ResourceExist] Table exist
      //    2026-09-26 实测：只按 -502002 判断，7 个已存在的表会被整批误报进 failed。
      if (/already exist|ResourceExist|Table exist|-502002|-501001/i.test(raw)) {
        existed.push(name);
      } else {
        failed.push(name + ' → ' + (raw || '未知错误'));
      }
    }
  }

  return { total: names.length, created, existed, failed };
}

/* ============================================================
 *  链路 A 结果回推（方案 D）
 * ============================================================
 *
 * ⭐⭐ 为什么必须由「小程序端触发」的云函数来发：
 *   客服消息的**云调用**（cloud.openapi.customerServiceMessage.send）自动鉴权的前提是
 *   「云函数由小程序端触发」。A 链路任务由 receiveCallback 创建并推进，而它是
 *   「HTTP 访问服务」触发 → 在那里发必报
 *       -501001 customerServiceMessage.send:fail invalid wx_openapi access_token
 *   （已实测，见 receiveCallback 注释）。
 *
 * 因此改为：云端只负责把结果标记为「待推送」（copywritings.push_pending = true），
 *   等用户打开小程序（app.onLaunch / 「我的」页 onShow）时调本 action 完成推送。
 *
 * 为什么体验上可接受：
 *   用户刚刚转发过视频 → 与服务号的会话必然在 48 小时窗口内 → 客服消息可送达。
 *   即便超出窗口（转发后隔天才打开小程序），也只是推送失败，结果仍在文案库，
 *   前端另有 pending_pushes 顶部提醒兜底。
 */

/** 取当前用户待推送的文案（A 链路 + push_pending） */
async function pushPending(user, event) {
  const limit = Math.min(Math.max(Number((event && event.limit) || 5), 1), 20);

  const r = await COLL
    .copywritings()
    .where({ uid: user._id, channel: 'A', push_pending: true })
    .limit(limit)
    .get();
  const list = (r.data || []).filter((c) => !c.deleted);
  if (!list.length) return { pushed: 0, failed: 0, total: 0 };

  // 取服务号 openid：优先用户档案，其次任务上的 userOpenid（A 链路建任务时写的）
  let gzhOpenid = user.openid_gzh || '';
  if (!gzhOpenid && list[0].task_id) {
    try {
      const tr = await COLL.tasks().doc(list[0].task_id).get();
      gzhOpenid = (tr.data && tr.data.userOpenid) || '';
    } catch (e) {
      /* ignore */
    }
  }
  if (!gzhOpenid) {
    return { pushed: 0, failed: list.length, total: list.length, error: '该账号未绑定服务号 openid' };
  }

  // 缩略图（公众号素材库配置；未配则降级纯文本）
  let thumb = '';
  try {
    const t = await COLL.config().doc('gzh_thumb_media').get();
    thumb = (t.data && t.data.media_id) || '';
  } catch (e) {
    thumb = '';
  }

  const appid = process.env.GZH_APPID || '';
  let pushed = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    try {
      if (thumb) {
        await cloud.openapi({ appid }).customerServiceMessage.send({
          touser: gzhOpenid,
          msgtype: 'miniprogrampage',
          miniprogrampage: {
            title: String(c.video_title || '文案已生成').slice(0, 20),
            pagepath: 'pages/detail/detail?id=' + c._id,
            thumb_media_id: thumb,
          },
        });
      } else {
        await cloud.openapi({ appid }).customerServiceMessage.send({
          touser: gzhOpenid,
          msgtype: 'text',
          text: {
            content:
              '✅ 文案已生成：' +
              (c.video_title || '未命名') +
              '\n📎 打开小程序「极速视频文案提取」- 文案库查看 / 复制',
          },
        });
      }
      // 推送成功 → 清标记（幂等：只有这里会清）
      await COLL
        .copywritings()
        .doc(c._id)
        .update({ data: { push_pending: false, push_state: 'kf_sent', pushed_at: new Date() } })
        .catch(() => {});
      pushed += 1;
    } catch (e) {
      failed += 1;
      const m = describeError(e);
      errors.push({ id: c._id, error: m });
      console.warn('[api] pushPending 单条失败', c._id, m);
      // 权限/鉴权类错误后续必然同样失败 → 不再继续尝试剩余条目，避免无意义循环
      if (/-501001|-604101|invalid wx_openapi/i.test(String(e && (e.errMsg || e.message || e)))) break;
    }
  }

  // 未推全部成功时，用户的待推送计数保持（用于小程序内顶部提醒）
  if (pushed > 0) {
    await COLL
      .users()
      .doc(user._id)
      .update({ data: { pending_pushes: failed } })
      .catch(() => {});
  }

  return {
    pushed,
    failed,
    total: list.length,
    errors: errors.slice(0, 3),
    hint:
      pushed > 0
        ? '已推送到服务号聊天窗口'
        : '推送失败：若报 -501001/-604101，请确认本云函数由小程序端触发（云调用自动鉴权前提）',
  };
}

/**
 * ⭐ 云调用「客服消息」能力自测（绕开用户校验，控制台直接调）。
 *
 * 用途：在**不动任何真实数据**的前提下，判定「云调用能不能发客服消息」。
 * 因为正式链路 pushPending 需要用户打开小程序才能触发，本 action 让排查不必等真机。
 *
 * ⚠️ 本 action 只在控制台「测试」里调用时才有意义：
 *    控制台调用**没有小程序端上下文** → 云调用自动鉴权可能同样失败（这正是要观察的现象之一）。
 *    真正判定「小程序端触发能否成功」仍需 app.onLaunch 走一次真实调用（看返回里的 pushed）。
 *
 * 入参：{"action":"pushDiag","openid":"服务号openid","text":"自定义内容"}
 */
async function pushDiag(event) {
  const e = event || {};
  const appid = process.env.GZH_APPID || '';
  const out = {
    appid: appid ? appid.slice(0, 8) + '...' : '❌ GZH_APPID 未配置',
    openid: e.openid ? String(e.openid).slice(0, 6) + '...' + String(e.openid).slice(-4) : '(未传)',
    send: null,
    whoami: null,
  };

  // 顺带探一次当前云函数是否拿到小程序上下文（判断有没有「小程序端触发」的自动鉴权）
  try {
    const ctx = getContext();
    out.whoami = {
      has_openid: !!ctx.openid,
      openid: ctx.openid ? String(ctx.openid).slice(0, 6) + '...' : '',
      has_unionid: !!ctx.unionid,
      source: ctx.source || '',
    };
  } catch (err) {
    out.whoami = { error: describeError(err) };
  }

  if (!appid) {
    out.send = { ok: false, error: 'GZH_APPID 未配置 → 无法调云调用' };
    return out;
  }
  if (!e.openid) {
    out.send = { ok: false, skipped: true, reason: '未传 openid，无法试发' };
    out.hint = '传 {"action":"pushDiag","openid":"<与服务号交互过的用户openid>"} 复跑';
    return out;
  }

  try {
    const r = await cloud.openapi({ appid }).customerServiceMessage.send({
      touser: e.openid,
      msgtype: 'text',
      text: { content: e.text || '【云调用自测】能收到这条，说明客服消息通道可用 ✓' },
    });
    out.send = { ok: true, errcode: r && r.errcode, errmsg: r && r.errmsg };
  } catch (err) {
    out.send = { ok: false, error: describeError(err), raw: String((err && err.errMsg) || '').slice(0, 200) };
  }

  out.hint =
    out.send && out.send.ok
      ? '✅ 云调用客服消息可用'
      : '❌ 失败。若报 -501001 invalid wx_openapi access_token → 云调用自动鉴权不成立' +
        '（要求云函数由小程序端触发；控制台调用不算）。改用 app.onLaunch 触发 pushPending 验证。';
  return out;
}

/**
 * 只读诊断（不改任何数据）
 * 用途：排查「新人 50 积分未到账」—— 看清 users 里到底有几条档案、各自的积分与 trial 状态。
 * 走 exports.main 旁路，不经过 ensureUserFromContext
 * （控制台调用没有 openid，否则会被当成新用户建一条空档案）。
 */
async function diag() {
  const ctx = getContext();
  const mask = (s) => (s ? String(s).slice(0, 6) + '…' + String(s).slice(-4) : '(空)');

  const out = { ctx_openid: mask(ctx.openid), ctx_unionid: mask(ctx.unionid) };

  try {
    const cnt = await COLL.users().count();
    out.userCount = cnt.total;
  } catch (e) {
    out.userCount = '查询失败：' + describeError(e);
  }

  try {
    const r = await COLL.users().orderBy('created_at', 'desc').limit(20).get();
    out.users = (r.data || []).map((u) => {
      const c = u.credits || {};
      return {
        openid_mini: mask(u.openid_mini),
        balance: c.balance || 0,
        total_earned: c.total_earned || 0,
        trial_granted: !!(u.trial && u.trial.granted),
        created_at: u.created_at,
      };
    });
  } catch (e) {
    out.users = '查询失败：' + describeError(e);
  }

  // 直接给结论，省得对着字段猜
  if (Array.isArray(out.users)) {
    const pending = out.users.filter((u) => !u.trial_granted);
    if (!out.users.length) {
      out.verdict = 'users 表为空 —— 尚未建档。从小程序端进一次首页即会建档并发放 50 积分。';
    } else if (pending.length) {
      out.verdict = '有 ' + pending.length + ' 条档案 trial_granted=false（新人积分未发放或发放失败）。重新部署 api 后，从小程序端进一次首页会自动补发。';
    } else {
      out.verdict = '所有档案都已发放新人积分（trial_granted=true）。若首页仍显示 0，问题在前端未拿到用户 —— 看 Console 里的 [api] / [app] 日志。';
    }
  }

  return out;
}

/**
 * 保存用户**本人主动提交**的昵称 / 头像（2026-09-27 新增）
 *
 * 背景：users 档案里本来就有 `nickname` / `avatarUrl` 两个字段，`userCenterSummary` 也一直在下发，
 *   但**从来没有写入路径** → 「我的」页点头像/昵称毫无反应。本 action 补上这一环。
 *
 * ⚠️ 只写这两个字段，其它一概不碰 —— 这是**用户自己填的内容**，程序不代改、不覆盖、不迁移
 *    （「用户记录的内容不允许任何非用户本人的改动」铁律）。
 * ⚠️ 云端必须再校验一次：端上可被绕过 → 昵称去首尾空白 + 截断 20 字；头像只接受字符串且截断 512。
 * ⚠️ 空值**不写**：避免一次误清空把真名永久抹掉（端上另有默认昵称兜底，不会给云端送空）。
 * ⚠️ 返回**更新后的摘要**，端上直接用返回值 setData，省掉一次 getUser 往返。
 */
async function saveProfile(user, { nickname, avatarUrl }) {
  const patch = {};
  if (typeof nickname === 'string') {
    const n = nickname.trim().slice(0, 20);
    if (n) patch.nickname = n;
  }
  if (typeof avatarUrl === 'string' && avatarUrl) {
    patch.avatarUrl = avatarUrl.slice(0, 512);
  }
  if (!Object.keys(patch).length) return userCenterSummary(user);

  patch.updated_at = new Date();
  await COLL.users().doc(user._id).update({ data: patch });
  return userCenterSummary(Object.assign({}, user, patch));
}

const actions = {
  redeemFriendInvite: friendInvite.redeem,
  startVideoExtract: videoExtract.start,
  getVideoTask: videoExtract.get,
  videoSaved: videoExtract.saved,
  referralSummary: referral.summary,
  referralPosterCode: referral.posterCode,
  // 用户
  ensureUser: async (user) => userCenterSummary(user),
  userCenter: async (user) => userCenterSummary(user),
  getUser: async (user) => userCenterSummary(user),
  saveProfile, // 「我的」页保存用户自己设的昵称 / 头像（见函数注释）
  // 文案库
  listCopywritings,
  userStats, // 「我的」页三个统计 + 最近一条（聚合，见函数注释）
  getCopywriting,
  updateCopywriting,
  deleteCopywriting,
  clearCopywritings,
  // 提取链路
  parseLink,
  getTask,
  cancelTask,
  // 计费与订单
  creditLogs,
  listUsage, // 「积分与订单」子页：消费明细 + 汇总 + 会员额度 + 订单（tasks 为主表，见函数注释）
  hideUsage, // 从该页移除一条流水（只写 usage_hidden，不动历史文案）
  createRechargeOrder,
  createMemberOrder,
  confirmOrder, // 端上支付成功后调：服务端查单确认 → 幂等发货
  // 杂项
  submitFeedback,
  track: doTrack,
  // 链路 A 结果回推（方案 D：小程序端触发 → 云调用自动鉴权生效）
  pushPending,
  // 运维（绕开用户校验，见 exports.main）
  providerStatus,
  timingReport,
};

exports.main = async (event) => {
  const action = event && event.action;

  // ⚠️ initDb / diag 是运维与诊断 action，必须**绕开**「确保用户」这一步：
  //    ① users 集合不存在时 ensureUserFromContext() 会先抛错，
  //       导致 initDb 永远执行不到 —— 那就永远建不了表（死锁）；
  //    ② 控制台调用没有 openid（会抛 401），拿不到诊断结果。
  const OPS_ACTIONS = { initDb, diag, pushDiag, providerStatus, timingReport, grantCredits, fixOrder, sigProbe, retryWxNotify,
    welcomeBonusBatch: welcomeBonus.batch, welcomeBonusReport: welcomeBonus.report };
  if (OPS_ACTIONS[action]) {
    try {
      return ok(await OPS_ACTIONS[action](event));
    } catch (e) {
      return err(describeError(e), e && e.code ? e.code : 1);
    }
  }

  const fn = actions[action];
  if (!fn) return err('unknown action: ' + action, 404);

  try {
    // 先确保用户（所有业务 action 都挂 uid）
    const user = await ensureUserFromContext({ referralCode: referral.normalize(event.referralCode) });
    if (!user) return err('login required', 401);
    // 登录、首页刷新和分享落地均可补偿处理；事务失败保留 pending，下一次请求重试。
    let current = user;
    try {
      const result = await referral.bindPending(user);
      if (result.changed) {
        const fresh = await COLL.users().doc(user._id).get();
        current = fresh.data || user;
      }
      if (!current.referral_code) current.referral_code = await referral.ensureCode(current);
    } catch (e) {
      // 推荐事务保持 pending，可重试；推荐服务故障不能影响原有提取和登录。
      console.warn('[referral] 暂未完成，将于下一次访问重试', e && (e.errMsg || e.message));
    }
    const data = await fn(current, event);
    return ok(data);
  } catch (e) {
    const code = e && e.code ? e.code : 1;
    // ⚠️ 不能用 e.message —— 业务错误是 { code, msg } 裸对象，SDK 错误是 { errCode, errMsg }
    return err(describeError(e), code);
  }
};
