// config/pricing.js - 定价与会员档位（2026-10-16 v5：一个余额、两种显示）
// 注意：云端以 cloud-common/consts.js 为准（同一套数字，勿单边改）

/* ⭐⭐⭐ 计费模型（2026-10-16 用户拍板 v5：视频与文案**分开计费**，一个余额两种显示）
 *
 *   规则（两行讲清）：
 *     · 🎬 视频提取 —— 扣积分，分 2 档：≤10 分钟 5 积分｜10~30 分钟 10 积分；
 *     · 📝 文案提取 —— 扣积分，**起步 2 积分 + 每分钟 2 积分**（四舍五入）。
 *   两样都要 = 两项相加（视频与文案是两个独立任务，各扣一次，天然相加）。
 *
 *   ✨ 兑换率：1 积分 = 0.5 分钟文案（每分钟文案 = 2 积分）。
 *     「积分」与「分钟」是**同一笔钱的两种说法**：M 分钟 = N 积分 × 0.5，现算，不落第二份存储。
 *     非会员 1 元 = 30 积分 = 15 分钟｜会员 1 元 = 40 积分 = 20 分钟。
 *
 *   ⭐ 为什么视频与文案粒度不同（成本结构决定，不是拍脑袋）：
 *     · 视频只取源 + 存云存储 + CDN（≈0.012 + 0.003T 元）；
 *     · 文案还要跑 ASR（**按音频秒数计费**）+ LLM 整理（≈0.016 + 0.0145T 元）；
 *     文案成本斜率是视频的 5 倍 ⇒ 视频用「两档封顶」、文案用「按时长线性」，两侧才都不过收也不亏。
 *
 *   ⚠️ 数字必须与云端 `cloud-common/consts.js` 完全一致 —— 守门测试 pricing-consistency.test.cjs 会盯。
 */
const CREDIT_START_TEXT = 2; // 文案起步积分
const CREDIT_PER_MIN_TEXT = 2; // 文案每分钟积分（＝兑换率 k）
const VIDEO_TIER_MIN = 10; // 视频分档线（分钟）
const CREDIT_VIDEO_SHORT = 5; // 视频 ≤10 分钟
const CREDIT_VIDEO_LONG = 10; // 视频 10~30 分钟
const MINUTES_PER_CREDIT = 1 / CREDIT_PER_MIN_TEXT; // 1 积分 = 0.5 分钟

