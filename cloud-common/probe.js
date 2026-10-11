// _common/probe.js - 链路 A「服务号消息回调」报文探针（PRD 12.3 Spike 用）
// 目的：用一次真机转发，实证「视频号卡片转发给服务号」的实际报文形态（MsgType / 字段集），
//      并顺带验证 MediaId 能否用微信「素材下载接口」（免费）直接取到视频文件。
// 特性：
//   ① 全量落库（主集合 wx_callbacks；集合不存在时自动降级写 config，避免用户漏建集合导致测不了）
//   ② 不改变主链路任何行为 —— 探测结果只写库，不参与判定
//   ③ 全程 try/catch，任何失败只 console.warn
// ⚠️ 实证完成后可整体删除本文件及 receiveCallback 中的调用（留着也不影响线上）。
const https = require('https');
const cloud = require('wx-server-sdk');
const { pick } = require('./xml');
const { env } = require('./providers');
const { db, COLL } = require('./db');
const { getAccessToken } = require('./wxapi');

const PROBE_COLLECTION = env('WX_PROBE_COLLECTION', 'wx_callbacks');
const FALLBACK_PREFIX = 'wxcb_';
const KEEP_MAX = 50; // 主集合最多保留条数（超出删最老）
const MEDIA_TIMEOUT = Number(env('WX_PROBE_MEDIA_TIMEOUT_MS', '3000')) || 3000;

/* ---------------- XML 结构指纹 ---------------- */

