// _common/providers.js - 第三方能力接入层（取源解析 / 字幕 / ASR / LLM）
//
// 真实链路（按顺序）：
//   ① resolveVideoSource  链接 → 视频直链 + 标题/封面/时长/字幕
//        优先 PARSE_API_URL（第三方视频解析服务，视频号 / 抖音 / 快手 / 小红书 / B站 都走这里）
//        未配置时用内置兜底（短链展开 + 页面 og:video 抓取），失败就报明确原因
//   ② downloadMedia       视频直链 → 云函数 /tmp 本地文件（≤100MB）
//   ③ fetchSubtitle       优先取平台自带字幕（用户要求：有字幕就不走语音识别）
//   ④ asrTranscribe       无字幕时才转写；有字幕时仅作交叉校正（ASR_CORRECT=true 开启）
//   ⑤ llmStructure        DeepSeek 整理成结构化文案（严格 JSON）
//
// 环境变量（云函数控制台 → 函数配置 → 环境变量）：
//   USE_MOCK              'false' 走真实；不设时按「是否配了任一真实密钥」自动判断
//   PARSE_API_URL         第三方视频解析服务地址（必填，链接链路）
//   PARSE_API_KEY         解析服务密钥（视服务商而定）
//   PARSE_API_KEY_IN      'query'（默认，拼 ?key=）| 'header'
//   PARSE_API_KEY_HEADER  自定义密钥请求头名（阿里云市场填 Authorization）
//   PARSE_API_KEY_PREFIX  自定义鉴权前缀（阿里云市场填 APPCODE；不填则原样发密钥）
//   PARSE_API_METHOD      GET（默认）| POST
//   PARSE_API_FIELD       URL 参数名 / POST 字段名（默认 url）
//   PARSE_API_BODY        POST 请求体编码：auto（默认，先 form 再自动换 json）| form | json
//   PARSE_API_EXTRA       额外固定参数，格式 k=v&k2=v2（如 productCode=video_parser）
//   PARSE_API_RESULT_PATH 结果所在路径（默认自动深搜）
//   DEEPSEEK_API_KEY      DeepSeek 密钥（必填，结构化环节）
//   LLM_API_URL           默认 https://api.deepseek.com/v1/chat/completions
//   LLM_MODEL             默认 deepseek-chat
//   ASR_API_URL           OpenAI 兼容 /audio/transcriptions 地址（无字幕时必填）
//   ASR_API_KEY           同上密钥
//   ASR_MODEL             默认 whisper-1
//   ASR_CORRECT           'true' 时有字幕也跑一次 ASR 做交叉校正（默认关闭，省时省钱）
//
// 超时（⚠️ 全部必须小于云函数执行超时上限，否则请求还没返回云函数就被强杀，
//        用户只能看到「解析超时」，真实原因永远拿不到）：
//   MEDIA_TIMEOUT_MS      下载视频超时，默认 45000
//   ASR_TIMEOUT_MS        ASR 请求超时，默认 50000
//   MEDIA_REFERER         下载视频时附带的 Referer（部分 CDN 有防盗链校验）
//   MEDIA_PARALLEL        下载并发分片数，默认 4（1 = 关闭并发，回退单连接）
//   MEDIA_RELAY_MIN_MS    云存储中转阈值：下载耗时 ≥ 此值才把媒体放到云存储备下次复用，
//                         默认 -1（关闭）。用途是防「跨实例重下整个视频」，
//                         建议先看 timingReport 的重下次数再决定开启值

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// 专有名词表（品牌/产品名）——提示词里显式声明，防止模型把「予行」当错字改成「旅行」
const { TERM_HINT, termRosterHint } = require('./transcriptQuality');

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 出网连接复用：整条提取链有 4~6 次出网请求（取源 / 字幕 / 下载 / ASR / LLM），
// 不开 keep-alive 每次都要重建 TCP + TLS 握手，累计白等 1~3 秒。
// maxSockets 要 ≥ 分片并发数，否则分片之间会排队。
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 12, keepAliveMsecs: 15000 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 12, keepAliveMsecs: 15000 });

function agentFor(u) {
  return u.protocol === 'http:' ? HTTP_AGENT : HTTPS_AGENT;
}

/** 读取本云函数环境变量 */
function env(name, fallback) {
  return process.env[name] !== undefined ? process.env[name] : fallback;
}

/** 读取整数型环境变量（带上下界钳制） */
function envInt(name, fallback, min, max) {
  const raw = env(name, '');
  const n = Number(raw);
  if (!raw || !isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 是否走演示模式。
 * 优先级：显式 USE_MOCK > 自动判断（配了任一真实密钥即视为真实）。
 * 自动判断是为了防止「密钥都配好了、忘了改 USE_MOCK」导致用户拿到的还是演示文案。
 */
function useMock() {
  const flag = String(env('USE_MOCK', '')).toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  const hasRealKey = !!(
    env('PARSE_API_URL', '') ||
    env('DEEPSEEK_API_KEY', '') ||
    env('LLM_API_KEY', '') ||
    env('ASR_API_URL', '')
  );
  return !hasRealKey;
}

/**
 * 平台域名特征表。
 * ⚠️ 各平台域名变体极多（视频号尤其：小程序卡片、公众号文章内嵌、微信短链各不同），
 *    顺序敏感：视频号放最前，避免被 weixin 之外的规则抢先。
 */
const PLATFORM_PATTERNS = [
  [
    'video_channel',
    /channels\.weixin\.qq\.com|finder\.video\.qq\.com|video\.qq\.com|v\.qq\.com|mp\.weixin\.qq\.com|weixin\.qq\.com|wxaurl\.cn|weixin110\.qq\.com/,
  ],
  ['douyin', /douyin\.com|iesdouyin|snssdk\.com|amemv\.com/],
  ['kuaishou', /kuaishou\.com|chenzhongtech|gifshow\.com|kwai\.com/],
  ['xiaohongshu', /xiaohongshu\.com|xhslink|xhscdn/],
  ['bilibili', /bilibili\.com|b23\.tv|acg\.tv/],
];

/** 平台 code → 展示名（服务端文案统一取这里，避免各处漂移） */
const PLATFORM_LABEL = {
  video_channel: '视频号',
  douyin: '抖音',
  xiaohongshu: '小红书',
  bilibili: 'B 站',
  kuaishou: '快手',
  local: '本地视频',
  other: '其他平台',
};

/** 支持平台的一句话文案（错误提示 / 引导语统一引用） */
const SUPPORTED_PLATFORM_TEXT = '视频号 / 抖音 / 小红书 / B站 / 快手';

/** 平台识别（B 链路链接特征）：识别不出返回 'other'，由调用方决定是否放行 */
function detectPlatform(url) {
  const u = (url || '').toLowerCase();
  if (!u) return 'other';
  for (let i = 0; i < PLATFORM_PATTERNS.length; i++) {
    if (PLATFORM_PATTERNS[i][1].test(u)) return PLATFORM_PATTERNS[i][0];
  }
  return 'other';
}

function platformLabel(code) {
  return PLATFORM_LABEL[code] || '该平台';
}

/** 该平台是否在承诺支持范围内 */
function isSupportedPlatform(code) {
  return !!PLATFORM_LABEL[code] && code !== 'other' && code !== 'local';
}

/* ------------------------------------------------------------------ *
 * 通用 HTTP（云函数出网不受小程序域名白名单限制）
 * ------------------------------------------------------------------ */

/** 底层请求：返回 { status, headers, buffer, text }，自动跟随 3 次重定向 */
function request(opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 20000;
  const redirects = o.redirects === undefined ? 3 : o.redirects;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(o.url);
    } catch (e) {
      return reject(new Error('无效地址：' + String(o.url).slice(0, 120)));
    }
    const lib = u.protocol === 'http:' ? http : https;
    let body = o.body;
    if (body && !Buffer.isBuffer(body)) body = Buffer.from(String(body), 'utf8');

    const headers = Object.assign({ 'User-Agent': UA }, o.headers || {});
    if (body) headers['Content-Length'] = body.length;

    const req = lib.request(
      {
        method: o.method || 'GET',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers,
        agent: agentFor(u),
        timeout: timeoutMs,
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, o.url).toString();
          const nextMethod = code === 303 ? 'GET' : o.method || 'GET';
          return resolve(
            request({
              url: next,
              method: nextMethod,
              headers: o.headers,
              body: nextMethod === 'GET' ? null : o.body,
              timeoutMs,
              redirects: redirects - 1,
            })
          );
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 12 * 1024 * 1024) return req.destroy(new Error('响应体过大'));
          chunks.push(c);
        });
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: code, headers: res.headers, buffer, text: buffer.toString('utf8') });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 请求并解析 JSON，非 2xx / 非 JSON 给出可读错误 */
async function requestJson(opts) {
  const res = await request(opts);
  if (res.status < 200 || res.status >= 300) {
    throw new Error('HTTP ' + res.status + '：' + res.text.slice(0, 160));
  }
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw new Error('返回内容不是 JSON：' + res.text.slice(0, 160));
  }
}

/**
 * 下载到本地文件。
 * ⚠️ 两个必须有的保护：
 *   ① 总耗时硬超时（不只是 socket 空闲超时）—— 慢速下载会一直「有数据」，
 *      空闲超时永远不触发，结果云函数被强杀、错误信息丢失。这里到点主动中断并抛出可读错误。
 *   ② 断点续传 —— 大视频一次下不完时，把已下字节留在 .part 文件里，
 *      下次带 Range 头接着下。否则 5 分钟以上的视频永远下不完（每次都被超时截断）。
 * 返回 { path, sizeBytes, resumed }
 */
function downloadToFile(url, destPath, opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes || 100 * 1024 * 1024;
  const timeoutMs = o.timeoutMs || envInt('MEDIA_TIMEOUT_MS', 45000, 5000, 55000);

  // 断点找起点（只对 .part 中转文件生效；正式文件由调用方直接复用，不走这里）
  let startAt = 0;
  if (o.resume) {
    try {
      if (fs.existsSync(destPath)) startAt = fs.statSync(destPath).size;
    } catch (e) {
      startAt = 0;
    }
    if (startAt >= maxBytes) startAt = 0;
  }

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('视频地址无效'));
    }
    const lib = u.protocol === 'http:' ? http : https;
    let settled = false;
    let hardTimer = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      fn(v);
    };

    const headers = Object.assign({ 'User-Agent': UA, Accept: '*/*' }, o.headers || {});
    if (startAt > 0) headers.Range = 'bytes=' + startAt + '-';

    const req = lib.get(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers,
        agent: agentFor(u),
        timeout: timeoutMs,
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          return downloadToFile(new URL(res.headers.location, url).toString(), destPath, o)
            .then((r) => done(resolve, r))
            .catch((e) => done(reject, e));
        }
        // 206 = 服务端接受续传；200 = 不支持，得从头来
        const partial = code === 206 && startAt > 0;
        if (code !== 200 && code !== 206) {
          res.resume();
          return done(reject, new Error('视频下载失败（HTTP ' + code + '）'));
        }
        const base = partial ? startAt : 0;
        const ws = fs.createWriteStream(destPath, { flags: base > 0 ? 'a' : 'w' });
        let size = base;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            try {
              ws.destroy();
              fs.unlinkSync(destPath);
            } catch (e) {
              /* ignore */
            }
            done(reject, new Error('视频超过 100MB 上限，建议截取关键片段'));
          }
        });
        res.pipe(ws);
        ws.on('finish', () => done(resolve, { path: destPath, sizeBytes: size, resumed: partial }));
        ws.on('error', (e) => done(reject, e));
      }
    );

    hardTimer = setTimeout(() => {
      try {
        req.destroy();
      } catch (e) {
        /* ignore */
      }
      done(reject, new Error('视频下载超时（' + Math.round(timeoutMs / 1000) + ' 秒），正在重试续传'));
    }, timeoutMs);

    req.on('timeout', () => {
      req.destroy();
      done(reject, new Error('视频下载中断（连接空闲超时）'));
    });
    req.on('error', (e) => done(reject, e));
  });
}

/* ------------------------------------------------------------------ *
 * ② b 分片并发下载
 * 下载是整条链路最大的一块时间（5 分钟视频约 40MB，单连接要 25~40 秒）。
 * 源站支持 Range 时开多连接并行拉，字节完全一致（最后校验总长），不影响质量。
 * ------------------------------------------------------------------ */

// 源站拒绝 Range / 限并发时，本实例内一段时间不再尝试分片，避免每次白试一遍
const PARALLEL_OFF_BY_RESOURCE = new Map();

