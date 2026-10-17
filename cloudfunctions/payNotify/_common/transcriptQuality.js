// 无网络、无模型调用的保守校对。只改有固定搭配证据的同音词，不做全文润色。
const RULES = [
  { id: 'common-sense', re: /(?:超出|超乎|违背|不合)(?:厂理|厂里|常里)(?=的(?:好|利益|收益|回报|低价)|[，。！？；,.!?;]|$)/g, fix: s => s.slice(0, 2) + '常理' },
  { id: 'reasonable', re: /合情合里/g, fix: () => '合情合理' },
  { id: 'unthinkable', re: /不可思义/g, fix: () => '不可思议' },
  { id: 'by-rule', re: /按步就班/g, fix: () => '按部就班' },
  { id: 'make-effort', re: /再接再励/g, fix: () => '再接再厉' },
  { id: 'opposite-effect', re: /事得其反/g, fix: () => '适得其反' },
  { id: 'forgive-past', re: /既往不究/g, fix: () => '既往不咎' },
  { id: 'spread', re: /不径而走/g, fix: () => '不胫而走' },
  { id: 'cannot-wait', re: /迫不急待/g, fix: () => '迫不及待' },
  { id: 'unexpected', re: /出奇不意/g, fix: () => '出其不意' },
  { id: 'local-conditions', re: /因地治宜/g, fix: () => '因地制宜' },
  { id: 'as-always', re: /一如即往/g, fix: () => '一如既往' },
  // ⭐ 2026-10-12：「自已」在任何语境下都不是词（语音识别/模型都可能产出），恒为错 → 直接换。
  { id: 'self', re: /自已/g, fix: () => '自己' },
];

// ⭐⭐ 2026-10-12 专有名词（品牌/产品名）确定性绑定。
//   背景：本产品名「予行·文案快提」被口播说出后，
//     ① ASR 听错 —— 予行(yǔ xíng) ↔ 旅行(lǚ xíng) 仅 ü/u 之差、快提(kuài tí) ↔ 快递(kuài dì)；
//     ② 大模型收到后仍会把「予行」当错字「合理化」成常见词「旅行」——**纯文本层面无法自证**。
//   故在此显式绑定。安全策略：**只有整体模式（"XX行 + 文案快X" 连写）才替换**，
//   绝不单词级替换 → 视频真在讲「旅行」时一字不动（已回归验证）。
const PROPER_TERMS = [
  {
    canonical: '予行·文案快提',
    alias: ['旅行文案快递', '予行文案快递', '旅行文案快提', '予行文案快提'],
  },
];

const TERM_RULES = [
  {
    id: 'brand-full',
    // 旅/予/余/雨/语/育/遇/羽/预/逾/舆 + 行 [+ 可选分隔符] + 文案快{提/递/题/替/体}
    re: /[旅予余雨语育遇羽预逾舆]\s*行\s*[·•.\-—–_、]?\s*文案快[提递题替体]/g,
    fix: () => '予行·文案快提',
  },
  {
    id: 'brand-kuaidi',
    // 残留的「文案快递 / 文案快题 / 文案快替」——三者均不成词，安全替换
    re: /文案快[递题替]/g,
    fix: () => '文案快提',
  },
];

/** 供 LLM 提示词使用：显式告知哪些是专有名词、禁止改写（否则模型会「合理化」成常见词） */
const TERM_HINT =
  '【本产品专有名词（必须原样输出，禁止改写、禁止拆开）】' +
  PROPER_TERMS.map(
    (t) =>
      '「' +
      t.canonical +
      '」（语音识别常误作 ' +
      t.alias.map((a) => '「' + a + '」').join('、') +
      '，一律按正确写法输出）'
  ).join('；') +
  '。';

