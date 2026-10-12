const { reconcileTranscript } = require('./transcriptQuality');
// _common/copywriting.js - 文案结果组装（PRD R-09 schema + F-04/V-01 长文页数据结构）
// content 结构：
//   { hook, highlights[], points[], transcript, full_markdown }
//   transcript 为 ASR 原文（事实层，不删改）；hook/highlights/points 为结构化整理（辅助视图）

/* ══════════════════════════════════════════════════════════════════════════
   转写文本清洗（2026-09-28 用户反馈）
   ══════════════════════════════════════════════════════════════════════════
   问题：提取结果里混进大量非口播内容 —— 「[音乐]」「[尴尬]」「(笑声)」「🎵😅」
   这类 **情绪标注 / 音效标记 / emoji**。用户明确：「这个是多余的，不需要，提取结果中不应该体现」。

   来源：Whisper 系转写（ASR_MODEL 默认 whisper-1）在识别非语音段时会输出
        `[Music]` `[Applause]` 等标签；中文口播里的语气停顿也常被判成 `[尴尬]` `[笑声]`。

   ⚠️ 清洗原则（与「字幕＝唯一主稿」的口径一致，别误伤正稿）：
   ① **只删「整体被包起来的」标注** —— `[...]`、`【...】`、`(...)`、`（...）`。
      括号内必须是**已知的音效/情绪词**才删，避免把口播里正常的括号内容当噪音（如「（三）」「（一）」）。
   ② **不碰句中标点以外的文字** —— 绝不删任何汉字、数字、字母。
   ③ 删完把因删除产生的**多余空格 / 悬空标点**收拾干净，不能留下「，，」或行首标点。
   ⚠️ 本函数是**纯字符串处理**，无副作用、可单测；唯一实现在此，别在别处再写一份。
   ══════════════════════════════════════════════════════════════════════════ */

/** 会被整段删除的音效 / 情绪标注词（中英）—— 命中即删，未命中则保留原括号 */
const NOISE_TAGS = [
  // 音效
  '音乐', '背景音乐', '歌声', '歌曲', '旋律', '节奏', '鼓点', '伴奏', '纯音乐',
  'music', 'bgm', 'song', 'instrumental', 'melody',
  // 非语音人声
  '掌声', '鼓掌', '欢呼', '喝彩', '尖叫', '笑', '笑声', '大笑', '哄笑', '偷笑',
  'applause', 'laughter', 'laughs', 'laughing', 'cheering', 'clapping',
  // 情绪 / 语气标注
  '尴尬', '叹气', '叹息', '咳嗽', '清嗓', '嗯', '呃', '啊', '哦', '噢', '唔', '咦', '诶', '哈',
  'sighs', 'coughs', 'clears throat', 'sigh', 'cough',
  // 其他常见非口播
  '静音', '无声', '噪音', '杂音', '沉默', '停顿', '听不清', '无法识别', 'inaudible', 'silence',
  'noise', 'blank_audio', 'background noise', 'pause',
];