/** 探测源站是否支持 Range（返回 { ok, totalBytes }）。用 bytes=0-0，正常只回 1 字节。 */
function probeRange(url, opts) {
  const o = opts || {};
  const timeoutMs = o.probeTimeoutMs || 8000;
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ ok: false });
    }
    const lib = u.protocol === 'http:' ? http : https;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = lib.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: Object.assign(
          { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-0' },
          o.headers || {}
        ),
        agent: agentFor(u),
        timeout: timeoutMs,
      },
      (res) => {
        const code = res.statusCode || 0;
        const m = String(res.headers['content-range'] || '').match(/\/(\d+)\s*$/);
        if (code === 206 && m && Number(m[1]) > 0) {
          res.resume();
          return done({ ok: true, totalBytes: Number(m[1]) });
        }
        // 不支持 Range 时服务端会开始发整个文件 → 立刻掐断，别把 40MB 读进内存
        try {
          req.destroy();
        } catch (e) {
          /* ignore */
        }
        done({ ok: false });
      }
    );
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch (e) {
        /* ignore */
      }
      done({ ok: false });
    });
    req.on('error', () => done({ ok: false }));
    req.end();
  });
}

/** 下载一个字节区间到独立分片文件（片内可续传），返回落盘字节数 */
function downloadChunk(url, filePath, start, end, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 45000;
  const want = end - start + 1;

  let have = 0;
  try {
    if (fs.existsSync(filePath)) have = fs.statSync(filePath).size;
  } catch (e) {
    have = 0;
  }
  if (have > want) have = 0;
  if (have === want) return Promise.resolve({ bytes: have, reused: true });

  const from = start + have;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('视频地址无效'));
    }
    const lib = u.protocol === 'http:' ? http : https;
    let settled = false;
    let hard = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (hard) clearTimeout(hard);
      fn(v);
    };

    const req = lib.get(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: Object.assign(
          { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=' + from + '-' + end },
          o.headers || {}
        ),
        agent: agentFor(u),
        timeout: timeoutMs,
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code !== 206 && code !== 200) {
          res.resume();
          return done(reject, new Error('分片下载失败（HTTP ' + code + '）'));
        }
        // 分片必须精确对应请求区间；防止等长但错位的响应污染音频。
        const range = String(res.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (code !== 206 || !range || Number(range[1]) !== from || Number(range[2]) !== end) {
          res.resume();
          return done(reject, new Error('分片区间不符'));
        }
        const ws = fs.createWriteStream(filePath, { flags: have > 0 ? 'a' : 'w' });
        let got = have;
        res.on('data', (c) => {
          got += c.length;
        });
        res.pipe(ws);
        ws.on('finish', () => done(resolve, { bytes: got }));
        ws.on('error', (e) => done(reject, e));
      }
    );

    hard = setTimeout(() => {
      try {
        req.destroy();
      } catch (e) {
        /* ignore */
      }
      done(reject, new Error('分片下载超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
    }, timeoutMs);
    req.on('error', (e) => done(reject, e));
  });
}

/** 多连接并行下载 → 全部分片就绪后按序合并、校验总长、清分片 */
async function downloadParallel(url, destPath, totalBytes, opts) {
  const o = opts || {};
  const n = Math.max(2, Math.min(8, o.parallel || 4));
  const span = Math.floor(totalBytes / n);
  const chunks = [];
  for (let i = 0; i < n; i++) {
    const start = i * span;
    const end = i === n - 1 ? totalBytes - 1 : start + span - 1;
    chunks.push({ start, end, file: destPath + '.p' + i });
  }

  const settledChunks = await Promise.allSettled(
    chunks.map(async (c) => {
      const want = c.end - c.start + 1;
      const r = await downloadChunk(url, c.file, c.start, c.end, {
        headers: o.headers,
        timeoutMs: o.timeoutMs,
      });
      if (r.bytes !== want) throw new Error('分片不完整（' + r.bytes + '/' + want + '）');
    })
  );

  const failedChunk = settledChunks.find((r) => r.status === 'rejected');
  if (failedChunk) throw failedChunk.reason;

  // 合并：逐片流式追加，不把文件读进内存
  const ws = fs.createWriteStream(destPath, { flags: 'w' });
  try {
    for (const c of chunks) {
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(c.file);
        rs.on('error', rej);
        rs.on('end', res);
        rs.pipe(ws, { end: false });
      });
    }
    await new Promise((res, rej) => {
      ws.on('finish', res);
      ws.on('error', rej);
      ws.end();
    });
  } catch (e) {
    try {
      ws.destroy();
    } catch (e2) {
      /* ignore */
    }
    throw e;
  }

  const size = mediaSize(destPath);
  if (size !== totalBytes) throw new Error('合并后大小不符（' + size + '/' + totalBytes + '）');
  chunks.forEach((c) => removeMedia(c.file));
  return { path: destPath, sizeBytes: size, parallel: true, chunks: n };
}

/**
 * 自动选下载方式：能并发就并发，否则单连接（带断点续传）。
 * ⚠️ 分片失败必须清掉 destPath 与分片残留再回退单连接 ——
 *    否则残留文件会被单连接的续传逻辑当成「已下好的前缀」，拼出一个坏文件。
 */
async function downloadAuto(url, destPath, opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes || 100 * 1024 * 1024;
  const n = envInt('MEDIA_PARALLEL', 4, 1, 8);

  const resourceKey = new URL(url).href;
  const deadline = Date.now() + (o.timeoutMs || 45000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const coolDown = (ms) => {
    if (PARALLEL_OFF_BY_RESOURCE.size >= 64) PARALLEL_OFF_BY_RESOURCE.delete(PARALLEL_OFF_BY_RESOURCE.keys().next().value);
    PARALLEL_OFF_BY_RESOURCE.set(resourceKey, Date.now() + ms);
  };
  if (n > 1 && Date.now() > (PARALLEL_OFF_BY_RESOURCE.get(resourceKey) || 0)) {
    const probe = await probeRange(url, { headers: o.headers, probeTimeoutMs: Math.min(o.probeTimeoutMs || 8000, remaining()) });
    if (!probe.ok) {
      // 源站不吃 Range：只冷却当前文件，其他用户/其他文件不受影响
      coolDown(5 * 60 * 1000);
    } else if (probe.totalBytes >= 8 * 1024 * 1024 && probe.totalBytes <= maxBytes) {
      // 小文件并发反而慢（握手开销占比高），8MB 以下走单连接
      try {
        return await downloadParallel(url, destPath, probe.totalBytes, {
          headers: o.headers,
          timeoutMs: remaining(),
          parallel: n,
        });
      } catch (e) {
        console.warn('[providers] 分片下载失败，回退单连接：', e && e.message);
        coolDown(10 * 60 * 1000);
        try {
          removeMedia(destPath);
        } catch (e2) {
          /* ignore */
        }
        for (let i = 0; i < 8; i++) {
          try {
            removeMedia(destPath + '.p' + i);
          } catch (e2) {
            /* ignore */
          }
        }
      }
    }
  }

  if (Date.now() >= deadline) throw new Error('视频下载超时');
  const r = await downloadToFile(url, destPath, Object.assign({}, o, { timeoutMs: remaining() }));
  return { path: r.path, sizeBytes: r.sizeBytes, parallel: false, resumed: !!r.resumed };
}

/**
 * multipart/form-data 上传（ASR 用）。
 * ⚠️ 必须流式：ASR 要传的是整个视频文件（5 分钟轻松 40MB+），
 *    原实现 fs.readFileSync + Buffer.concat 会在内存里同时存在两份 → 云函数 OOM 被强杀。
 *    这里只把「表单头」与「结尾边界」放内存，文件本体走流。
 * ⚠️ 超时必须小于云函数执行超时，否则请求没回来云函数先被强杀，真实错误永远看不到。
 */
function postMultipart(url, { fields, file }, headers, timeoutMs, onTiming) {
  const boundary = '----WBBoundary' + crypto.randomBytes(12).toString('hex');
  const head = [];
  const f = fields || {};
  Object.keys(f).forEach((k) => {
    if (f[k] === undefined || f[k] === null) return;
    head.push(
      Buffer.from(
        '--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + f[k] + '\r\n',
        'utf8'
      )
    );
  });

  let filePath = '';
  let fileSize = 0;
  if (file && file.path) {
    filePath = file.path;
    fileSize = fs.statSync(filePath).size;
    head.push(
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="' +
          (file.field || 'file') +
          '"; filename="' +
          (file.filename || 'media.mp4') +
          '"\r\nContent-Type: ' +
          (file.contentType || 'video/mp4') +
          '\r\n\r\n',
        'utf8'
      )
    );
  }

  const headBuf = Buffer.concat(head);
  const tailBuf = Buffer.from((filePath ? '\r\n' : '') + '--' + boundary + '--\r\n', 'utf8');
  const t = timeoutMs || envInt('ASR_TIMEOUT_MS', 50000, 5000, 55000);

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('语音识别地址无效：' + String(url).slice(0, 120)));
    }
    const lib = u.protocol === 'http:' ? http : https;
    let settled = false;
    let hardTimer = null;
    let rs = null;
    // ⭐ 上传 / 服务端 耗时拆分（2026-09-29 提速排查，**纯观测不改行为**）：
    //   upload_ms = 数据真正写进内核的耗时（网络上行慢 → 这里大）
    //   wait_ms   = 服务端收完请求 → 吐出首字节（排队/推理慢 → 这里大）
    const tStart = Date.now();
    let tFinish = 0;
    let tTtfb = 0;
    const reportTiming = (ok) => {
      if (typeof onTiming !== 'function') return;
      try {
        onTiming({
          bytes: fileSize,
          upload_ms: tFinish ? tFinish - tStart : 0,
          wait_ms: tFinish && tTtfb ? tTtfb - tFinish : 0,
          body_ms: tTtfb ? Date.now() - tTtfb : 0,
          total_ms: Date.now() - tStart,
          ok: !!ok,
        });
      } catch (e) {
        /* ignore */
      }
    };
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (rs) {
        try {
          rs.destroy();
        } catch (e) {
          /* ignore */
        }
      }
      reportTiming(fn === resolve);
      fn(v);
    };

    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        timeout: t,
        headers: Object.assign(
          {
            'User-Agent': UA,
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'Content-Length': headBuf.length + fileSize + tailBuf.length,
          },
          headers || {}
        ),
      },
      (res) => {
        tTtfb = Date.now();
        const code = res.statusCode || 0;
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 8 * 1024 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (code < 200 || code >= 300) {
            return done(reject, new Error('HTTP ' + code + '：' + text.slice(0, 200)));
          }
          done(resolve, text);
        });
      }
    );

    hardTimer = setTimeout(() => {
      try {
        req.destroy();
      } catch (e) {
        /* ignore */
      }
      done(reject, new Error('语音识别超时（' + Math.round(t / 1000) + ' 秒），请稍后重试或换更短的视频'));
    }, t);

    req.on('timeout', () => {
      req.destroy();
      done(reject, new Error('语音识别连接中断'));
    });
    req.on('error', (e) => done(reject, e));
    // 全部数据已写入内核（上行带宽被节流时会被拖住）→ 作为「上传完成」时间锚点
    req.on('finish', () => {
      tFinish = Date.now();
    });

    req.write(headBuf);
    if (!filePath) return req.end(tailBuf);

    rs = fs.createReadStream(filePath);
    rs.on('error', (e) => {
      try {
        req.destroy();
      } catch (e2) {
        /* ignore */
      }
      done(reject, e);
    });
    rs.pipe(req, { end: false });
    rs.on('end', () => req.end(tailBuf));
  });
}

/* ------------------------------------------------------------------ *
 * 解析结果字段归一（各家解析服务字段名五花八门，这里深度自适应）
 * ------------------------------------------------------------------ */

const KEY_VIDEO = [
  'video_url', 'videoUrl', 'nwm_video_url', 'nwmVideoUrl', 'no_watermark_url', 'noWatermarkUrl',
  'play_url', 'playUrl', 'play_addr', 'playAddr', 'download_url', 'downloadUrl', 'mp4', 'video',
  'src', 'url',
];
const KEY_TITLE = ['video_title', 'videoTitle', 'title', 'desc', 'description', 'name'];
const KEY_COVER = ['cover_url', 'coverUrl', 'cover', 'poster', 'origin_cover', 'originCover', 'thumb', 'first_frame', 'photo'];
const KEY_DURATION = ['duration_sec', 'durationSec', 'duration', 'video_duration', 'videoDuration', 'length'];
const KEY_SUBTITLE_URL = ['subtitle_url', 'subtitleUrl', 'caption_url', 'captionUrl', 'srt', 'vtt', 'subtitle_src'];
const KEY_SUBTITLE = ['subtitle', 'subtitles', 'caption', 'captions', 'sub_text', 'subtitle_text', 'subtitleText', 'transcript', 'text'];

/** 把任意值归一成文本（数组取元素 text/content 拼接） */
function toText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') return toText(x.text || x.content || x.subtitle || x.line || '');
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof v === 'object') {
    return toText(v.text || v.content || v.subtitle || v.url || '');
  }
  return '';
}

/** 深度遍历收集 key → 值（先出现的优先） */
function flatten(obj, out, depth) {
  const d = depth || 0;
  if (d > 6 || obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) flatten(item, out, d + 1);
    return out;
  }
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (out[k] === undefined && v !== null && v !== undefined && v !== '') out[k] = v;
    if (v && typeof v === 'object') flatten(v, out, d + 1);
  });
  return out;
}

function pick(flat, keys) {
  for (const k of keys) {
    if (flat[k] === undefined) continue;
    const t = toText(flat[k]);
    if (t) return t;
  }
  return '';
}

