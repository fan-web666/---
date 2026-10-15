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
const { prepare: prepareAudio } = require('./lossless-audio');

/**
 * 把「选片缩略图」传到云存储（tmp/<requestId>.jpg，与视频同名同目录）
 *
 * ⭐⭐ 2026-10-15 用户报「本地视频昨天还有封面图，今天没有了」——
 *    根因：封面只存在**本机**（utils/util.js 的 lvthumb_*.jpg）。微信清理小程序
 *    文件缓存 / 换设备 / 重装后，本机文件没了 → 历史与结果页只剩一块通用图标。
 *    ⇒ 现在同时留两份：
 *      ① 本机持久目录 → 本机零网络秒开（见 cacheLocalThumb）；
 *      ② 云存储 fileID → 带回 parseLink 落库成 cover_url，与平台视频一个口径，
 *         换设备、清缓存、重装都还在。
 *
 * ⚠️ 失败一律静默：封面缺失不该拖垮提取主流程（拿不到就退回本机缩略图）。
 * @param {string} thumbPath wx.chooseMedia 给的本机缩略图路径（与视频上传并行调用）
 * @param {string} requestId 本次提交的稳定 ID（同时是视频的云存储文件名主干）
 * @returns {Promise<string>} fileID；没有缩略图 / 上传失败 → ''
 */
async function uploadCover(thumbPath, requestId) {
  if (!thumbPath || !requestId) return '';
  try {
    const r = await wx.cloud.uploadFile({
      cloudPath: 'tmp/' + requestId + '.jpg',
      filePath: thumbPath,
    });
    return (r && r.fileID) || '';
  } catch (e) {
    console.warn('[extract] 封面转存失败（回落本机缩略图）', e && (e.errMsg || e.message));
    return '';
  }
}

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