/* ══════════════════════════════════════════════════════════════════════════
   专有名词「参考词表」—— 提示词用**示例**，不是白名单
   ══════════════════════════════════════════════════════════════════════════
   ⭐⭐ 2026-10-12 用户明确要求「系统解决一类问题，不是解决某一个词」。
   背景：ASR 对**低频专有名词**最容易出错 —— 听不清就把同音/近音的常见词填进去
        （智谱→质朴、千问→前问、Kimi→听me）。而旧提示词里「专有名词一律不改」
        这条护栏，恰好把这一整类问题挡在了门外（不是漏了某个词，是规则方向反了）。

   本表的作用只是**让模型理解「这一类」是什么样**（few-shot 示例），
   判据始终是「同音/近音/外文空耳 + 上下文指向」，**不是「在不在表里」**。
   → 因此表外的新词同样会被还原；新增词也只需往这里加一行示例即可。

   ⚠️ 切勿把本表当白名单去做本地硬替换：表里绝大多数词都存在**正常同音词**
      （智谱↔质朴、千问↔前问），纯文本层面无法自证，硬替换必然误伤
      （「生活质朴」→「生活智谱」）。这类**必须由模型看上下文裁决**。
   ══════════════════════════════════════════════════════════════════════════ */
const COMMON_TERMS = {
  'AI / 科技产品': [
    '豆包', '智谱', 'Kimi', '通义千问', 'DeepSeek', '文心一言', '腾讯元宝', '讯飞星火',
    '即梦', '扣子', 'Manus', 'ChatGPT', 'Claude', 'Gemini', 'Midjourney', 'Sora', 'Cursor',
  ],
  '内容 / 电商平台': [
    '抖音', '快手', '小红书', '视频号', '哔哩哔哩', '知乎', '微博', '公众号',
    '淘宝', '拼多多', '京东', '美团', '饿了么', '得到', '樊登读书',
  ],
  // ⭐ 2026-10-17 新增（用户实例：ASR 把 Figma 听成「飞鸽马」）：
  //    设计/效率类工具的官方写法本身就是拉丁字母，必须整类按原文输出；
  //    这张表只是 few-shot 示例，不是白名单（表外同类同样适用同一原则）。
  '设计 / 效率工具': [
    'Figma', 'Framer', 'Sketch', 'Photoshop', 'Illustrator', 'Canva', 'Notion', 'Obsidian', 'Adobe XD',
  ],
};

/** 拼成提示词片段（给无字幕/ASR 分支用） */
function termRosterHint() {
  const parts = Object.keys(COMMON_TERMS).map(
    (k) => '· ' + k + '：' + COMMON_TERMS[k].join('、')
  );
  return [
    // ⭐⭐ 约束前置（项目铁律：追加在末尾的约束会被忽略）
    '【外文专有名词的输出形态 —— 硬约束】品牌 / 产品 / 软件 / 网站 / 模型名，一律输出**拉丁原文**' +
      '（Figma、Notion、Cursor、Claude、DeepSeek），**禁止音译或意译成汉字**（✗「飞鸽马」✗「哞神」✗「听me」）。' +
      '只有中文里已有**公认通用译名**的才写中文（如 Google→谷歌），拿不准就保留原文。' +
      '还原某个专有名词时，**本条结果里每一处出现都必须统一成同一写法**（含 highlights 摘的原句）。',
    '【参考词表（**仅为示例**：同类专有名词一律按同一原则还原，**不限此表**）】',
    ...parts,
  ].join('\n');
}

/* ══════════════════════════════════════════════════════════════════════════
   数字与符号的**书写形态**规范 —— 2026-10-12
   ══════════════════════════════════════════════════════════════════════════
   背景：用户反馈「90% 要写成数字和符号，不要写『百分之九十』，年份、播放量同理」。
   ⚠️ 这不是「我们丢过规则」——全仓库历史里从来没有数字规范条款。
      真实原因：**旧模型 SenseVoice 自带 ITN（数字归一化）**，自动把「百分之九十」输出成
      「90%」；换成 Qwen3-ASR 后它不做这步，于是中文数字原样冒出来。
      ⇒ 换模型 = 静默丢掉一项「模型顺带送的能力」，必须由本层补回来。

   分工（两层保险）：
     · **提示词层**（providers.js ASR_RULES ⑤）负责**通用判断**：数量/金额/时长/日期统一
       用阿拉伯数字，同时让模型避开成语习语（千万不要、一心一意、十分）。
     · **本层（确定性）**只做**模式唯一、零歧义**的两类，防模型漏改：
         ① `百分之X` → `X%`（「百分之」几乎只用于百分数，无歧义）
         ② 四字中文数字 + 年 → 年份（二零二六年 → 2026年）
       ⚠️ 刻意**不做**「X万/X亿」的通用转换：「千万」= must（千万不要）、「万一」= in case，
          纯文本层面无法区分「1000万」与「千万要」→ 属必须由模型看上下文的判断，硬转必误伤。
   ══════════════════════════════════════════════════════════════════════════ */
