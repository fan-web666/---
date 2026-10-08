// utils/extract-session.js - 全局提取会话（跨页面存活的状态机）
/* ⭐⭐ 2026-09-28 用户需求：「允许后台提取」——从提取中页返回首页后任务必须继续跑，
   且首页「立即提取」按钮要显示「提取中 28%」。

   ⚠️⚠️ 为什么必须独立成模块，不能留在 pages/loading 里：
   ① 页面实例在 navigateBack 时被销毁，挂在页面上的 setTimeout 随之失效；
   ② **服务端的流水线是靠前端轮询 getTask 驱动的**（每次轮询推进一步，见
      cloudfunctions/api/index.js#getTask）—— 轮询一停，任务就只剩 parsePipeline
      定时器（每 1 分钟一步）兜底，用户要干等好几分钟。
   → 轮询必须活在「不随页面销毁」的地方：模块级单例。

   结构（唯一状态源，三个视图）：
       本模块            = 状态机 + 轮询 + 平滑推帧 + 终态弹窗
       pages/loading     = 进度视图（订阅后渲染；结果是它负责跳转）
       pages/index       = 按钮视图（只读 phase / percent，用来改「立即提取」按钮文案）

   ⚠️ 本文件的进度算法（锚点只升不降 + 时间驱动 creep、上限 95%）与超时常量
      原是 pages/loading/loading.js 的实现，**原样搬移，未改数值** ——
      详见 DETAIL-云函数与提取链路.md「加载进度：锚点＋时间驱动」。 */

const { call } = require('./api');
const { cacheLocalThumb } = require('./util');
const tracker = require('./tracker');

// ⚠️ 惰性取 app：本模块可能在 App() 执行完之前就被 require（utils 的规矩，同 utils/auth.js）
const app = () => getApp();

/* ---------- 常量（与原 loading.js 一致，勿单边改） ---------- */
const POLL_INTERVAL = 800; // 轮询间隔（毫秒）
const TIMEOUT = 300 * 1000; // 超时上限（毫秒）
const SMOOTH_INTERVAL = 300; // 进度环平滑推帧间隔（毫秒）
const CREEP_SECONDS = 220; // 时间驱动爬升总时长（秒）：到这个点爬到 95% 上限

const STEPS = () => [
  { key: 'parse', name: '解析视频链接', status: 'doing', statusText: '进行中' },
  { key: 'asr', name: '提取字幕 / 识别语音', status: 'idle', statusText: '等待中' },
  { key: 'format', name: '整理成文案段落', status: 'idle', statusText: '等待中' },
];

const STAGE_INFO = {
  parse: { title: '正在解析视频链接…', sub: '正在向平台获取视频信息' },
  asr: { title: '正在提取字幕 / 识别语音…', sub: '有字幕优先用字幕，没有才转写语音' },
  format: { title: '正在整理文案段落…', sub: '马上就好' },
};

/* ---------- 状态 ---------- */
const state = {
  phase: 'idle', // idle | running | done | failed
  mode: '', // link | local
  taskId: '',
  percent: 0,
  statusLabel: '解析中',
  title: '',
  headSub: '',
  cover: '',
  stateTitle: '正在提取视频文案…',
  stateSub: '请勿退出，稍后自动跳转',
  steps: STEPS(),
  resultId: '',
  errorMsg: '',
};

let payload = null; // 当前任务的启动参数（失败重试要用同一份）
const subs = [];
const viewers = {}; // 谁在看进度（决定终态由谁提示，避免双重弹窗）
let pollTimer = null;
let smoothTimer = null;
let startAt = 0;
let srvPercent = 0; // 服务端锚点（离散：10/40/55/80/100）
let displayPercent = 0; // 环形显示值（小数，平滑推帧）
let lastSrvAt = 0;
let lastSrvError = '';
let lastSnap = {};

function snapshot() {
  return {
    phase: state.phase,
    mode: state.mode,
    percent: state.percent,
    statusLabel: state.statusLabel,
    title: state.title,
    headSub: state.headSub,
    cover: state.cover,
    stateTitle: state.stateTitle,
    stateSub: state.stateSub,
    steps: state.steps,
    resultId: state.resultId,
    errorMsg: state.errorMsg,
  };
}