let generation = 0;
let serverFailed = false;
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
  if (state.phase === 'running') return;
  generation += 1;
  serverFailed = false;
  const o = p || {};
  const isLocal = o.mode === 'local';
  payload = {
    mode: isLocal ? 'local' : 'link',
    url: o.url || '',
    path: o.path || '',
    fileID: o.fileID || '',
    uploadMs: Number(o.uploadMs) || 0,
    prepareMs: Number(o.prepareMs) || 0,
    uploadBytes: Number(o.uploadBytes) || 0,
    audioOnly: !!o.audioOnly,
    requestId: o.requestId || ('extract_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)),
    thumb: o.thumb || '',
    // 携带源文件体积和时长，用于上传及耗时诊断。
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
  // ⭐ 步骤1 计时从「本次提取开始」起算：本地视频的抽取+上传早于任何服务端 status，
  //    不从这一刻起算的话，上传那段既不走秒、也不计时长。
  parseAt = Date.now();
  localPhaseLabel = '';
  lastSnap = {}; // 强制全量外发一次

  // ⭐ 本地阶段没有服务端 status，秒数只能本地走 → 从一开提取就启动（原来只在 startPoll 里启动）
  startTextTick();

  emit('start');
  startSmooth();

  if (isLocal) submitLocal();
  else submitLink();
}

async function submitLink() {
  const run = generation;
  const input = payload;
  const a = app();
  if (!a || !a.globalData.cloudReady) return mockRun();
  if (!input.url) return fail(new Error('缺少视频链接'));
  try {
    applyStage('parse');
    setSrvPercent(12);

    const tLink = Date.now();
    const res = await call('parseLink', { url: input.url, request_id: input.requestId });
    if (run !== generation || state.phase !== 'running') return; // 期间被取消 / 已收尾
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
    if (run === generation) fail(e);
  }
}

// 常见 MP4/MOV 优先在手机无损抽取 AAC 上传；不支持则保留原视频。
async function submitLocal() {
  const run = generation;
  const input = payload;
  const a = app();
  if (!a || !a.globalData.cloudReady) return mockRun();
  if (!input.path) return fail(new Error('未取到视频文件'));
  try {
    applyStage('parse');
    setSrvPercent(8);

    // 重试复用已经上传的原文件，避免重新上传。
    if (!input.fileID) {
    // ⭐ 进入本地阶段：抽取音频 + 上传云存储都在这里，界面秒数由本地计时器续写
    localPhaseLabel = '正在准备视频';
    state.headSub = localPhaseLabel + ' · 0s';
    emit('change');

    const prepared = await prepareAudio(input, () => run === generation && state.phase === 'running');
    if (run !== generation || state.phase !== 'running') { prepared.cleanup(); return; }
    const uploadPath = prepared.path;
    // 上传进度：把体积写到界面上，用户能看出「是在传，不是卡了」
    localPhaseLabel = '正在上传' + (prepared.bytes ? ' · ' + (prepared.bytes / 1048576).toFixed(1) + 'MB' : '');
    state.headSub = localPhaseLabel + '…';
    state.stateSub = '上传完成即开始识别';
    emit('change');
    const tUpload = Date.now();
    const extMatch = uploadPath.match(/\.(m4a|mp4|mov|m4v|webm|avi)(?:[?#].*)?$/i);
    const cloudPath = 'tmp/' + input.requestId + '.' + (extMatch ? extMatch[1].toLowerCase() : 'mp4');
    // ⭐ 封面转存与视频上传**并行**（封面只依赖 requestId，不依赖视频的 fileID）→ 不额外拖长上传耗时。
    //    失败静默（uploadCover 内部已 try/catch，永不 reject），绝不影响提取主流程。
    const coverPromise = uploadCover(input.thumb, input.requestId);
    let up;
    try { up = await wx.cloud.uploadFile({ cloudPath, filePath: uploadPath }); }
    finally { prepared.cleanup(); }
    if (run !== generation || state.phase !== 'running') return;
    input.uploadMs = Date.now() - tUpload;
    input.audioOnly = prepared.audioOnly;
    input.prepareMs = prepared.ms;
    input.uploadBytes = prepared.bytes;
    console.log('[extract] 上传 ' + input.uploadMs + 'ms');

    // ⭐ 把选片时拿到的缩略图存两份：
    //    ① 本机持久目录（key = 云存储 fileID）→ 历史 / 结果页零网络秒开；
    //    ② 云存储 tmp/<requestId>.jpg（上面 coverPromise，与视频并行传的）→ 落库成 cover_url，
    //       换设备 / 清缓存后仍有封面。
    //    ⚠️ 2026-10-15 之前只有 ①：微信清理文件缓存后封面整片消失，只剩一块通用图标。
    if (!up || !up.fileID) throw new Error('视频上传未完成，请重试');
    input.fileID = up.fileID;
    cacheLocalThumb(up.fileID, input.thumb);
    input.coverFileId = await coverPromise;
    // 本地阶段结束：清掉「正在上传 xx」文案（秒数此后由步骤1的 parseAt 统一续写）
    localPhaseLabel = '';
    }

    state.headSub = '上传完成，正在解析';
    setSrvPercent(20);
    emit('change');

    const tLink = Date.now();
    const res = await call('parseLink', { file_id: input.fileID, cover_file_id: input.coverFileId || '', source: 'local', request_id: input.requestId, client_timing: { upload_ms: input.uploadMs || 0, prepare_ms: input.prepareMs || 0, upload_bytes: input.uploadBytes || 0, audio_only: !!input.audioOnly, original_bytes: Math.round((input.sizeMB || 0) * 1024 * 1024), reencoded: false } });
    if (run !== generation || state.phase !== 'running') return;
    console.log('[extract] 建任务 ' + (Date.now() - tLink) + 'ms（含冷启动）');

    state.taskId = (res && res.task_id) || '';
    if (!state.taskId) {
      if (res && res.copywriting_id) return finish(res.copywriting_id);
      throw new Error((res && (res.msg || res.hint)) || '任务创建失败');
    }
    startPoll();
  } catch (e) {
    if (run === generation) fail(e);
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
let pollStartAt = 0; // 开始轮询的时刻（历史字段，保留兼容）
/* ---------- ⭐ 2026-10-12：本地阶段（抽取音频 / 上传视频）计时 ----------
 * 本地视频在「建任务」之前有一段纯客户端工作：无损抽音频 + 上传云存储。
 * 这段没有服务端 status，原来的秒数定时器也只从轮询才开始 ——
 * 于是上传那 20+ 秒界面完全静止，事后步骤 1 还只显示 1s（对不上）。
 * 下面三个变量让这段也走本地时钟，并把耗时如实计入步骤 1。 */
let parseAt = 0; // 步骤1（parse）计时起点 ＝ 本次提取开始时刻（含本地抽取/上传 + 服务端取源）
let localPhaseLabel = ''; // 本地阶段动态小字前缀（如「正在上传 · 26.6MB」）；空 = 无

/** 观测到服务端 status 变化 → 结算上一个 status 的时长 */
function noteStatus(st) {
  if (!st || st === 'failed' || st === 'done') return;
  if (st === curStatus) return;
  // ⭐ 首个 status 到来之前那段全部归入步骤1（parse）：
  //    本地视频＝抽取音频 + 上传 + 建任务；链接视频＝建任务（含云函数冷启动）。
  //    ⚠️ 起点必须用 parseAt（本次提取开始），不能用 pollStartAt（轮询开始）——
  //       本地视频的上传发生在轮询之前，用 pollStartAt 会把那 20 秒整个丢掉 → 步骤1 只显示 1s。
  if (!curStatus && parseAt) {
    statusMs.pending = (statusMs.pending || 0) + Math.max(0, Date.now() - parseAt);
  } else if (curStatus && statusAt) {
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
  // ⭐ 服务端还没给过任何 status（本地视频＝抽取/上传中）→ 步骤1 按本地时钟走秒。
  //    从 parseAt 起算，与 noteStatus 首次结算的值连续，不会跳变。
  if (!has && stepKey === 'parse' && parseAt && !curStatus) {
    ms += Date.now() - parseAt;
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
    } else if (parseAt && Date.now() - parseAt > 800) {
      // ⭐ 服务端还没给过 status（本地视频＝抽取/上传中；链接视频＝建任务中）
      //    → 秒数本地续写，否则界面在这段完全静止（原来上传 20 秒一动不动）。
      //    800ms 阈值：避免刚进入本页就闪一下「· 0s」。
      const prefix = localPhaseLabel || '正在解析视频链接';
      state.headSub = prefix + ' · ' + Math.round((Date.now() - parseAt) / 1000) + 's';
      decorateSteps();
      emit('change');
    }
    textTimer = setTimeout(tick, 1000);
  };
  textTimer = setTimeout(tick, 1000);
}

function startPoll() {
  const run = generation;
  clearPoll();
  const tick = async () => {
    if (run !== generation || state.phase !== 'running') return;
    const previousStatus = curStatus;

    if (Date.now() - startAt > TIMEOUT) {
      // 把服务端记录的最后一次错误带出来，否则用户只看到一句泛泛的「解析超时」
      const hint = lastSrvError ? '（' + lastSrvError + '）' : '';
      return fail(new Error('解析超时，请稍后重试' + hint));
    }

    try {
      const tPoll = Date.now();
      const res = await call('getTask', { task_id: state.taskId });
      if (run !== generation || state.phase !== 'running') return;

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
      if (res && res.status === 'failed') {
        serverFailed = true;
        return fail(new Error(res.msg || '解析失败'));
      }
    } catch (e) {
      // 单次失败不终止，继续轮询
      console.warn('[session] 轮询失败一次', e && e.message);
    }

    if (run !== generation || state.phase !== 'running') return;
    // 已推进到下一阶段时立即继续；状态未变/通讯失败才按原间隔查询。
    pollTimer = setTimeout(tick, curStatus && curStatus !== previousStatus ? 0 : POLL_INTERVAL);
  };
  pollStartAt = Date.now();
  startTextTick();
  pollTimer = setTimeout(tick, 0);
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

/**
 * 把技术性报错翻成用户看得懂的话（2026-10-15）
 *
 * ⭐ 起因：用户「刘可」提交了一条**纯音乐、没有人声口播**的抖音视频，ASR 正确返回空文本，
 *    但弹窗把原始 JSON 原样甩给了用户（`语音识别未返回文本：{"duration":26.7899375,...}`），
 *    还配了个「重试」按钮 —— 用户连点 6~7 次，每一次都注定失败。
 *    🔬 实测（同一条链路对比验证过）：换别的抖音视频一切正常，抽音频/ASR 都没问题，
 *    两个 ASR 模型一致判定这条视频「只有音乐」（SenseVoice 直接返回 🎼 音乐标记）。
 * ⇒ 这是「这条视频本来就没有人声」，属于**选材问题而不是故障** → 必须讲清楚，
 *   并且不给「重试」（重试必然再失败，还白扣一次任务）。
 */
function friendlyError(msg) {
  const m = String(msg || '');
  // ① ASR 正常应答、但整段没有任何人声 → 纯音乐 / 只有画面文字的短视频。重试无意义。
  if (/未返回文本|没有检测到人声/.test(m)) {
    return {
      text: '这条视频里没有检测到人声（多半是纯音乐伴奏、或只有画面文字的短视频），没有可提取的口播文案。换一条有人讲解、口播的视频再试试吧～',
      retryable: false,
    };
  }
  // ② 服务商临时抽风（5xx / 超时 / 连接中断）→ 值得重试
  if (/HTTP 5\d{2}|超时|timeout|中断|socket|ECONN|EAI_AGAIN/i.test(m)) {
    return { text: '识别服务暂时繁忙，稍等一下再试一次通常就好了。', retryable: true };
  }
  // ③ 解析不到视频地址 → 链接过期 / 内容不公开 / 服务商限流，多半可重试
  if (/未返回视频地址|不支持此链接|链接已失效/.test(m)) {
    return { text: '没能解析出这条链接里的视频，可能是链接已失效或该内容未公开。重新复制一次分享链接再试试。', retryable: true };
  }
  // ④ 其他明确的请求错误（4xx）→ 重试无用
  if (/HTTP 4\d{2}/.test(m)) {
    return { text: '这条视频暂时处理不了，换一条试试吧～', retryable: false };
  }
  // ⑤ 认不出来的 → 原文照旧，保持可重试
  return { text: m || '解析失败，请稍后重试', retryable: true };
}

function fail(err) {
  if (state.phase !== 'running') return;
  state.phase = 'failed';
  const raw = (err && err.message) || '解析失败，请稍后重试';
  const f = friendlyError(raw);
  state.errorMsg = f.text;
  stopAll();
  tracker.track('extract_failed', { msg: raw });

  // 终态弹窗放在这里而不是页面里：后台提取时用户可能已经回到首页，
  // 由页面弹的话没人订阅就静默丢了。⚠️ 只此一处，别在页面里再弹一次。
  wx.showModal({
    title: f.retryable ? '提取失败' : '这条视频提取不了',
    content: f.text,
    // 「没有人声」这类确定性失败不给重试按钮 —— 点了也是白点（2026-10-15）
    showCancel: f.retryable,
    cancelText: '返回',
    confirmText: f.retryable ? '重试' : '知道了',
    success: (r) => {
      if (f.retryable && r.confirm) return retry();
      // 返回：不取消服务端任务 —— 超时只是「这边等不及了」，服务端可能正常跑完，
      // 结果会进文案库，用户回首页在历史里还能看到（白丢一条结果对用户更亏）。
      if (isLoadingOnTop()) wx.navigateBack();
      reset();
    },
  });
}

/** 失败重试：⚠️ 前端判失败 ≠ 服务端已停，先取消旧任务（顺带退积分）再重开，防双边扣费 */
function retry() {
  if (state.taskId && !serverFailed) {
    state.phase = 'running';
    state.errorMsg = '';
    startAt = Date.now();
    startSmooth();
    startPoll();
    emit('change');
    return;
  }
  const next = Object.assign({}, payload || { mode: 'link', url: '' });
  if (serverFailed) delete next.requestId;
  start(next);
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
  generation += 1;
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
