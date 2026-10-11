// _common/wxapi.js - 微信服务号开放接口（access_token / 客服消息 / 订阅消息）
// 依赖 app_config 集合缓存 access_token；appid/secret 在环境变量或下方默认值（部署时配置）
const https = require('https');
const { db, cmd, COLL } = require('./db');
const { env } = require('./providers');

const APPID = env('GZH_APPID', 'your-gzh-appid');
const SECRET = env('GZH_SECRET', 'your-gzh-secret');
// 客服消息主动推送前提：用户与服务号交互后 48h 内（PRD 6.2）

function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: method || 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** 读取 access_token（优先缓存；app_config 集合 _id='gzh_token'） */
async function getAccessToken(force) {
  if (!APPID || APPID.indexOf('your-') === 0) {
    throw new Error('GZH_APPID 未配置（云函数环境变量）');
  }
  // 读缓存
  if (!force) {
    try {
      const r = await COLL.config().doc('gzh_token').get();
      const d = r.data;
      if (d && d.access_token && d.expires_at > Date.now() + 300000) {
        return d.access_token;
      }
    } catch (e) {
      // 首次无缓存
    }
  }
  const res = await httpJson(
    'GET',
    'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' +
      encodeURIComponent(APPID) +
      '&secret=' +
      encodeURIComponent(SECRET)
  );
  if (!res.access_token) throw new Error('获取 access_token 失败: ' + JSON.stringify(res));
  try {
    await COLL.config().doc('gzh_token').set({
      data: {
        access_token: res.access_token,
        expires_at: Date.now() + res.expires_in * 1000,
        updated_at: new Date(),
      },
    });
  } catch (e) {
    // 并发写失败忽略（token 仍在内存有效期内）
  }
  return res.access_token;
}

/** 客服消息：文本 */
async function sendKfText(openid, content) {
  const token = await getAccessToken();
  return httpJson('POST', 'https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + token, {
    touser: openid,
    msgtype: 'text',
    text: { content },
  });
}

/** 客服消息：小程序卡片（msgtype=miniprogrampage，PRD C-01） */
async function sendKfMiniPage(openid, { title, pagepath, thumb_media_id }) {
  if (!thumb_media_id) {
    throw new Error('thumb_media_id 未配置（需在公众号后台"素材管理"上传 520×416 封面图取得 media_id，写入 app_config）');
  }
  const token = await getAccessToken();
  return httpJson('POST', 'https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + token, {
    touser: openid,
    msgtype: 'miniprogrampage',
    miniprogrampage: {
      title: (title || '').slice(0, 20),
      pagepath: pagepath || 'pages/index/index',
      thumb_media_id,
    },
  });
}

/** 订阅消息（降级通道，PRD 12.5；templateId 需在小程序后台申请） */
async function sendSubscribe(openid, templateId, data, page) {
  const token = await getAccessToken();
  return httpJson('POST', 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token, {
    touser: openid,
    template_id: templateId,
    page: page || 'pages/index/index',
    data: data || {},
    miniprogram_state: 'formal',
  });
}

module.exports = { getAccessToken, sendKfText, sendKfMiniPage, sendSubscribe };
