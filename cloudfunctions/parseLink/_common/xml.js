// _common/xml.js - 微信服务号消息 XML 编解码（轻量实现，不引第三方依赖）
// 微信消息 XML 结构固定：<xml><FromUserName><![CDATA[x]]></FromUserName>...</xml>
// 服务号服务器配置接入细节见 receiveCallback/README 备注

/** 取 XML 中某标签的文本内容（自动剥 CDATA / 实体） */
function pick(xml, tag) {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(xml || '');
  if (!m) return '';
  let v = m[1];
  v = v.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  return v.trim();
}

/** 解析微信回调消息为结构化对象 */
function parseMessage(xml) {
  const msg = {
    ToUserName: pick(xml, 'ToUserName'),
    FromUserName: pick(xml, 'FromUserName'), // 用户(关注者) gzh openid
    CreateTime: pick(xml, 'CreateTime'),
    MsgType: pick(xml, 'MsgType'), // text | video | image | link | event | ...
    MsgId: pick(xml, 'MsgId'),
    Content: pick(xml, 'Content'),
    Event: pick(xml, 'Event'), // subscribe | unsubscribe | CLICK ...
    EventKey: pick(xml, 'EventKey'),
    MediaId: pick(xml, 'MediaId'),
    ThumbMediaId: pick(xml, 'ThumbMediaId'),
    Title: pick(xml, 'Title'),
    Description: pick(xml, 'Description'),
    Url: pick(xml, 'Url'),
    PicUrl: pick(xml, 'PicUrl'),
    // 转发链接/卡片（视频号转发给服务号后实际形态需 W1 Spike 实证，PRD 12.3）
    rawXml: xml,
  };
  return msg;
}

/** 生成被动回复文本 XML */
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

module.exports = { pick, parseMessage, replyTextXml };
