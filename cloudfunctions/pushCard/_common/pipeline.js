// _common/pipeline.js - 解析任务状态机（PRD F-02 / R-06~R-12 / 8.2）
//
// ⚠️ 为什么是「分步」状态机：
//   微信云函数单次调用有超时上限（最长 60 秒，需在控制台调满）。而真实链路要
//   取源（调解析服务）→ 下载视频 → 字幕/ASR 转写 → LLM 整理，四步串起来轻松超过 60 秒。
//   所以每次 runTask 只推进一步，由调用方（前端轮询 getTask / parsePipeline 定时器 /
//   服务号回调）反复驱动。中途被杀掉也没关系：任务状态已落库，下一步从断点续跑。
//
// ⚠️ 为什么「下载」和「转写」必须分成两步：
//   5 分钟以上的视频，光下载就要几十秒，转写又要几十秒。两步挤在同一次调用里
//   必然撞上 60 秒上限被强杀 —— 而强杀不会留下任何错误信息，用户只看得到
//   「解析超时」，无从排查。拆开后每步都有独立的尝试次数与可读错误。
//
// 状态流转：
//   pending --取源+扣费--> downloading --下载--> transcribing --字幕/转写--> asr --结构化+归档--> done
//   （任一步异常 → failed，已扣费用自动退还）
//
// 并发保护：phase_started_at 作为「步骤租约」。同一状态下只有抢到租约的调用能执行，
//   租约超过 LEASE_MS 未刷新即视为上一次调用已被中断，允许重试。
// 重试保护：同一状态最多尝试 STEP_MAX_TRIES 次，超过则判失败，避免无限空转。

const { db, cmd, COLL } = require('./db');
const { TASK_STATUS } = require('./consts');
const { executeCharge, rollbackCharge } = require('./credit');
const providers = require('./providers');
const { reconcileTranscript } = require('./transcriptQuality');
const { buildContent, cleanTranscript } = require('./copywriting');
const wxapi = require('./wxapi');

// 步骤租约：略大于云函数最大超时（60s）。设太大 → 上一次调用被强杀后，
// 后续轮询要白白空等这么久才能接手（用户看到进度条长时间不动）。
const LEASE_MS = 65 * 1000;
const STEP_MAX_TRIES = 3; // 同一步骤最多尝试次数
const TASK_DEADLINE_MS = 10 * 60 * 1000; // 单任务总时限
const EPOCH = new Date(0);

// 状态 → 埋点键（tasks.timing.<key> = { ms, ... }）。改状态名时必须同步这里。
const STEP_TIMING_KEY = {
  [TASK_STATUS.PENDING]: 'resolve',
  [TASK_STATUS.DOWNLOADING]: 'download',
  [TASK_STATUS.TRANSCRIBING]: 'transcribe',
  [TASK_STATUS.ASR]: 'structure',
  [TASK_STATUS.LLM]: 'structure',
};

/**
 * 「可重试」错误判定：超时 / 连接中断 / 网络抖动这类错误下一次很可能就过了，
 * 不该一步判死 —— 尤其下载步骤带断点续传，第二次往往直接从断点下完。
 * 与之相对的是「致命错误」（解析服务不支持该链接、文件超限、服务未配置），重试无意义。
 */
const RETRYABLE_RE =
  /超时|timeout|中断|abort|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket|网络|下载失败|服务暂时|503|502|504/i;

