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

/**
 * 组装 content（原文 + 结构化并存，PRD 1.3）
 * @param {object} structured llmStructure 输出（可能缺 transcript）
 * @param {string} transcriptText ASR 原文
 */
function buildContent(structured, transcriptText) {
  const s = structured || {};
  const correct = text => reconcileTranscript({ transcript: text }).text;
  // ⭐ 2026-10-12 提取精度：优先采用大模型回填的「校对后全文」——
  //    无字幕（语音识别主稿）时它已修掉同音错别字（夺舌→夺舍 / 京剧→金句 / 频繁→平淡），
  //    有字幕时提示词要求原样回填字幕版，等价于原稿。
  //    兜底防模型偷懒（返回空 / 明显变短）→ 一律回退原稿，绝不因模型失手丢内容：
  const compactLen = t => String(t || '').replace(/\s/g, '').length;
  const raw = transcriptText || '';
  const llmText = String(s.transcript || '').trim();
  const srcLen = compactLen(raw);
  const usable = compactLen(llmText) > 0 && (srcLen === 0 || compactLen(llmText) >= srcLen * 0.6);
  // 主稿已经过字幕/音频对照；这里只再跑一遍**本地固定搭配规则**（不依赖模型，纯确定性）——
  // ⚠️ 原实现漏掉了这一步：规则库只作用于 hook/highlights/points，「口播原文」从未被纠错。
  const transcript = correct(usable ? llmText : (raw || llmText));
  const hook = correct(s.hook || '');
  const highlights = Array.isArray(s.highlights) ? s.highlights.map(correct) : [];
  const points = Array.isArray(s.points) ? s.points.map(p => ({ ...p, title: correct(p.title || ''), text: correct(p.text || '') })) : [];
  return {
    hook,
    highlights,
    points,
    transcript,
    full_markdown: markdownify({
      title: s.title || '',
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

module.exports = { buildContent, markdownify, splitParagraphs, cleanTranscript, isNoiseTag, EMOJI_RE };
