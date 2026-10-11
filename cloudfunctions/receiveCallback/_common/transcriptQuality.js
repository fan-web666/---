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
  return { text, source, edits, ruleVersion: '2026-10-09.1' };
}

module.exports = { reconcileTranscript };