/**
 * 外发变更。只把**真正变了**的键放进 patch —— 平滑推帧每 300ms 一次，
 * 不筛的话页面会跟着做无谓 setData（进度环只是重绘 canvas，不需要过 setData）。
 * @param {string} [event] 'change' | 'start' | 'done' | 'reset'
 */
function emit(event) {
  const snap = snapshot();
  const patch = {};
  Object.keys(snap).forEach((k) => {
    const a = snap[k];
    const b = lastSnap[k];
    const same = Array.isArray(a) ? JSON.stringify(a) === JSON.stringify(b) : a === b;
    if (!same) patch[k] = a;
  });
  lastSnap = snap;
  if (!Object.keys(patch).length && !event) return;
  subs.slice().forEach((fn) => {
    try {
      fn(snap, patch, event || 'change');
    } catch (e) {
      console.warn('[session] 订阅回调异常', e && e.message);
    }
  });
}

function subscribe(fn) {
  subs.push(fn);
  try {
    fn(snapshot(), snapshot(), 'init'); // 立即回调一次 → 页面不用自己拉首个状态
  } catch (e) {
    console.warn('[session] 首次回调异常', e && e.message);
  }
  return function unsubscribe() {
    const i = subs.indexOf(fn);
    if (i > -1) subs.splice(i, 1);
  };
}

/** 登记「正在看进度页」—— 终态弹窗只由一处弹，避免双重提示 */
function setViewer(name, on) {
  if (on) viewers[name] = true;
  else delete viewers[name];
}
function hasViewer(name) {
  return !!viewers[name];
}

/* ---------- 进度（锚点 + 时间驱动，原实现搬移） ---------- */

/** 设置显示进度（接受小数；整数变化才外发，驱动环由页面自己重绘） */
function setPercent(p) {
  const raw = Math.max(0, Math.min(100, Number(p) || 0));
  displayPercent = raw;
  const v = Math.round(raw);
  if (v === state.percent) return;
  state.percent = v;
  state.statusLabel = v < 30 ? '解析中' : v < 90 ? '识别中' : '整理中';
  emit('change');
}

/** 收到服务端锚点（离散值）：只升不降，并立刻抬到该值 */
function setSrvPercent(p) {
  const v = Math.max(0, Math.min(100, Math.round(Number(p) || 0)));
  if (v <= srvPercent) return;
  srvPercent = v;
  lastSrvAt = Date.now();
  if (v > displayPercent) setPercent(v);
}

function startSmooth() {
  stopSmooth();
  const tick = () => {
    if (state.phase !== 'running') return;
    const elapsed = (Date.now() - startAt) / 1000;
    const stall = Math.min(30, Math.floor((Date.now() - lastSrvAt) / 1000));
    const creep = 95 * (1 - Math.pow(1 - Math.min(elapsed / CREEP_SECONDS, 1), 2.2));
    const anchor = srvPercent + 8 + stall;
    const target = Math.min(95, Math.max(anchor, creep));
    if (displayPercent < target) {
      const step = Math.max(0.6, (target - displayPercent) * 0.22);
      setPercent(Math.min(target, displayPercent + step));
    }
    smoothTimer = setTimeout(tick, SMOOTH_INTERVAL);
  };
  smoothTimer = setTimeout(tick, SMOOTH_INTERVAL);
}

function stopSmooth() {
  if (smoothTimer) {
    clearTimeout(smoothTimer);
    smoothTimer = null;
  }
}

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function stopAll() {
  clearPoll();
  stopSmooth();
  stopTextTick();
}

/* ---------- 阶段 ---------- */