/** 时长归一：抖音等返回毫秒，>3600 一律按毫秒处理 */
function normalizeDuration(v) {
  let n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  if (n > 3600) n = Math.round(n / 1000);
  return Math.round(n);
}

/**
 * 按 PARSE_API_RESULT_PATH（如 data.result / data.list[0]）取子对象；
 * 未配置或路径取不到时，回退到整个 json（由 flatten 深搜兜住）。
 */
function locateResult(json, pathStr) {
  const p = String(pathStr || '').trim();
  if (!p) return json;
  let cur = json;
  for (const seg of p.split('.')) {
    if (cur === null || typeof cur !== 'object') return json;
    const idxM = seg.match(/\[(\d+)\]/);
    const key = seg.replace(/\[(\d+)\]/g, '');
    cur = key ? cur[key] : cur;
    if (idxM && Array.isArray(cur)) cur = cur[Number(idxM[1])];
    if (cur === undefined || cur === null) return json;
  }
  return cur;
}

/**
 * 把各家解析服务的返回统一成内部结构。
 * 返回 { videoUrl, title, cover, durationSec, subtitle, subtitleUrl }
 */
function normalizeParseResult(json, pathStr) {
  const root = locateResult(json, pathStr);
  const flat = flatten(root, {}, 0);
  // 深层 data 里的字段也收进来（很多服务是 { data: { video: {...} } }）
  if (root !== json) flatten(json, flat, 0);

  const videoUrl = pick(flat, KEY_VIDEO);
  const rawDur = pick(flat, KEY_DURATION);
  return {
    videoUrl,
    title: pick(flat, KEY_TITLE).slice(0, 120),
    cover: pick(flat, KEY_COVER),
    durationSec: normalizeDuration(rawDur),
    subtitle: pick(flat, KEY_SUBTITLE),
    subtitleUrl: pick(flat, KEY_SUBTITLE_URL),
  };
}

/* ------------------------------------------------------------------ *
 * ① 取源：链接 → 视频直链
 * ------------------------------------------------------------------ */

function mockSource(shareUrl) {
  return {
    url: shareUrl,
    title: '',
    cover: '',
    durationSec: 0,
    subtitle: '',
    subtitleUrl: '',
    mock: true,
  };
}

/** POST 请求体编码：form（阿里云市场各家普遍要求）| json */
function encodeBody(payload, mode) {
  if (mode === 'json') {
    return { body: Buffer.from(JSON.stringify(payload), 'utf8'), ct: 'application/json' };
  }
  const s = Object.keys(payload)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(payload[k]))
    .join('&');
  return { body: Buffer.from(s, 'utf8'), ct: 'application/x-www-form-urlencoded' };
}

/**
 * 业务码判断：兼容 code / status / success 多种约定。
 * ⚠️ 各家成功码不一（阿里云市场「聚美智数」成功码是 201，且把 code / success 放在 data 内层），
 *    原来只认 0 / 200 → 成功响应被误判成失败。这里放宽，并同时看内层 data。
 */
function assertParseOk(json) {
  const biz = json && typeof json.data === 'object' && json.data ? json.data : {};
  const code = json.code !== undefined ? json.code : json.status;
  const okCode =
    code === undefined || code === 0 || code === 200 || code === 201 ||
    code === '0' || code === '200' || code === '201';
  const okFlag = json.success === true || biz.success === true;
  if (!okCode && !okFlag) {
    throw new Error(
      '解析服务返回失败：' + (json.msg || json.message || json.error || biz.msg || 'code=' + code)
    );
  }
  if (json.success === false || biz.success === false) {
    throw new Error(
      '解析服务返回失败：' + (json.msg || json.message || json.error || biz.msg || '未知原因')
    );
  }
}

/** 调第三方解析服务（POST 体编码可配，格式不对自动换一种重试一次） */
async function callParseApi(apiUrl, shareUrl, platform) {
  const key = env('PARSE_API_KEY', '');
  const method = String(env('PARSE_API_METHOD', 'GET')).toUpperCase();
  const field = env('PARSE_API_FIELD', 'url');
  const keyIn = String(env('PARSE_API_KEY_IN', 'query')).toLowerCase();
  const bodyMode = String(env('PARSE_API_BODY', 'auto')).toLowerCase();

  // 额外固定参数（部分服务商要求如 productCode=video_parser），格式 k=v&k2=v2
  const extra = {};
  String(env('PARSE_API_EXTRA', '')).split('&').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) extra[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });

  const baseHeaders = { Accept: 'application/json' };
  if (key && keyIn === 'header') {
    // 鉴权头与格式可配：阿里云市场的 API 是 `Authorization: APPCODE <code>`，
    // 不是通用的 `Bearer`。不配 PARSE_API_KEY_HEADER 时保持原行为（X-API-Key + Bearer）。
    const hname = String(env('PARSE_API_KEY_HEADER', '')).trim();
    if (hname) {
      const pfx = String(env('PARSE_API_KEY_PREFIX', '')).trim();
      baseHeaders[hname] = pfx ? pfx + ' ' + key : key;
    } else {
      baseHeaders['X-API-Key'] = key;
      baseHeaders['Authorization'] = 'Bearer ' + key;
    }
  }

  // POST：auto 先 form（阿里云市场文档口径）再 json；GET：全走 query
  const modes = method === 'POST' ? (bodyMode === 'auto' ? ['form', 'json'] : [bodyMode]) : ['query'];
  let lastErr = null;

  for (const mode of modes) {
    try {
      const headers = Object.assign({}, baseHeaders);
      let url = apiUrl;
      let body = null;

      if (method === 'POST') {
        // ⚠️ 只发服务商文档里声明的参数（真实解析服务基本只认 url）。
        //    原先无条件塞 key / platform，部分服务商对未知参数直接 400 拒绝。
        const payload = Object.assign({}, extra);
        payload[field] = shareUrl;
        if (key && keyIn === 'query') payload.key = key;
        const enc = encodeBody(payload, mode);
        body = enc.body;
        headers['Content-Type'] = enc.ct;
      } else {
        const qs = [field + '=' + encodeURIComponent(shareUrl)];
        Object.keys(extra).forEach((k) =>
          qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]))
        );
        if (key && keyIn === 'query') qs.push('key=' + encodeURIComponent(key));
        url += (url.indexOf('?') > -1 ? '&' : '?') + qs.join('&');
      }

      const json = await requestJson({ url, method, headers, body, timeoutMs: 30000 });
      assertParseOk(json);
      return json;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || '');
      // 只在「像请求格式不对」时才换编码重试一次（HTTP 4xx/5xx、参数类错误）；
      // 业务性失败（如不支持该平台）不重试，避免白白消耗调用次数。
      if (!/HTTP [45]\d{2}|参数|param|content-type|format|sign/i.test(msg)) break;
    }
  }
  throw lastErr;
}

/** 内置兜底：短链展开 + 页面 og:video 抓取（未配解析服务时用，不保证可用） */
async function builtinResolve(shareUrl, platform) {
  try {
    // request 内部已跟随重定向（最多 5 跳），拿到的就是落地页 HTML
    const res = await request({ url: shareUrl, method: 'GET', timeoutMs: 12000, redirects: 5 });
    const html = res.text || '';
    const grab = (patterns) => {
      for (const re of patterns) {
        const m = html.match(re);
        if (m && m[1]) return m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      }
      return '';
    };
    const videoUrl = grab([
      /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url)?["']/i,
      /"playAddr"\s*:\s*"([^"]+)"/i,
      /"play_addr"\s*:\s*\{[^}]*"url_list"\s*:\s*\[\s*"([^"]+)"/i,
      /"video_url"\s*:\s*"([^"]+)"/i,
      /"backup_url"\s*:\s*\[\s*"([^"]+)"/i,
    ]);
    const title = grab([/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i, /<title>([^<]*)<\/title>/i]);
    const cover = grab([/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i]);
    if (videoUrl) {
      return {
        url: videoUrl,
        title: title || '',
        cover: cover || '',
        durationSec: 0,
        subtitle: '',
        subtitleUrl: '',
        platform,
        mock: false,
      };
    }
    if (platform === 'video_channel') {
      throw new Error(
        '视频号链接需要第三方解析服务才能取到视频：请在小程序云函数环境变量配置 PARSE_API_URL'
      );
    }
    throw new Error(
      '未能从该链接解析出视频地址（' + platformLabel(platform) + '），请检查链接是否完整，或配置 PARSE_API_URL 解析服务'
    );
  } catch (e) {
    const m = String((e && e.message) || '');
    // 自己的业务错误（含"未能从该链接解析出视频地址"）直接抛，网络类错误补一层人话
    if (/未能从该链接|需要第三方解析服务/.test(m)) throw e;
    throw new Error('打开链接失败（' + m.slice(0, 80) + '），请检查链接是否完整');
  }
}

/**
 * ① 取源
 * @param {string} shareUrl 分享链接（或本地文件的 cloud:// fileID）
 * @param {string} platform 平台 code
 * @param {object} opts     { fileId, isLocal }
 */
async function resolveVideoSource(shareUrl, platform, opts) {
  const o = opts || {};

  // 本地视频：前端已上传云存储，源就是该文件，无需解析
  if (o.fileId || platform === 'local') {
    if (o.fileId && /^cloud:\/\//.test(o.fileId)) {
      return {
        url: o.fileId,
        title: '',
        cover: '',
        durationSec: 0,
        subtitle: '',
        subtitleUrl: '',
        local: true,
        mock: false,
      };
    }
    if (useMock()) return mockSource(shareUrl);
    throw new Error('本地视频文件缺失，请重新选择');
  }

  const apiUrl = env('PARSE_API_URL', '');
  if (apiUrl) {
    const json = await callParseApi(apiUrl, shareUrl, platform);
    const norm = normalizeParseResult(json, env('PARSE_API_RESULT_PATH', ''));
    if (!norm.videoUrl && !norm.subtitle) {
      throw new Error(
        '解析服务未返回视频地址（' + platformLabel(platform) + '），可能该服务不支持此链接，或链接已失效'
      );
    }
    return {
      url: norm.videoUrl,
      title: norm.title,
      cover: norm.cover,
      durationSec: norm.durationSec,
      subtitle: norm.subtitle,
      subtitleUrl: norm.subtitleUrl,
      platform,
      mock: false,
    };
  }

  if (useMock()) return mockSource(shareUrl);
  return await builtinResolve(shareUrl, platform);
}

/* ------------------------------------------------------------------ *
 * ② 下载
 * ------------------------------------------------------------------ */

function guessExt(url) {
  const m = String(url || '').match(/\.(mp4|m4a|mp3|wav|mov|m4v|webm)(\?|$)/i);
  if (m) return '.' + m[1].toLowerCase();
  return '.mp4';
}

/** 临时媒体的固定落点：同一任务固定同名 → 同一实例内重跑可直接复用，省一次出网 */
function mediaPathFor(taskId, url) {
  return path.join(os.tmpdir(), 'wb_' + String(taskId || Date.now()) + guessExt(url));
}

/** 删除临时媒体文件（含未完成的 .part） */
function removeMedia(filePath) {
  if (!filePath) return;
  [filePath, filePath + '.part'].forEach((p) => {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      /* ignore */
    }
  });
}

/** 已下载完整文件的大小（不存在/空文件返回 0） */
function mediaSize(filePath) {
  if (!filePath) return 0;
  try {
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size || 0;
  } catch (e) {
    return 0;
  }
}