/** 报文里出现过的所有标签名（顺序去重）——加密报文只会看到一个 Encrypt */
function tagNames(xml) {
  const out = [];
  const re = /<([A-Za-z_][A-Za-z0-9_]*)(?:\s[^>]*)?>/g;
  let m;
  while ((m = re.exec(xml || ''))) {
    if (out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

/**
 * 每个标签的值长度（不存值，用来判断「有没有内容」）
 * ⚠️ 值必须用「CDATA 优先 / 否则不含 <」两分支匹配 —— 不能用 [\s\S]*?，
 *    否则根标签 <xml>…</xml> 会贪婪吞掉内部所有标签，后面一个都匹配不到（实测会全空）。
 */
function fieldLengths(xml) {
  const out = {};
  const re = /<([A-Za-z_][A-Za-z0-9_]*)(?:\s[^>]*)?>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(xml || ''))) {
    out[m[1]] = (m[2] !== undefined ? m[2] : m[3] || '').length;
  }
  return out;
}

/* ---------------- 落库（含降级） ---------------- */

async function trimMain() {
  try {
    const c = await db().collection(PROBE_COLLECTION).count();
    if (c.total <= KEEP_MAX) return;
    const old = await db()
      .collection(PROBE_COLLECTION)
      .orderBy('created_at', 'asc')
      .limit(Math.min(c.total - KEEP_MAX, 100))
      .get();
    for (const d of old.data || []) {
      await db().collection(PROBE_COLLECTION).doc(d._id).remove().catch(() => {});
    }
  } catch (e) {
    /* ignore */
  }
}

async function safeInsert(doc) {
  try {
    const r = await db().collection(PROBE_COLLECTION).add({ data: doc });
    trimMain();
    return { id: r._id, where: PROBE_COLLECTION };
  } catch (e) {
    // 集合不存在（用户未手动创建）→ 降级写 config 集合，保证照样测得到
    try {
      const id = FALLBACK_PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      await COLL.config().doc(id).set({ data: Object.assign({ _probe: true }, doc) });
      return { id, where: 'config' };
    } catch (e2) {
      console.warn('[probe] 落库失败（主+降级都失败）', e && e.message, e2 && e2.message);
      return null;
    }
  }
}

async function safeAttach(handle, patch) {
  if (!handle || !handle.id) return;
  try {
    if (handle.where === PROBE_COLLECTION) {
      await db().collection(PROBE_COLLECTION).doc(handle.id).update({ data: patch });
    } else {
      await COLL.config().doc(handle.id).update({ data: patch });
    }
  } catch (e) {
    console.warn('[probe] 更新失败', e && e.message);
  }
}

/* ---------------- 对外：记录一次回调 ---------------- */

/**
 * 记录一次服务号回调报文。同步、快速（不含网络请求），返回句柄供后续 attach。
 * @returns {Promise<{handle:object|null, hasMediaId:boolean, msgType:string, encrypted:boolean}|null>}
 */
async function record(source, query, rawBody, meta) {
  try {
    const xml = String(rawBody || '');
    const encrypted = /<Encrypt>/i.test(xml);
    const mediaId = pick(xml, 'MediaId');
    const doc = {
      source: source || 'http',
      created_at: new Date(),
      body_bytes: Buffer.byteLength(xml, 'utf8'),
      encrypted,
      // ⚠️ encrypted=true 就说明服务号配的是「安全模式」→ 本探针拿不到明文，需改回明文模式
      tag_names: tagNames(xml),
      field_lengths: fieldLengths(xml),
      msg_type: pick(xml, 'MsgType'),
      event: pick(xml, 'Event'),
      msg_id: pick(xml, 'MsgId'),
      has_media_id: !!mediaId,
      media_id_prefix: String(mediaId).slice(0, 12),
      thumb_media_id_prefix: String(pick(xml, 'ThumbMediaId')).slice(0, 12),
      title: pick(xml, 'Title'),
      url: pick(xml, 'Url').slice(0, 600),
      pic_url: pick(xml, 'PicUrl').slice(0, 300),
      query_keys: Object.keys(query || {}),
      // ⭐ 2026-09-28：记录「报文从哪个字段取到」——排查 body 取不到的问题（曾因只读 event.body 而空报文）
      body_from: (meta && meta.body_from) || '',
      body_len: (meta && meta.body_len) || xml.length,
      is_base64: !!(meta && meta.is_base64),
      event_keys: (meta && meta.event_keys) || '',
      raw_xml: xml.slice(0, 8000),
    };
    const handle = await safeInsert(doc);
    console.log(
      '[probe] 报文已落库 type=' + doc.msg_type + ' mediaId=' + doc.has_media_id +
      ' encrypted=' + encrypted + ' body_from=' + doc.body_from
    );
    return { handle, hasMediaId: !!mediaId, msgType: doc.msg_type, encrypted, mediaId };
  } catch (e) {
    console.warn('[probe] record 异常', e && e.message);
    return null;
  }
}

/* ---------------- 对外：素材下载能力探测 ---------------- */

/**
 * 用 MediaId 试调微信「素材下载接口」，只读响应头 + 前几字节判魔数，不落整文件。
 * 结论三态：真视频（ftyp）/ 报错 JSON / 无响应。
 */
function probeMediaDownload(mediaId) {
  return new Promise((resolve) => {
    getAccessToken()
      .then((token) => {
        const url =
          'https://api.weixin.qq.com/cgi-bin/media/get?access_token=' +
          encodeURIComponent(token) +
          '&media_id=' +
          encodeURIComponent(mediaId);
        const u = new URL(url);
        const req = https.request(
          { method: 'GET', hostname: u.hostname, path: u.pathname + u.search },
          (res) => {
            const ctype = String(res.headers['content-type'] || '');
            const isJson = ctype.indexOf('json') >= 0;
            const out = {
              http_status: res.statusCode,
              content_type: ctype,
              content_length: Number(res.headers['content-length'] || 0),
              disposition: String(res.headers['content-disposition'] || '').slice(0, 200),
            };
            let head = Buffer.alloc(0);
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              out.head_hex = head.slice(0, 16).toString('hex');
              out.magic = head.slice(4, 8).toString('ascii');
              out.is_mp4 = out.magic === 'ftyp';
              if (isJson) {
                try {
                  out.json = JSON.parse(head.toString('utf8'));
                } catch (e) {
                  out.json_raw = head.toString('utf8').slice(0, 300);
                }
              }
              out.verdict = out.is_mp4 ? 'real_media' : isJson ? 'api_error' : 'unknown';
              resolve(out);
            };
            res.on('data', (d) => {
              if (head.length < 4096) head = Buffer.concat([head, d]).slice(0, 4096);
              // 非 JSON = 真的在推流，拿够 32 字节就断，别把整个视频收下来
              if (!isJson && head.length >= 32) {
                try {
                  res.destroy();
                } catch (e) {
                  /* ignore */
                }
              }
            });
            res.on('end', finish);
            res.on('close', finish);
          }
        );
        req.on('error', (e) => resolve({ error: String((e && e.message) || e) }));
        req.setTimeout(MEDIA_TIMEOUT, () => {
          try {
            req.destroy();
          } catch (e) {
            /* ignore */
          }
          resolve({ error: 'timeout_' + MEDIA_TIMEOUT + 'ms' });
        });
        req.end();
      })
      .catch((e) => resolve({ error: 'token: ' + (e && e.message) }));
  });
}

/**
 * 完整探测：拿到 MediaId 就试下载 + 把结论 attach 回那条报文记录。
 */
async function probeMedia(handle, mediaId) {
  if (!handle || !mediaId) return null;
  try {
    const r = await probeMediaDownload(mediaId);
    await safeAttach(handle, { media_probe: r });
    console.log('[probe] 素材下载探测 verdict=' + (r && r.verdict ? r.verdict : r && r.error));
    return r;
  } catch (e) {
    console.warn('[probe] probeMedia 异常', e && e.message);
    return null;
  }
}

