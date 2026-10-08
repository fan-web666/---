// 云函数 receiveCallback - 认证服务号「消息回调」入口（链路 A：接收视频号转发 → 入队解析）
//
// ⭐⭐ 2026-09-28 重构：改为「单文件自包含」，模块加载阶段只依赖 wx-server-sdk 一个包。
//    原因：本函数原先在文件顶部 require('./_common/*')（14 个文件），一旦云端依赖安装未生效，
//    就会在**加载阶段**直接抛错 → 微信后台表现为「HTTP 返回非 200」，而这类错误**无法从外部区分**。
//    现在：顶部只 require wx-server-sdk（云端一定装好），业务依赖全部**惰性加载**并兜底，
//    任何失败都返回**可读 JSON**，绝不 500。且新增 `{"selftest": true}` 可自证依赖健康度。
//
// 部署方式：
//   1) 本函数通过「云函数 HTTP 访问服务」暴露公网 URL。
//      ⚠️ 不要在控制台找「HTTP 访问服务」入口 —— 微信云开发控制台 v2 没有这个标签。
//      正解：`config.json` 里声明 triggers（见同目录 config.json），上传时自动建路径。
//   2) 微信开发者平台 → 基础信息 → 域名与消息推送配置 → 消息推送：
//        URL            = https://<云开发默认域名>/receiveCallback
//        Token          = 与云函数环境变量 GZH_CALLBACK_TOKEN 一致
//        EncodingAESKey = 明文模式可不填
//        消息加解密模式 = 明文
//   3) 环境变量（云开发控制台 → 云函数 → receiveCallback → 配置 → 环境变量）：
//        GZH_APPID / GZH_SECRET / GZH_CALLBACK_TOKEN
//   4) ⚠️ 环境变量改完**必须重新部署**云函数，才会读到新值。
//
// ⚠️ PRD 12.3 Spike：视频号卡片转发给服务号后回调的 MsgType 实际形态
//    （video / link / 其他）需真机转发一次确认，本文件按 video/link 双分支兜底。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const CALLBACK_TOKEN = process.env.GZH_CALLBACK_TOKEN || '';
const SERVICE_NAME = '极速视频文案提取';
const SUPPORTED_TEXT = '抖音 / 快手 / 小红书 / 视频号 / B 站';

// ============================================================
// 一、零依赖基础工具（不 require 任何本地文件，保证这段一定能跑）
// ============================================================

/** 微信服务器配置校验签名：sha1(sort([token, timestamp, nonce]).join('')) */
function verifyWechatSignature(token, signature, timestamp, nonce) {
  if (!token || !signature || !timestamp || !nonce) return false;
  const crypto = require('crypto');
  const arr = [String(token), String(timestamp), String(nonce)].sort();
  const hash = crypto.createHash('sha1').update(arr.join('')).digest('hex');
  return hash === String(signature);
}

/**
 * 极简 XML 解析：返回一级标签 → 文本（微信报文都是简单结构，正则足够）
 *
 * ⚠️⚠️ 2026-09-28 修复（这是「用户端收不到回复」的真正元凶）：
 *    原正则 `(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?` 里，`]]>` 那段是**可选**的，
 *    正则引擎**优先跳过可选组** → `[\s\S]*?` 非贪婪只匹配到空串 → **所有 CDATA 字段全解析成空**，
 *    函数返回 `{}` → `msg.MsgType` 为 undefined → 落到兜底分支 → 回复的 ToUserName 为空
 *    → 微信无法判断回给谁 → **静默丢弃**（日志显示 200 成功，用户端零反应）。
 *
 *    正解：把「CDATA 取值」与「普通取值」写成**两个互斥的必经分支** `(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))`，
 *    二者至少命中一个，不存在「都跳过」的可能。
 *    ⚠️ 与 `_common/probe.js#fieldLengths` 保持同一套写法（那边一直是对的）。
 */