function now() {
  return new Date();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 读取任务文档（找不到返回 null） */
async function readTask(taskId) {
  try {
    const r = await COLL.tasks().doc(taskId).get();
    return r && r.data ? r.data : null;
  } catch (e) {
    return null;
  }
}

/**
 * 抢步骤租约（原子 CAS）。
 * 条件：同一任务 + 同一状态 + 租约已过期（或从未有过租约）。
 * 只有一条更新能命中，命中者才允许执行该步骤。
 */
async function claim(task) {
  const nowD = new Date();
  const res = await COLL
    .tasks()
    .where({
      _id: task._id,
      status: task.status,
      phase_started_at: cmd().or([cmd().exists(false), cmd().lt(new Date(nowD.getTime() - LEASE_MS))]),
    })
    .update({ data: { phase_started_at: nowD, updated_at: nowD } });
  const claimed = !!(res && res.stats && res.stats.updated);
  if (claimed) task._leaseAt = nowD;
  return claimed;
}

/** 生成事件（埋点，失败不阻塞主流程） */
async function emit(event, props) {
  try {
    await COLL.events().add({
      data: {
        event,
        uid: (props && props.uid) || '',
        openid: (props && props.openid) || '',
        page: (props && props.page) || '',
        props: props || {},
        ts: now(),
      },
    });
  } catch (e) {
    // 忽略
  }
}

/** 推进一步到下一步（清空租约，让下一步立即可被认领） */
async function moveTo(task, status, extra) {
  const res = await COLL
    .tasks()
    .where({ _id: task._id, status: task.status, phase_started_at: task._leaseAt })
    .update({
      data: Object.assign(
        {
          status,
          phase_started_at: EPOCH,
          updated_at: now(),
        },
        extra || {}
      ),
    });
  if (!(res && res.stats && res.stats.updated)) {
    const error = new Error('任务已取消或步骤已被其他执行器接管');
    error.code = 'TASK_LEASE_LOST';
    throw error;
  }
}

/** 清理任务留下的媒体文件与云存储中转件（任务进入终态时调用；PRD 8.4 不留存源视频） */
async function cleanupTaskMedia(task) {
  try {
    providers.removeMedia(task && task.media_path);
  } catch (e) {
    /* ignore */
  }
  if (task && task.media_file_id) {
    await providers.dropRelay(task.media_file_id).catch(() => {});
  }
}

/**
 * 记录一次「可重试」的步骤失败：累加重试计数、留下最后错误（供诊断），
 * 并把租约还回去 —— 否则下一次轮询会一直 busy 空等到租约自然过期。
 */
async function markStepError(task, status, tries, msg, timing) {
  const data = {
    phase_started_at: EPOCH,
    step_meta: { status, tries, last_error: msg, last_at: now() },
    // ⭐ 累计重试次数（诊断用）：重试的耗时**不会**进 timing.X.ms（成功那次会覆盖），
    //    只能在 total_ms 与各步之和的差值里看出来。有这个计数就能直接定性。
    step_retries: cmd().inc(1),
    updated_at: now(),
  };
  // 失败也留一条耗时（诊断「是超时被杀还是快速报错」）
  if (timing && timing.key) {
    data['timing.' + timing.key] = { ms: timing.ms, error: msg, tries };
  }
  await COLL
    .tasks()
    .where({ _id: task._id, status, phase_started_at: task._leaseAt })
    .update({ data })
    .catch((e) => console.warn('[pipeline] 记录步骤错误失败', e && e.message));
}

/** 标记失败（含已扣费用退还；幂等——refunded 后不再重复退） */
async function failTask(task, reason, msg) {
  const failedWrite = await COLL
    .tasks()
    .where({ _id: task._id, status: task.status, ...(task._leaseAt ? { phase_started_at: task._leaseAt } : {}) })
    .update({
      data: {
        status: TASK_STATUS.FAILED,
        error: { reason, msg: msg || '' },
        retry_count: cmd().inc(1),
        attempt_log: cmd().push([{ at: now(), status: task.status, reason, msg: msg || '' }]),
        refunded: !!task.charged && !task.refunded,
        phase_started_at: EPOCH,
        ['timing.total_ms']: Date.now() - (task.created_at ? new Date(task.created_at).getTime() : Date.now()),
        updated_at: now(),
      },
    })
    .catch((e) => console.warn('[pipeline] 标记失败写入异常', e && e.message));

  if (!(failedWrite && failedWrite.stats && failedWrite.stats.updated)) return;

  if (task.charged && !task.refunded && task.credit_decision) {
    await rollbackCharge(task.uid, task.credit_decision).catch((e) =>
      console.warn('[pipeline] 退还费用失败', e && e.message)
    );
  }
  await cleanupTaskMedia(task);
  await emit('extract_fail', {
    uid: task.uid,
    task_id: task._id,
    reason,
    msg: msg || '',
  });
}

/** 推卡（A 链路）：优先小程序卡片，缩略图未配置时降级文本卡片（PRD C-01/C-04/5.5 静默失败） */
async function pushResultToUser(task, copywriting) {
  const gzhOpenid = task.userOpenid || '';
  if (!gzhOpenid || task.channel !== 'A') {
    await COLL.copywritings().doc(copywriting._id).update({ data: { push_state: 'none' } });
    return { ok: true, mode: 'none' };
  }

  // ⭐⭐ 2026-09-28 方案 D：A 链路结果**统一标记为待推送**，不在云端直接发。
  //    原因：A 链路任务由 receiveCallback（HTTP 访问服务）创建并推进，
  //    而客服消息的云调用自动鉴权**要求云函数由小程序端触发** → 在这里发必报 -501001。
  //    改由 `api#pushPending`（小程序端触发）读取本标记后推送，窗口更稳、鉴权有效。
  await COLL
    .copywritings()
    .doc(copywriting._id)
    .update({ data: { push_state: 'pending', push_pending: true, push_marked_at: now() } })
    .catch((e) => console.warn('[push] 标记待推送失败', e && e.message));
  return { ok: true, mode: 'pending' };
}

/**
 * 旧版直推实现（保留供 pushCard 手动补推复用）。
 * ⚠️ 只在「小程序端触发」的云函数里可用（云调用自动鉴权前提）。
 */
async function pushResultToUserDirect(task, copywriting) {
  const gzhOpenid = task.userOpenid || '';
  if (!gzhOpenid || task.channel !== 'A') {
    await COLL.copywritings().doc(copywriting._id).update({ data: { push_state: 'none' } });
    return { ok: true, mode: 'none' };
  }
  try {
    // 读缩略图 media_id（公众号素材库配置）
    let thumb = '';
    try {
      const r = await COLL.config().doc('gzh_thumb_media').get();
      thumb = r.data && r.data.media_id;
    } catch (e) {
      thumb = '';
    }
    const pagepath = 'pages/detail/detail?id=' + copywriting._id;
    if (thumb) {
      await wxapi.sendKfMiniPage(gzhOpenid, {
        title: copywriting.video_title || '文案已生成',
        pagepath,
        thumb_media_id: thumb,
      });
    } else {
      // 降级：文本卡片（含打开路径），PRD 10.3 文案规范
      const content =
        '✅ 文案已生成：' +
        (copywriting.video_title || '未命名') +
        '\n📎 打开小程序「极速视频文案提取」- 文案库查看 / 复制';
      await wxapi.sendKfText(gzhOpenid, content);
    }
    await COLL
      .copywritings()
      .doc(copywriting._id)
      .update({ data: { push_state: 'kf_sent', push_pending: false } });
    return { ok: true, mode: 'sent' };
  } catch (e) {
    // 静默失败：结果落文案库，进入小程序顶部提醒（PRD 5.5）
    console.warn('[push] 推卡失败', e && e.message);
    await COLL
      .copywritings()
      .doc(copywriting._id)
      .update({ data: { push_state: 'kf_failed', push_pending: true } });
    try {
      await COLL
        .users()
        .where({ openid_gzh: gzhOpenid })
        .update({ data: { pending_pushes: cmd().inc(1) } });
    } catch (e2) {
      /* ignore */
    }
    return { ok: false, mode: 'silent', err: e && e.message };
  }
}

/* ------------------------------------------------------------------ *
 * 各步骤
 * ------------------------------------------------------------------ */

/** 步骤 1：取源（链接 → 视频直链 + 字幕）+ 结算扣费 */
async function stepResolve(task) {
  const t0 = Date.now();
  const platform = task.source_platform || 'other';
  const isLocal = platform === 'local' || !!task.file_id;

  const resolved = await providers.resolveVideoSource(
    task.share_url || task.video_url,
    platform,
    { fileId: task.file_id, isLocal }
  );
  const parseMs = Date.now() - t0;

  // ⭐ 时长：解析服务**不返回**（实测返回体里没有 duration 字段），必须自己探 ——
  //   计费按时长分档（2026-10-16 v5：视频 5/10 两档、文案 起步 2 + 每分钟 2），不探就只能按最低档扣。
  //   成本 = 一次 1MB Range 请求（实测 0.16~0.62s）；探不到回落最低档，**不阻断主链路**。
  let probe = { sec: 0 };
  if (resolved.url && !resolved.mock) {
    try {
      probe = await providers.probeDuration(resolved.url);
    } catch (e) {
      probe = { sec: 0, reason: (e && e.message) || 'throw' };
    }
  }
  const durationSec = probe.sec || resolved.durationSec || task.duration_sec || 0;

  // 结算（严格幂等）
  // charged 三态：缺省/undefined = 未扣；'charging' = 正在扣（或扣费中途被打断）；true = 已扣。
  // 先原子抢锁再扣，避免两个调用同时推进到这一步造成重复扣费。
  let decision = task.credit_decision || null;
  if (!task.charged) {
    const lock = await COLL
      .tasks()
      .where({ _id: task._id, charged: cmd().neq(true) })
      .update({ data: { charged: 'charging', updated_at: now() } });
    if (!(lock && lock.stats && lock.stats.updated)) {
      return { ok: false, reason: 'busy' };
    }
    const chargeRes = await executeCharge(task.uid, durationSec, 'text');
    if (!chargeRes.ok) {
      // 未扣成功 → 释放标记（任务随后会被标记失败，不会重试）
      await COLL
        .tasks()
        .doc(task._id)
        .update({ data: { charged: false, updated_at: now() } })
        .catch(() => {});
      // reason 保留真实成因（too_long / insufficient）：仅用于日志与埋点，端上展示的是 msg。
      // ⚠️ 旧写法一律写 'insufficient'，会把「超时长」误记成「余额不足」。
      await failTask(task, chargeRes.reason || 'insufficient', chargeRes.msg);
      return { ok: false, reason: 'insufficient', msg: chargeRes.msg };
    }
    decision = chargeRes.decision;
  }

  await moveTo(task, TASK_STATUS.DOWNLOADING, {
    resolved: {
      url: resolved.url || '',
      title: resolved.title || '',
      cover: resolved.cover || '',
      durationSec,
      subtitle: resolved.subtitle || '',
      subtitleUrl: resolved.subtitleUrl || '',
      mock: !!resolved.mock,
    },
    duration_sec: durationSec,
    video_title: resolved.title || task.video_title || '',
    charged: true,
    credit_decision: decision,
    // 埋点：本步耗时（parse_ms 是纯取源耗时，差额是扣费与写库）
    ['timing.resolve']: {
      ms: Date.now() - t0,
      parse_ms: parseMs,
      platform,
      duration_sec: durationSec,
      // ⭐ 时长探测埋点（2026-10-15 新增）：用来盯「探到率」与耗时，探不到会退化成最低档
      probe_sec: probe.sec || 0,
      probe_from: probe.from || 'none',
      probe_ms: probe.ms || 0,
      probe_bytes: probe.bytes || 0,
      probe_reason: probe.reason || '',
      has_subtitle: !!resolved.subtitle,
      has_subtitle_url: !!resolved.subtitleUrl,
    },
  });

  await emit('extract_start', { uid: task.uid, task_id: task._id, source_platform: platform });
  return { ok: true, step: 'resolve', durationSec, platform };
}

/** 步骤 2：备好媒体文件（只下载；转写单独一步，避免两步串行撞 60 秒上限） */
async function stepDownload(task) {
  const t0 = Date.now();
  // 本地云文件在转写步骤下载一次；不同云实例之间不依赖 /tmp 共享。
  if (task.file_id && /^cloud:\/\//.test(task.file_id)) {
    await moveTo(task, TASK_STATUS.TRANSCRIBING, {
      subtitle_probed: true,
      ['timing.download']: { ms: Date.now() - t0, skipped: 'local_download_in_transcribe' },
    });
    return { ok: true, step: 'download', skipped: true };
  }
  const resolved = task.resolved || {};
  const wantCorrect = String(providers.env('ASR_CORRECT', 'false')).toLowerCase() === 'true';

  // ---- 字幕优先：有字幕就根本不用下视频 ----
  // ⚠️ 比原来多做一步：只有 subtitleUrl（字幕文件地址）时也**先试抓一次**。
  //    原实现只认内联字幕，只有 subtitleUrl 时会先把整个视频下完、转写步才抓到字幕
  //    —— 那几十秒下载纯属白费。抓不到再回退下载，行为不变。
  let subtitleProbed = false; // ⭐ 见下：本步抓过字幕（无论成败）就落库，转写步不再重复抓
  if (!wantCorrect && (resolved.subtitle || resolved.subtitleUrl)) {
    subtitleProbed = true;
    let subText = '';
    try {
      const sub = await providers.fetchSubtitle(resolved);
      subText = (sub && sub.text) || '';
    } catch (e) {
      console.warn('[pipeline] 字幕预抓失败，回退下载视频', e && e.message);
    }
    if (subText) {
      await moveTo(task, TASK_STATUS.TRANSCRIBING, {
        media_path: '',
        media_size: 0,
        subtitle_text: subText,
        download_skipped: 'has_subtitle',
        ['timing.download']: {
          ms: Date.now() - t0,
          skipped: 'has_subtitle',
          chars: subText.length,
        },
      });
      return { ok: true, step: 'download', skipped: true, reason: 'has_subtitle' };
    }
  }

  const media = await providers.downloadMedia(
    { url: resolved.url, mock: resolved.mock, relayFileId: task.media_file_id || '' },
    task._id
  );
  const dlMs = Date.now() - t0;

  // ---- 下载很慢时留一份云存储中转件 ----
  // 只为防「转写步落到别的实例、/tmp 失配」时重下整个视频。
  // 默认关闭（MEDIA_RELAY_MIN_MS=-1），常规任务零额外开销。
  let relayFileId = task.media_file_id || '';
  const relayMin = providers.mediaRelayMinMs();
  if (!relayFileId && relayMin >= 0 && dlMs >= relayMin && media.path) {
    try {
      relayFileId = (await providers.putRelay(task._id, media.path)) || '';
    } catch (e) {
      console.warn('[pipeline] 云存储中转上传失败（忽略，不影响本次提取）', e && e.message);
    }
  }

  await moveTo(task, TASK_STATUS.TRANSCRIBING, {
    media_path: media.path || '',
    media_size: media.sizeBytes || 0,
    media_file_id: relayFileId || '',
    // ⭐ 2026-09-29 提速：本步已经试抓过字幕（没抓到）→ 转写步别再试一次，
    //    否则同一个死链要白等两轮超时（原来 20s × 2）。
    subtitle_probed: subtitleProbed,
    ['timing.download']: {
      ms: Date.now() - t0,
      dl_ms: dlMs,
      bytes: media.sizeBytes || 0,
      fetchMode: media.fetchMode || '',
      cached: !!media.cached, // true = 命中本实例 /tmp，没真正下载
      relay: !!media.relay, // true = 从云存储中转件取回
      parallel: !!media.parallel, // true = 走了分片并发
      relay_min_ms: relayMin,
    },
  });

  return { ok: true, step: 'download', sizeBytes: media.sizeBytes || 0, cached: !!media.cached };
}

/** 步骤 3：字幕优先 / 语音转写（媒体文件由步骤 2 备好，这里不再下载） */
async function stepTranscribe(task) {
  const t0 = Date.now();
  const resolved = task.resolved || {};
  const wantCorrect = String(providers.env('ASR_CORRECT', 'false')).toLowerCase() === 'true';

  // ---- 字幕优先（用户硬要求：有字幕就不走语音识别） ----
  // 下载步可能已预抓过（只有 subtitleUrl 时先试抓成功就跳过了下载）→ 直接复用，不重复请求
  let subtitleText = task.subtitle_text || '';
  // ⚠️ task.subtitle_probed = 下载步已经试抓过（没抓到）→ 不重复抓，避免同一死链白等两轮超时。
  //    wantCorrect（交叉校正）时下载步不会预抓，probed 为 false，这里照常抓。
  if (!subtitleText && !task.subtitle_probed && (resolved.subtitle || resolved.subtitleUrl)) {
    try {
      const sub = await providers.fetchSubtitle(resolved);
      subtitleText = (sub && sub.text) || '';
    } catch (e) {
      console.warn('[pipeline] 字幕提取失败，回退语音识别', e && e.message);
    }
  }
  const subtitleMs = Date.now() - t0;
  // ⭐ 字幕清洗（2026-09-28 用户：「提取结果里总是有这种音符和表情…不应该体现」）——
  //    在**合并之前**对每种来源各清一次，这样落库的 subtitle_text / asr_text 中间字段也干净，
  //    后续「字幕优先 + 音频校核」的比较不会被噪音标注干扰。
  subtitleText = cleanTranscript(subtitleText);

  // ---- 语音识别：无字幕必跑；有字幕时按 ASR_CORRECT 决定是否交叉校正 ----
  let asrText = '';
  let mediaStat = null;
  let mediaFetchMs = 0;
  let asrMs = 0;
  // ⚠️ 必须声明在 if 之外！下方 moveTo 落库要用（原写成 if 块内 `const asrT` →
  //    出块即 ReferenceError「asrT is not defined」，2026-09-29 线上事故：所有提取都失败）。
  let asrT = null;
  let asrAudio = null; // 音频轨抽取结果（提速：只把音频轨传给 ASR，画面不传）
  const needAsr = !subtitleText || wantCorrect;
  if (needAsr) {
    // downloadMedia 幂等：上一步下好的文件直接命中（cached=true，几乎不耗时）；
    // 跨实例 /tmp 失配时会先试云存储中转件，都没有才重新拉源站。
    const m0 = Date.now();
    const media = await providers.downloadMedia(
      { url: resolved.url, mock: resolved.mock, relayFileId: task.media_file_id || '' },
      task._id
    );
    mediaFetchMs = Date.now() - m0;
    mediaStat = {
      cached: !!media.cached,
      relay: !!media.relay,
      bytes: media.sizeBytes || 0,
      fetchMode: media.fetchMode || '',
    };
    const a0 = Date.now();
    const asr = await providers.asrTranscribe(media, task);
    asrMs = Date.now() - a0;
    asrText = (asr && asr.text) || '';
    // ⭐ 上传 vs 服务端的耗时拆分（诊断：上行带宽慢 / 服务端排队慢，修法完全不同）
    asrT = (asr && asr.timing) || null;
    asrAudio = (asr && asr.audio) || null;
    // ⭐ 同上：ASR 产出的情绪标注 / emoji 也要在源头清掉
    asrText = cleanTranscript(asrText);
    // ⚠️ 这里**不删**媒体文件：万一后续步骤失败要重试，留着能省一次下载。
    //    统一在任务进入终态时清理（stepStructure 成功 / failTask）。
  }

  const quality = reconcileTranscript({ subtitle: subtitleText, asrText });
  const transcript = quality.text;
  if (!transcript.trim()) {
    throw new Error('没有提取到文字内容，请确认视频里有清晰的口播或字幕');
  }

  const source = subtitleText ? (asrText ? 'subtitle+asr' : 'subtitle') : 'asr';
  await moveTo(task, TASK_STATUS.ASR, {
    subtitle_text: subtitleText,
    asr_text: asrText,
    transcript_text: transcript,
    transcript_quality: { rule_version: quality.ruleVersion, edits: quality.edits },
    text_source: source,
    ['timing.transcribe']: {
      ms: Date.now() - t0,
      subtitle_ms: subtitleMs,
      // ⚠️ 重下会在这里露出来：media_cached=false 且 media_relay=false 就是真重下了
      media_cached: mediaStat ? mediaStat.cached : null,
      media_relay: mediaStat ? mediaStat.relay : null,
      media_fetch_ms: mediaFetchMs,
      media_fetch_mode: mediaStat ? mediaStat.fetchMode : '',
      media_bytes: mediaStat ? mediaStat.bytes : 0,
      asr_ms: asrMs,
      // ⭐ 拆分打点（2026-09-29 提速排查）：upload=上行耗时，wait=服务端耗时，bytes=实际上传字节
      asr_upload_ms: asrT ? asrT.upload_ms : 0,
      asr_wait_ms: asrT ? asrT.wait_ms : 0,
      // ⭐ 实际用的模型与尝试次数（提速排查：模型算力池差异极大，见 providers.js#asrTranscribe）
      asr_model: asrT ? asrT.model || '' : '',
      asr_attempts: asrT ? asrT.attempts || 0 : 0,
      asr_retry_ms: asrT ? asrT.retry_ms || 0 : 0,
      asr_attempt_log: asrT ? asrT.attempt_log || [] : [],
      asr_bytes: asrT ? asrT.bytes : mediaStat ? mediaStat.bytes : 0,
      // ⭐ 音频轨抽取的收益（提速核心）：原始体积 → 实际上传体积
      asr_audio_from: asrAudio ? asrAudio.from_bytes : 0,
      asr_audio_sent: asrAudio ? asrAudio.to_bytes : 0,
      asr_audio_ms: asrAudio ? asrAudio.extract_ms : 0,
      need_asr: needAsr,
      source,
      chars: transcript.length,
    },
  });

  return {
    ok: true,
    step: 'transcribe',
    source,
    chars: transcript.length,
  };
}

/** 步骤 3：LLM 结构化 + 归档 + 推卡 */
async function stepStructure(task) {
  const t0 = Date.now();
  const quality = reconcileTranscript({ subtitle: task.subtitle_text || '', asrText: task.asr_text || '', transcript: task.transcript_text || '' });
  const transcript = quality.text;
  const subtitle = task.subtitle_text || '';
  const asrText = task.asr_text || '';

  let structured = null;
  let resultStatus = 'ok';
  // 封面归档与文案整理相互独立，并行准备；都完成后才写结果，保留完整输出。
  const resolved = task.resolved || {};
  const coverReady = providers.relayCover(resolved.cover, task._id).catch((e) => {
    console.warn('[pipeline] 封面归档失败，保留原地址', e && e.message);
    return '';
  });
  let llmMs = 0;
  try {
    const l0 = Date.now();
    structured = await providers.llmStructure({
      subtitle,
      asrText,
      transcript,
    });
    llmMs = Date.now() - l0;
  } catch (e) {
    // LLM 失败 → 纯转写降级（PRD R-10：保证用户至少拿到文字）
    console.warn('[pipeline] LLM 失败走纯转写降级', e && e.message);
    structured = providers.plainFallback(transcript);
    resultStatus = 'plain_fallback';
  }

  const content = buildContent(structured, transcript);
  // ⭐ 2026-10-12：改用 content.title（已过专有名词/错字纠错），不再直接用 LLM 原始 title。
  const title =
    content.title || resolved.title || task.video_title || '视频口播文案';

  // ⭐ 2026-09-28：封面转存云存储。平台封面直链带签名时效（几小时~一两天就 403），
  //    过期后历史 / 详情页只能降级成色块 → 归档时把图下一份放进自己云存储，库里改存 fileID。
  //    转存失败返回 ''（内部已 try/catch），此处回落原直链，绝不影响归档主流程。
  const coverFileId = await coverReady;

  const addRes = await COLL.copywritings().add({
    data: {
      uid: task.uid,
      task_id: task._id,
      channel: task.channel || 'B',
      source_platform: task.source_platform || 'other',
      video_title: title,
      video_url: resolved.url || '',
      // ⭐ 2026-10-15：本地视频的封面由客户端上传（task.cover_file_id = tmp/<requestId>.jpg 的 fileID）。
      //    以前本地视频这条恒为空 → 端上只能退回落「本机缩略图」，微信一清文件缓存就只剩通用图标。
      //    优先级：客户端封面 → relayCover 转存结果 → 平台原始封面直链。
      cover_url: task.cover_file_id || coverFileId || resolved.cover || '',
      author: task.author || '',
      duration_sec: task.duration_sec || 0,
      char_count: (content.transcript || '').length,
      text_source: task.text_source || 'asr',
      content,
      status: resultStatus,
      push_state: 'none',
      deleted: false,
      mock: !!resolved.mock,
      created_at: now(),
      updated_at: now(),
    },
  });

  try {
  await moveTo(task, TASK_STATUS.DONE, {
    result_id: addRes._id,
    video_title: title,
    ['timing.structure']: {
      ms: Date.now() - t0,
      llm_ms: llmMs,
      fallback: resultStatus !== 'ok',
      chars: (content.transcript || '').length,
      points: (structured && structured.points && structured.points.length) || 0,
      highlights: (structured && structured.highlights && structured.highlights.length) || 0,
    },
    // 端到端耗时：从任务创建到出结果，诊断「整体为什么慢」直接看这个
    ['timing.total_ms']: Date.now() - (task.created_at ? new Date(task.created_at).getTime() : t0),
  });

  } catch (e) {
    if (e.code === 'TASK_LEASE_LOST') await COLL.copywritings().doc(addRes._id).remove().catch(() => {});
    throw e;
  }

  // 结果已落库，临时媒体文件用完即删（PRD 8.4 不留存源视频）
  await cleanupTaskMedia(task);

  // A 链路推卡（B 链路不推，结果即时在小程序内展示）
  const copy = {
    _id: addRes._id,
    uid: task.uid,
    task_id: task._id,
    channel: task.channel,
    source_platform: task.source_platform,
    video_title: title,
    duration_sec: task.duration_sec || 0,
    push_state: 'none',
  };
  await pushResultToUser(task, copy);

  await emit('extract_success', {
    uid: task.uid,
    task_id: task._id,
    duration_sec: task.duration_sec || 0,
    char_count: (content.transcript || '').length,
    text_source: task.text_source || 'asr',
    mock: !!resolved.mock,
  });

  return { ok: true, step: 'structure', done: true, copywritingId: addRes._id, title };
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 推进任务「一步」。可安全重复调用：已完成/进行中/被并发占用都直接返回。
 * @returns {Promise<{ok:boolean, reason?:string, step?:string, done?:boolean}>}
 */
async function runTask(taskId) {
  const task = await readTask(taskId);
  if (!task) return { ok: false, reason: 'task_not_found' };
  if (task.status === TASK_STATUS.DONE || task.status === TASK_STATUS.FAILED) {
    return { ok: false, reason: 'already_finished', status: task.status, result_id: task.result_id || '' };
  }

  // 总时限保护
  const createdAt = task.created_at ? new Date(task.created_at).getTime() : Date.now();
  if (Date.now() - createdAt > TASK_DEADLINE_MS) {
    await failTask(task, 'timeout', '解析超时（超过 10 分钟），请重试或换一条视频');
    return { ok: false, reason: 'timeout' };
  }

  // 单步重试上限
  const sameStep = task.step_meta && task.step_meta.status === task.status;
  const tries = sameStep ? (task.step_meta.tries || 0) : 0;
  if (tries >= STEP_MAX_TRIES) {
    await failTask(
      task,
      'step_retry_exceeded',
      '处理这一步连续 ' + tries + ' 次未完成（视频可能过大，或解析/转写服务不稳定），请稍后重试'
    );
    return { ok: false, reason: 'step_retry_exceeded' };
  }

  // 抢租约
  if (!(await claim(task))) return { ok: false, reason: 'busy', status: task.status };
  await COLL
    .tasks()
    .doc(taskId)
    .update({ data: { step_meta: { status: task.status, tries: tries + 1, last_at: now() } } })
    .catch(() => {});

  const stepKey = STEP_TIMING_KEY[task.status] || '';
  const stepT0 = Date.now();
  try {
    if (task.status === TASK_STATUS.PENDING) return await stepResolve(task);
    if (task.status === TASK_STATUS.DOWNLOADING) return await stepDownload(task);
    if (task.status === TASK_STATUS.TRANSCRIBING) return await stepTranscribe(task);
    if (task.status === TASK_STATUS.ASR) return await stepStructure(task);
    // 兼容历史遗留：llm 状态即「待结构化」
    if (task.status === TASK_STATUS.LLM) return await stepStructure(task);
    return { ok: false, reason: 'unknown_status', status: task.status };
  } catch (e) {
    if (e && e.code === 'TASK_LEASE_LOST') return { ok: false, reason: 'busy', status: task.status };
    const msg = (e && (e.msg || e.message)) || '解析失败，请稍后重试';
    const nextTries = tries + 1;
    console.error('[pipeline] 步骤失败', task.status, '第 ' + nextTries + ' 次：', msg);

    // 超时 / 中断一类错误不立即判死，留给下一次轮询续跑（下载支持断点续传，重试往往能过）
    if (nextTries < STEP_MAX_TRIES && RETRYABLE_RE.test(msg)) {
      await markStepError(task, task.status, nextTries, msg, {
        key: stepKey,
        ms: Date.now() - stepT0,
      });
      return { ok: false, reason: 'retryable', status: task.status, msg };
    }

    await failTask(task, 'step_error', msg);
    return { ok: false, reason: 'internal', msg };
  }
}

/**
 * 连续推进直到任务进入终态或耗尽时间预算。
 * 用于「一次调用内尽量跑完」的场景（服务号回调、定时器兜底）。
 */
/**
 * 连续推进任务，直到完成 / 出错 / 预算或步数用完。
 *
 * ⭐⭐ 2026-09-29 提速（关键）：新增 `maxSteps` —— 每次调用最多连续推进几个「成功步骤」。
 *   背景：原实现一次 getTask 会把「取源→下载→转写→整理」四步一气跑完（40 秒），
 *   而 HTTP 响应只能等整个函数返回 → **前端这 40 秒收不到任何中间状态**，
 *   界面一直停在第一步「视频解析」，用户体感就是「卡死 40 秒」（真实耗时反而看不见）。
 *   限制成「一步一返回」后，前端每次轮询都能看到新阶段 → 进度条真实、卡在哪一环一目了然。
 *   ⚠️ 单步内部的硬超时（下载 45s / ASR 50s）本函数管不到，但步与步之间不再叠加。
 *   ⚠️ **不统计 retryable 的重试**：下载的断点续传依赖同一调用内反复重试把文件下完，
 *      若按步数把它掐断，每次调用只下一点 → 反而更慢（见下方 steps 计数位置）。
 *
 * @param {string} taskId
 * @param {number} budgetMs 本次调用在「步与步之间」允许花费的上限
 * @param {number} maxSteps 最多连续推进的成功步数；≤0 / 缺省 = 不限
 */
async function runUntilDone(taskId, budgetMs, maxSteps) {
  const deadline = Date.now() + (budgetMs || 45000);
  const stepCap = maxSteps > 0 ? maxSteps : 0;
  let steps = 0;
  let last = null;
  let busyWaits = 0;
  while (Date.now() < deadline) {
    last = await runTask(taskId);
    if (!last) break;
    if (last.done) return last;
    if (last.reason === 'already_finished') return last;
    if (
      [
        'insufficient',
        'timeout',
        'step_retry_exceeded',
        'internal',
        'task_not_found',
        'unknown_status',
      ].indexOf(last.reason) > -1
    ) {
      return last;
    }
    if (last.reason === 'busy') {
      // 步骤正被别的调用占着（或上一次调用被强杀、租约还没自然过期）。
      // 只短暂等一下，别把整个时间预算耗在空转上 —— 前端下次轮询自然会再来。
      return last;
    }
    busyWaits = 0;
    // ⭐ 只有「成功推进一步」才计数 —— retryable 的重试（下载断点续传）不计入，
    //    否则一次调用只下一点点就交还控制权，整体反而更慢。
    if (last.ok && last.step) {
      steps += 1;
      if (stepCap && steps >= stepCap) return last;
    }
    // retryable → 租约已还回去，可立刻再试一次（下载有断点续传，每次都能多下一点）
    // ok:true   → 已推进一步，继续下一步
  }
  return last || { ok: false, reason: 'budget_exhausted' };
}

/** 兜底扫描：未完成任务重新推进（定时器调用，PRD 8.2 不丢任务） */
async function rescanPending(opts) {
  const olderThanMs = (opts && opts.olderThanMs) || 30 * 1000;
  const threshold = new Date(Date.now() - olderThanMs);
  const r = await COLL
    .tasks()
    .where({
      status: cmd().in([
        TASK_STATUS.PENDING,
        TASK_STATUS.DOWNLOADING,
        TASK_STATUS.TRANSCRIBING,
        TASK_STATUS.ASR,
        TASK_STATUS.LLM,
      ]),
      updated_at: cmd().lt(threshold),
    })
    .limit(20)
    .get();
  const results = [];
  for (const t of r.data || []) {
    results.push(
      await runTask(t._id).catch((e) => ({ ok: false, reason: 'rescan_err', err: e && e.message }))
    );
  }
  return results;
}

module.exports = {
  REVISION: '20261011-speed-r4',
  runTask,
  runUntilDone,
  rescanPending,
  pushResultToUser,
  pushResultToUserDirect,
  emit,
  readTask,
};
