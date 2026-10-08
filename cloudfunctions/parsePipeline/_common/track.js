// _common/track.js - 埋点写库（events 集合，PRD 9.1；供 api/receiveCallback 等服务端触发）
const { COLL } = require('./db');

async function track({ uid, openid, event, page, props }) {
  if (!event) return;
  try {
    await COLL.events().add({
      data: {
        event,
        uid: uid || '',
        openid: openid || '',
        page: page || '',
        props: props || {},
        ts: new Date(),
      },
    });
  } catch (e) {
    // 埋点失败不阻塞
  }
}

module.exports = { track };