function parseMessage(xml) {
  const out = {};
  const src = String(xml || '');
  // ⭐⭐⭐ 容错版正则（2026-09-28 加固）
  //   ① 字段名允许字母/数字/下划线/连字符（微信偶尔有 `MsgId` / `MsgID` 混用）
  //   ② CDATA 与普通取值写成**两个互斥必经分支**（旧版 `(?:...)?` 可跳过 → 全解析成空）
  //   ③ 不做 trim 以外的加工，原样保留
  const re = /<([A-Za-z_][A-Za-z0-9_-]*)(?:\s[^>]*)?>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/gi;
  let m;
  while ((m = re.exec(src))) {
    const key = m[1];
    if (key.toLowerCase() === 'xml') continue;
    const val = (m[2] !== undefined ? m[2] : m[3]) || '';
    // 同名键保留第一个非空值（微信报文里 ToUserName 只会出现一次，但防重复标签）
    if (out[key] === undefined || (!out[key] && val)) out[key] = val.trim();
  }

  // ⭐ 兜底：若正则一无所获，尝试「报文被整体转义/多包一层」的形态
  if (!out.ToUserName && !out.FromUserName) {
    const unescaped = src
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    if (unescaped !== src) return parseMessage(unescaped);
  }
  return out;
}

/**
 * 被动回复文本（微信要求 5 秒内返回，纯文本 XML）
 * ⚠️⚠️ 参数方向不要弄反（微信报文与被动回复的 To/From 语义相反）：
 *   @param {string} toUser   **收件人 = 用户 openid**
 *   @param {string} fromUser **发件人 = 公众号 gh_号**
 */
function replyTextXml(toUser, fromUser, content) {
  return (
    '<xml>' +
    '<ToUserName><![CDATA[' + toUser + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + fromUser + ']]></FromUserName>' +
    '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[' + content + ']]></Content>' +
    '</xml>'
  );
}

// ============================================================
// ⭐⭐⭐ 被动回复「守门员」（2026-09-28 事故修复）
//
// 【事故现象】用户端零反应、零提示，日志却全部正常。
// 【根因 1】回复的 To/From **写反**（见 handleMessage 顶部长注释）→ 微信无法投递、静默丢弃。
// 【根因 2】当报文解析失败时，函数仍返回一条
//          `<ToUserName><![CDATA[]]></ToUserName>` 的 XML → 同样无法投递 → 静默丢弃。
//
// 【修复】统一出口把关：
//        - **拿不到「用户 openid」（回复的收件人）** → 返回 'success'（微信约定：不回复，但不报错）
//        - 拿得到 → 正常返回 XML
//        ⚠️ 绝不再让「空 ToUserName 的 XML」流出去。
// ⚠️ 注意：这里传进来的 `toUser` 是**回复方向**的收件人（= 用户 openid），
//    不是报文里的 ToUserName（那是公众号 gh）。
// ============================================================

/**
 * 安全包装被动回复：收件人（用户 openid）为空时降级返回 'success'
 * @param {string} xml 已经拼好的回复 XML
 * @param {string} toUser 回复的收件人 = **用户 openid**（⚠️ 不是报文里的 ToUserName）
 * @returns {string} 合法的被动回复内容
 */
function safeReply(xml, toUser) {
  if (!toUser) {
    console.warn('[receiveCallback] ⚠️ 收件人(用户 openid)为空，降级返回 success（避免微信静默丢弃）');
    return 'success';
  }
  return xml || 'success';
}

/** 统一的 JSON 返回 */
function json(statusCode, obj) {
  return { statusCode: statusCode, body: JSON.stringify(obj) };
}

// ============================================================
// ⭐⭐⭐ 被动回复的返回形态（2026-09-28 排查全过程，务必读完再改）
//
// 【症状】服务端日志一切正常（200 调用成功、回复字符串内容正确），
//        但用户手机端微信里**零反应**，连一条错误提示都没有。
//
// 【排查证据 · curl 线上实测】
//   curl -i -X POST <URL> -H 'Content-Type: text/xml' --data-binary '<xml>...'
//   → HTTP/1.1 200 OK
//     content-type: text/plain; charset=utf-8      ← 微信要求 text/xml
//     content-disposition: attachment              ← ⚠️⚠️ 致命：网关当「文件下载」处理
//     <xml><ToUserName>...                          ← 体本身是对的
//
// 结论：**body 正确、状态码正确，但响应头让微信认不出这是被动回复** → 静默丢弃。
//
// 【两种返回形态实测对比】
//   ① `return '<xml>...</xml>'`（裸字符串）→ 网关自动给 text/plain + attachment
//   ② `return { statusCode, headers, body }`（对象）
//      → 腾讯云 HTTP 访问服务**支持自定义响应头**，会把 statusCode/headers/body
//        拆解成真正的 HTTP 响应，body 不会二次 JSON 序列化。
//        （官方示例：docs.cloudbase.net/cbrf/example）
//
// 【最终方案】默认走 ②，显式声明 `Content-Type: text/xml`。
//   备份通路：`?__raw=1` → 裸字符串（形态 ①，用于对照排查）。
// ============================================================