function applyStage(stage) {
  const order = ['parse', 'asr', 'format'];
  const idx = order.indexOf(stage);
  state.steps = state.steps.map((s, i) => {
    let status = 'idle';
    if (stage === 'done' || (idx > -1 && i < idx)) status = 'done';
    else if (i === idx) status = 'doing';
    return Object.assign({}, s, {
      status,
      statusText: status === 'done' ? '已完成' : status === 'doing' ? '进行中' : '等待中',
    });
  });
  const info = STAGE_INFO[stage] || {};
  if (info.title) state.stateTitle = info.title;
  if (info.sub) state.stateSub = info.sub;
  // 三步小字带上各自真实耗时（已完成 · 31s / 进行中 · 52s）
  decorateSteps();
  emit('change');
}

/* ---------- 启动 ---------- */

/**
 * 开一次提取。
 * @param {{mode:'link'|'local', url?:string, path?:string, thumb?:string}} p
 */
function start(p) {
  const o = p || {};
  const isLocal = o.mode === 'local';
  payload = {
    mode: isLocal ? 'local' : 'link',
    url: o.url || '',
    path: o.path || '',
    thumb: o.thumb || '',
    // ⭐ 2026-09-29 提速：带上体积与时长，用来判断「值不值得压缩」（见 shouldCompress）
    sizeMB: Number(o.sizeMB) || 0,
    durationSec: Number(o.durationSec) || 0,
  };

  stopAll();
  state.phase = 'running';
  state.mode = payload.mode;
  state.taskId = '';
  state.percent = 0;
  state.statusLabel = '解析中';
  state.title = isLocal ? '本地视频' : '正在解析视频…';
  state.headSub = isLocal ? '正在上传…' : '链接已提交，正在处理';
  // ⭐ 封面：本地视频在选片时就有缩略图 → 立刻显示，不再是一块黑；
  //    链接视频的平台封面要等「取源」那一步，由轮询回传（getTask → cover）
  state.cover = isLocal ? payload.thumb : '';
  state.stateTitle = isLocal ? '正在上传视频…' : '正在解析视频链接…';
  state.stateSub = isLocal ? '大文件上传需要一点时间' : '正在向平台获取视频信息';
  state.steps = STEPS();
  state.resultId = '';
  state.errorMsg = '';

  startAt = Date.now();
  srvPercent = 0;
  displayPercent = 0;
  lastSrvAt = Date.now();
  lastSrvError = '';
  // 阶段计时清零（每步耗时按本次提取单独统计）
  curStatus = '';
  statusAt = 0;
  statusMs = {};
  pollStartAt = 0;
  lastSnap = {}; // 强制全量外发一次

  emit('start');
  startSmooth();

  if (isLocal) submitLocal();
  else submitLink();
}

async function submitLink() {
  const a = app();
  if (!a || !a.globalData.cloudReady) return mockRun();
  if (!payload.url) return fail(new Error('缺少视频链接'));
  try {
    applyStage('parse');
    setSrvPercent(12);

    const tLink = Date.now();
    const res = await call('parseLink', { url: payload.url });
    if (state.phase !== 'running') return; // 期间被取消 / 已收尾
    console.log('[extract] 建任务 ' + (Date.now() - tLink) + 'ms（含冷启动）');

    state.taskId = (res && res.task_id) || '';
    if (!state.taskId) {
      if (res && res.copywriting_id) return finish(res.copywriting_id);
      throw new Error((res && (res.msg || res.hint)) || '任务创建失败');
    }

    if (res.video_title) {
      state.title = res.video_title;
      state.headSub = (res.duration_sec ? '时长已获取 · ' : '') + '链接已解析';
      emit('change');
    }

    tracker.track('extract_start', { platform: res.platform || '' });
    startPoll();
  } catch (e) {
    fail(e);
  }
}