/** 归一化：去空白 + 小写（用于比对，不修改原文） */
function normTag(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 判断括号里的内容是否属于「该删的噪音标注」
 * ⚠️ 宁可漏删也不能误删 —— 拿不准就保留（口播正文优先）
 */
function isNoiseTag(inner) {
  const t = normTag(inner);
  if (!t) return false;
  // 纯数字 / 纯符号（如「（1）」「（三）」）不是噪音标注，是正文序号
  if (!/[\u4e00-\u9fa5a-z]/.test(t)) return false;
  // 完全相等，或「噪音词 + 少量修饰」（如「背景音乐」「众人笑声」）
  return NOISE_TAGS.some((n) => t === normTag(n) || (t.length <= 8 && t.indexOf(normTag(n)) > -1 && normTag(n).length >= 2));
}

/** emoji / 各类符号字形（覆盖常见区间） */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/**
 * 清洗转写文本
 * @param {string} text 原始转写（字幕或 ASR）
 * @returns {string} 清洗后的文本
 */
function cleanTranscript(text) {
  let s = String(text || '');
  if (!s) return '';

  // ① 去 emoji / 符号字形
  s = s.replace(EMOJI_RE, '');

  // ② 去「整段被包起来的」噪音标注
  //    ⚠️ 只处理**不跨行**的短标注（超过 12 字的多半是正文里的正常括号说明，保留）
  const BRACKETS = [
    [/\[([^\[\]\n]{0,12})\]/g, '[]'],
    [/【([^【】\n]{0,12})】/g, '【】'],
    [/\(([^()\n]{0,12})\)/g, '()'],
    [/（([^（）\n]{0,12})）/g, '（）'],
  ];
  BRACKETS.forEach(([re, pair]) => {
    const [open, close] = [pair[0], pair[1]];
    s = s.replace(re, (m, inner) => (isNoiseTag(inner) ? '' : m));
    // 空括号（如原文本就是「[]」）也一并去掉
    s = s.split(open + close).join('');
  });

  // ③ 收拾删除后的残局：连续标点、行首悬空标点、多重空格
  s = s
    .replace(/[ \t]{2,}/g, ' ') // 多空格合一
    .replace(/ *([，。！？、；：,.!?;:])/g, '$1') // 标点前不留空格
    .replace(/([，。！？、；：])\1+/g, '$1') // 连续重复标点合一（「，，」→「，」）
    .replace(/([，、；：])\s*(?=[，。！？、；：])/g, '') // 标点连排时丢掉前一个次级标点
    .replace(/^[，。、；：！？,.!?;:\s]+/gm, '') // 每行行首不留悬空标点
    .replace(/[ \t]+$/gm, '') // 行尾空格
    .replace(/\n{3,}/g, '\n\n') // 连续空行压缩
    .trim();

  return s;
}

/* ══════════════════════════════════════════════════════════════════════════
   修订对套用（2026-10-12 提速）
   ══════════════════════════════════════════════════════════════════════════
   背景：原实现让大模型把「校对后的整篇正文」原样回填一次，而输出 token 的 ~90%
        就是这段正文 —— 大模型逐字串行生成，正文多长就要花多久。实测同一批任务
        llm 耗时 2.2s ~ 12.1s，与正文长度强相关（差 5.5 倍）。
   改法：模型只回「改动点」edits，正文由本函数套用到原文上生成。
        → 输出量骤降，生成时间随之骤降；正文＝原文字面＋明确修订，不会因重写漏字。

   ⚠️ 安全铁律：**宁可不改，也绝不改错位置。**
     · o 至少 2 个字符（单字替换极易误伤，如「不」→「是」）
     · o 至多 60 个字符（防模型给出一大段把正文整块吃掉）
     · o 必须在原文里**恰好出现一次**（找不到 / 出现多次 → 丢弃该条：位置不确定就不动）
     · o / n 一律当**纯字符串**处理，不做正则解析 —— 模型给的字符绝不能变成元字符
     · 逐条套用；结果压缩长度 < 原文 60% → **整批作废**，回退原文（沿用既有 60% 阈值口径）
   ══════════════════════════════════════════════════════════════════════════ */

/** 单条修订对允许的原文片段长度区间（字符） */
const EDIT_O_MIN = 2;
const EDIT_O_MAX = 60;
/** 一次最多套用多少条（防脏数据把 CPU 打满） */
const EDIT_MAX = 120;

/**
 * 把模型给出的「修订对」套用到原文，生成最终正文。
 * @param {string} raw 原文（ASR 或字幕稿）
 * @param {Array<{o:string,n:string}>} edits 修订对（n 为空串 = 删除）
 * @returns {{text:string, applied:number, dropped:number, reverted:boolean}}
 */
function applyEdits(raw, edits) {
  const src = String(raw || '');
  const list = Array.isArray(edits) ? edits : [];
  const compactLen = t => String(t || '').replace(/\s/g, '').length;
  if (!src || !list.length) {
    return { text: src, applied: 0, dropped: list.length, reverted: false };
  }

  let out = src;
  let applied = 0;
  let dropped = 0;
  const cap = Math.min(list.length, EDIT_MAX);
  for (let i = 0; i < cap; i++) {
    const e = list[i];
    if (!e) { dropped++; continue; }
    const o = String(e.o == null ? '' : e.o);
    const n = String(e.n == null ? '' : e.n);
    if (o.length < EDIT_O_MIN || o.length > EDIT_O_MAX) { dropped++; continue; }
    const at = out.indexOf(o);
    if (at < 0) { dropped++; continue; }
    // 出现多次 → 无法确定改哪一处 → 宁可不动
    if (out.indexOf(o, at + 1) > -1) { dropped++; continue; }
    out = out.slice(0, at) + n + out.slice(at + o.length);
    applied++;
  }

  const srcN = compactLen(src);
  if (applied === 0 || (srcN > 0 && compactLen(out) < srcN * 0.6)) {
    return { text: src, applied: 0, dropped: list.length, reverted: true };
  }
  return { text: out, applied, dropped, reverted: false };
}

/**
 * 组装 content（原文 + 结构化并存，PRD 1.3）
 * @param {object} structured llmStructure 输出（edits 或兼容用的 transcript）
 * @param {string} transcriptText ASR 原文
 */
function buildContent(structured, transcriptText) {
  const s = structured || {};
  const correct = text => reconcileTranscript({ transcript: text }).text;
  const compactLen = t => String(t || '').replace(/\s/g, '').length;
  const raw = transcriptText || '';
  const llmText = String(s.transcript || '').trim();
  const srcLen = compactLen(raw);

  // ⭐⭐ 2026-10-12 提速（依据：timingReport 实测 —— llm_s 与正文长度强相关，2.2s ↔ 12.1s 差 5.5 倍）：
  //    模型不再回填整篇正文，只回「修订对」edits，由 applyEdits 套用到原文上。
  //    正文因此 = **原文字面 + 明确修订**：既省掉「把整篇原文再打一遍」的生成时间，
  //    也不会像「模型重写」那样出现漏字 / 语气被改写。
  //    兜底链（逐级退化，绝不丢内容）：
  //      ① edits 可用            → 应用结果
  //      ② edits 全被丢弃 / 正文塌破 60% → applyEdits 内部已回退原文
  //      ③ 没有 edits（旧格式 / plainFallback）→ 沿用旧逻辑：模型给的完整正文 → 原文
  let base = '';
  if (Array.isArray(s.edits) && s.edits.length) {
    const r = applyEdits(raw, s.edits);
    if (r.reverted) {
      console.warn(
        '[copywriting] 修订对未命中或正文过短，整批作废回退原文（apply ' +
          r.applied + '/' + s.edits.length + '，dropped ' + r.dropped + '）'
      );
    }
    base = r.text;
  }
  if (!base) {
    const usable = compactLen(llmText) > 0 && (srcLen === 0 || compactLen(llmText) >= srcLen * 0.6);
    base = usable ? llmText : (raw || llmText);
  }
  // 主稿已经过字幕/音频对照；这里只再跑一遍**本地固定搭配规则**（不依赖模型，纯确定性）——
  // ⚠️ 原实现漏掉了这一步：规则库只作用于 hook/highlights/points，「口播原文」从未被纠错。
  const transcript = correct(base);
  // ⭐ 2026-10-12：title 原先是**唯一没过纠错**的字段 → 曾出现「予行·文案快提」在标题里
  //    被写成「旅行文案快递」（截图实证）。现在一并过 correct()。
  const title = correct(s.title || '');
  const hook = correct(s.hook || '');
  const highlights = Array.isArray(s.highlights) ? s.highlights.map(correct) : [];
  const points = Array.isArray(s.points) ? s.points.map(p => ({ ...p, title: correct(p.title || ''), text: correct(p.text || '') })) : [];
  return {
    title,
    hook,
    highlights,
    points,
    transcript,
    full_markdown: markdownify({
      title,
      hook,
      highlights,
      points,
      transcript,
    }),
  };
}

/** 生成一键复制用的 Markdown 全文（V-02：含标题层级） */
function markdownify({ title, hook, highlights, points, transcript }) {
  const lines = [];
  if (title) lines.push('# ' + title);
  if (hook) lines.push('', '> ' + hook);
  if (highlights && highlights.length) {
    lines.push('', '## 金句');
    highlights.forEach((h) => lines.push('- ' + h));
  }
  if (points && points.length) {
    lines.push('', '## 内容要点');
    points.forEach((p, i) => {
      const text = typeof p === 'string' ? p : p.text || '';
      lines.push((i + 1) + '. ' + text);
    });
  }
  if (transcript) {
    lines.push('', '## 口播原文', '');
    lines.push(transcript);
  }
  return lines.join('\n');
}

/** 段落化 transcript（用于详情页分段渲染）：按空行/换行拆段，空段过滤 */
function splitParagraphs(text) {
  if (!text) return [];
  return String(text)
    .split(/\n{1,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

module.exports = { buildContent, applyEdits, markdownify, splitParagraphs, cleanTranscript, isNoiseTag, EMOJI_RE };