/**
 * 把 XML 提供给网关。
 * - 默认：`{statusCode, headers:{'Content-Type':'text/xml'}, body}`（微信认这个）
 * - `?__raw=1`：裸字符串（网关自动加 text/plain，仅排查用）
 */
function xmlResponse(xml, query) {
  const q = query || {};
  // ⭐ 排查通路：裸字符串形态（网关会给 text/plain + attachment）
  if (String(q.__raw) === '1') return xml;
  // ✅ 正常通路：显式 text/xml，让微信能识别为被动回复
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: xml,
  };
}

/**
 * ⭐⭐ 从 HTTP 事件里取出原始 body（报文 XML）。
 *
 * ⚠️ 2026-09-28 实测：腾讯云 CloudBase「HTTP 访问服务」的 POST 事件里，
 *    **报文不一定在 event.body**，且可能是 base64 编码。之前只读 `event.body`
 *    → 结果拿到空串 → 解析出空 msg_type → 业务静默失效。
 *    这里把已知的几种形态全部兜住，并把「命中哪个字段」记录下来，便于排查。
 *
 * @returns {{ text: string, from: string }}
 */
function extractBody(event) {
  const candidates = ['body', 'bodyXml', 'data', 'rawBody', 'content'];
  for (let i = 0; i < candidates.length; i++) {
    const k = candidates[i];
    let v = event[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object') {
      // 有些形态会把 body 放在 { body: { ... } } 里
      try {
        v = JSON.stringify(v);
      } catch (e) {
        continue;
      }
    }
    v = String(v);
    // base64 解码：显式标记 or 内容看起来像 base64（且不像 XML）
    const looksXml = v.indexOf('<?xml') >= 0 || v.indexOf('<xml') >= 0;
    const looksB64 = /^[A-Za-z0-9+/=\s]{20,}$/.test(v) && v.indexOf('<') < 0;
    if (event.isBase64Encoded === true || (!looksXml && looksB64)) {
      try {
        const dec = Buffer.from(v, 'base64').toString('utf8');
        if (dec.indexOf('<xml') >= 0 || dec.indexOf('<?xml') >= 0) {
          return { text: dec, from: k + '(base64)' };
        }
      } catch (e) {
        // 解不出来就按原文用
        if (!looksXml && looksB64) continue;
      }
    }
    if (v.trim()) return { text: v, from: k };
  }
  return { text: '', from: '(未找到)' };
}

/** 从报文里抽链接（不依赖 providers，兜底可用） */
function extractLink(msg) {
  const keys = ['Url', 'url', 'Link', 'link', 'shareUrl'];
  for (let i = 0; i < keys.length; i++) {
    if (msg[keys[i]]) return msg[keys[i]];
  }
  const m = String(msg.Content || '').match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : '';
}

// ============================================================
// 二、惰性加载业务依赖（失败不致命，返回可读错误）
// ============================================================

const D = { __loaded: false };
function lazy(name, loader) {
  try {
    D[name] = loader();
  } catch (e) {
    D[name] = null;
    D[name + '__err'] = (e && (e.message || String(e))) || '未知错误';
  }
  return D[name];
}

function loadDeps() {
  if (D.__loaded) return D;
  D.__loaded = true;
  lazy('probe', () => require('./_common/probe'));
  lazy('db', () => require('./_common/db'));
  lazy('user', () => require('./_common/user'));
  lazy('pipeline', () => require('./_common/pipeline'));
  lazy('track', () => require('./_common/track'));
  lazy('providers', () => require('./_common/providers'));
  lazy('consts', () => require('./_common/consts'));
  lazy('credit', () => require('./_common/credit'));
  lazy('wxapi', () => require('./_common/wxapi'));
  return D;
}