/** ② 视频 → 云函数临时文件（幂等：已有完整文件直接复用） */
async function downloadMedia(videoMeta, taskId) {
  const meta = videoMeta || {};
  const src = meta.url || '';

  // 本地视频（cloud:// fileID）：用云开发 SDK 直接下载
  if (/^cloud:\/\//.test(src)) {
    const dest = path.join(os.tmpdir(), 'wb_' + String(taskId || Date.now()) + '.mp4');
    const cached = mediaSize(dest);
    if (cached) return { path: dest, sizeBytes: cached, mock: false, cached: true };
    const cloud = require('wx-server-sdk');
    // 同一原文件的签名 URL，分片下载不改变音视频编码。
    const deadline = Date.now() + envInt('MEDIA_TIMEOUT_MS', 45000, 5000, 55000);
    const bounded = (promise, ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('云文件下载超时')), ms);
      Promise.resolve(promise).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
    const part = dest + '.part';
    try {
      const urls = await bounded(cloud.getTempFileURL({ fileList: [src] }), Math.min(3000, deadline - Date.now()));
      const item = (urls.fileList || []).find(f => f.fileID === src && f.status === 0);
      if (!item || !/^https:\/\//i.test(item.tempFileURL || '')) throw new Error('云文件临时地址不可用');
      const r = await downloadAuto(item.tempFileURL, part, {
        maxBytes: 100 * 1024 * 1024, timeoutMs: Math.max(1, deadline - Date.now()), probeTimeoutMs: 3000, resume: false,
      });
      if (!r.sizeBytes) throw new Error('云文件为空');
      fs.renameSync(part, dest);
      return { path: dest, sizeBytes: r.sizeBytes, mock: false, parallel: !!r.parallel, fetchMode: 'cloud-range' };
    } catch (e) {
      removeMedia(part);
      console.warn('[providers] 云文件直下载未完成，回退 SDK', e && e.message);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('云文件下载超时');
    const r = await bounded(cloud.downloadFile({ fileID: src }), remaining);
    const size = r.fileContent ? r.fileContent.length : 0;
    if (!size) throw new Error('云文件为空');
    if (size > 100 * 1024 * 1024) throw new Error('视频超过 100MB 上限，建议截取关键片段');
    fs.writeFileSync(part, r.fileContent);
    fs.renameSync(part, dest);
    return { path: dest, sizeBytes: size, mock: false, fetchMode: 'cloud-sdk' };
  }

  if (!src && !meta.relayFileId) throw new Error('缺少视频地址，无法下载');
  if (meta.mock && useMock()) return { path: '', sizeBytes: 0, mock: true };

  const dest = mediaPathFor(taskId, src);
  // ① 上一次调用已经下好了同一个文件 → 直接用（跨实例时命中不了，落回下面两条路）
  const cached = mediaSize(dest);
  if (cached) return { path: dest, sizeBytes: cached, mock: false, cached: true };

  // ② 上次下载很慢时留了云存储中转件 → 内网取回，比重新拉源站快得多
  if (meta.relayFileId) {
    try {
      const size = await fetchRelay(meta.relayFileId, dest);
      if (size > 0) return { path: dest, sizeBytes: size, mock: false, relay: true };
    } catch (e) {
      console.warn('[providers] 云存储中转件取回失败，回退直接下载', e && e.message);
    }
  }

  if (!src) throw new Error('缺少视频地址，无法下载');

  // 下到 .part 再原子改名 → 正式文件存在即代表「完整」，不会复用残缺文件
  const part = dest + '.part';
  const referer = env('MEDIA_REFERER', '');
  const r = await downloadAuto(src, part, {
    maxBytes: 100 * 1024 * 1024,
    timeoutMs: envInt('MEDIA_TIMEOUT_MS', 45000, 5000, 55000),
    resume: true,
    headers: referer ? { Referer: referer } : {},
  });
  fs.renameSync(part, dest);
  return { path: dest, sizeBytes: r.sizeBytes, mock: false, parallel: !!r.parallel };
}

/* ------------------------------------------------------------------ *
 * ② c 云存储中转（防「跨实例重下整个视频」）
 * 背景：下载步与转写步若落在不同的云函数实例，/tmp 里的文件就没了，
 *       转写步会从头再下一次（几十秒白费）。
 * 设计：默认关闭（MEDIA_RELAY_MIN_MS=-1）。开启后**只有下载耗时超过阈值**才
 *       上传中转件 —— 常规情况零额外开销，把成本花在可能真的会重下的任务上。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * ② b 封面转存（防「封面链接过期 → 历史 / 详情页全变绿块」）
 * 背景：解析接口给的封面是平台 CDN 直链，尾巴带签名，**几小时~一两天就 403**。
 *       过期后前端只能按设计降级成色块（history.js / result.js 的 coverFail）。
 * 做法：归档时把图下一份放自己的云存储，库里改存 fileID（cloud://，永久有效）。
 * ⚠️ 任何异常都只返回 ''，由调用方回落原直链 —— 封面问题绝不能影响提取主流程。
 * ------------------------------------------------------------------ */

/** 封面转存：成功返回云存储 fileID，失败返回 ''（调用方回落原链接） */
async function relayCover(url, taskId) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return '';
  const stamp = String(taskId || Date.now());
  const tmp = path.join(os.tmpdir(), 'cover-' + stamp + '.jpg');
  try {
    // 封面正常 20~200KB；给 2MB 上限 + 8 秒硬超时，够用又不会拖住归档
    const r = await downloadToFile(u, tmp, { maxBytes: 2 * 1024 * 1024, timeoutMs: 8000 });
    if (((r && r.sizeBytes) || 0) < 512) return ''; // 太小 → 多半是防盗链吐的错误页，不是图
    const cloud = require('wx-server-sdk');
    const fileId = await Promise.race([
      cloud
        .uploadFile({ cloudPath: 'covers/' + stamp + '.jpg', fileContent: fs.createReadStream(tmp) })
        .then((x) => (x && x.fileID) || ''),
      new Promise((_, rej) => setTimeout(() => rej(new Error('封面转存上传超时')), 15000)),
    ]);
    return fileId || '';
  } catch (e) {
    console.warn('[cover] 转存失败，回落原链接', e && e.message);
    return '';
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      /* 临时文件清理失败无所谓 */
    }
  }
}

/** 中转阈值（毫秒）。<0 表示关闭中转。 */
function mediaRelayMinMs() {
  return envInt('MEDIA_RELAY_MIN_MS', -1, -1, 600000);
}

/** 把 /tmp 的媒体文件放一份到云存储（流式上传，不读进内存） */
async function putRelay(taskId, filePath) {
  if (mediaRelayMinMs() < 0 || !filePath) return '';
  let stream;
  try {
    stream = fs.createReadStream(filePath);
  } catch (e) {
    return '';
  }
  const cloud = require('wx-server-sdk');
  const cloudPath = 'task-media/' + String(taskId || Date.now()) + guessExt(filePath);
  const fileId = await Promise.race([
    cloud
      .uploadFile({ cloudPath, fileContent: stream })
      .then((r) => (r && r.fileID) || ''),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('云存储中转上传超时')), 15000)
    ),
  ]);
  return fileId || '';
}

/** 从云存储中转件取回到 /tmp（同环境内网，通常 1~5 秒） */
async function fetchRelay(fileId, destPath) {
  const cloud = require('wx-server-sdk');
  const r = await cloud.downloadFile({ fileID: fileId });
  const buf = r && r.fileContent;
  if (!buf || !buf.length) throw new Error('中转件为空');
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

/** 删除中转件（任务进入终态时清理，不占存储也不留残留） */
async function dropRelay(fileId) {
  if (!fileId) return;
  try {
    const cloud = require('wx-server-sdk');
    await cloud.deleteFile({ fileList: [fileId] });
  } catch (e) {
    console.warn('[providers] 删除中转件失败（忽略）', e && e.message);
  }
}

/* ------------------------------------------------------------------ *
 * ③ 字幕（优先）
 * ------------------------------------------------------------------ */

/** 解析 SRT / VTT 文本 → 纯文本 */
function parseSubtitleText(raw) {
  return String(raw || '')
    .replace(/\r/g, '')
    .replace(/^WEBVTT.*$/m, '')
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '\n')
    .replace(/^\d+$/gm, '')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    // 相邻重复行去掉（字幕滚动导致同一句出现多次）
    .filter((s, i, arr) => i === 0 || s !== arr[i - 1])
    .join('\n');
}

/** ③ 取字幕：优先解析服务已返回的文本，其次字幕文件 URL */
async function fetchSubtitle(videoMeta) {
  const meta = videoMeta || {};
  if (meta.subtitle) {
    const t = parseSubtitleText(meta.subtitle);
    if (t) return { text: t, source: 'platform' };
  }
  if (meta.subtitleUrl) {
    try {
      // ⭐⭐ 2026-09-29 提速（实测数据驱动）：字幕文件是「白捡的便宜」，绝不能拖慢主链路。
      //    timingReport 实证：转写步 31.3s 里 ASR 只占 3.1s，其余 28s 全耗在这里 ——
      //    视频号等平台给的 subtitleUrl 常年 403 / 挂死，原设 20s 超时 + 跟随 3 次重定向
      //    （每次重定向各算一次超时）→ 白等 20~60 秒后才回退 ASR，用户看到的就是「10 秒视频要几十秒」。
      //    → 收到 5s（可用 SUBTITLE_TIMEOUT_MS 调）+ 最多跟 1 次重定向；抓不到立刻回退语音识别。
      //    ⚠️ 行为不变：抓到就用（字幕仍优先），抓不到照旧走 ASR，只是不再干等。
      const res = await request({
        url: meta.subtitleUrl,
        timeoutMs: envInt('SUBTITLE_TIMEOUT_MS', 5000, 1000, 20000),
        redirects: 1,
      });
      const t = parseSubtitleText(res.text);
      if (t) return { text: t, source: 'platform_file' };
    } catch (e) {
      console.warn('[providers] 字幕文件下载失败', e && e.message);
    }
  }
  return { text: '', source: '' };
}

/* ------------------------------------------------------------------ *
 * ④ ASR（无字幕时用；有字幕时可选做交叉校正）
 * ------------------------------------------------------------------ */

function mockAsr() {
  const demoText = [
    '你有没有遇到过这种情况：刷到一个很好的口播视频，想把里面的观点和文案留下来，却只能反复暂停、手打记录？',
    '今天分享一个方法，三步把短视频变成可编辑的文案。第一步，看到想收藏的视频，直接转发给文案助手；第二步，等三到八秒，它会自动把口播转成文字；第三步，点开返回的卡片，复制整理好的文案。',
    '不管是做选题库、写小红书，还是整理学习笔记，这个方法都能帮你省下每天至少三十分钟的机械操作。',
    '最后提醒一句：提取结果只用于你自己的学习整理，不要侵权二次传播。觉得有用的话，点个赞让更多人看到。',
  ];
  return {
    text: demoText.join('\n\n'),
    segments: demoText.map((s) => ({ text: s, start: 0, end: 0 })),
    mock: true,
  };
}

/* ------------------------------------------------------------------ *
 * ③-b 音频轨抽取（**兜底优化，不是提速主力**）：ASR 只吃声音，画面纯属白传
 * ------------------------------------------------------------------ */