const CN_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const CN_UNIT = { '十': 10, '百': 100, '千': 1000 };
const CN_BIG = { '万': 10000, '亿': 100000000 };

/**
 * 中文数字 → 阿拉伯数字字符串，**拿不准就返回 null**（调用方保持原文）。
 * 支持：逐位直译（二零二六 → "2026"）、带单位（九十 → "90"、一百二十 → "120"、一亿两千万 → "120000000"）。
 */
function cn2arabic(raw) {
  const s = String(raw || '');
  if (!s || !/^[零〇一二两三四五六七八九十百千万亿]+$/.test(s)) return null;
  // ① 无单位 → 逐位直译（年份、编号，保留位数不折叠前导零）
  if (!/[十百千万亿]/.test(s)) {
    let out = '';
    for (const ch of s) {
      if (CN_DIGIT[ch] === undefined) return null;
      out += CN_DIGIT[ch];
    }
    return out;
  }
  // ② 带单位 → 分段累加
  let total = 0, section = 0, num = 0, seen = false;
  for (const ch of s) {
    if (CN_DIGIT[ch] !== undefined) { num = CN_DIGIT[ch]; seen = true; continue; }
    if (CN_UNIT[ch] !== undefined) { section += (num || 1) * CN_UNIT[ch]; num = 0; seen = true; continue; }
    if (CN_BIG[ch] !== undefined) { section = (section + num) * CN_BIG[ch]; total += section; section = 0; num = 0; seen = true; continue; }
    return null;
  }
  if (!seen) return null;
  return String(total + section + num);
}

const NUMBER_RULES = [
  {
    id: 'percent',
    // 「百分之九十」→「90%」；原本就是阿拉伯数字的也补上 %（「百分之10」→「10%」）
    re: /百分之\s*([零〇一二两三四五六七八九十百千万亿]+|\d+(?:\.\d+)?)/g,
    fix: (m, n) => {
      const a = /^\d/.test(n) ? n : cn2arabic(n);
      return a === null ? m : a + '%';
    },
  },
  {
    id: 'year-cn',
    // 恰好四字中文数字 + 年 → 年份（二零二六年 → 2026年）。
    //   ⚠️ 刻意只认「四字」：三字/两字的「三年」「三十年」既可能是年份也可能是时长，交模型判断。
    re: /([零〇一二两三四五六七八九]{4})年/g,
    fix: (m, n) => {
      const a = cn2arabic(n);
      return a && a.length === 4 ? a + '年' : m;
    },
  },
  {
    id: 'big-number',
    // 量级数字（播放量 / 粉丝数 / 销量 / 金额）：八十六万 → 86万；一千二百万 → 1200万；一亿两千万 → 1.2亿。
    // ⚠️ 这是本项目**最需要防误伤**的转换，三道闸缺一不可（见下方 in-fix 注释）：
    //     ① 必须含「数字字」—— 挡掉「千万（=绝不要）」「亿万」「百万」这类无数字的构词；
    //     ② 不许出现两个连续数字字 —— 挡掉「两三百万」「五六千」这类**约数**（转成 300万 会改语义）；
    //     ③ 后面必须跟标点/句末或计量名词 —— 挡掉「十万火急」「一亿两千万人」以外的构词用法。
    re: /[零〇一二两三四五六七八九十百千万亿]{2,16}/g,
    fix: (m, offset, input) => {
      const next = String(input).slice(offset + m.length);
      const tailOk =
        next === '' ||
        /^[\s，。！？；：、,.!?;]/.test(next) ||
        /^(?:播放|粉丝|粉|人|用户|下载|浏览|阅读|观看|点赞|关注|收入|订单|销量|流量|元|块|钱|次|单|条|台|名|位|美元|以上|左右|多)/.test(next);
      if (!tailOk) return m;
      const DIGITS = '零〇一二两三四五六七八九';
      if (!new RegExp('[' + DIGITS + ']').test(m)) return m; // ①
      if (new RegExp('[' + DIGITS + ']{2}').test(m)) return m; // ② 约数不动
      const endsBig = /[万亿]$/.test(m);
      const endsSmall = /[十百千]$/.test(m);
      const v = cn2arabic(m);
      if (v === null) return m;
      const n = Number(v);
      if (!isFinite(n) || n <= 0) return m;
      // 以「元/块/钱」收尾的金额 → 直接给完整阿拉伯数字（三万五千块 → 35000块）
      if (endsSmall) {
        if (!/^(?:元|块|钱)/.test(next)) return m;
        return String(Math.round(n));
      }
      if (!endsBig) return m;
      const tidy = (x) => String(Math.round(x * 100) / 100);
      if (n >= 1e8) return tidy(n / 1e8) + '亿';
      if (n >= 1e4) return tidy(n / 1e4) + '万';
      return String(n);
    },
  },
];

