// ISO BMFF 无损重封装：复制完整 AAC 数据和原时间表，不解码、不重编码。
// 非单音轨 AAC、分片/加密、异常索引均回退原视频。限制输入内存和处理时间。
function demux(input, maxMs = 600) {
  const src = new Uint8Array(input);
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const started = Date.now();
  const check = () => { if (Date.now() - started > maxMs) throw Error('budget'); };
  const u32 = o => view.getUint32(o, false);
  const tag = o => String.fromCharCode(...src.subarray(o, o + 4));
  const raw = b => src.subarray(b.start, b.end);
  function boxes(start, end) {
    const result = [];
    let p = start;
    while (p < end) {
      if (p + 8 > end) throw Error('truncated box');
      let size = u32(p), header = 8;
      if (size === 1) {
        if (p + 16 > end) throw Error('truncated extended box');
        size = u32(p + 8) * 4294967296 + u32(p + 12); header = 16;
      } else if (size === 0) size = end - p;
      if (!Number.isSafeInteger(size) || size < header || p + size > end) throw Error('invalid box');
      result.push({ type: tag(p + 4), start: p, body: p + header, end: p + size });
      p += size;
      if (result.length > 100000) throw Error('too many boxes');
    }
    return result;
  }
  const one = (list, type) => {
    const matches = list.filter(b => b.type === type);
    if (matches.length !== 1) throw Error('missing/duplicate ' + type);
    return matches[0];
  };
  const join = parts => {
    const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  };
  const box = (type, parts) => {
    const body = join(parts), header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, body.length + 8, false);
    for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i);
    return join([header, body]);
  };
  try {
    if (src.length < 1024 || src.length > 60 * 1024 * 1024) return null;
    const top = boxes(0, src.length);
    if (top.some(b => b.type === 'moof')) return null;
    const moov = one(top, 'moov'), ftyp = one(top, 'ftyp');
    if (moov.end - moov.start > 1024 * 1024) return null;
    const mk = boxes(moov.body, moov.end);
    if (mk.some(b => b.type === 'mvex')) return null;
    const audio = mk.filter(b => b.type === 'trak').filter(t => {
      const mdia = one(boxes(t.body, t.end), 'mdia');
      const h = one(boxes(mdia.body, mdia.end), 'hdlr');
      return h.body + 12 <= h.end && tag(h.body + 8) === 'soun';
    });
    if (audio.length !== 1) return null;
    const tk = boxes(audio[0].body, audio[0].end);
    // 外部轨道引用和未知剪辑依赖不尝试处理。
    if (tk.some(b => b.type === 'tref')) return null;
    const mdia = one(tk, 'mdia'), dk = boxes(mdia.body, mdia.end);
    const minf = one(dk, 'minf'), fk = boxes(minf.body, minf.end);
    const stbl = one(fk, 'stbl'), sk = boxes(stbl.body, stbl.end);
    if (sk.some(b => ['senc', 'saiz', 'saio'].includes(b.type))) return null;
    const stsd = one(sk, 'stsd');
    if (stsd.body + 8 > stsd.end || u32(stsd.body + 4) !== 1) return null;
    const entry = one(boxes(stsd.body + 8, stsd.end), 'mp4a');
    // 音频样本描述 v0；版本1/2及外部数据引用保持原视频路径。
    if (entry.body + 28 > entry.end || view.getUint16(entry.body + 8, false) !== 0 || view.getUint16(entry.body + 6, false) !== 1) return null;
    const codec = boxes(entry.body + 28, entry.end);
    if (codec.some(b => b.type === 'sinf')) return null;
    const esds = one(codec, 'esds');
    // mp4a 也能装非 AAC：必须验证 ES / DecoderConfig 的音频 AAC 标识。
    const descriptor = (p, end, expected) => {
      if (p >= end || src[p++] !== expected) throw Error('descriptor');
      let length = 0, n = 0, byte;
      do { if (p >= end || ++n > 4) throw Error('descriptor length'); byte = src[p++]; length = length * 128 + (byte & 127); } while (byte & 128);
      if (p + length > end) throw Error('descriptor bounds');
      return { start: p, end: p + length };
    };
    const es = descriptor(esds.body + 4, esds.end, 3);
    if (es.start + 3 > es.end) return null;
    const flags = src[es.start + 2];
    let dp = es.start + 3;
    if (flags & 128) dp += 2;
    if (flags & 64) { if (dp >= es.end) return null; dp += 1 + src[dp]; }
    if (flags & 32) dp += 2;
    const dc = descriptor(dp, es.end, 4);
    if (dc.start + 13 > dc.end || src[dc.start] !== 0x40 || (src[dc.start + 1] >> 2) !== 5) return null;
    const sz = one(sk, 'stsz'), sc = one(sk, 'stsc'), ts = one(sk, 'stts');
    if (sz.body + 12 > sz.end || sc.body + 8 > sc.end || ts.body + 8 > ts.end) return null;
    const uniform = u32(sz.body + 4), count = u32(sz.body + 8);
    if (!count || count > 200000 || (!uniform && sz.body + 12 + count * 4 !== sz.end)) return null;
    const sizes = Array.from({ length: count }, (_, i) => uniform || u32(sz.body + 12 + i * 4));
    const timeCount = u32(ts.body + 4);
    if (!timeCount || ts.body + 8 + timeCount * 8 !== ts.end) return null;
    let timedSamples = 0;
    for (let i = 0; i < timeCount; i++) {
      timedSamples += u32(ts.body + 8 + i * 8);
      if (!u32(ts.body + 12 + i * 8)) return null;
    }
    if (timedSamples !== count) return null;
    const offsetsBox = sk.filter(b => b.type === 'stco' || b.type === 'co64');
    if (offsetsBox.length !== 1) return null;
    const co = offsetsBox[0], wide = co.type === 'co64', stride = wide ? 8 : 4;
    if (co.body + 8 > co.end) return null;
    const chunkCount = u32(co.body + 4);
    if (!chunkCount || chunkCount > 100000 || co.body + 8 + chunkCount * stride !== co.end) return null;
    const nsc = u32(sc.body + 4);
    if (!nsc || nsc > chunkCount || sc.body + 8 + nsc * 12 !== sc.end) return null;
    const mappings = [];
    for (let i = 0; i < nsc; i++) {
      const p = sc.body + 8 + i * 12;
      const first = u32(p), samples = u32(p + 4);
      if (!first || first > chunkCount || !samples || u32(p + 8) !== 1 || (i && first <= mappings[i - 1].first)) return null;
      mappings.push({ first, samples });
    }
    if (mappings[0].first !== 1) return null;
    const mdats = top.filter(b => b.type === 'mdat');
    const chunks = [], lengths = [];
    let sample = 0, map = 0, audioBytes = 0;
    const regions = [];
    for (let i = 0; i < chunkCount; i++) {
      if ((i & 255) === 0) check();
      while (map + 1 < mappings.length && mappings[map + 1].first <= i + 1) map++;
      const num = mappings[map].samples;
      if (sample + num > count) return null;
      let len = 0;
      for (let j = 0; j < num; j++) { const size = sizes[sample++]; if (!size) return null; len += size; }
      const p = co.body + 8 + i * stride;
      const offset = wide ? u32(p) * 4294967296 + u32(p + 4) : u32(p);
      if (!Number.isSafeInteger(offset) || !mdats.some(b => offset >= b.body && offset + len <= b.end)) return null;
      regions.push({ start: offset, end: offset + len });
      chunks.push(src.subarray(offset, offset + len)); lengths.push(len); audioBytes += len;
    }
    regions.sort((a, b) => a.start - b.start);
    if (regions.some((r, i) => i && r.start < regions[i - 1].end) || sample !== count || audioBytes >= src.length * 0.6) return null;
    const rebuild = base => {
      const body = new Uint8Array(8 + chunkCount * 4), dv = new DataView(body.buffer);
      dv.setUint32(4, chunkCount, false);
      let p = base;
      for (let i = 0; i < chunkCount; i++) { dv.setUint32(8 + i * 4, p, false); p += lengths[i]; }
      const ns = box('stbl', sk.map(b => b === co ? box('stco', [body]) : raw(b)));
      const nf = box('minf', fk.map(b => b === stbl ? ns : raw(b)));
      const nd = box('mdia', dk.map(b => b === minf ? nf : raw(b)));
      const nt = box('trak', tk.map(b => b === mdia ? nd : raw(b)));
      // 原始 mvhd、mdhd、stts、edts 和 codec 配置不变；只去掉视频轨。
      return box('moov', [raw(one(mk, 'mvhd')), nt]);
    };
    let nm = rebuild(0);
    nm = rebuild(raw(ftyp).length + nm.length + 8);
    check();
    const output = join([raw(ftyp), nm, box('mdat', chunks)]);
    if (output.length >= src.length * 0.6) return null;
    return { data: output.buffer, bytes: output.length, samples: count };
  } catch (_) { return null; }
}