/** 收集 _common 各模块加载情况（排查「HTTP 返回非 200」的第一现场） */
function depReport() {
  const d = loadDeps();
  const out = {};
  Object.keys(d).forEach((k) => {
    if (k === '__loaded' || k.indexOf('__err') > 0) return;
    out[k] = d[k] ? 'OK' : 'FAIL: ' + (d[k + '__err'] || '未知');
  });
  return out;
}

// ============================================================
// 三、自检入口（无任何业务依赖，哪怕 _common 全崩也能返回）
// ============================================================

async function selfTest() {
  const deps = depReport();
  const broken = Object.keys(deps).filter((k) => deps[k] !== 'OK');
  const out = {
    ok: broken.length === 0,
    fn: 'receiveCallback',
    version: '2026-09-28-selfcontained',
    runtime: process.version,
    env_id: process.env.TCB_ENV || process.env.SCF_NAMESPACE || '(未知)',
    config: {
      GZH_APPID: process.env.GZH_APPID
        ? String(process.env.GZH_APPID).slice(0, 8) + '...'
        : '❌ 未配置',
      GZH_SECRET: process.env.GZH_SECRET ? '✅ 已配置' : '❌ 未配置',
      GZH_CALLBACK_TOKEN: CALLBACK_TOKEN ? '✅ 已配置' : '❌ 未配置',
    },
    deps: deps,
    notes: [],
  };

  if (broken.length) {
    out.notes.push(
      '❌ 以下 _common 模块加载失败：' + broken.join(', ') +
      ' → 多为云端未安装依赖或文件残缺。请在开发者工具里对 receiveCallback 执行' +
      '「上传并部署：云端安装依赖」后重试。'
    );
  } else {
    out.notes.push('✅ 全部 _common 模块加载正常。');
  }
  if (!CALLBACK_TOKEN) {
    out.notes.push('⚠️ GZH_CALLBACK_TOKEN 未配置 → 签名校验必然失败 → 微信后台填 URL 会报「HTTP 返回非 200」');
  }
  if (!process.env.GZH_APPID || !process.env.GZH_SECRET) {
    out.notes.push('⚠️ GZH_APPID / GZH_SECRET 未配置 → access_token 与云调用都不可用');
  }
  out.notes.push('📌 环境变量改动后必须重新部署云函数才会生效。');
  return out;
}

// ============================================================
// 四、业务处理
// ============================================================

/** 按 MsgId 找已建任务。
 * ⚠️ 微信服务器 5 秒收不到被动回复会重试（最多 3 次），真实链路单步就可能十几秒必然超时，
 *    靠 MsgId 去重保证「重试只是继续推进同一个任务」，不会重复建卡、重复扣费。 */
async function findTaskByMsgId(msgId) {
  if (!msgId) return null;
  const d = loadDeps();
  if (!d.db) return null;
  try {
    const r = await d.db.COLL.tasks().where({ msg_id: msgId }).limit(1).get();
    return r.data && r.data.length ? r.data[0] : null;
  } catch (e) {
    return null;
  }
}

/** 建 A 链路任务（video 媒体 或 链接类消息） */
async function createATask(gzhOpenid, msg) {
  const d = loadDeps();
  const user = await d.user.ensureUser({ source: 'gzh', openid: gzhOpenid, unionid: '' });
  const active = await d.credit.countActiveTasks(user._id);
  if (active >= d.consts.MAX_USER_CONCURRENT) return { limited: true };
  const addRes = await d.db.COLL.tasks().add({
    data: {
      uid: user._id,
      userOpenid: gzhOpenid, // A 链路：回推卡片用
      channel: 'A',
      msg_id: msg.MsgId || '',
      share_url: msg.Url || '',
      video_url: msg.Url || '',
      // ⚠️ 备用通道：若报文真带 MediaId，将来可用微信「素材下载接口」免费取视频，
      //    省掉视频号解析费（0.02 元/次）。当前仅落库不消费，等探针实证后再决定启用。
      gzh_media_id: msg.MediaId || '',
      source_platform: 'video_channel',
      author: '',
      status: 'pending',
      attempt_log: [],
      created_at: new Date(),
      updated_at: new Date(),
    },
  });
  return { taskId: addRes._id, limited: false };
}