// ⚠️ 2026-09-29 结论修正（别被旧假设带偏）：
//   当初以为「转写慢 = 上行带宽被体积拖累」，据此做了这个抽取器。**实测证伪**：
//   同一份 1MB 文件上传恒定 0.14 秒（5MB 也只 0.15 秒）—— 上行根本不是瓶颈，
//   真正的长尾在 ASR **服务端**（详见 asrTranscribe 顶部：同文件 2.0s~74.6s）。
//   保留它的理由：① 零风险（失败一律回退原文件）② 服务商若有单文件体积上限，它能兜底
//   ③ 省一点上行与内存。**别指望它带来秒级改善** —— 那是模型的锅。
//   抽出音频轨单独封装成 m4a，通常只剩原文件的 3%~10% → 上传时间按体积线性下降。
//   ⭐ 与「提取质量」完全无关：识别输入本来就是音频，画面从头到尾没参与过识别。
//
// ⚠️ 四重保险，失败一律退回原文件，绝不影响主流程：
//   ① 只在文件 > ASR_AUDIO_MIN_MB（默认 2MB）时才尝试；
//   ② 结果必须非空且 < 原体积 60%，否则视为「没赚到」→ 原样上传；
//   ③ 结构异常（非 MP4 / box 不完整 / 偏移越界）→ 返回 null；
//   ④ 整体可用 ASR_EXTRACT_AUDIO=false 关闭。
// 实现：纯 Buffer 解析 ISO BMFF box，无第三方依赖。
function extractAudioM4a(srcPath, taskId) {
  const t0 = Date.now();
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const buf = fs.readFileSync(srcPath);
  const total = buf.length;
  if (total < 1024) return null;

  const u32 = (o) => buf.readUInt32BE(o);
  const u64 = (o) => buf.readUInt32BE(o) * 4294967296 + buf.readUInt32BE(o + 4);

  // 顺序读同一层级的 box
  function readBoxes(start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      let headerLen = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = u64(p + 8);
        headerLen = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < headerLen || p + size > end) break;
      out.push({ type, start: p, size, bodyStart: p + headerLen, bodyEnd: p + size });
      p += size;
    }
    return out;
  }
  const find = (arr, t) => arr.find((b) => b.type === t) || null;

  function u32b(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v, 0);
    return b;
  }
  function full(flags) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(flags || 0, 0);
    return b;
  }
  function box(type, ...parts) {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  }

  const top = readBoxes(0, total);
  const moov = find(top, 'moov');
  if (!moov) return null;

  const moovKids = readBoxes(moov.bodyStart, moov.bodyEnd);
  const mvhd = find(moovKids, 'mvhd');
  const movieTimescale = mvhd ? u32(mvhd.bodyStart + 12) || 1000 : 1000;

  // 找音频 trak（hdlr.handler_type === 'soun'）
  let trakKids = null;
  let mdiaKids = null;
  for (const tk of moovKids.filter((b) => b.type === 'trak')) {
    const k1 = readBoxes(tk.bodyStart, tk.bodyEnd);
    const mdia = find(k1, 'mdia');
    if (!mdia) continue;
    const k2 = readBoxes(mdia.bodyStart, mdia.bodyEnd);
    const hdlr = find(k2, 'hdlr');
    if (!hdlr) continue;
    const ht = buf.toString('latin1', hdlr.bodyStart + 8, hdlr.bodyStart + 12);
    if (ht === 'soun') {
      trakKids = k1;
      mdiaKids = k2;
      break;
    }
  }
  if (!trakKids || !mdiaKids) return null;

  const mdhd = find(mdiaKids, 'mdhd');
  if (!mdhd) return null;
  const mdhdV = buf[mdhd.bodyStart];
  const mediaTimescale = mdhdV === 1 ? u32(mdhd.bodyStart + 20) : u32(mdhd.bodyStart + 12);

  const minf = find(mdiaKids, 'minf');
  if (!minf) return null;
  const minfKids = readBoxes(minf.bodyStart, minf.bodyEnd);
  const stbl = find(minfKids, 'stbl');
  if (!stbl) return null;
  const stblKids = readBoxes(stbl.bodyStart, stbl.bodyEnd);

  const stsd = find(stblKids, 'stsd');
  const sttsBox = find(stblKids, 'stts');
  const stscBox = find(stblKids, 'stsc');
  const stszBox = find(stblKids, 'stsz');
  const stcoBox = find(stblKids, 'stco');
  const co64Box = find(stblKids, 'co64');
  if (!stsd || !stszBox || (!stcoBox && !co64Box)) return null;

  // ⚠️ 只抽 AAC（mp4a）。极少数视频音频轨是 ALAC / AMR / PCM：单独封装成 m4a 后，
  //    识别端的解码兼容性不如「带画面的原片」稳 → 一律不动，走原路（宁慢不坏）。
  if (stsd.bodyStart + 16 > stsd.bodyEnd) return null;
  const sounFormat = buf.toString('latin1', stsd.bodyStart + 12, stsd.bodyStart + 16);
  if (sounFormat !== 'mp4a') return null;

  // --- stsz：每个 sample 的字节数 ---
  let p = stszBox.bodyStart + 4;
  const uniformSize = u32(p);
  p += 4;
  const sampleCount = u32(p);
  p += 4;
  if (sampleCount <= 0 || sampleCount > 4000000) return null;
  const sizes = new Array(sampleCount);
  if (uniformSize === 0) {
    if (p + sampleCount * 4 > stszBox.bodyEnd) return null;
    for (let i = 0; i < sampleCount; i++) sizes[i] = u32(p + i * 4);
  } else {
    for (let i = 0; i < sampleCount; i++) sizes[i] = uniformSize;
  }

  // --- stco / co64：每个 chunk 的偏移 ---
  const chunkOffsets = [];
  if (stcoBox) {
    let q = stcoBox.bodyStart + 4;
    const n = u32(q);
    q += 4;
    if (q + n * 4 > stcoBox.bodyEnd) return null;
    for (let i = 0; i < n; i++) chunkOffsets.push(u32(q + i * 4));
  } else {
    let q = co64Box.bodyStart + 4;
    const n = u32(q);
    q += 4;
    if (q + n * 8 > co64Box.bodyEnd) return null;
    for (let i = 0; i < n; i++) chunkOffsets.push(u64(q + i * 8));
  }
  if (!chunkOffsets.length) return null;

  // --- stsc：chunk -> 每个 chunk 含几个 sample ---
  const stsc = [];
  {
    let q = stscBox.bodyStart + 4;
    const n = u32(q);
    q += 4;
    for (let i = 0; i < n; i++) {
      stsc.push({ first: u32(q + i * 12), spc: u32(q + i * 12 + 4) });
    }
  }
  if (!stsc.length) return null;

  // --- 算出每个 sample 在文件中的位置 ---
  const sampleOffsets = new Array(sampleCount);
  let si = 0;
  for (let ci = 0; ci < chunkOffsets.length && si < sampleCount; ci++) {
    let spc = stsc[0].spc;
    for (let k = 0; k < stsc.length; k++) {
      if (ci + 1 >= stsc[k].first) spc = stsc[k].spc;
      else break;
    }
    let off = chunkOffsets[ci];
    for (let j = 0; j < spc && si < sampleCount; j++) {
      sampleOffsets[si] = off;
      off += sizes[si];
      si++;
    }
  }
  if (si < sampleCount) return null;

  // --- 拼出音频数据 ---
  const parts = [];
  let mdatLen = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = sampleOffsets[i];
    const len = sizes[i];
    if (!len || s < 0 || s + len > total) return null;
    parts.push(buf.slice(s, s + len));
    mdatLen += len;
  }
  if (mdatLen <= 0) return null;
  const mdatPayload = Buffer.concat(parts, mdatLen);

  // --- 总时长：stts 累加（单位 = media timescale 的采样数） ---
  let totalUnits = 0;
  let delta = 1024;
  try {
    let q = sttsBox.bodyStart + 4;
    const n = u32(q);
    q += 4;
    for (let i = 0; i < n; i++) {
      const cnt = u32(q + i * 8);
      const d = u32(q + i * 8 + 4);
      if (i === 0) delta = d || 1024;
      totalUnits += cnt * d;
    }
  } catch (e) {
    totalUnits = sampleCount * delta;
  }
  if (!totalUnits) totalUnits = sampleCount * delta;

  // --- 重建 moov（只含一条音频轨） ---
  const stsdRaw = buf.slice(stsd.start, stsd.bodyEnd);

  function buildStbl(mdatStart) {
    const offsets = [];
    let acc = mdatStart;
    for (let i = 0; i < sampleCount; i++) {
      offsets.push(acc);
      acc += sizes[i];
    }
    const stco = box('stco', full(0), u32b(sampleCount), Buffer.concat(offsets.map(u32b)));
    // 音频帧时间戳：整段恒定 delta
    const stts = box('stts', full(0), u32b(1), u32b(sampleCount), u32b(delta));
    // 每 sample 一个 chunk，索引最简单也最稳
    const stsc = box('stsc', full(0), u32b(1), u32b(1), u32b(1), u32b(1));
    const stsz = box('stsz', full(0), u32b(0), u32b(sampleCount), Buffer.concat(sizes.map(u32b)));
    return box('stbl', stsdRaw, stts, stsc, stsz, stco);
  }

  function buildTrak(mdatStart, durMovie) {
    const tkhdBody = Buffer.alloc(84);
    tkhdBody.writeUInt32BE(0x00000007, 0);
    tkhdBody.writeUInt32BE(0, 4);
    tkhdBody.writeUInt32BE(0, 8);
    tkhdBody.writeUInt32BE(1, 12);
    tkhdBody.writeUInt32BE(0, 16);
    tkhdBody.writeUInt32BE(durMovie, 20);
    tkhdBody.writeUInt32BE(0, 24);
    tkhdBody.writeUInt32BE(0, 28);
    tkhdBody.writeUInt16BE(0, 32);
    tkhdBody.writeUInt16BE(0, 34);
    tkhdBody.writeUInt16BE(0x0100, 36);
    tkhdBody.writeUInt16BE(0, 38);
    [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].forEach((v, i) =>
      tkhdBody.writeUInt32BE(v, 40 + i * 4)
    );
    tkhdBody.writeUInt32BE(0, 76);
    tkhdBody.writeUInt32BE(0, 80);

    const mdhdBody = Buffer.alloc(24);
    mdhdBody.writeUInt32BE(0, 0);
    mdhdBody.writeUInt32BE(0, 4);
    mdhdBody.writeUInt32BE(0, 8);
    mdhdBody.writeUInt32BE(mediaTimescale || 48000, 12);
    mdhdBody.writeUInt32BE(totalUnits, 16);
    mdhdBody.writeUInt16BE(0x55c4, 20);
    mdhdBody.writeUInt16BE(0, 22);

    const hdlr = box(
      'hdlr',
      full(0),
      u32b(0),
      Buffer.from('soun', 'latin1'),
      Buffer.alloc(12),
      Buffer.from('SoundHandler\0', 'latin1')
    );
    const smhd = box('smhd', full(0), u32b(0));
    const dinf = box('dinf', box('dref', full(0), u32b(1), box('url ', full(1))));
    const minf = box('minf', smhd, dinf, buildStbl(mdatStart));
    const mdia = box('mdia', box('mdhd', mdhdBody), hdlr, minf);
    return box('trak', box('tkhd', tkhdBody), mdia);
  }

  function buildMoov(mdatStart) {
    const durMovie = Math.max(
      1,
      Math.round((totalUnits * (movieTimescale || 1000)) / (mediaTimescale || 48000))
    );
    const mvhdBody = Buffer.alloc(100);
    mvhdBody.writeUInt32BE(0, 0);
    mvhdBody.writeUInt32BE(0, 4);
    mvhdBody.writeUInt32BE(0, 8);
    mvhdBody.writeUInt32BE(movieTimescale || 1000, 12);
    mvhdBody.writeUInt32BE(durMovie, 16);
    mvhdBody.writeUInt32BE(0x00010000, 20);
    mvhdBody.writeUInt16BE(0x0100, 24);
    mvhdBody.writeUInt16BE(0, 26);
    mvhdBody.writeUInt32BE(0, 28);
    mvhdBody.writeUInt32BE(0, 32);
    [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].forEach((v, i) =>
      mvhdBody.writeUInt32BE(v, 36 + i * 4)
    );
    mvhdBody.writeUInt32BE(2, 96);
    return box('moov', box('mvhd', mvhdBody), buildTrak(mdatStart, durMovie));
  }

  const ftyp = box(
    'ftyp',
    Buffer.from('M4A ', 'latin1'),
    u32b(0x200),
    Buffer.from('M4A isomiso2', 'latin1')
  );

  // stco 依赖 moov 的最终大小 -> 两遍构造（大小不变，一次即收敛）
  let moovBuf = buildMoov(0);
  const mdatStart = ftyp.length + moovBuf.length + 8;
  moovBuf = buildMoov(mdatStart);

  const out = Buffer.concat([ftyp, moovBuf, box('mdat', mdatPayload)]);
  const outPath = path.join(os.tmpdir(), 'wb_' + String(taskId || Date.now()) + '_a.m4a');
  fs.writeFileSync(outPath, out);
  return { path: outPath, sizeBytes: out.length, ms: Date.now() - t0, samples: sampleCount };
}