// ⭐⭐ 2026-09-29 提速（本地视频专用）：上传前先压一道 —— **但只在「真的划算」的时候压**。
//    ASR 只吃音频轨，**视频清晰度对识别结果毫无影响** —— 所以「压低画质」≠「降低提取质量」。
//    手机原片动辄 1080p / 4K（10 秒就 20~40MB），直传会把云函数的上行占满，
//    实测 50 秒都传不完 → 直接撞 ASR 超时（用户看到「语音识别超时（50 秒），请更换更短的视频」）。
//
//    ⚠️⚠️ 但压缩本身很贵：wx.compressVideo 要把**整段视频重新解码再编码**，耗时与时长/分辨率
//    成正比，真机上 20 秒 1080p 常见 30~60 秒。而它的唯一收益只是「少传一点体积」。
//    所以两个维度都要判：**体积小 → 传就完事了；码率本来就低 → 压了也降不下来，白等。**
const COMPRESS_MIN_MB = 8;        // ≤ 8MB：上传几秒就完，压缩纯亏
const COMPRESS_MIN_MBPS = 3.5;    // ≤ 3.5Mbps：已经是低码率源，压完体积几乎不变
const COMPRESS_TIMEOUT_MS = 20000; // 硬熔断：慢机型上宁可传原片，也不能一直卡在「解析中」

/** 是否值得走压缩（导出供诊断/日志用） */
function shouldCompress(sizeMB, durationSec) {
  if (!sizeMB || sizeMB <= COMPRESS_MIN_MB) return false;
  if (!durationSec || durationSec <= 0) return true; // 拿不到时长，按大文件处理
  return (sizeMB * 8) / durationSec > COMPRESS_MIN_MBPS;
}

/**
 * 压缩（可能直接返回原路径）。
 * ⚠️ 失败 / 超时 / 老基础库不支持 → **原样上传**，主流程不受影响。
 * ⚠️ 熔断触发后压缩仍在后台跑，这里不再等它 —— 不阻塞就是目的。
 */
function compressVideoIfPossible(path, sizeMB, durationSec) {
  if (!path || typeof wx.compressVideo !== 'function') return Promise.resolve(path);
  if (!shouldCompress(sizeMB, durationSec)) return Promise.resolve(path);
  return new Promise((resolve) => {
    let settled = false;
    const done = (p) => {
      if (settled) return;
      settled = true;
      resolve(p || path);
    };
    setTimeout(() => {
      if (settled) return;
      console.warn('[extract] 压缩超过 ' + COMPRESS_TIMEOUT_MS + 'ms，改用原片继续');
      done(path);
    }, COMPRESS_TIMEOUT_MS);
    wx.compressVideo({
      src: path,
      quality: 'low',
      success: (r) => done((r && r.tempFilePath) || path),
      fail: () => done(path),
    });
  });
}

async function submitLocal() {
  const a = app();
  if (!a || !a.globalData.cloudReady) return mockRun();
  if (!payload.path) return fail(new Error('未取到视频文件'));
  try {
    applyStage('parse');
    setSrvPercent(8);

    // 只有「体积大 + 码率高」才值得压；压不出结果（失败 / 超时 20s）就原样传，绝不阻断主流程
    const tCompress = Date.now();
    if (shouldCompress(payload.sizeMB, payload.durationSec)) {
      state.headSub = '正在压缩视频…';
      state.stateSub = '压缩后上传更快，最长等 20 秒';
      emit('change');
    }
    const uploadPath = await compressVideoIfPossible(payload.path, payload.sizeMB, payload.durationSec);
    if (state.phase !== 'running') return;
    console.log(
      '[extract] 压缩' +
        (uploadPath === payload.path ? '跳过' : '完成') +
        ' ' + (Date.now() - tCompress) + 'ms · 源 ' + (payload.sizeMB || '?') + 'MB'
    );

    // 上传进度：把体积写到界面上，用户能看出「是在传，不是卡了」
    state.headSub = '正在上传' + (payload.sizeMB ? ' · ' + payload.sizeMB.toFixed(1) + 'MB' : '') + '…';
    state.stateSub = '上传完成即开始识别';
    emit('change');
    const tUpload = Date.now();
    const cloudPath = 'tmp/' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.mp4';
    const up = await wx.cloud.uploadFile({ cloudPath, filePath: uploadPath });
    if (state.phase !== 'running') return;
    console.log('[extract] 上传 ' + (Date.now() - tUpload) + 'ms');

    // ⭐ 把选片时拿到的缩略图转存到本地持久目录（key = 云存储 fileID）→
    //    历史 / 结果页直接用它当封面，不再出现「先一块黑图、过会才出首帧」的过程。
    //    失败静默：拿不到就回落 <video> 首帧，不影响上传主流程。
    cacheLocalThumb(up.fileID, payload.thumb);

    state.headSub = '上传完成，正在解析';
    setSrvPercent(20);
    emit('change');

    const tLink = Date.now();
    const res = await call('parseLink', { file_id: up.fileID, source: 'local' });
    if (state.phase !== 'running') return;
    console.log('[extract] 建任务 ' + (Date.now() - tLink) + 'ms（含冷启动）');

    state.taskId = (res && res.task_id) || '';
    if (!state.taskId) {
      if (res && res.copywriting_id) return finish(res.copywriting_id);
      throw new Error((res && (res.msg || res.hint)) || '任务创建失败');
    }
    startPoll();
  } catch (e) {
    fail(e);
  }
}

