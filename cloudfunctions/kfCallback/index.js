/**
 * kfCallback —— 企业微信「微信客服」回调接收器（链路 A 可行性实测专用）
 *
 * 【实测目的】
 *   验证「用户把视频号视频转发给微信客服」时，官方回调到底给出哪些字段。
 *   核心问题：**有没有 object_id / object_nonce_id**（视频号视频的唯一钥匙）。
 *     · 有 → 官方路可行，可直接换出可下载直链
 *     · 只有 nickname/title → 官方路走不通，只能走第三方协议方案
 *
 * 【链路】
 *   用户转发视频号视频 → 微信客服 → 企微推事件到本函数（加密 XML）
 *     → 解密 → 调 kf/sync_msg 拉取真实消息 → 落库 + 自检口回显
 *
 * 【自检口】（HTTP GET，免签名、只读）
 *   ?__kfdiag=1      配置体检（环境变量 / 集合）
 *   ?__kfsync=1      ★ 直接拉「3 天内全部客服消息」—— 最核心的一条，不依赖数据库
 *   ?__kfaccounts=1  客服账号列表（确认 open_kfid）
 *   ?__kf=10         读回回调探针表最近 N 条
 *
 * 【环境变量】WXWORK_CORP_ID / WXWORK_KF_SECRET
 *   （TOKEN / AES_KEY 已固定在下方，原样填到企微后台即可）
 *
 * ⚠️ 企微回调与企业微信公众平台不同：**强制 AES 加密**，必须解密。
 * ⚠️ 企微要求 1 秒内回包；本函数先落库再返回，实测场景可接受（超时企微会重试）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const wxwork = require('./_common/wxwork');

// ============================================================
// 固定参数（由我方指定，用户原样填到微信客服后台「开发配置 → 企业内部接入」）
//
// ⚠️⚠️ 2026-09-28 实测坑：EncodingAESKey 必须**纯字母数字**
//   旧值 'OeItGCVWihqoTzr7x7X3konMYGUV5nD4q8d7kQ/QjiE' 虽然是标准 43 位 base64，
//   但含 `+` `/` → 微信客服后台前端校验直接**红字拒绝（"请输入43位的英文或数字"）、
//   不让点「完成」**（不是提示，是硬拦截）。
//   ⚠️ 微信后台自己的「随机获取」按钮生成的 key 也可能含 `+`/`/` —— 它的校验很迷，
//      但**我们能控制的只有自己这把 key**：直接生成纯字母数字版规避。
//   ✅ 生成法（保证仍是合法 base64、可解出 32 字节）：
//      do { k = randomBytes(32).toString('base64').replace(/=+$/,'') } while (/[+/]/.test(k))
// ============================================================
const FIXED_TOKEN = 'jswenan2026kf';
const FIXED_AES_KEY = 'nJ7XQbi7V4qbrsP1yIFliMzYgCiUl2hkjbnf2MItGW4';

const COLL = 'kf_probe';

function cfg() {
  return {
    corpId: process.env.WXWORK_CORP_ID || '',
    secret: process.env.WXWORK_KF_SECRET || '',
    token: process.env.WXWORK_KF_TOKEN || FIXED_TOKEN,
    aesKey: process.env.WXWORK_KF_AES_KEY || FIXED_AES_KEY,
  };
}

// ============================================================
// 工具
// ============================================================
function jsonOut(obj) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

function extractBody(event) {
  if (!event) return '';
  let b = event.body;
  if (b === undefined || b === null) b = event.data || '';
  if (typeof b === 'object') b = JSON.stringify(b);
  b = String(b || '');
  if (event.isBase64Encoded && b) {
    try {
      b = Buffer.from(b, 'base64').toString('utf8');
    } catch (e) {}
  }
  return b;
}

async function saveProbe(doc) {
  try {
    const data = Object.assign({ created_at: new Date() }, doc);
    await db.collection(COLL).add({ data: data });
  } catch (e) {
    console.warn('[kfCallback] 落库失败（集合可能未创建）', e && e.message);
  }
}

// ============================================================
// 一、GET：企微 URL 校验
// ⚠️ 必须**裸返回**解密后的 echostr 明文（不能包 JSON）
// ============================================================
function verifyUrl(q) {
  const c = cfg();
  const echostr = q.echostr || '';
  if (!echostr) return 'kfCallback alive';

  const expect = wxwork.calcSignature(c.token, q.timestamp || '', q.nonce || '', echostr);
  const got = q.msg_signature || '';
  if (got && expect !== got) {
    console.warn('[kfCallback] ⚠️ URL 校验签名不匹配 expect=' + expect + ' got=' + got);
  }
  try {
    const r = wxwork.decrypt(c.aesKey, echostr);
    console.log('[kfCallback] ✅ URL 校验通过 receiveId=' + r.receiveId);
    saveProbe({ kind: 'verify', ok: true, receive_id: r.receiveId, plain: r.msg });
    return r.msg;
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.warn('[kfCallback] ❌ echostr 解密失败: ' + msg);
    saveProbe({ kind: 'verify', ok: false, error: msg, aes_key_len: (c.aesKey || '').length });
    return 'verify-fail:' + msg;
  }
}

// ============================================================
// 二、POST：企微事件（加密）
// ============================================================
async function handlePost(event, q) {
  const c = cfg();
  const bodyXml = extractBody(event);
  const encryptStr = wxwork.pickTag(bodyXml, 'Encrypt');
  const got = q.msg_signature || '';

  let decrypted = '';
  let decErr = '';
  if (encryptStr) {
    const expect = wxwork.calcSignature(c.token, q.timestamp || '', q.nonce || '', encryptStr);
    if (got && expect !== got) {
      console.warn('[kfCallback] ⚠️ POST 签名不匹配（仍尝试解密）');
    }
    try {
      decrypted = wxwork.decrypt(c.aesKey, encryptStr).msg;
    } catch (e) {
      decErr = String((e && e.message) || e);
    }
  } else {
    decErr = '未找到 <Encrypt> 节点（body 长度 ' + bodyXml.length + '）';
  }

  const msg = decrypted ? wxwork.parseAll(decrypted) : {};

  console.log(
    '[kfCallback] POST MsgType=' + (msg.MsgType || '') +
    ' Event=' + (msg.Event || '') +
    ' OpenKfId=' + (msg.OpenKfId || '') +
    ' decErr=' + decErr
  );

  await saveProbe({
    kind: 'event',
    raw: String(bodyXml).slice(0, 4000),
    decrypted: decrypted,
    dec_err: decErr,
    msg_type: msg.MsgType || '',
    event: msg.Event || '',
    open_kfid: msg.OpenKfId || '',
    cb_token: msg.Token || '',
    payload: msg,
    query: q,
  });

  // 新消息事件 → 立刻拉取（★ 实测关键的一步）
  if (msg.Event === 'kf_msg_or_event') {
    const r = await doSync({
      token: msg.Token || '',
      openKfId: msg.OpenKfId || '',
      save: true,
      tag: 'from_callback',
    });
    console.log('[kfCallback] sync 结果 errcode=' + r.errcode + ' 条数=' + r.msg_count);
  }

  // ⚠️ 企微约定：直接回 'success'（不回空串以外的内容）
  return 'success';
}

// ============================================================
// 三、拉取消息（实测核心）
// ============================================================
async function doSync(opts) {
  const o = opts || {};
  const c = cfg();
  const out = {
    ok: false,
    tag: o.tag || 'manual',
    corp_id_set: !!c.corpId,
    secret_set: !!c.secret,
  };
  try {
    out.step = 'gettoken';
    const t = await wxwork.getAccessToken(c.corpId, c.secret);
    out.access_token_cached = t.cached;

    out.step = 'sync_msg';
    const r = await wxwork.syncMsg(t.token, {
      token: o.token || '',
      cursor: o.cursor || '',
      openKfId: o.openKfId || '',
    });

    out.step = 'done';
    out.ok = !!(r && r.errcode === 0);
    out.errcode = r && r.errcode;
    out.errmsg = r && r.errmsg;
    out.next_cursor = r && r.next_cursor;
    out.has_more = r && r.has_more;
    out.msg_count = (r && r.msg_list && r.msg_list.length) || 0;
    // ★★ 核心证据：每条消息的 msgtype 与全部原始字段
    out.messages = (r && r.msg_list) || [];

    if (o.save) await saveProbe({ kind: 'sync', tag: out.tag, payload: out });
    return out;
  } catch (e) {
    out.step = out.step || 'error';
    out.error = String((e && e.message) || e);
    out.detail = e && e.detail;
    if (o.save) await saveProbe({ kind: 'sync_error', tag: out.tag, payload: out });
    return out;
  }
}

/** 客服账号列表：确认 open_kfid 与 Secret 是否正确 */
async function doAccounts() {
  const c = cfg();
  try {
    const t = await wxwork.getAccessToken(c.corpId, c.secret);
    const r = await wxwork.accountList(t.token);
    return { ok: !!(r && r.errcode === 0), errcode: r && r.errcode, errmsg: r && r.errmsg, data: r };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), detail: e && e.detail };
  }
}