/** ④ 语音转写（OpenAI 兼容 /audio/transcriptions，可直接传 mp4） */
async function asrTranscribe(media, task) {
  const asrUrl = env('ASR_API_URL', '');
  const asrKey = env('ASR_API_KEY', '');

  if (!asrUrl || !asrKey) {
    if (useMock()) return mockAsr();
    throw new Error(
      '未配置语音识别服务：该视频没有可提取的字幕，需在云函数环境变量配置 ASR_API_URL / ASR_API_KEY 才能转写'
    );
  }
  if (!media || !media.path) throw new Error('音频文件缺失，无法转写');

  const origSize = media.sizeBytes || mediaSize(media.path);
  const sizeMB = Math.round(origSize / 1024 / 1024);

  // ⭐ 2026-09-29 提速：只传音频轨（详见 extractAudioM4a 注释）。
  //    识别输入本来就是音频，画面从未参与识别 → 对提取质量零影响，纯粹省掉白传的体积。
  //    抽不出 / 没赚到 / 出任何错 → sendPath 保持原文件，行为与改动前完全一致。
  // ⭐ 2026-10-12 修正（排查「本地视频识别偶发 30+ 秒」时发现）：
  //    前端已无损抽出音频轨上传时，云端下载后的**本地文件名被统一写成 wb_xxx.mp4**
  //    （见 downloadMedia 的 cloud:// 分支），扩展名根本反映不了真实内容 ——
  //    所以不能按扩展名判断，必须用前端随任务上报的 client_timing.audio_only 标记。
  //    原先一律按 video/mp4 上报，等于告诉识别服务「这是视频」，
  //    服务端可能先做一遍解封装再识别，白等一段。
  const clientAudioOnly = !!(task && task.client_timing && task.client_timing.audio_only);
  let sendPath = media.path;
  let sendCt = clientAudioOnly ? 'audio/mp4' : 'video/mp4';
  let sendName = clientAudioOnly ? 'audio.m4a' : path.basename(sendPath);
  let audioInfo = null;
  const audioOn = String(env('ASR_EXTRACT_AUDIO', 'true')).toLowerCase() !== 'false';
  if (audioOn && origSize > envInt('ASR_AUDIO_MIN_MB', 2, 0, 100) * 1024 * 1024) {
    try {
      const a = extractAudioM4a(media.path, task && task._id);
      if (a && a.sizeBytes > 0 && a.sizeBytes < origSize * 0.6) {
        sendPath = a.path;
        sendCt = 'audio/mp4';
        sendName = path.basename(a.path);
        audioInfo = {
          from_bytes: origSize,
          to_bytes: a.sizeBytes,
          extract_ms: a.ms,
          samples: a.samples,
        };
        console.log(
          '[providers] 音频轨抽取 ' + a.ms + 'ms · ' + origSize + ' → ' + a.sizeBytes + ' bytes（省 ' +
            Math.round((1 - a.sizeBytes / origSize) * 100) + '%）'
        );
      }
    } catch (e) {
      console.warn('[providers] 音频轨抽取失败，原样上传', e && e.message);
    }
  }

  // ⭐⭐⭐ 2026-09-29 提速（真因，实测证据）：
  //    慢的**不是上传，是模型服务端**。同一份 1 秒音频实测硅基流动 FunAudioLLM/SenseVoiceSmall：
  //      2.0s / 24.4s / 33.6s / 44.5s / 74.6s —— 而上传耗时恒定 0.14 秒。
  //    → 这是算力池排队 / 冷启动，**跟文件体积、上行带宽毫无关系**
  //      （所以「只传音频轨」省不到这一步，它只在服务端有体积上限时兜底）。
  //    同平台 XingChenAGI 系模型，同一份文件稳定 2.0~2.8s。
  //    策略：
  //      ① 默认模型换成稳定的 XingChen（env ASR_MODEL 仍可覆盖）
  //      ② 失败 / 超时 / 返回空文本 → 换 ASR_MODEL_FALLBACK **串行**重试一次
  //    ⚠️ 必须串行：实测同账号并发会被队列惩罚（4 并发 → 17.8~21.4s，总墙钟反而更慢），
  //       所以**绝不能**改成两路并发竞速，也**不要**做「切片并发」。
  //    ⚠️ 时长实测（2026-09-29，52s 音频 / 串行）：Ultra 8~10s、V3.2 8.1s、GSR 10.2s、
  //       SenseVoice 3~4s（但历史上会间歇性挂死到 50s+，故不作默认）、Qwen3-ASR-1.7B 报 500。
  //    ⭐ 2026-10-12 复测（8 分钟长音频 · 交替 3 轮）：Qwen3-ASR-1.7B 均值 16.6s / 波动 2.1s；
  //       SenseVoiceSmall 均值 23.8s / 波动 17.8s（最慢 35.0s）。9-29 的 500 已恢复。
  //       同段 TTS 语料逐字对照（9 项专有名词）：Qwen3 对 5 / SenseVoice 对 0
  //       （治补清盐 / 通易千问 / 提mi），SenseVoice 还丢标点、凭空吐 emoji。
  //       ⇒ 主模型改为 Qwen3：实测唯一能**同时**改善均值与波动的候选；兜底选型见下方说明。
  //    🚫 淘汰 `FunAudioLLM/SenseVoiceSmall` 作**主模型**（下面 ASR_RETIRED 会强制挡掉）：
  //       排队波动 17.8s，1 秒音频实测曾等 74.6s；用户端表现就是「第二步几十秒不动」
  //       （2026-10-12 用户反馈「上次 1s，这次 31s」即此因，与前端改动无关）。
  //    ⚠️ 兜底位**故意仍选 SenseVoice**（2026-10-12 复盘 DETAIL-提速与精度 §二 后修正）：
  //       它在各时长上的均值都快于 XingChen Ultra —— 9-30 实测 5 分钟音频 SenseVoice 均值 13s
  //       （6.5~34.7s），而 Ultra 是 43.7/41.1/55.0s，物理上贴着 50s 超时线；
  //       10-12 实测 90s 音频 SenseVoice 约 75% 在 5s 内、Ultra 却要 12.8~24.9s。
  //       ⇒「Ultra 作兜底只会更慢」（旧记忆里"必须 Ultra"系短视频样本偏差，已作废）。
  //       兜底是「主模型挂了才用」的救援位，此时「能出结果」优先于「稳」，故取均值最快者。
  //       它的用字精度差只影响主模型选型，不影响救援职能。
  //    🚫 禁用 `XingChenAGI/XingChenGSR-V1.0`：实测它对英文语音**直接输出中文翻译**
  //       （输入 Sintel 英文台词 → 返回「是什么让你来到守门人的土地」），会篡改文案语言，
  //       属于「降低提取质量」，绝不可配成主/备模型。
  const ASR_DEFAULT_MODEL = 'Qwen/Qwen3-ASR-1.7B';
  const ASR_DEFAULT_FALLBACK = 'FunAudioLLM/SenseVoiceSmall';
  // 🚫 实测淘汰表：**只作用于主模型** —— 即使环境变量显式配了也会被忽略并回退默认
  //    （保护线上，避免「第二步几十秒不动」）。要恢复某模型，把键从下表删掉即可。
  const ASR_RETIRED = {
    'FunAudioLLM/SenseVoiceSmall': '作主模型时排队波动 17.8s（8 分钟音频均值 23.8s，最慢 35.0s）',
  };
  function pickAsrModel(v, dft) {
    if (!v) return dft;
    if (ASR_RETIRED[v]) {
      console.warn('[providers] ASR 模型 ' + v + ' 已淘汰（' + ASR_RETIRED[v] + '）→ 自动改用 ' + dft);
      return dft;
    }
    return v;
  }
  const primaryModel = pickAsrModel(env('ASR_MODEL', ''), ASR_DEFAULT_MODEL);
  // 兜底不做淘汰校验（它本身就是 SenseVoice）；`env()` 对空串返回空串，故这里显式兜一下
  const fbModel = env('ASR_MODEL_FALLBACK', '') || ASR_DEFAULT_FALLBACK;
  const asrModels = fbModel && fbModel !== primaryModel ? [primaryModel, fbModel] : [primaryModel];
  const asrTimeout = envInt('ASR_TIMEOUT_MS', 50000, 5000, 55000);
  // 主备共用原 ASR_TIMEOUT_MS 总预算；不按压缩音频字节数提前中断主模型。
  // AAC 码率不是时长，提前切换可能丢掉即将完成的全文并重复排队。
  const asrDeadline = Date.now() + asrTimeout;
  // ⭐ 2026-10-12 修复「兜底模型形同虚设」：
  //    原实现把剩余预算**全部**交给当前模型，主模型一旦跑满总预算就超时，
  //    此时 remaining ≤ 0 → 兜底分支永远进不去 —— 也就是「配了兜底模型，实际一次都没跑过」。
  //    现在非最后一个模型最多用「总预算 − 预留」，保证兜底真的有机会执行。
  //    预留值取 12s（实测兜底模型对短音频 12~25s，虽有超时风险，但总比不试好）。
  const asrRetryReserve =
    asrModels.length > 1 ? envInt('ASR_RETRY_RESERVE_MS', 12000, 0, 30000) : 0;
  const attemptLog = [];
  const retryReason = e => {
    const m = String((e && e.message) || '');
    if (/超时|timeout/i.test(m)) return 'timeout';
    if (/HTTP 429/.test(m)) return 'rate_limit';
    if (/HTTP 5\d{2}/.test(m)) return 'upstream_5xx';
    if (/未返回文本/.test(m)) return 'empty_text';
    return 'request_error';
  };

  let text = '';
  let mpTiming = null; // 上传/服务端耗时拆分（诊断用）
  let modelUsed = '';
  let attempts = 0;
  let lastErr = null;
  let lastRaw = '';
  for (let i = 0; i < asrModels.length; i++) {
    const model = asrModels[i];
    const hasNext = i + 1 < asrModels.length;
    const remaining = asrDeadline - Date.now();
    if (remaining <= 0 || (i > 0 && remaining < 1000)) break;
    // ⭐ 非最后一个模型：预留 asrRetryReserve 给后续兜底，避免主模型独吞全部预算
    //    （预算耗尽后兜底分支永远进不去，等于白配）
    const attemptBudget = hasNext ? Math.max(3000, remaining - asrRetryReserve) : remaining;
    attempts = i + 1;
    const attemptStarted = Date.now();
    let attemptTiming = null;
    let outcome = 'error';
    let reason = '';
    try {
      const raw = await postMultipart(
        asrUrl,
        {
          fields: { model, response_format: 'json' },
          file: {
            field: 'file',
            path: sendPath,
            filename: sendName,
            contentType: sendCt,
          },
        },
        { Authorization: 'Bearer ' + asrKey },
        attemptBudget,
        (t) => {
          attemptTiming = t;
        }
      );
      lastRaw = raw;
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch (e) {
        json = null;
      }
      const got = (json && (json.text || (json.data && json.data.text))) || '';
      if (got) {
        text = String(got).trim();
        modelUsed = model;
        outcome = 'ok';
        break;
      }
      // 服务端 200 却没给文本 → 这个模型（或这次调度）不可用，换一个再试
      lastErr = new Error('语音识别未返回文本：' + String(raw).slice(0, 160));
      reason = 'empty_text';
      console.warn('[providers] ASR 模型 ' + model + ' 返回空文本' + (hasNext ? ' → 换 ' + asrModels[i + 1] + ' 重试' : ''));
      if (!hasNext) break;
    } catch (e) {
      lastErr = e;
      reason = retryReason(e);
      const m = String((e && e.message) || '');
      // 只有「超时 / 中断 / 5xx / 429」这类「这次不行、换一个大概率行」的错误才值得换模型；
      // 4xx（429 除外）多是请求本身有问题，换模型也一样，直接收手。
      const worthRetry = /超时|中断|HTTP 5\d{2}|HTTP 429|socket|ECONN|EAI_AGAIN|timeout/i.test(m);
      console.warn(
        '[providers] ASR 模型 ' + model + ' 失败：' + m + (worthRetry && hasNext ? ' → 换 ' + asrModels[i + 1] + ' 重试' : '')
      );
      if (!(worthRetry && hasNext)) break;
    } finally {
      const row = { model, outcome, reason, total_ms: Date.now() - attemptStarted,
        upload_ms: attemptTiming ? attemptTiming.upload_ms : 0,
        wait_ms: attemptTiming ? attemptTiming.wait_ms : 0 };
      attemptLog.push(row);
      if (outcome === 'ok') mpTiming = attemptTiming || { total_ms: row.total_ms, upload_ms: 0, wait_ms: 0 };
    }
  }

  // 抽出来的音频是本次临时产物 → 用完即删；原始视频文件由 pipeline 统一管理，不动
  if (audioInfo) {
    try {
      fs.unlinkSync(sendPath);
    } catch (e) {
      /* ignore */
    }
  }

  if (!text) {
    const m = String((lastErr && lastErr.message) || '语音识别失败');
    // 大文件 + 4xx/超时 → 多半是服务商单文件上限或处理不过来，给出可操作提示，
    // 而不是把 HTTP 413 这种原始报错直接甩给用户。
    if (sizeMB >= 15 && /HTTP (4\d{2}|5\d{2})|超时|中断/.test(m)) {
      throw new Error(
        '语音识别失败（视频约 ' +
          sizeMB +
          'MB）：' +
          m +
          '；可换更短的视频，或改用支持更大文件的语音识别服务'
      );
    }
    if (/未返回文本/.test(m) && lastRaw) {
      throw new Error('语音识别未返回文本：' + String(lastRaw).slice(0, 160));
    }
    throw lastErr || new Error('语音识别失败');
  }
  if (mpTiming) {
    // 诊断：下次 timingReport 能直接看到「用的哪个模型、试了几次」
    mpTiming.model = modelUsed;
    mpTiming.attempts = attempts;
    mpTiming.attempt_log = attemptLog;
    mpTiming.retry_ms = attemptLog.filter(a => a.outcome !== 'ok').reduce((n, a) => n + a.total_ms, 0);
  }
  // ⭐ 2026-10-11 诊断增强：成功也打一行，云端日志一眼可见「用了哪个模型 / 几秒 / 有没有重试」。
  //    原先只在失败时 console.warn，成功后无任何输出 → 排查「为什么这次慢」时无从下手。
  try {
    const t = mpTiming || {};
    console.log(
      '[providers] ASR 完成 · 模型=' + (modelUsed || '-') +
      ' · 总耗时=' + (t.total_ms || 0) + 'ms' +
      '（上传 ' + (t.upload_ms || 0) + 'ms / 服务端 ' + (t.wait_ms || 0) + 'ms）' +
      ' · 上报=' + (t.bytes || 0) + 'B/' + sendCt +
      ' · 尝试=' + attempts + ' 次' +
      (attemptLog.length > 1
        ? ' · 前序失败=' + attemptLog.filter(a => a.outcome !== 'ok').map(a => a.model + '(' + a.reason + ' ' + a.total_ms + 'ms)').join(', ')
        : '') +
      ' · 文本=' + String(text || '').length + ' 字'
    );
  } catch (e) {
    /* 诊断日志本身绝不能影响主流程 */
  }
  return { text: text, segments: [], mock: false, timing: mpTiming, audio: audioInfo };
}

/* ------------------------------------------------------------------ *
 * ⑤ LLM 结构化
 * ------------------------------------------------------------------ */

