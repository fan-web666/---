// _common/mp4-duration.js - 从 MP4 分片缓冲里解出时长（纯解析，不联网、不落盘）
//
// ⚠️ 为什么需要它（2026-10-15 实测确认）：
//   解析服务返回体里**没有时长字段**（17智联只有 code/msg/data(title·url·photo…)/exec_time/ip），
//   线上文案类任务 duration_sec 恒为 0。而计费**按提取类型 + 时长分档**（2026-10-16 v5：
//   视频 ≤10 分钟 5 / 10~30 分钟 10 积分；文案 起步 2 + 每分钟 2 积分），扣费前必须知道时长，
//   否则长内容只能按最低档扣（30 分钟文案成本 ¥0.45，起步档仅收 ≈¥0.07 ⇒ 亏）。
//   实测：只读 MP4 **头 1MB** 就能解出，抖音/小红书/B站/视频号 **4/4 成功**（0.16~0.62s）。
//
// 📌 与 video-extract.js#durationFromFile 的分工（刻意不合并）：
//   · 那边吃**已下载的整片文件**（fd 随机读，不把 100MB 视频读进内存），视频链路扣费用，结果权威；
//   · 这边吃**远端 Range 拿回的 1MB 缓冲**，只用于「扣费前估价」，失败即返回 0 由调用方兜底。
//   ⚠️ 两者都按 moov → mvhd 的 version/timescale/duration 解析，**改一处必须核对另一处**。

/** mvhd 的 type 标签在 tagIndex（版本号在其后 4 字节）。取不到返回 null。 */
function parseMvhdTag(buf, tagIndex) {
  const v = buf[tagIndex + 4];
  try {
    if (v === 0) {
      if (tagIndex + 24 > buf.length) return null;
      const scale = buf.readUInt32BE(tagIndex + 16);
      const dur = buf.readUInt32BE(tagIndex + 20);
      if (scale > 0 && scale <= 1000000 && dur > 0) return { version: 0, scale, dur, sec: dur / scale };
    } else if (v === 1) {
      if (tagIndex + 36 > buf.length) return null;
      const scale = buf.readUInt32BE(tagIndex + 24);
      const dur = Number(buf.readBigUInt64BE(tagIndex + 28));
      if (scale > 0 && scale <= 1000000 && dur > 0) return { version: 1, scale, dur, sec: dur / scale };
    }
  } catch (e) {
    /* 越界即放弃 */
  }
  return null;
}

/** 在缓冲内按 box 链走（仅当缓冲从文件 0 开始时成立） */
function walkBuffer(buf, start, limit, depth) {
  const out = { mvhd: null, hasVideo: false };
  if (depth > 4) return out;
  for (let at = start; at + 8 <= limit;) {
    let size = buf.readUInt32BE(at);
    let header = 8;
    const type = buf.toString('ascii', at + 4, at + 8);
    if (size === 1) {
      if (at + 16 > limit) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    }
    if (size === 0) size = limit - at;
    // ⚠️ 缓冲是截断的：box 超出缓冲就停，不算错（尾段本来就不靠走路）
    if (!Number.isSafeInteger(size) || size < header || at + size > limit) break;
    if (type === 'mvhd') {
      const m = parseMvhdTag(buf, at + 4);
      if (m) out.mvhd = m;
    }
    if (type === 'hdlr' && size - header >= 12 && at + header + 12 <= limit) {
      if (buf.toString('ascii', at + header + 8, at + header + 12) === 'vide') out.hasVideo = true;
    }
    if (type === 'moov' || type === 'trak' || type === 'mdia') {
      const sub = walkBuffer(buf, at + header, at + size, depth + 1);
      if (!out.mvhd && sub.mvhd) out.mvhd = sub.mvhd;
      if (sub.hasVideo) out.hasVideo = true;
    }
    at += size;
  }
  return out;
}

/**
 * 从分片缓冲解时长。
 * @param {Buffer} buf  分片内容
 * @param {number} base 该分片在文件中的起始偏移（0 = 文件开头）
 * @returns {number} 秒；解不出返回 0
 */
function fromBuffer(buf, base) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return 0;
  if ((Number(base) || 0) === 0) {
    const r = walkBuffer(buf, 0, buf.length, 0);
    // moov 在头部且完整：只认带 vide 轨的（避免把纯音频文件当视频）
    if (r.mvhd && r.hasVideo) return Math.round(r.mvhd.sec);
  }
  // 兜底：按签名扫（尾段没法从头走 box 链；或 moov 超出缓冲时也靠它）
  // ⚠️ 放宽到「只要有 mvhd 就认」—— 视频直链不可能是纯音频，宁可解出来也不要退化成最低档。
  let i = buf.indexOf('mvhd', 0, 'ascii');
  while (i >= 0) {
    const m = parseMvhdTag(buf, i);
    if (m) return Math.round(m.sec);
    i = buf.indexOf('mvhd', i + 4, 'ascii');
  }
  return 0;
}

module.exports = { fromBuffer, parseMvhdTag };
