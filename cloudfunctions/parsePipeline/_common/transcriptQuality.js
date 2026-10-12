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
};

/** 拼成提示词片段（给无字幕/ASR 分支用） */
function termRosterHint() {
  const parts = Object.keys(COMMON_TERMS).map(
    (k) => '· ' + k + '：' + COMMON_TERMS[k].join('、')
  );
  return [
    '【参考词表（**仅为示例**：同类专有名词一律按同一原则还原，**不限此表**）】',
    ...parts,
  ].join('\n');
}

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
  return { text, source, edits, ruleVersion: '2026-10-12.1' };
}

module.exports = { reconcileTranscript, TERM_HINT, termRosterHint, PROPER_TERMS, COMMON_TERMS };