function compact(s) { return String(s || '').replace(/[\s，。！？；：、,.!?;:“”"'（）()]/g, ''); }

/** 字幕默认主稿；音频只用于确认同位置的局部纠错，不把不同版本全文互换。 */
function reconcileTranscript({ subtitle = '', asrText = '', transcript = '' } = {}) {
  const source = subtitle ? 'subtitle' : asrText ? 'asr' : 'transcript';
  const original = String(subtitle || asrText || transcript || '');
  const edits = [];
  let text = original;
  const audio = compact(asrText);
  for (const rule of RULES) {
    text = text.replace(rule.re, (before, offset, input) => {
      const after = rule.fix(before);
      if (before === after) return before;
      // 仅在相邻文字也相同的情况下，把另一版本作为校对证据。
      const left = compact(input.slice(Math.max(0, offset - 12), offset)).slice(-6);
      const right = compact(input.slice(offset + before.length, offset + before.length + 12)).slice(0, 6);
      const confirmed = !!audio && left.length + right.length >= 4 && audio.includes(left + compact(after) + right);
      // 两版同位置都采用原词时保留字幕，避免单靠常见搭配推翻两份来源。
      const contradicted = !!subtitle && !!audio && left.length + right.length >= 4 && audio.includes(left + compact(before) + right);
      if (contradicted && !confirmed) return before;
      edits.push({ rule: rule.id, before, after, evidence: confirmed ? 'subtitle-asr-context' : 'fixed-phrase-context' });
      return after;
    });
  }
  // 专有名词绑定放在固定搭配规则**之后**做，避免边界被同音规则先改动。
  for (const rule of TERM_RULES) {
    text = text.replace(rule.re, (before) => {
      const after = rule.fix(before);
      if (before === after) return before;
      edits.push({ rule: rule.id, before, after, evidence: 'proprietary-term' });
      return after;
    });
  }
  // 数字与符号的**书写形态**规范（确定性）—— 只动形态、不动数值，放最后做。
  //   ⚠️ 是「格式归一化」不是「用字校对」：字幕稿同样适用（字幕里写「百分之九十」一样要转）。
  for (const rule of NUMBER_RULES) {
    text = text.replace(rule.re, (before, ...args) => {
      // args = [...捕获组, offset, input] —— 原样透传，各规则按需取用
      const after = rule.fix(before, ...args);
      if (before === after) return before;
      edits.push({ rule: rule.id, before, after, evidence: 'number-format' });
      return after;
    });
  }
  return { text, source, edits, ruleVersion: '2026-10-12.2' };
}

module.exports = { reconcileTranscript, TERM_HINT, termRosterHint, PROPER_TERMS, COMMON_TERMS, cn2arabic };