// ============================================================
// 四、体检 / 读探针
// ============================================================
async function diag() {
  const c = cfg();
  const out = {
    ok: true,
    fn: 'kfCallback',
    now: new Date().toISOString(),
    cfg: {
      WXWORK_CORP_ID: c.corpId
        ? c.corpId.slice(0, 4) + '***' + c.corpId.slice(-2) + '（长度 ' + c.corpId.length + '）'
        : '❌ 未配置',
      WXWORK_KF_SECRET: c.secret ? '✅ 已配置（长度 ' + c.secret.length + '）' : '❌ 未配置',
      WXWORK_KF_TOKEN: '✅ ' + c.token,
      WXWORK_KF_AES_KEY: '✅ 长度 ' + c.aesKey.length,
    },
    selfcheck: ['?__kfdiag=1', '?__kfsync=1', '?__kfaccounts=1', '?__kf=10'],
  };
  try {
    await db.collection(COLL).limit(1).get();
    out.db = '✅ ' + COLL + ' 可读';
  } catch (e) {
    out.db = '❌ ' + String((e && e.message) || e) + '（去云开发控制台新建集合 ' + COLL + '）';
  }
  return out;
}

async function readProbe(n) {
  const lim = Math.max(1, Math.min(Number(n) || 10, 20));
  try {
    const r = await db.collection(COLL).orderBy('created_at', 'desc').limit(lim).get();
    return { ok: true, requested: lim, count: r.data.length, list: r.data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ============================================================
// 五、入口
// ============================================================
exports.main = async (event, context) => {
  try {
    const q = (event && event.queryStringParameters) || {};
    const method = String((event && event.httpMethod) || '').toUpperCase();
    const flag = function (k) {
      return q[k] || (event && event[k]);
    };

    // ---- 自检口（HTTP GET 或控制台）----
    if (flag('__kfdiag')) return jsonOut(await diag());
    if (flag('__kfaccounts')) return jsonOut(await doAccounts());
    if (flag('__kfsync')) {
      return jsonOut(
        await doSync({
          openKfId: q.open_kfid || '',
          cursor: q.cursor || '',
          tag: 'selfcheck',
        })
      );
    }
    if (flag('__kf')) return jsonOut(await readProbe(q.__kf));

    // ---- 控制台手动触发 ----
    if (event && event.action === 'sync') return jsonOut(await doSync({ openKfId: event.open_kfid || '', save: true, tag: 'console' }));
    if (event && event.action === 'diag') return jsonOut(await diag());

    // ---- 企微 HTTP ----
    if (method === 'GET') return verifyUrl(q);
    if (method === 'POST') return await handlePost(event, q);

    return jsonOut({ ok: true, hint: 'kfCallback 存活。自检口：?__kfdiag=1 / ?__kfsync=1' });
  } catch (e) {
    console.error('[kfCallback] 入口异常', e && (e.message || e));
    return jsonOut({ ok: false, error: String((e && e.message) || e), detail: e && e.detail });
  }
};