/* ---------- 轮询 ---------- */

/**
 * 服务端 status → 进度小字。
 * ⚠️ 前端 steps 只有三档（parse / asr / format），而服务端 status 有五档 ——
 *    细化到 status 才能看出「到底卡在取源、下载、识别还是整理」。
 */
const STATUS_TEXT = {
  pending: '正在解析视频链接',
  downloading: '正在下载视频',
  transcribing: '正在语音识别',
  asr: '正在整理文案',
  llm: '正在整理文案',
};

/* ---------- 阶段计时（⭐ 2026-09-29：秒数必须本地走，不能等响应） ---------- *
 * ⚠️ 为什么必须这样：云函数一次 getTask 最长会跑 40~50 秒（单步硬超时：
 *    下载 45s / ASR 50s），HTTP 响应要等整个函数返回才发出来。
 *    原来「正在语音识别 · 6s」这行字**只在收到响应时**刷新 ——
 *    于是那 50 秒里数字一动不动，用户看到的就是「卡死」。
 *    → 秒数交给本地 1 秒定时器：响应来不来，字都在走。
 *    → 顺带把每一步的真实耗时写到步骤小字上（已完成 · 31s），
 *      不用翻日志、不用截图，卡在哪一环一眼可见。
 * ------------------------------------------------------------------------ */
// 服务端 status → 前端三步（与 api/index.js#STAGE_BY_STATUS 同源，改一处必须同步）
const STATUS_STEP = {
  pending: 'parse',
  downloading: 'asr',
  transcribing: 'asr',
  asr: 'format',
  llm: 'format',
};
let curStatus = ''; // 最近一次观测到的服务端 status
let statusAt = 0; // 进入该 status 的本地时刻
let statusMs = {}; // status → 已确认耗时（ms），用于步骤小字
let textTimer = null; // 本地 1 秒定时器（与轮询响应解耦）
let pollStartAt = 0; // 开始轮询的时刻（用来给「取源」那步补时长）

/** 观测到服务端 status 变化 → 结算上一个 status 的时长 */
function noteStatus(st) {
  if (!st || st === 'failed' || st === 'done') return;
  if (st === curStatus) return;
  // 首个响应之前那段没有 status 可归属（链接视频＝取源那一步）→ 记给「解析视频链接」
  if (!curStatus && pollStartAt && st !== 'pending') {
    statusMs.pending = (statusMs.pending || 0) + Math.max(0, Date.now() - pollStartAt);
  }
  if (curStatus && statusAt) {
    statusMs[curStatus] = (statusMs[curStatus] || 0) + (Date.now() - statusAt);
  }
  curStatus = st;
  statusAt = Date.now();
}

/** 某个前端步骤累计花了多久（秒字符串；没数据返回 ''） */
function stepSeconds(stepKey) {
  let ms = 0;
  let has = false;
  Object.keys(STATUS_STEP).forEach((k) => {
    if (STATUS_STEP[k] === stepKey && statusMs[k]) {
      ms += statusMs[k];
      has = true;
    }
  });
  if (curStatus && STATUS_STEP[curStatus] === stepKey && statusAt) {
    ms += Date.now() - statusAt;
    has = true;
  }
  return has ? Math.max(1, Math.round(ms / 1000)) + 's' : '';
}

