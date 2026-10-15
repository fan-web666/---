// config/pricing.js - 定价与会员档位（与 PRD 6.3/6.4 已拍板值对齐）
// 注意：云端以 cloud-common/consts.js 为准（同一套数字，勿单边改）

/**
 * 单次成本 = 价格 ÷ 额度，3 位小数（月 ¥0.165 / 季 ¥0.167 / 年 ¥0.170）。
 * ⭐ 一律**现算**、不另存常量 —— 改额度或改价时文案自动跟着变，
 *    不会出现「价格改了、成本文案没跟着改」这种脏数据。
 * ⚠️ 不限次档没有分母，返回空串，由调用方决定显示什么。
 * @param {object} plan MEMBER_PLANS 里的一项
 * @returns {string} 形如 '¥0.165'；取不到返回 ''
 */
function unitPriceText(plan) {
  const p = plan || {};
  const quota = Number(p.quotaTotal) || 0;
  const price = Number(p.price) || 0;
  if (p.unlimited || quota <= 0 || price <= 0) return '';
  return '¥' + (price / quota).toFixed(3);
}

/* ⭐⭐⭐ 计费模型（2026-10-15 用户定稿：视频提取与文案提取**分开计费**）
 *   规则一句话：视频「每 15 分钟 1 单位」｜文案「每 3 分钟 1 单位」｜两样都要就**相加**。
 *   为什么粒度不同（成本结构决定的，不是拍脑袋）：
 *     · 提取视频 = 只取源 + 存云存储 + CDN，成本 ≈ 0.012 + 0.003T 元/分钟；
 *     · 提取文案 = 还要跑 ASR（**按音频秒数计费**）+ LLM 整理，成本 ≈ 0.016 + 0.0145T 元/分钟；
 *     文案成本随时长涨得快 5 倍 ⇒ 用同一个粒度必然一边过收、一边亏本。
 *   1 单位 = 5 积分（非会员）＝ 1 次会员额度（1 元 = 30 积分）。
 *   ⚠️ 数字必须与云端 `cloud-common/consts.js` 完全一致 —— 守门测试 pricing-consistency.test.cjs 会盯。
 */
const UNIT_TEXT_MIN = 3; // 文案：每 3 分钟 1 单位
const UNIT_VIDEO_MIN = 15; // 视频：每 15 分钟 1 单位
const CREDIT_PER_UNIT = 5; // 1 单位 = 5 积分（非会员）

/** 时长 → 单位数（不足 1 个单位按 1 个；时长未知按 1） */
function unitsOf(durationSec, kind) {
  const sec = Number(durationSec) || 0;
  const per = (kind === 'video' ? UNIT_VIDEO_MIN : UNIT_TEXT_MIN) * 60;
  if (!(sec > 0)) return 1;
  return Math.max(1, Math.ceil(sec / per));
}

/** 非会员积分（＝单位数 × 5），与云端 computeCost().creditCost 同口径 */
function creditOf(durationSec, kind) {
  return unitsOf(durationSec, kind) * CREDIT_PER_UNIT;
}