/* ---------------- 对外：读回最近 N 条（方便在控制台直接取结果） ---------------- */

function slim(d) {
  return {
    at: d.created_at,
    source: d.source,
    msg_type: d.msg_type,
    event: d.event,
    encrypted: d.encrypted,
    tag_names: d.tag_names,
    field_lengths: d.field_lengths,
    has_media_id: d.has_media_id,
    media_id_prefix: d.media_id_prefix,
    thumb_media_id_prefix: d.thumb_media_id_prefix,
    title: d.title,
    url: d.url,
    pic_url: d.pic_url,
    media_probe: d.media_probe || null,
    raw_xml: d.raw_xml,
  };
}

/** 读回最近 n 条报文记录（默认 3，上限 20） */
async function listRecent(n) {
  const lim = Math.min(Math.max(Number(n) || 3, 1), 20);
  try {
    const r = await db()
      .collection(PROBE_COLLECTION)
      .orderBy('created_at', 'desc')
      .limit(lim)
      .get();
    return { where: PROBE_COLLECTION, count: (r.data || []).length, items: (r.data || []).map(slim) };
  } catch (e) {
    try {
      const r2 = await COLL.config().where({ _probe: true }).orderBy('created_at', 'desc').limit(lim).get();
      return { where: 'config(降级)', count: (r2.data || []).length, items: (r2.data || []).map(slim) };
    } catch (e2) {
      return { where: 'none', count: 0, items: [], error: String((e && e.message) + ' | ' + (e2 && e2.message)) };
    }
  }
}

/* ---------------- 对外：环境体检 ---------------- */

/** 自检：不依赖真机转发，直接看「管道通不通」 */
async function selfTest() {
  const out = { env: {}, collections: {}, token: null, hint: [] };
  const checks = [
    ['GZH_APPID', 'your-gzh-appid'],
    ['GZH_SECRET', 'your-gzh-secret'],
    ['GZH_CALLBACK_TOKEN', 'your-wechat-callback-token'],
    ['PARSE_API_URL', ''],
  ];
  checks.forEach(([k, bad]) => {
    const v = String(env(k, '') || '');
    out.env[k] = !v ? 'MISSING' : v === bad || v.indexOf('your-') === 0 ? 'PLACEHOLDER' : 'OK';
  });

  try {
    await db().collection(PROBE_COLLECTION).limit(1).get();
    out.collections[PROBE_COLLECTION] = 'OK';
  } catch (e) {
    out.collections[PROBE_COLLECTION] = 'NOT_EXISTS(降级写 config)';
  }
  try {
    await COLL.config().limit(1).get();
    out.collections.config = 'OK';
  } catch (e) {
    out.collections.config = 'FAIL';
  }

  try {
    const t = await getAccessToken();
    out.token = { ok: true, prefix: String(t).slice(0, 8) + '...', length: String(t).length };
  } catch (e) {
    out.token = { ok: false, error: e && e.message };
  }

  if (out.env.GZH_APPID !== 'OK' || out.env.GZH_SECRET !== 'OK') {
    out.hint.push('GZH_APPID / GZH_SECRET 未正确配置 → getAccessToken 会失败 → 客服消息与素材下载都不可用');
  }
  if (out.env.GZH_CALLBACK_TOKEN !== 'OK') {
    out.hint.push('GZH_CALLBACK_TOKEN 未配置 → 服务号服务器配置的 Token 校验会 403');
  }
  if (!out.token.ok) {
    out.hint.push('access_token 获取失败 → 检查 AppID/Secret 是否为「已认证服务号」的凭据、IP 白名单');
  }
  if (out.hint.length === 0) out.hint.push('管道检查通过，可以真机转发实测了');
  return out;
}

/* ---------------- 对外：云调用能力探测（免 access_token / 免 IP 白名单） ---------------- */

/**
 * ⭐ 关键实证：公众号「云调用」在「非小程序端触发」的云函数里到底能不能用？
 *
 * 依据：官方《发送客服消息》文档标了「云调用：customerServiceMessage.send」，
 *       《公众号云调用》文档列出 officialAccount.media.get（素材下载）。
 *       云调用无需 access_token、无需 IP 白名单（微信自动鉴权）。
 * ⚠️ 唯一不确定点：云调用文档说「从小程序端触发的云函数自动鉴权」，
 *    而 receiveCallback 是「微信服务器推送 / HTTP 访问服务」触发 → 本函数就是来验这一条的。
 *
 * 探测两项能力（都不做真实副作用）：
 *   ① 素材下载 media.get        —— 链路 A 免视频号解析费的关键（有 mediaId 才有意义）
 *   ② 客服消息发送 .send        —— 结果推回聊天窗口的关键；用 msgtype=text + 极短内容试发
 *      ⚠️ 试发会真的给用户发一条消息，故仅在传了 openid 时才做；内容明确标注为测试。
 *
 * @param {object} opts { mediaId, openid, appid }
 * @returns {Promise<object>} 结构化诊断（不抛错）
 */