/** 把「已完成 · 31s」写进三步列表的小字（幂等，随时可重算） */
function decorateSteps() {
  state.steps = state.steps.map((s) => {
    const t = stepSeconds(s.key);
    if (!t) return s;
    const base = s.status === 'done' ? '已完成' : s.status === 'doing' ? '进行中' : '等待中';
    return Object.assign({}, s, { statusText: base + ' · ' + t });
  });
}

function stopTextTick() {
  if (textTimer) {
    clearTimeout(textTimer);
    textTimer = null;
  }
}

/** 本地每秒刷新小字：云函数长跑时界面照样在动 */
function startTextTick() {
  stopTextTick();
  const tick = () => {
    if (state.phase !== 'running') return;
    if (curStatus) {
      const stText = STATUS_TEXT[curStatus];
      if (stText) {
        state.headSub = stText + ' · ' + Math.round((Date.now() - statusAt) / 1000) + 's';
      }
      decorateSteps();
      emit('change');
    }
    textTimer = setTimeout(tick, 1000);
  };
  textTimer = setTimeout(tick, 1000);
}

function startPoll() {
  clearPoll();
  const tick = async () => {
    if (state.phase !== 'running') return;

    if (Date.now() - startAt > TIMEOUT) {
      // 把服务端记录的最后一次错误带出来，否则用户只看到一句泛泛的「解析超时」
      const hint = lastSrvError ? '（' + lastSrvError + '）' : '';
      return fail(new Error('解析超时，请稍后重试' + hint));
    }

    try {
      const tPoll = Date.now();
      const res = await call('getTask', { task_id: state.taskId });
      if (state.phase !== 'running') return;

      // ⭐⭐ 提速诊断（2026-09-29）：把「轮询往返耗时 + 服务端状态 + 累计时间 + 分步 timing」
      //    打到 console。开发者工具 Console 面板即可看出卡在取源 / 下载 / 转写哪一步，
      //    以及每次轮询在云函数里待了多久 —— 「界面不动」的那段就是这里的长往返。
      console.log(
        '[extract] poll ' +
          ((res && res.status) || '?') +
          ' · 往返 ' + (Date.now() - tPoll) + 'ms' +
          ' · 累计 ' + ((Date.now() - startAt) / 1000).toFixed(1) + 's',
        (res && res.timing) || ''
      );

      const stage = (res && res.stage) || '';
      const percent = res && typeof res.percent === 'number' ? res.percent : null;

      if (stage) applyStage(stage);
      if (percent !== null) setSrvPercent(percent);

      // ⭐ 2026-09-29 提速：小字按真实 status 走 + **本阶段**已用秒数。
      //    ⚠️ 秒数由本地 startTextTick 每秒续写：这一次响应可能是 50 秒后
      //       才回来的（云函数单步硬超时），期间数字必须自己在走，否则像卡死。
      noteStatus(res && res.status);
      decorateSteps();
      const stText = STATUS_TEXT[curStatus];
      if (stText) {
        state.headSub = stText + ' · ' + Math.round((Date.now() - statusAt) / 1000) + 's';
        emit('change');
      }
      if (res && res.last_error) lastSrvError = res.last_error;
      // ⭐ 平台封面（取源那一步就写进 task.resolved.cover）→ 提取中页显示真实缩略图
      if (res && res.cover) state.cover = res.cover;
      if (res && res.video_title) state.title = res.video_title;
      emit('change');

      if (res && res.status === 'done') return finish(res.copywriting_id);
      if (res && res.status === 'failed') return fail(new Error(res.msg || '解析失败'));
    } catch (e) {
      // 单次失败不终止，继续轮询
      console.warn('[session] 轮询失败一次', e && e.message);
    }

    pollTimer = setTimeout(tick, POLL_INTERVAL);
  };
  pollStartAt = Date.now();
  startTextTick();
  pollTimer = setTimeout(tick, 800);
}