/** GET：微信服务器配置校验（echostr 原样返回） */
async function handleVerify(query) {
  const sig = (query && query.signature) || '';
  const ts = (query && query.timestamp) || '';
  const nonce = (query && query.nonce) || '';
  const echostr = (query && query.echostr) || '';
  const ok = verifyWechatSignature(CALLBACK_TOKEN, sig, ts, nonce);
  const d = loadDeps();
  // 探针：这条记录一旦出现，就证明「URL 可达 ＋ Token 匹配」——
  // 后台消息推送页点一次「提交」就会打进来，不必等真机转发。
  if (d.probe) {
    try {
      await d.probe.record('verify', query, '');
    } catch (e) {}
  }
  console.log(
    '[receiveCallback] verify ok=' + ok + ' token_configured=' + !!CALLBACK_TOKEN +
    ' sig=' + String(sig).slice(0, 10)
  );
  if (!ok) return { statusCode: 403, body: 'invalid signature' };
  return { statusCode: 200, body: echostr };
}

/** POST：接收消息（5s 内返回被动回复；解析结果用客服消息主动推，PRD 6.2） */
async function handleMessage(bodyXml, gzhOpenid, meta) {
  const msg = parseMessage(bodyXml);
  const d = loadDeps();

  // ============================================================
  // ⭐⭐⭐ 2026-09-28 真·根因修复：被动回复的 To/From 语义与「收到的报文」**正好相反**
  //
  //   【收到报文】（微信 → 我们）
  //     ToUserName   = 公众号 gh_号   ← 收件人（公众号自己）
  //     FromUserName = 用户 openid     ← 发件人（用户）
  //
  //   【被动回复】（我们 → 微信）★ 方向必须对调
  //     ToUserName   = **用户 openid**   ← 收件人（发给用户）
  //     FromUserName = **公众号 gh_号**  ← 发件人（公众号在回复）
  //
  //   ⚠️ 写反的后果：微信收到 `<ToUserName>公众号gh</ToUserName>` →
  //      认为「这条回复是发给公众号自己的」→ **无法投递 → 静默丢弃**。
  //      现象＝服务端日志 200 全正常、HTTP 200、XML 合法，**用户端零反应零提示**。
  //      （这解释了 2026-09-28 排查一上午的全部现象，前面怀疑过的云调用/白名单/响应头/配置都不是。）
  // ============================================================
  const gzhId = msg.ToUserName || '';                     // 公众号 gh_号
  const userOpenid = msg.FromUserName || gzhOpenid || ''; // 用户 openid
  // 下面两个是「回复方向」的别名，直接喂给 replyTextXml(第1个=ToUserName, 第2个=FromUserName)
  const toUser = userOpenid; // 回复的接收方 = 用户
  const fromUser = gzhId;    // 回复的发送方 = 公众号

  // 探针：先落报文（同步、快），再进业务
  if (d.probe) {
    try {
      await d.probe.record('http', {}, bodyXml, meta || {});
    } catch (e) {}
  }
  console.log(
    '[receiveCallback] msg type=' + (msg.MsgType || '') + ' event=' + (msg.Event || '') +
    ' user=' + userOpenid + ' gzh=' + gzhId + ' url=' + String(msg.Url || '').slice(0, 80) +
    ' mediaId=' + (msg.MediaId ? 'YES' : 'no')
  );

  // 事件：关注欢迎
  if (msg.MsgType === 'event') {
    if (msg.Event === 'subscribe') {
      return safeReply(replyTextXml(
        toUser,
        fromUser,
        '你好，我是' + SERVICE_NAME + '～\n刷到想收藏的短视频，直接转发给我，帮你提取口播文案 ✅\n（支持：' + SUPPORTED_TEXT + '）'
      ), toUser);
    }
    return 'success';
  }

  // 文本消息
  if (msg.MsgType === 'text') {
    const content = (msg.Content || '').trim();
    if (/^https?:\/\//i.test(content)) {
      return safeReply(replyTextXml(
        toUser,
        fromUser,
        '收到链接～建议打开小程序「' + SERVICE_NAME + '」粘贴链接提取更稳定；或直接把视频号视频转发给我'
      ), toUser);
    }
    return safeReply(replyTextXml(
      toUser,
      fromUser,
      '直接把要提取的短视频转发给我就行～\n支持：① 视频号视频直接转发 ② 其他平台在小程序内粘贴链接\n我会自动转成文案并发给你 ✅'
    ), toUser);
  }

  // video / link / shortvideo：视频号转发（MsgType 实际形态见 PRD 12.3 Spike）
  if (msg.MsgType === 'video' || msg.MsgType === 'link' || msg.MsgType === 'shortvideo') {
    // 基础依赖缺失 → 明确告知，不假装成功
    if (!d.user || !d.pipeline || !d.db) {
      const broken = Object.keys(depReport()).filter((k) => depReport()[k] !== 'OK');
      console.error('[receiveCallback] 业务依赖缺失', broken.join(','));
      return safeReply(replyTextXml(
        toUser,
        fromUser,
        '服务正在配置中，请稍后再试～（部署自检未通过：' + broken.join('、') + '）'
      ), toUser);
    }

    // 幂等：微信超时重试时不重复建任务，只是继续推进同一个
    let task = await findTaskByMsgId(msg.MsgId);
    if (!task) {
      const taskRes = await createATask(userOpenid, msg);
      if (taskRes.limited) {
        return safeReply(replyTextXml(toUser, fromUser, '收到！你正在解析的任务有点多，稍等片刻再发我一条就好～'), toUser);
      }
      task = { _id: taskRes.taskId };
      // ⭐⭐ 2026-09-28 方案 D：**不再从本函数发客服消息**。
      //    原因：本函数由「HTTP 访问服务」触发，云调用自动鉴权不成立，
      //    实测报 `-501001 customerServiceMessage.send:fail invalid wx_openapi access_token`。
      //    （云调用要求云函数由**小程序端**触发才自动鉴权，详见 api 的 pushPending。）
      //    现在只负责：落库 + 建任务。结果由 `api#pushPending` 在用户打开小程序时推回聊天窗口。
    }

    // ⭐⭐ 2026-09-28 修正：微信被动回复**硬性要求 5 秒内返回**（超时用户端会看到
    //    「该公众号暂时无法提供服务」）。原实现给 25 秒预算 → 必然超时；
    //    更糟的是函数返回后被运行时冻结，任务会**卡在中间态**，等第二天才被救活。
    //    现在只给 3 秒：能推几步算几步（通常能完成「取源 + 扣费」），
    //    剩余步骤由 `parsePipeline` 定时器（每 1 分钟扫描「20 秒未更新的中间态」）续跑，
    //    直到终态后由 `api#pushPending` 在用户打开小程序时把结果推回聊天窗口。
    await d.pipeline
      .runUntilDone(task._id, 3000)
      .catch((e) => console.warn('[receiveCallback] 推进任务异常', e && (e.msg || e.message)));

    // 被动回复：5 秒窗口内送达（用户能看到「已收到」），结果另由 push_pending 兜底。
    return safeReply(replyTextXml(toUser, fromUser, '收到视频，正在解析 ⏳ 完成后我会把文案发给你'), toUser);
  }

  // 其他消息类型
  return safeReply(replyTextXml(
    toUser,
    fromUser,
    '暂只支持视频类内容的文案提取（' + SUPPORTED_TEXT + '），其他内容可忽略～'
  ), toUser);
}