async function prepare(input, alive = () => true) {
  const original = { path: input.path, audioOnly: false, ms: 0, bytes: Math.round((input.sizeMB || 0) * 1048576), cleanup() {} };
  const sizeMB = Number(input.sizeMB) || 0;
  // ⭐ 2026-10-12 二改（用户反馈「有些本地文件提取要 30+ 秒，字数少的反而更慢」）：
  //    ① **解除与「缩略图」的耦合** —— 抽音频只跟视频文件本身有关。
  //       原先 `!input.thumb` 就会直接放弃抽取 → 没取到封面的视频一律原样上传几十 MB，
  //       云函数再从云存储整份下载；上传 + 下载两段叠加，正是「慢的那个」的成因。
  //    ② 体积未知（file.size 取不到 = 0）**不再当成小文件放过**，改为照常尝试抽取。
  //    ③ 只在四种「明确不该抽」的情况下直接放弃：环境不支持 / 扩展名不支持 /
  //       明确过大（>60MB，怕内存爆）/ 明确过小（<2MB，抽了也省不下多少）。
  // ⭐⭐ 2026-10-12 三改（用户报「本地 7 分多钟、40多MB 视频，第一步 52s」）：
  //    上限 40 → 60MB。此前 40MB 以上**一律整份原样上传** —— 49MB 原片直传云存储
  //    实测 52 秒；而抽音频后只有 3~4MB（音频 ≈ 原片 5~6%，实测 71MB → 4.08MB）。
  //    预估第一步 52s → 7s 上下，且第 2 步云端下载的也同步变小。
  //    内存代价：readFile 峰值 ≈ 文件本身（上限 60MB）＋几 MB 输出；失败走 fail 回调
  //    自动回退原样上传 ⇒ 最坏等同改动前的行为，不会让提取失败。
  const extOk = /\.(mp4|mov|m4v)$/i.test(input.path || '');
  const envOk = typeof wx.getFileSystemManager === 'function' && !!(wx.env && wx.env.USER_DATA_PATH);
  if (!envOk || !extOk || sizeMB > 60 || (sizeMB > 0 && sizeMB < 2)) {
    console.log('[audio] 跳过抽取（原样上传）· sizeMB=' + sizeMB + ' · extOk=' + extOk + ' · envOk=' + envOk);
    return original;
  }
  const fs = wx.getFileSystemManager(), started = Date.now();
  let ended = false, timer, outputPath = '';
  let why = 'demux 不支持该封装'; // 抽取未成功的原因（诊断：开发者工具可见）
  const cleanup = () => { if (outputPath) { try { fs.unlink({ filePath: outputPath, fail() {} }); } catch (_) {} } };
  return new Promise(resolve => {
    const finish = value => {
      if (ended) { if (value.audioOnly) cleanup(); return; }
      ended = true; clearTimeout(timer);
      if (value.audioOnly) {
        console.log('[audio] 抽取成功 · ' + (value.bytes / 1048576).toFixed(2) + 'MB ← 原 ' + sizeMB.toFixed(1) + 'MB · 耗时 ' + (Date.now() - started) + 'ms');
      } else {
        value.ms = Date.now() - started;
        console.log('[audio] 抽取未成功（回退原样上传）· 原因=' + why + ' · 耗时 ' + value.ms + 'ms');
      }
      resolve(value);
    };
    // ⭐ 2026-10-12：预算 1s → 2.5s。大文件（20~40MB）读取 + 解析本身就要几百 ms，
    //    1s 预算会让它们大概率超时回退 → 退回原样上传大视频（20+ 秒）。
    //    放宽后：抽音频成功可把上传体积压到 <1MB（净省 20 秒）；失败也只是多等最多 2.5s。
    // ⭐⭐ 2026-10-12 三改：预算 2.5s → 4s，与 60MB 上限**必须同步**。
    //    否则会出现「上限放开了、却因预算不够总超时回退」→ 白等一场、收益归零。
    //    代价：抽不出的文件最多多等 1.5s 才回退（离开页面有 alive() 兜底，不会干等）。
    timer = setTimeout(() => { why = '超过 4s 预算'; finish(original); }, 4000);
    try {
      fs.readFile({ filePath: input.path, success(res) {
        if (ended || !alive()) { why = '页面已离开'; return finish(original); }
        const audio = demux(res.data, Math.min(2500, Math.max(500, 4000 - (Date.now() - started))));
        if (!audio || ended || !alive() || Date.now() - started > 3800) {
          why = !audio ? 'demux 不支持该封装' : '超过 4s 预算';
          return finish(original);
        }
        outputPath = wx.env.USER_DATA_PATH + '/extract_audio_' + String(input.requestId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) + '.m4a';
        try {
          fs.writeFile({ filePath: outputPath, data: audio.data, success() {
            if (!alive()) { cleanup(); why = '页面已离开'; return finish(original); }
            finish({ path: outputPath, audioOnly: true, ms: Date.now() - started, bytes: audio.bytes, cleanup });
          }, fail() { cleanup(); why = '写临时文件失败'; finish(original); } });
        } catch (_) { cleanup(); why = '写临时文件异常'; finish(original); }
      }, fail() { why = '读文件失败'; finish(original); } });
    } catch (_) { why = '读文件异常'; finish(original); }
  });
}

module.exports = { demux, prepare };