async function probeCloudCall(opts) {
  const o = opts || {};
  const appid = o.appid || env('GZH_APPID', '');
  const out = {
    appid_prefix: String(appid).slice(0, 8) + '...',
    sdk: 'wx-server-sdk',
    media_get: null,
    kf_send: null,
    verdict: {},
    notes: [],
  };

  if (!appid || appid.indexOf('your-') === 0) {
    out.notes.push('GZH_APPID 未配置 → 无法指定 appid 调云调用');
    return out;
  }

  // ① 素材下载（media.get）
  if (!o.mediaId) {
    out.media_get = { skipped: true, reason: '未传 mediaId（真机转发一次后才有）' };
    out.notes.push('mediaId 缺失：素材下载探测已跳过。可先只验客服消息发送（需传 openid）。');
  } else {
    try {
      const r = await cloud.openapi({ appid }).officialAccount.media.get({ mediaId: o.mediaId });
      // 云调用返回 Buffer（文件流）或对象（出错时的 errcode/errmsg）
      const isBuf = r && (Buffer.isBuffer(r) || Buffer.isBuffer(r.buffer));
      const buf = isBuf ? (Buffer.isBuffer(r) ? r : r.buffer) : null;
      out.media_get = buf
        ? {
            ok: true,
            bytes: buf.length,
            magic: buf.slice(4, 8).toString('ascii'),
            is_mp4: buf.slice(4, 8).toString('ascii') === 'ftyp',
          }
        : { ok: false, raw: JSON.stringify(r).slice(0, 300) };
    } catch (e) {
      out.media_get = { ok: false, error: describeCallError(e) };
    }
  }

  // ② 客服消息发送（customerServiceMessage.send）
  if (!o.openid) {
    out.kf_send = { skipped: true, reason: '未传 openid（需一个与服务号交互过的用户 openid）' };
    out.notes.push('openid 缺失：客服消息发送探测已跳过。可在控制台传 openid 复跑。');
  } else {
    try {
      const r = await cloud.openapi({ appid }).customerServiceMessage.send({
        touser: o.openid,
        msgtype: 'text',
        text: { content: '【云调用测试】这条消息由云调用发送，测试成功后会自动删除该通道 ✓' },
      });
      out.kf_send = { ok: true, errcode: r && r.errcode, errmsg: r && r.errmsg };
    } catch (e) {
      out.kf_send = { ok: false, error: describeCallError(e) };
    }
  }

  // 汇总裁决（给用户一句话结论）
  out.verdict.media_get = out.media_get && out.media_get.skipped
    ? 'SKIPPED'
    : out.media_get && out.media_get.ok
    ? 'AVAILABLE'
    : 'UNAVAILABLE';
  out.verdict.kf_send = out.kf_send && out.kf_send.skipped
    ? 'SKIPPED'
    : out.kf_send && out.kf_send.ok
    ? 'AVAILABLE'
    : 'UNAVAILABLE';

  if (out.verdict.kf_send === 'AVAILABLE') {
    out.notes.push('✅ 客服消息云调用可用 → 结果推回聊天窗口不需要 access_token，也不需要 IP 白名单');
  } else if (out.verdict.kf_send === 'UNAVAILABLE') {
    out.notes.push('❌ 客服消息云调用不可用 → 需回退 access_token 方案（需固定出口 IP 或白名单）');
  }
  if (out.verdict.media_get === 'AVAILABLE') {
    out.notes.push('✅ 素材下载云调用可用 → 视频号解析费（0.02 元/次）可省');
  }
  out.notes.push('⚠️ 若报 -604101「无权限」→ 云调用权限配置有 10 分钟缓存，稍等后重试');
  return out;
}

/** 把云调用的报错整理成人能看懂的一段（云函数 catch 到的 e 形态不统一） */
function describeCallError(e) {
  if (!e) return 'unknown';
  const parts = [];
  if (e.errCode !== undefined) parts.push('errCode=' + e.errCode);
  if (e.errMsg) parts.push('errMsg=' + String(e.errMsg).slice(0, 300));
  if (e.errcode !== undefined) parts.push('errcode=' + e.errcode);
  if (e.errmsg) parts.push('errmsg=' + String(e.errmsg).slice(0, 300));
  if (parts.length === 0) parts.push((e.message || String(e)).slice(0, 300));
  return parts.join(' | ');
}

module.exports = { record, probeMedia, probeMediaDownload, selfTest, listRecent, probeCloudCall, PROBE_COLLECTION };