// prompt 里写死了用户的写作偏好：只整理不编造、禁止 AI 腔（对仗 / 排比 / 破折号抒情 / 金句收尾）
const SYSTEM_PROMPT = [
  '你是短视频口播文案的整理助手。用户会给你一段短视频的口播文字稿（可能来自平台字幕或语音识别，可能有错别字、口语赘词、重复）。',
  '把它整理成便于阅读和二次使用的结构化文案。',
  '',
  '【硬性要求】',
  '1. 只做整理，不编造。原文没有的信息一律不写；专有名词、数字、结论必须忠于原文**表达的事实**。⚠️「忠于原文」是用字校对的目标，不是「不许改任何专有名词」——语音识别听错的专有名词，按用户消息【用字校对】里的【专有名词还原】规则改成正确写法。',
  '2. 用字以主稿为准（主稿是哪一版见用户消息里的【校对规则】）：主稿读得通的地方**逐字保留**，包括同音字、近音字、网络用语、方言词、人名地名；只在主稿明显不成词、断句错乱、或与上下文语义冲突时才修正。去掉口语赘词（嗯、啊、那个、就是说）和重复词（删除同样写进 edits，n 留空串），但不得改变原意。',
  '   ⚠️ 你的改动权限**仅限三种**：删口语赘词/重复词、改听错的同音错字、还原听错的专有名词。**不得**换近义词、不得调语序、不得书面化润色。',
  '   ⚠️ 两版稿子写法不同，**不等于**主稿有错。凡主稿说得通的写法一律保留（例：主稿「老登」、语音识别稿「老灯」 → 保留「老登」），严禁换成语音识别版的用字。',
  '3. 保持原文段落顺序和叙事逻辑，不要重排、不要合并成一段。',
  '4. 禁止 AI 腔，具体包括：',
  '   - 不要「不是…而是…」这类对仗句式',
  '   - 不要排比堆砌',
  '   - 不要用破折号做抒情过渡',
  '   - 不要「值得注意的是」「更关键的是」这类连接词',
  '   - 不要写金句式收尾',
  '5. 标题（title）＝整条视频的**一句话概括**，抓核心主张，不抓细节：',
  '   · **高度概括**：回答「这条视频到底讲了什么」，让没看过的人一眼看懂主题；不要只抓它举的某个例子、或它用的某个工具。',
  '   · **概括优先，30 字以内**（中文字符计，英文品牌名算 1 个词）；可用一个或两个逗号分成两小句，读起来像人话。',
  '   · ⚠️ **宁可写全，不要为凑短而丢信息**：30 字以内，先把「讲了什么」说完整 —— 该带的主体、限定词、价值点都要带上，不要漏掉关键限定词。',
  '   · ⚠️ **通顺优先于字数**：不要把词组压断、压成生造简称（例：不要把「坚持日更三十天」压成「更三十天」）。',
  '   · 只写「主题 / 核心主张」：不写具体做法、不堆工具名、不举例子、不写过程步骤。',
  '   · 用原文出现过的说法，不自造概念；不加引号、不加书名号，结尾不加句号。',
  '6. hook 是一句话导语，开门见山说清内容，不要情绪共鸣式铺垫（不要「大家都有同感」这类）。',
  '7. highlights 是能直接拿去当标题 / 开场钩子用的表达，2~5 条；没有就给空数组。',
  '   · 每条都必须是**从原文摘出来的、意思完整的一整句话**：该有的前提、条件、限定、结论要**一起带上**，脱离上下文也能独立读懂。',
  '   · ⚠️ **禁止把一整句话截成半句**：凡句子带「前提 / 条件 / 除非 / 因为 / 否则」这类成分的，要把条件和结论**一起摘全**；只摘半截等于没说完整，用户会认为你在随便摘一句。',
  '   · 长度跟着原文那句话走：通常 20~60 字；原句本身就长，就照长摘，**不要为了短而砍断**。',
  '   · 优先挑**有观点、有判断、有反常识结论**的完整句子；纯叙述过程、纯过渡、纯罗列的句子不要选。',
  '8. points 是原文的**结构化要点**：按原文顺序分段列出，**一个子主题一条**（一个道理、一个方法、一件事、一个例子各自成条），不同子主题**必须分开列**，绝不能并成一大段。',
  '   · 条数由内容自然决定：短稿少、长稿多，长视频列到十几二十条都正常。⚠️ **宁可多分几条，也不要几百字一大段** —— 一段几百字读起来很累，这是用户明确反馈的问题。',
  '   · text 是**这一段原文的整理**：把啰嗦的口语理顺、去掉语气词与重复，但**信息点、关键细节、例子、数字、结论一个都不能丢**；通常 1~3 句，**逐条力争 120 字以内**。',
  '   · ⚠️ **不许压缩成一句话提纲**：原文讲了几件事，要点里就得留几件事；宁可写得比原文略长，也不能把细节概括掉、合并掉。拆分时**保持核心思想与原文一致**，只是分得更细，不要改变原意。',
  '   · title 用 3~6 个字概括本条。',
  '9. edits 字段**只列你改动过的地方**，没动过的地方一律不要输出 —— 系统会把 edits 套用到原文上自动生成最终正文，所以你**不需要、也不要把整篇正文抄回来**。',
  '   · 每条形如 {"o":"被改之前的原文","n":"改之后的文字"}；要删掉某个词，就把 n 写成空串 ""。',
  '   · ⚠️ o 必须**在原文里一字不差地出现**（连标点也要一致），并且**带上前后各 2~4 个字的上下文**，让它在全文里**只出现一次**。找不到或出现多次的条目会被系统丢弃。',
  '   · 上面【用字校对】的五类改动**该做就要做全**：语气词、重复、啰嗦表达、数字形态漏掉不写，等于整理没做。',
  '   · 但四类之外的地方**一个字都不要动** —— 不要为了凑数而改写原文，不要顺手润色。',
  '',
  '【输出格式】严格输出 JSON，不要任何解释文字，不要 markdown 代码块：',
  '{"edits":[{"o":"原文片段（含上下文、全文唯一）","n":"改后文字（删除则填空串）"}],"title":"字符串","hook":"字符串","highlights":["字符串"],"points":[{"type":"step|point|tip","title":"字符串","text":"字符串"}]}',
].join('\n');

/**
 * 无字幕（语音识别主稿）的用字规则。
 * ⭐ 2026-10-12：原口径是「只有固定搭配和上下文共同明确支持时才修正…不得猜改」——
 *    该护栏本意是防「机器听写覆盖人写的字幕」，但视频号**根本没有平台字幕**
 *    （17智联实测返回无 subtitle/subtitleUrl），全链路 100% 走 ASR →
 *    护栏就变成「明知听错了也不许改」，线上出现「夺舍→夺舌」「金句→京剧」。
 *    故本分支改为**授权逐句用字校对**，判据从「固定搭配」放宽到「该词在本句语义是否成立」，
 *    同时把护栏写得更死（人名/地名/品牌/数字/术语一律不改，读得通的网络用语/方言一律保留）。
 *    ⭐ 有字幕分支（SUBTITLE_RULES）**不动**：字幕仍是唯一主稿，逐字保留。
 */
const ASR_RULES = [
  '【用字校对（先做这一步，再整理）】',
  '⚠️ 校对阶段你**只被授权做五件事**，除此之外**一个字都不许动**：',
  '  ① 删口语赘词、口头禅与重复（嗯、啊、那个、就是说、然后然后…）—— **必做项，逐句过一遍，别漏**；',
  '  ② 把机器听错的同音/近音**错字**改成正确用字；',
  '  ③ 还原被机器听错的**专有名词**（人名、地名、品牌、产品名、公司名、型号、行业术语）；',
  '  ④ 把**啰嗦的口语理顺**：同一件事反复讲了几遍的合并成一句、断句错乱的重新断句、',
  '     与正文无关的插话和自我更正（跑题的话、重复起头）删掉 —— 让句子干净、逻辑通顺。',
  '  ⑤ 把中文数字**改写成阿拉伯数字 + 常用符号** —— 这只是同一个数的另一种写法，不是改数值，放心改：',
  '     · 百分数与分数：「百分之九十」→「90%」、「十分之一」→「1/10」、「三分之二」→「2/3」；',
  '     · 年份、日期、时间：「二零二六年」→「2026年」、「三月五号」→「3月5日」、「三点二十分」→「3点20分」；',
  '     · 数量、金额、播放量、粉丝数、销量、时长 —— **一律用阿拉伯数字，量级词照原文保留**：',
  '       「一千八百万播放」→「1800万播放」、「六十万粉」→「60万粉」、「两万三千块」→「23000块」、',
  '       「三百多单」→「300多单」、「七年」→「7年」、「五倍」→「5倍」。',
  '     ⚠️ **要改就改彻底**：这类「数出来的数」在正文、标题、要点里都要统一成阿拉伯数字，不允许只改一半。',
  '     ⚠️ **只改「数出来的数」**；成语、习语、固定说法里**构词用的数字一个字都不动**：',
  '       一心一意、二话不说、三番五次、四面八方、千万不要、十分、万一、一起、一样、一定、第一、乱七八糟。',
  '     ⚠️ **数值本身绝不许改**（原文说 90% 就写 90%，不许写成 80%）；量级、倍数、单位照原文，不做换算替换。',
  '除这五件事以外不得做：换近义词、把口语改成书面腔（「AI 腔」：对仗、排比、「值得注意的是」这类连接词）、',
  '  添加原文没有的信息、把有信息量的话概括掉。',
  '判据：**改完要更通顺，但意思不多不少** —— 信息变少、或语气被改成书面腔，都算违规。',
  '  · 反例（违规）：把「那种质朴的方式」改成「那种笨拙的方式」（换近义词）；把「挺好的」改成「相当不错」（书面化）。',
  '',
  '【② 错字校准的判据】',
  '该词本身不成词、或与整句语义冲突，而存在发音相同/相近、放进去语义通顺的词 → 改。',
  '  例：「被夺舌了一样」→「被夺舍了一样」；「一张口就是别人的京剧」→「一张口就是别人的金句」；',
  '     「你对自已的了解」→「你对自己的了解」（「自已」不成词）；「不是我们的生活频繁」→「不是我们的生活平淡」（与整句语义冲突）。',
  '该词在本句成立、只是少见 → **保留**。网络用语、方言词、新兴热词一律不动（例：「老登」「硬控」「破防」保留）。',
  '数字、量词、语气词**不参与错字校准**（数值、量词、语气一律照原文，不许听错就改数）；',
  '  但数字的**书写形态**按上面第 ⑤ 项统一规范（中文数字 → 阿拉伯数字 + 符号）。',
  '',
  '【③ 专有名词还原（本步重点）】',
  '语音识别对**低频专有名词**最容易出错：听不清，就把同音/近音的常见词填了进去。',
  '出现下列任一信号 → 判定该处是专有名词被听错，还原成正确写法：',
  '  ▸ 该词在本句说不通、或根本不是词，且上下文能佐证它应是某个专有名词：例「前问」→「千问」、「听me」→「Kimi」；',
  '  ▸ 它夹在一串同类专有名词里、与本列其他项明显不同类：例「豆包、质朴、Kimi、DeepSeek」中「质朴」应为「智谱」；',
  '  ▸ 它是外文名的中文空耳：例「听me」→「Kimi」、「地普思考」→「DeepSeek」。',
  '  ⚠️ **必须有语境佐证**：同句或邻句出现了同类词、或话题明显在聊它所属领域，才可还原；',
  '     若句子本身完全通顺、上下文也支持原字 → 保留原字（例：「有问题你就向前问路」通顺且无语境佐证 → 不动）。',
  '  硬约束 A：改后的词必须是**真实存在、有据可查的专有名词**，严禁凭发音自造新词。',
  '  硬约束 B（分词边界）：同音错字只出现在**一个词的内部**。若那两个字分属前后两个词',
  '     （例「向前｜问路」里的「前问」＝「向前」+「问路」，句子本身完全通顺），那不是误识 → **不要改**。',
  '  反例（禁止改动）：人名、地名本来就写对的不动；网络用语/方言不是专有名词，保留。',
  '· ' + TERM_HINT,
  '· 拿不准 → 保留原字。',
  '',
  '然后按系统要求整理成结构化文案；把**校对中改动过的每一处**依次写进 edits（没改的地方一律不要列），不要抄回整篇原文。',
].join('\n');

/**
 * 有字幕（平台字幕主稿）的用字规则 —— **严格保护字幕用字，只整理不校对**。
 * ⭐ 铁律不变（2026-09-29 事故：放宽曾让 ASR 同音误识覆盖正确字幕「老登」→「老灯」）。
 */
const SUBTITLE_RULES = [
  '【用字规则】字幕版是**唯一主稿**，逐字保留其用字（含同音字、近音字、网络用语、方言词、人名地名）。',
  '只在某处**明显不成词、断句错乱、或与上下文语义冲突**（读不通）时才修正；字幕版读得通的写法一律保留（例：字幕「老登」 → 保留「老登」）。',
  '不许因为别处写法不同而改写、删字或换词。',
  '',
  '然后按系统要求整理成结构化文案；字幕版读得通的地方**一律不要写进 edits**，只有按上述规则确实修正过的字词才列（没改就给空数组）。',
].join('\n');