/* ---------- 终态 ---------- */

function finish(copywritingId) {
  if (state.phase !== 'running') return;
  console.log('[extract] ✅ 全流程 ' + ((Date.now() - startAt) / 1000).toFixed(1) + 's');
  state.phase = 'done';
  state.resultId = copywritingId || '';
  stopAll();
  applyStage('done');
  setPercent(100);
  state.stateTitle = '提取完成';
  state.stateSub = '正在打开结果…';
  emit('done');
  tracker.track('extract_done');
}

function fail(err) {
  if (state.phase !== 'running') return;
  state.phase = 'failed';
  const msg = (err && err.message) || '解析失败，请稍后重试';
  state.errorMsg = msg;
  stopAll();
  tracker.track('extract_failed', { msg });

  // 终态弹窗放在这里而不是页面里：后台提取时用户可能已经回到首页，
  // 由页面弹的话没人订阅就静默丢了。⚠️ 只此一处，别在页面里再弹一次。
  wx.showModal({
    title: '提取失败',
    content: msg,
    showCancel: true,
    cancelText: '返回',
    confirmText: '重试',
    success: (r) => {
      if (r.confirm) return retry();
      // 返回：不取消服务端任务 —— 超时只是「这边等不及了」，服务端可能正常跑完，
      // 结果会进文案库，用户回首页在历史里还能看到（白丢一条结果对用户更亏）。
      if (isLoadingOnTop()) wx.navigateBack();
      reset();
    },
  });
}

/** 失败重试：⚠️ 前端判失败 ≠ 服务端已停，先取消旧任务（顺带退积分）再重开，防双边扣费 */
function retry() {
  cancelServerTask();
  start(payload || { mode: 'link', url: '' });
}

function isTopPage(route) {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const cur = pages[pages.length - 1];
  return !!(cur && cur.route === route);
}
function isLoadingOnTop() {
  return isTopPage('pages/loading/loading');
}

/* ---------- 取消 / 复位 ---------- */

function cancelServerTask() {
  const a = app();
  const id = state.taskId;
  if (id && a && a.globalData.cloudReady) {
    call('cancelTask', { task_id: id }).catch(() => {});
  }
  state.taskId = '';
}

/** 用户确认取消（弹窗在页面里，本函数只负责收尾） */
function cancel() {
  stopAll();
  cancelServerTask();
  tracker.track('extract_cancel');
  reset();
}

/** 会话复位（结果已看 / 主动取消 / 失败返回后）—— 首页按钮随之回到「立即提取」 */
function reset() {
  stopAll();
  state.phase = 'idle';
  state.mode = '';
  state.taskId = '';
  state.percent = 0;
  state.statusLabel = '解析中';
  state.title = '';
  state.headSub = '';
  state.cover = '';
  state.stateTitle = '正在提取视频文案…';
  state.stateSub = '请勿退出，稍后自动跳转';
  state.steps = STEPS();
  state.resultId = '';
  state.errorMsg = '';
  payload = null;
  srvPercent = 0;
  displayPercent = 0;
  emit('reset');
}

/* ---------- 演示模式（云环境未配置时） ---------- */

function mockRun() {
  state.title = '演示视频 · 未配置云环境';
  state.headSub = '演示模式';
  state.stateSub = '演示模式：未配置云环境，将生成示例结果';
  applyStage('parse');
  const seq = [
    [800, 'parse', 25],
    [1800, 'asr', 62],
    [3200, 'format', 88],
    [4200, 'done', 100],
  ];
  seq.forEach(([delay, stage, pct]) => {
    setTimeout(() => {
      if (state.phase !== 'running') return;
      if (stage === 'done') return finish('');
      applyStage(stage);
      setSrvPercent(pct);
    }, delay);
  });
}

module.exports = {
  start,
  cancel,
  reset,
  subscribe,
  snapshot,
  setViewer,
  hasViewer,
  isRunning: () => state.phase === 'running',
  phase: () => state.phase,
  resultId: () => state.resultId,
  setPercent, // 仅测试用
  setSrvPercent, // 仅测试用
};