// ============================================================
// 五、入口
// ============================================================

exports.main = async (event) => {
  try {
    event = event || {};

    // 自检（排查第一现场，任何情况下都能返回）
    if (event.selftest) return await selfTest();

    // 读回最近 N 条报文（传 {"probeList": 3}）
    if (event.probeList) {
      const d = loadDeps();
      if (!d.probe) return json(200, { ok: false, error: 'probe 模块加载失败', deps: depReport() });
      return await d.probe.listRecent(event.probeList);
    }

    // ⭐ 云调用能力探测（传 {"probeCloudCall": true}，可带 mediaId / openid）
    if (event.probeCloudCall) {
      const d = loadDeps();
      if (!d.probe) return json(200, { ok: false, error: 'probe 模块加载失败', deps: depReport() });
      return await d.probe.probeCloudCall({
        mediaId: event.mediaId || '',
        openid: event.openid || '',
      });
    }

    // HTTP 访问服务触发（event.httpMethod）
    if (event.httpMethod) {
      const method = String(event.httpMethod).toUpperCase();
      const query = event.queryStringParameters || {};

      // ⭐ 诊断入口：GET 带 ?__selftest=1 → 环境体检（环境变量/集合/Token），免控制台
      if (query.__selftest) return json(200, await selfTest());

      // ⭐ 诊断入口：GET 带 ?__probe=10 → 直接读回探针表最近 N 条
      //    目的：让排查者**不必登录控制台**就能看「微信有没有真的推过来」。
      //    ⚠️ 只读、无副作用；查询参数无签名，故仅返回报文摘要（不返回完整原始报文）。
      if (query.__probe) {
        const d = loadDeps();
        if (!d.probe) return json(200, { ok: false, error: 'probe 模块加载失败', deps: depReport() });
        const list = await d.probe.listRecent(query.__probe);
        return json(200, list);
      }

      // ⭐ 诊断入口：GET 带 ?__diag=1 → 回显本次 HTTP 事件的字段结构（排查报文取不到的问题）
      if (query.__diag) {
        const keys = {};
        Object.keys(event).forEach((k) => {
          const v = event[k];
          keys[k] = v === null ? 'null'
            : Array.isArray(v) ? 'array[' + v.length + ']'
            : typeof v === 'object' ? 'object{' + Object.keys(v).join(',') + '}'
            : typeof v === 'string' ? 'string[' + v.length + '] ' + v.slice(0, 60)
            : typeof v;
        });
        const got = extractBody(event);
        return json(200, {
          ok: true,
          msg: 'HTTP 事件字段结构（诊断用）',
          httpMethod: event.httpMethod,
          isBase64Encoded: event.isBase64Encoded === true,
          event_keys: keys,
          body_picked_from: got.from,
          body_len: got.text.length,
          body_head: got.text.slice(0, 300),
        });
      }

      // 浏览器直接 GET 且无签名参数 → 给「路径已通」的明文回执，便于人工自测
      if (method === 'GET' && !query.signature) {
        return {
          statusCode: 200,
          body:
            '✅ receiveCallback 已连通（HTTP 访问服务生效）\n' +
            '当前缺少 signature 参数 → 这是人工自测访问，不是微信服务器校验。\n' +
            '请在微信后台「消息推送」里提交本 URL 完成正式校验。',
        };
      }
      if (method === 'GET') {
        const r = await handleVerify(query);
        // ⭐ 校验通过时 echostr 必须**裸返回**（微信按纯文本比对）；失败时也裸返回错误串
        return { statusCode: r.statusCode, body: r.body };
      }

      if (method === 'POST') {
        // ⭐ 报文可能在 body / bodyXml / data，且可能是 base64（见 extractBody 注释）
        const got = extractBody(event);
        const gzhOpenid = query.openid || (event.headers && event.headers.openid) || '';
        console.log(
          '[receiveCallback] POST body_from=' + got.from + ' len=' + got.text.length +
          ' head=' + got.text.slice(0, 120)
        );
        const reply = await handleMessage(got.text, gzhOpenid, {
          body_from: got.from,
          body_len: got.text.length,
          is_base64: event.isBase64Encoded === true,
          event_keys: Object.keys(event).join(','),
        });
        console.log('[receiveCallback] POST reply head=' + String(reply).slice(0, 80));
        // ⭐ 关键：XML 必须**裸返回**，不能包 {statusCode, body}（见 xmlResponse 注释）
        return xmlResponse(reply || '', query);
      }
      return { statusCode: 405, body: 'method not allowed' };
    }

    // 非 HTTP 调用（控制台测试入口）：event.bodyXml / event.openid
    if (event.bodyXml) {
      return await handleMessage(event.bodyXml, event.openid || '');
    }

    // 控制台空跑 → 默认给自检，不再返回无信息量的「unsupported trigger」
    return await selfTest();
  } catch (e) {
    // 兜底：任何异常都返回可读 JSON，绝不 500（500 会让微信后台报「HTTP 返回非 200」）
    console.error('[receiveCallback] 顶层异常', e && (e.stack || e.message));
    return json(200, {
      ok: false,
      error: (e && (e.message || e.errMsg)) || String(e),
      stack: String((e && e.stack) || '').split('\n').slice(0, 4),
      hint: '函数已加载，但处理过程中出错。把本 JSON 发我即可定位。',
    });
  }
};