function buildUserPrompt(input) {
  const o = input || {};
  const subtitle = o.subtitle ? (o.transcript || o.subtitle) : '';
  const asrText = o.asrText || '';
  if (subtitle && asrText && subtitle !== asrText) {
    return [
      '下面给你两版同一段口播的文字稿。',
      '【字幕版】（平台自带字幕）—— **唯一主稿，用字以此为准**',
      subtitle,
      '',
      '【语音识别版】（机器听写，仅供核对同一句的明显错处）',
      asrText,
      '',
      '【校对规则】',
      '1. 以字幕版为唯一主稿，**逐字保留字幕版的用字**（含同音字、近音字、网络用语、方言词、人名地名）。',
      '2. 只有当字幕版某处**明显不成词、断句错乱、或与上下文语义冲突**（读不通）时，才采用语音识别版中同一句对应的合理用词，禁止整段替换。',
      '3. ⚠️ 语音识别版和字幕版写得不一样，**不代表字幕版有错**。凡字幕版读得通的写法一律保留字幕版（例：字幕「老登」、语音识别「老灯」 → 保留「老登」）。',
      '4. 字幕版正确的部分不许因为语音识别版不同而改写、删字或换词。',
      '',
      '然后按系统要求整理成结构化文案；字幕版读得通的地方**一律不要写进 edits**，只有按上述规则确实修正过的字词才列。',
    ].join('\n');
  }
  const main = o.transcript || subtitle || asrText || '';
  const bySubtitle = !!subtitle;
  return [
    bySubtitle
      ? '下面是这条短视频的平台字幕（**唯一主稿**，用字以此为准）：'
      : '下面是这条短视频的语音识别文字稿（机器听写，**必然存在同音/近音错别字**）：',
    main,
    '',
    bySubtitle ? SUBTITLE_RULES : ASR_RULES + '\n\n' + termRosterHint(),
  ].join('\n');
}

/** 从可能带 ``` 包裹的返回里抠出 JSON */
function extractJson(content) {
  let s = String(content || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start > -1 && end > start) s = s.slice(start, end + 1);
  return s;
}

/**
 * 归一化模型返回的 edits（清脏数据）。
 * ⚠️ 这里只做「类型/空值」层面的清洗，**真正的安全护栏在 copywriting.js#applyEdits**
 *    （唯一性、长度上下限、总长不许塌）。两处职责不同，别把护栏搬到这边。
 */
function normalizeEdits(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => ({
      o: String((e && e.o) == null ? '' : e.o),
      n: String((e && e.n) == null ? '' : e.n),
    }))
    .filter((e) => e.o)
    .slice(0, 120);
}

function mockStructure() {
  return {
    title: '三步把短视频变成可编辑文案',
    hook: '刷到好口播却只能手打记录？三步就能把它变成可编辑文案。',
    highlights: [
      '转发 → 等待三到八秒 → 复制整理好的文案，全程不离开微信。',
      '选题库、小红书、学习笔记，一条视频文案多处复用。',
      '提取结果只用于个人学习整理，不侵权二次传播。',
    ],
    points: [
      { type: 'step', title: '第 1 步', text: '刷到想收藏的视频，直接转发给文案助手' },
      { type: 'step', title: '第 2 步', text: '等待 3~8 秒，自动完成语音转写与智能整理' },
      { type: 'step', title: '第 3 步', text: '点开卡片，复制原文或结构化整理好的文案' },
    ],
    mock: true,
  };
}

/**
 * ⑤ 结构化整理
 * @param {object} input { subtitle, asrText, transcript }
 */
async function llmStructure(input) {
  const o = typeof input === 'string' ? { transcript: input } : input || {};
  const transcript = o.transcript || o.subtitle || o.asrText || '';

  const key = env('DEEPSEEK_API_KEY', '') || env('LLM_API_KEY', '');
  if (!key) {
    if (useMock()) return mockStructure();
    throw new Error('未配置大模型密钥：请在云函数环境变量配置 DEEPSEEK_API_KEY');
  }
  if (!transcript.trim()) throw new Error('没有可整理的文本内容');

  const url = env('LLM_API_URL', 'https://api.deepseek.com/v1/chat/completions');
  const model = env('LLM_MODEL', 'deepseek-chat');
  const payload = {
    model,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(o) },
    ],
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await requestJson({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: Buffer.from(JSON.stringify(payload), 'utf8'),
        timeoutMs: 60000,
      });
      const choice = json.choices && json.choices[0];
      const content = choice && choice.message && choice.message.content;
      if (!content) {
        throw new Error('大模型返回为空：' + JSON.stringify(json).slice(0, 160));
      }
      const parsed = JSON.parse(extractJson(content));
      const points = Array.isArray(parsed.points)
        ? parsed.points
            .map((p) =>
              typeof p === 'string'
                ? { type: 'point', title: '', text: p }
                : { type: p.type || 'point', title: p.title || '', text: p.text || '' }
            )
            .filter((p) => p.text)
        : [];
      return {
        // ⭐⭐ 2026-10-12 提速（timingReport 实测依据）：改为「只回填修订对」。
        //    实测 llm_s 与正文长度强相关（2.2s ↔ 12.1s，差 5.5 倍）—— 因为原实现要求模型
        //    每轮把整篇正文逐字重打一遍，而输出 token 的 ~90% 就是这段正文。
        //    现在只列改动点，由 copywriting.js#applyEdits 套用到原文上：
        //      ① 输出量骤降 → 生成耗时随之骤降；② 正文＝原文字面＋明确修订，不会因重写而漏字。
        edits: normalizeEdits(parsed.edits),
        // 兼容旧格式：模型若仍直接给了完整正文（或走了 plainFallback），buildContent 会回退到旧路径。
        transcript: String(parsed.transcript || '').trim(),
        title: String(parsed.title || '').trim(),
        hook: String(parsed.hook || '').trim(),
        highlights: Array.isArray(parsed.highlights)
          ? parsed.highlights.map((h) => String(h).trim()).filter(Boolean)
          : [],
        points,
        mock: false,
      };
    } catch (e) {
      lastErr = e;
      console.warn('[providers] LLM 第 ' + (attempt + 1) + ' 次失败：', e && e.message);
    }
  }
  throw lastErr || new Error('大模型整理失败');
}

/** 纯转写降级（PRD R-10：LLM/ASR 全失败时保证用户拿到文字） */
function plainFallback(transcriptText) {
  return {
    title: '视频口播原文',
    hook: '',
    highlights: [],
    points: [],
    transcript: transcriptText || '',
  };
}

/* ------------------------------------------------------------------ *
 * 配置自检
 * ------------------------------------------------------------------ */

/** 供控制台排查：当前各项能力是否已配置 */
function providerStatus() {
  const hasLlm = !!(env('DEEPSEEK_API_KEY', '') || env('LLM_API_KEY', ''));
  const hasAsr = !!(env('ASR_API_URL', '') && env('ASR_API_KEY', ''));
  const hasParse = !!env('PARSE_API_URL', '');
  return {
    mode: useMock() ? '演示模式（返回示例文案）' : '真实模式（走真实解析/转写/整理）',
    parse: hasParse ? '已配置：' + env('PARSE_API_URL', '') : '未配置 → 链接解析只能用内置兜底（视频号必定失败）',
    asr: hasAsr
      ? '已配置：' + env('ASR_API_URL', '') + ' · ' + env('ASR_MODEL', 'whisper-1')
      : '未配置 → 无字幕的视频无法转写',
    llm: hasLlm
      ? '已配置：' + env('LLM_MODEL', 'deepseek-chat') + ' @ ' + env('LLM_API_URL', 'https://api.deepseek.com/v1/chat/completions')
      : '未配置 → 结构化整理会失败并降级为纯原文',
    correct: String(env('ASR_CORRECT', 'false')).toLowerCase() === 'true' ? '开启（有字幕也跑 ASR 校正）' : '关闭（有字幕直接采用）',
  };
}

/* ------------------------------------------------------------------ *
 * ③ 时长探测（扣费前估价）—— 只读 MP4 头/尾 1MB 解 mvhd
 * ------------------------------------------------------------------ */

const PROBE_BYTES = 1024 * 1024;
const PROBE_MAX = PROBE_BYTES + 64 * 1024; // 服务端忽略 Range 时，收满这点就主动断开

/** 单次带 Range 的 GET：最多跟 3 跳重定向，收满 ~1MB 立刻断开（绝不把整片拖下来） */
function rangedProbe(url, range, timeoutMs, hops) {
  const depth = hops || 0;
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ ok: false, reason: 'bad_url' });
    }
    const lib = u.protocol === 'http:' ? http : https;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const req = lib.get(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: { 'User-Agent': UA, Accept: '*/*', Range: range },
        agent: agentFor(u),
        timeout: timeoutMs,
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].indexOf(code) >= 0 && res.headers.location && depth < 3) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch (e) {
            return finish({ ok: false, reason: 'bad_redirect' });
          }
          return rangedProbe(next, range, timeoutMs, depth + 1).then(finish);
        }
        if (code !== 200 && code !== 206) {
          res.resume();
          return finish({ ok: false, reason: 'HTTP ' + code });
        }
        const cr = String(res.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        const start = cr ? Number(cr[1]) : 0;
        const total = cr ? Number(cr[3]) : Number(res.headers['content-length'] || 0) || 0;
        const parts = [];
        let got = 0;
        const snap = () => ({ ok: true, code, buf: Buffer.concat(parts), start, total });
        res.on('data', (c) => {
          if (done) return;
          parts.push(c);
          got += c.length;
          if (got >= PROBE_MAX) {
            res.destroy();
            finish(snap());
          }
        });
        res.on('end', () => finish(snap()));
        res.on('error', () => finish({ ok: false, reason: 'stream_error' }));
      }
    );
    req.on('error', () => finish({ ok: false, reason: 'request_error' }));
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, reason: 'timeout' });
    });
  });
}

/**
 * 探测媒体时长（**扣费前**估价用）。
 *
 * ⚠️ 为什么必须有它：实测确认**解析服务返回体里没有时长字段**（线上 duration_sec 恒 0），
 *    而计费按时长分档（2026-10-16 v5：视频 5/10 两档、文案 起步 2 + 每分钟 2）——不探测就只能按最低档扣，
 *    长内容必亏（30 分钟文案成本 ¥0.45，起步档仅收 ≈¥0.07）。
 * 手法：只读 MP4 **头 1MB** 解 moov/mvhd（实测抖音/小红书/B站/视频号 **4/4 成功**，0.16~0.62s）；
 *      头里没有 moov，再补一次**尾 1MB**（moov 在尾的那种封装）。
 * ⚠️ 只用于估价/计费兜底：拿不到就返回 sec=0，由调用方按最低档处理，**绝不阻断主链路**。
 * @param {string} url 视频直链，或 cloud:// 云文件 ID（本地视频）
 * @returns {Promise<{sec:number, from:'head'|'tail'|'none', bytes:number, ms:number, reason?:string}>}
 */
async function probeDuration(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 8000;
  const t0 = Date.now();
  const src = String(url || '');
  if (!src) return { sec: 0, from: 'none', bytes: 0, ms: 0, reason: 'empty' };

  let target = src;
  if (/^cloud:\/\//.test(src)) {
    // 本地视频：云存储文件没有直链，换一个临时下载地址再探
    try {
      const cloud = require('wx-server-sdk');
      const r = await cloud.getTempFileURL({ fileList: [src] });
      const f = (r.fileList || [])[0] || {};
      target = f.tempFileURL || f.tempFileUrl || '';
    } catch (e) {
      return { sec: 0, from: 'none', bytes: 0, ms: Date.now() - t0, reason: 'temp_url_fail' };
    }
    if (!target) return { sec: 0, from: 'none', bytes: 0, ms: Date.now() - t0, reason: 'temp_url_empty' };
  }

  const mp4 = require('./mp4-duration');
  const head = await rangedProbe(target, 'bytes=0-' + (PROBE_BYTES - 1), timeoutMs, 0);
  if (!head.ok) return { sec: 0, from: 'none', bytes: 0, ms: Date.now() - t0, reason: head.reason };
  const headSec = mp4.fromBuffer(head.buf, head.start);
  if (headSec > 0) return { sec: headSec, from: 'head', bytes: head.buf.length, ms: Date.now() - t0 };

  if (head.total > head.buf.length) {
    const tail = await rangedProbe(target, 'bytes=-' + PROBE_BYTES, timeoutMs, 0);
    if (tail.ok) {
      const tailSec = mp4.fromBuffer(tail.buf, tail.start);
      if (tailSec > 0) {
        return { sec: tailSec, from: 'tail', bytes: head.buf.length + tail.buf.length, ms: Date.now() - t0 };
      }
    }
  }
  return { sec: 0, from: 'none', bytes: head.buf.length, ms: Date.now() - t0, reason: 'no_mvhd' };
}

module.exports = {
  probeDuration,
  env,
  envInt,
  useMock,
  detectPlatform,
  isSupportedPlatform,
  platformLabel,
  PLATFORM_LABEL,
  SUPPORTED_PLATFORM_TEXT,
  resolveVideoSource,
  downloadMedia,
  mediaRelayMinMs,
  putRelay,
  fetchRelay,
  dropRelay,
  relayCover,
  mediaPathFor,
  mediaSize,
  removeMedia,
  fetchSubtitle,
  asrTranscribe,
  llmStructure,
  plainFallback,
  providerStatus,
  // 供单测
  _internal: {
    normalizeParseResult,
    normalizeDuration,
    parseSubtitleText,
    extractJson,
    flatten,
    toText,
    assertParseOk,
    encodeBody,
    probeRange,
    downloadChunk,
    downloadParallel,
    downloadAuto,
    downloadToFile,
  },
};