module.exports = {
  // 单次成本（会员卡面 / 会员说明共用同一实现）
  unitPriceText,
  // 单位换算（端上任何「本次要花多少」的展示都必须走这里，别自己算）
  unitsOf,
  creditOf,
  UNIT_TEXT_MIN,
  UNIT_VIDEO_MIN,
  CREDIT_PER_UNIT,

  // 新人积分（一次性，仅首次建档发放）
  TRIAL_CREDIT: 100,

  // 兑换比例：1 元 = 30 积分（2026-10-15 由 20 上调）
  CREDIT_PER_YUAN: 30,

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

  // 扣分说明表（充值页「充值规则」弹窗展示，2026-10-15 改为单位制）
  CREDIT_RULES: [
    { duration: '提取视频 · 每 15 分钟', cost: '5 积分（会员扣 1 次额度）' },
    { duration: '提取文案 · 每 3 分钟', cost: '5 积分（会员扣 1 次额度）' },
    { duration: '视频 + 文案同时提取', cost: '两项相加' },
    { duration: '超过 30 分钟', cost: '暂不支持，已扣费用自动退回' },
  ],

  // 余额不足时的引导
  LOW_BALANCE_TIPS: [
    { scene: '偶尔缺分', action: '充值补齐' },
    { scene: '经常提取', action: '会员额度更划算' },
  ],

  // 会员档位（2026-10-15 定价体系重构：**价格一分没动**，只下调额度 ⇒ 微信虚拟支付道具无需重新发布）
  // ⭐ 额度是「单位」口径：文案每 3 分钟 1 次、视频每 15 分钟 1 次（见上）。
  // ⚠️ 不限次档（¥19.9/月）已**下架**：覆盖不了重度用户成本（30 分钟文案单次成本约 ¥0.45）。
  //    存量已购用户到期前权益不变，但这里不再展示、也不能再买（云端 api 侧同样拦了）。
  MEMBER_PLANS: [
    {
      id: 'vip_month',
      name: '月卡',
      price: 9.9,
      priceText: '¥9.9',
      durationDays: 30,
      quotaTotal: 60,
      meta: '60 次额度 · 30 天',
      desc: '每月 60 次提取额度',
    },
    {
      id: 'vip_quarter',
      name: '季卡',
      price: 25,
      priceText: '¥25',
      durationDays: 90,
      quotaTotal: 150,
      meta: '150 次额度 · 90 天',
      desc: '90 天共 150 次',
    },
    {
      id: 'vip_year',
      name: '年卡 · 推荐',
      price: 68,
      priceText: '¥68',
      durationDays: 365,
      quotaTotal: 400,
      meta: '400 次额度 · 365 天',
      desc: '365 天共 400 次',
      recommend: true,
    },
  ],

  // 「单次」的口径 —— 会员说明弹窗里独立成段展示
  // ⚠️ 必须与云端 `cloud-common/consts.js#computeCost` ＋ `credit.js#settleDecision` 一致：
  //    视频提取（video-extract.js#finish）与文案提取（executeCharge）**是两个独立任务**，各扣一次
  //    → 同一条链接两样都要，天然就是「相加」。改扣减规则就要同步改这里，否则说明与实扣不符。
  // 📌 本条取代了原来那张**从未被渲染**的 MEMBER_BENEFITS 表（避免同一件事留两份定义）。
  UNIT_RULES: [
    { label: '提取视频', value: '每 15 分钟算 1 次（不足 15 分钟按 1 次）' },
    { label: '提取文案', value: '每 3 分钟算 1 次（不足 3 分钟按 1 次）' },
    { label: '视频与文案同时提取', value: '两项相加（例：30 分钟两样都要 = 2 + 10 = 12 次）' },
    { label: '为什么粒度不同', value: '文案要跑语音识别（按音频秒数计费），成本随时长涨得快 5 倍' },
  ],

  // 额度与续费规则
  // ⚠️ 2026-10-15 用户明确：结转**有前提** —— 只有继续续费才生效；
  //    会员到期且不续费 → 剩余额度一律清零（不限档位）。文案必须体现这个前提，
  //    不能写成无条件的「不清零」。
  QUOTA_RULES: [
    { label: '未用完额度', value: '同一个会员周期内有效；续费可结转' },
    { label: '会员到期不续费', value: '剩余额度清零，不再保留' },
    { label: '到期前 3 天 / 1 天', value: '订阅消息提醒' },
    { label: '续费方式', value: '一键续费确认后支付' },
    { label: '不限次档', value: '已下架；存量用户到期前权益不变' },
  ],

  // 提取内容模式（设置页单选）
  EXTRACT_MODES: [
    {
      id: 'full',
      name: '全文文案',
      desc: '逐句转写，保留原有表达',
    },
    {
      id: 'segment',
      name: '分段整理',
      desc: '自动分段，去掉语气词',
    },
    {
      id: 'summary',
      name: '摘要提炼',
      desc: '提炼 3 条核心要点',
    },
  ],

  // 文案语言
  LANGUAGES: ['中文（简体）', '中文（繁体）', 'English'],
};