/** 千分位（本地实现，避免与 utils/util 循环依赖） */
function thousands(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 本次扣的**积分** —— 与云端 `computeCost().creditCost` 同口径。
 * ⚠️ 端上任何「本次要花多少」的展示都必须走这里，别自己算。
 * @param {number} durationSec 秒；0 = 未知 → 按最低档兜底（视频 5 / 文案起步 2）
 * @param {'text'|'video'} kind
 */
function creditOf(durationSec, kind) {
  const sec = Math.max(0, Number(durationSec) || 0);
  if (kind === 'video') return sec > VIDEO_TIER_MIN * 60 ? CREDIT_VIDEO_LONG : CREDIT_VIDEO_SHORT;
  return Math.max(CREDIT_START_TEXT, Math.round(CREDIT_START_TEXT + CREDIT_PER_MIN_TEXT * (sec / 60)));
}

/** 积分 → 可解析的文案分钟数（M = N × 0.5，取整到分钟） */
function minutesOfCredits(credits) {
  return Math.round((Number(credits) || 0) * MINUTES_PER_CREDIT);
}

/** 积分 → 分钟文本（带千分位；取不到给 '0'） */
function minutesText(credits) {
  const c = Number(credits) || 0;
  return c > 0 ? thousands(minutesOfCredits(c)) : '0';
}

/**
 * 单次成本 = 价格 ÷ 额度（**积分**），3 位小数。
 * ⭐ 一律**现算**、不另存常量 —— 改额度或改价时文案自动跟着变。
 * 📌 三档设计为同比例（1 元 = 40 积分）⇒ 结果均为 ¥0.025，这是有意为之（无档位歧视）。
 * ⚠️ 不限次档没有分母，返回空串。
 */
function unitPriceText(plan) {
  const p = plan || {};
  const quota = Number(p.quotaTotal) || 0;
  const price = Number(p.price) || 0;
  if (p.unlimited || quota <= 0 || price <= 0) return '';
  return '¥' + (price / quota).toFixed(3);
}

/* 会员档位定义（2026-10-16 v5）
 * ⚠️ **价格一分没动**（¥9.9 / ¥25 / ¥68）⇒ 微信后台已发布的虚拟支付道具**无需重新发布**；
 *    改的只是「发多少积分」：会员 1 元 = 40 积分（比非会员 30 积分/元便宜 25%）。
 *    月 ¥9.9 → 396 积分｜季 ¥25 → 1000 积分｜年 ¥68 → 2720 积分（三档均 ¥0.025/积分）。
 * ⚠️ 不限次档（¥19.9/月）已**下架**：覆盖不了重度用户成本；线上无存量付费会员，直接停售。
 */
const PLAN_DEF = [
  { id: 'vip_month', name: '月卡', price: 9.9, priceText: '¥9.9', durationDays: 30, quotaTotal: 396 },
  { id: 'vip_quarter', name: '季卡', price: 25, priceText: '¥25', durationDays: 90, quotaTotal: 1000 },
  { id: 'vip_year', name: '年卡 · 推荐', price: 68, priceText: '¥68', durationDays: 365, quotaTotal: 2720, recommend: true },
];

module.exports = {
  // 计费（端上任何「本次要花多少」都必须走这里）
  creditOf,
  minutesOfCredits,
  minutesText,
  unitPriceText,
  CREDIT_START_TEXT,
  CREDIT_PER_MIN_TEXT,
  VIDEO_TIER_MIN,
  CREDIT_VIDEO_SHORT,
  CREDIT_VIDEO_LONG,
  MINUTES_PER_CREDIT,

  // 新人积分（一次性，仅首次建档发放）
  TRIAL_CREDIT: 100,

  // 兑换比例：非会员 1 元 = 30 积分；会员 1 元 = 40 积分
  CREDIT_PER_YUAN: 30,
  CREDIT_PER_YUAN_MEMBER: 40,

  // 充值快捷档位（元 / 积分）—— 与 CREDIT_PER_YUAN 同源，改比例必须同步重算这几档
  RECHARGE_PRESETS: [
    { amount: 5, credits: 150 },
    { amount: 10, credits: 300 },
    { amount: 20, credits: 600 },
    { amount: 50, credits: 1500 },
    { amount: 100, credits: 3000 },
    { amount: 200, credits: 6000 },
  ],

  // 充值页默认选中档位（20 元）
  RECHARGE_DEFAULT: 20,

  // 自定义充值金额范围（元）
  CUSTOM_MIN: 1,
  CUSTOM_MAX: 200,

  // 自定义金额快捷填充
  CUSTOM_QUICK: [8, 15, 66],

  MAX_DURATION_SEC: 30 * 60, // >30min 拒绝

  // 扣分说明表（充值页「充值规则」弹窗展示，2026-10-16 v5）
  CREDIT_RULES: [
    { duration: '提取视频 · 10 分钟以内', cost: CREDIT_VIDEO_SHORT + ' 积分' },
    { duration: '提取视频 · 10~30 分钟', cost: CREDIT_VIDEO_LONG + ' 积分' },
    { duration: '提取文案', cost: '起步 ' + CREDIT_START_TEXT + ' 积分 + 每分钟 ' + CREDIT_PER_MIN_TEXT + ' 积分' },
    { duration: '视频 + 文案同时提取', cost: '两项相加' },
    { duration: '超过 30 分钟', cost: '暂不支持，已扣费用自动退回' },
  ],

  // 余额不足时的引导
  LOW_BALANCE_TIPS: [
    { scene: '偶尔缺分', action: '充值补齐' },
    { scene: '经常提取', action: '会员额度更划算' },
  ],

  // 会员档位（meta / desc 数字**现算**，不写死）
  MEMBER_PLANS: PLAN_DEF.map(function (p) {
    const mins = minutesText(p.quotaTotal);
    return Object.assign({}, p, {
      meta: p.quotaTotal + ' 积分 ≈ ' + mins + ' 分钟',
      desc: p.quotaTotal + ' 积分额度（≈ ' + mins + ' 分钟文案）',
    });
  }),

  // 「扣费规则」的口径 —— 会员说明弹窗里独立成段展示
  // ⚠️ 必须与云端 `cloud-common/consts.js#computeCost` ＋ `credit.js#settleDecision` 一致：
  //    视频提取（video-extract.js#finish）与文案提取（executeCharge）**是两个独立任务**，各扣一次
  //    → 同一条链接两样都要，天然就是「相加」。改扣减规则就要同步改这里，否则说明与实扣不符。
  CHARGE_RULES: [
    { label: '提取视频', value: '10 分钟以内 ' + CREDIT_VIDEO_SHORT + ' 积分；10~30 分钟 ' + CREDIT_VIDEO_LONG + ' 积分' },
    { label: '提取文案', value: '起步 ' + CREDIT_START_TEXT + ' 积分 + 每分钟 ' + CREDIT_PER_MIN_TEXT + ' 积分（5 分钟素材 = ' + creditOf(300, 'text') + ' 积分）' },
    { label: '视频与文案同时提取', value: '两项相加（例：30 分钟两样都要 = ' + CREDIT_VIDEO_LONG + ' + ' + creditOf(1800, 'text') + ' = ' + (CREDIT_VIDEO_LONG + creditOf(1800, 'text')) + ' 积分）' },
    { label: '积分与分钟的关系', value: '1 积分 = 0.5 分钟文案。非会员 1 元 = 30 积分 = 15 分钟；会员 1 元 = 40 积分 = 20 分钟' },
    { label: '为什么视频按档、文案按分钟', value: '文案要跑语音识别（按音频秒数计费），成本随时长涨得快 5 倍' },
  ],

  // 额度与续费规则
  // ⚠️ 结转**有前提** —— 只有继续续费才生效；到期不续费 → 剩余额度一律清零。
  QUOTA_RULES: [
    { label: '会员额度', value: '以积分计量，与充值积分同单位（会员 1 元 = 40 积分）' },
    { label: '未用完额度', value: '同一个会员周期内有效；续费可结转' },
    { label: '会员到期不续费', value: '剩余额度清零，不再保留' },
    { label: '到期前 3 天 / 1 天', value: '订阅消息提醒' },
    { label: '续费方式', value: '一键续费确认后支付' },
  ],

  // 提取内容模式（设置页单选）
  EXTRACT_MODES: [
    { id: 'full', name: '全文文案', desc: '逐句转写，保留原有表达' },
    { id: 'segment', name: '分段整理', desc: '自动分段，去掉语气词' },
    { id: 'summary', name: '摘要提炼', desc: '提炼 3 条核心要点' },
  ],

  // 文案语言
  LANGUAGES: ['中文（简体）', '中文（繁体）', 'English'],
};
