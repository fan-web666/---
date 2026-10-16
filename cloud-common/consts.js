// _common/consts.js - 云端常量与规则（PRD 6.3/6.4 v0.3.8 已拍板；与小程序 config/pricing.js 同源）
// 注意：改这里后需同步改小程序端 config/pricing.js，二者数字必须一致

const DB_COLLECTIONS = {
  users: 'users',
  referralCodes: 'referral_codes',
  referralBindings: 'referral_bindings',
  copywritings: 'copywritings',
  tasks: 'tasks',
  orders: 'orders',
  creditLogs: 'credit_logs',
  events: 'events',
  config: 'app_config', // 全局开关/元数据（如 access_token 缓存）
};

// 任务状态。
// ⚠️ downloading 与 transcribing 必须分开：云函数单次调用最长 60 秒，
//    5 分钟以上视频「下载（几十秒）+ 转写（几十秒）」串在一步里必定被强杀，
//    任务会卡死在中间态、前端只能看到「解析超时」。
//    拆开后每一步都落在 60 秒内，任一步被中断都能从断点续跑。
const TASK_STATUS = {
  PENDING: 'pending', // 取源 + 扣费
  DOWNLOADING: 'downloading', // 只下载视频到 /tmp
  TRANSCRIBING: 'transcribing', // 字幕优先 / 语音转写
  ASR: 'asr', // 结构化整理（历史命名，勿改，兼容进行中任务）
  LLM: 'llm', // 同上，历史遗留
  DONE: 'done',
  FAILED: 'failed',
};

const MEMBER_TIERS = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
  UNLIMITED: 'unlimited',
};

// 会员档位：price 分、durationDays、额度；unlimited 无额度
// ⭐⭐⭐ 2026-10-16 定价体系 v5（单余额双显示，用户拍板）：
//    · **价格一分没动**（¥9.9 / ¥25 / ¥68）⇒ 微信后台已发布的虚拟支付道具**无需重新发布**；
//    · 额度**单位由「次数」改为「积分」**：会员 1 元 = 40 积分（比非会员 30 积分/元便宜 25%）
//      → 月 ¥9.9 → 396 积分｜季 ¥25 → 1000 积分｜年 ¥68 → 2720 积分。
//    · 扣减一律按「积分」（见 computeCost）：视频扣 5/10，文案按「起步 2 + 每分钟 2」扣。
//    ✨ 界面「积分」与「分钟」是**同一笔钱的两种说法**：M 分钟 = N 积分 × 0.5（1 积分 = 0.5 分钟），
//       即 1 元 = 30 积分 = 15 分钟（非会员）／1 元 = 40 积分 = 20 分钟（会员）。
//    ⚠️ **不做存量折算**（2026-10-16 用户明确：线上尚无真实付费会员，测试账号自己人可忽略）
//       —— quota.remaining 直接按**积分**语义使用。
//    quotaMonthly 是「月均」口径，仅供展示，**不参与扣减**（扣减只认 quotaTotal / quota.remaining）。
const MEMBER_PLANS = {
  vip_month: { id: 'vip_month', tier: MEMBER_TIERS.MONTHLY, priceCents: 990, durationDays: 30, quotaMonthly: 396, quotaTotal: 396, unlimited: false },
  vip_quarter: { id: 'vip_quarter', tier: MEMBER_TIERS.QUARTERLY, priceCents: 2500, durationDays: 90, quotaMonthly: 333, quotaTotal: 1000, unlimited: false },
  vip_year: { id: 'vip_year', tier: MEMBER_TIERS.YEARLY, priceCents: 6800, durationDays: 365, quotaMonthly: 227, quotaTotal: 2720, unlimited: false },
  // ⭐ 不限次档 2026-10-15 用户决定**下架**：¥19.9 覆盖不了重度用户成本
  //    （30 分钟文案单次成本 ¥0.45，一天 10 次就是 ¥4.5/天）。保留定义只为两件事：
  //    ① 存量已购用户的权益判定（自然到期为止）；② 端上按 offShelf 隐藏。
  //    ⚠️ 不许再卖出 —— 下单入口 api/index.js#createMemberOrder 校验 offShelf 并抛错；
  //    ❗ 回调发货链路（order.js#deliverOrder）**故意不拦**：用户已付款必须发货，拦了等于吞钱。
  vip_unlimited: { id: 'vip_unlimited', tier: MEMBER_TIERS.UNLIMITED, priceCents: 1990, durationDays: 30, unlimited: true, offShelf: true },
};

// 充值档位：amountCents / credits
const RECHARGE_PRESETS = [
  { id: 'credit_50', amountCents: 500, credits: 150 },
  { id: 'credit_100', amountCents: 1000, credits: 300 },
  { id: 'credit_200', amountCents: 2000, credits: 600 },
  { id: 'credit_500', amountCents: 5000, credits: 1500 },
  { id: 'credit_1000', amountCents: 10000, credits: 3000 },
  { id: 'credit_2000', amountCents: 20000, credits: 6000 },
];

// 新人积分（一次性）
const TRIAL_CREDIT = 100;

// 兑换 1 元 = 30 积分（2026-10-15 由 20 上调）
// ⚠️ 与「支付代币比例」COIN_PER_YUAN 是两码事：代币仍是 1 元 = 10 代币，且微信后台发布后不可改，别动它。
const CREDIT_PER_YUAN = 30;

// 会员兑换：1 元 = 40 积分（比非会员便宜 25%）—— 2026-10-16 v5
// ⚠️ 它决定会员额度：quotaTotal = 价格(元) × 40（月 9.9→396 / 季 25→1000 / 年 68→2720）
const CREDIT_PER_YUAN_MEMBER = 40;

// 自定义充值金额范围（元）
// ⚠️ 必须与端上 config/pricing.js 的 CUSTOM_MIN / CUSTOM_MAX 同值，改一处必改两处。
//    代币模式下任意金额都能下单，这里只是业务侧风控上限（同时也是与「代币比例」无关的独立约束）。
const CUSTOM_MIN_YUAN = 1;
const CUSTOM_MAX_YUAN = 200;

// ⭐⭐⭐ 计费模型（2026-10-16 用户拍板 v5：视频与文案**分开计费**，单余额双显示）
//   规则（两行讲清）：
//     · 🎬 视频提取 —— 扣积分，分 2 档：≤10 分钟 **5 积分**｜10~30 分钟 **10 积分**；
//     · 📝 文案提取 —— 扣积分，**起步 2 积分 + 每分钟 2 积分**（四舍五入）。
//   两样都要 = 两项相加（视频与文案是两个独立任务、各扣一次，天然相加，不需 kind='both'）。
//   ⭐ 兑换率：1 积分 = 0.5 分钟文案（每分钟文案 = 2 积分）—— 界面「N 积分 / M 分钟」是同一笔钱的两种说法。
//     非会员 1 元 = 30 积分 = 15 分钟｜会员 1 元 = 40 积分 = 20 分钟。
//   ⭐ 为什么视频与文案粒度不同（成本结构决定，不是拍脑袋）：
//     · 视频提取只取源 + 存云存储 + CDN，成本 ≈ 0.012 + 0.003T 元；
//     · 文案提取还要跑 ASR（**按音频秒数计费**）+ LLM 整理，成本 ≈ 0.016 + 0.0145T 元；
//     文案成本随时长涨得快 5 倍 ⇒ 视频用「两档封顶」、文案用「按时长线性」，两侧才都不过收也不亏。
//   ⚠️ 时长由「扣费前只读 MP4 头 1MB」得到（providers.js#probeDuration，四平台实测 4/4、127~620ms）；
//      探测失败传 0 → 按**最低档兜底**（视频 5 积分 / 文案起步 2 积分），**绝不多扣用户**。
const CREDIT_START_TEXT = 2; // 文案起步积分（覆盖与时长无关的固定开销 ≈¥0.016）
const CREDIT_PER_MIN_TEXT = 2; // 文案每分钟积分（＝兑换率 k：1 积分 = 0.5 分钟）
const VIDEO_TIER_SEC = 10 * 60; // 视频分档线：≤10 分钟 / 10~30 分钟
const CREDIT_VIDEO_SHORT = 5; // 视频 ≤10 分钟
const CREDIT_VIDEO_LONG = 10; // 视频 10~30 分钟
const MINUTES_PER_CREDIT = 1 / CREDIT_PER_MIN_TEXT; // 1 积分 = 0.5 分钟（界面双显示用）
const MAX_DURATION_SEC = 30 * 60; //  >30min 拒绝
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // ≤100MB（PRD 6.3）
const MAX_USER_CONCURRENT = 3; // 单用户同时 ≤3 个任务

// 会员到期提醒：到期前 3 天 / 1 天（PRD 6.3/6.4）
const RENEW_REMIND_DAYS = [3, 1];

// 同视频当日去重窗口（毫秒）
const DUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 按「提取什么 + 时长」算扣费（**积分**；会员与非会员同一公式，差别只在「1 元给多少积分」）
 *
 * ⭐ 视频提取与文案提取是**两个独立任务**（tasks.extract_kind = 'video' / 'text'）：
 *    同一条链接两样都要 → 建两个任务、各扣一次，天然就是「相加」，故这里不需要 kind='both'。
 *
 * @param {number} durationSec 秒；0 = 时长未知（探测失败 → 按最低档兜底，绝不多扣）
 * @param {'text'|'video'} kind 提取类型；⚠️ 缺省按 'text'（历史调用方都是文案链路）
 * @returns {{allowed:boolean, level:'basic'|'multi'|'reject', kind:string,
 *            creditCost:number, durationSec:number}}
 *   creditCost —— 本次扣的**积分**（视频 5 / 10；文案 起步 2 + 每分钟 2）
 */
function computeCost(durationSec, kind) {
  const k = kind === 'video' ? 'video' : 'text';
  const sec = Math.max(0, Number(durationSec) || 0);
  if (sec > MAX_DURATION_SEC) {
    return { allowed: false, level: 'reject', kind: k, creditCost: 0, durationSec: sec };
  }
  let cost;
  if (k === 'video') {
    cost = sec > VIDEO_TIER_SEC ? CREDIT_VIDEO_LONG : CREDIT_VIDEO_SHORT;
  } else {
    // 文案：起步 + 每分钟（四舍五入）；sec=0（未知）→ 起步 2，即最低档兜底
    cost = Math.max(CREDIT_START_TEXT, Math.round(CREDIT_START_TEXT + CREDIT_PER_MIN_TEXT * (sec / 60)));
  }
  return {
    allowed: true,
    level: cost > CREDIT_START_TEXT ? 'multi' : 'basic',
    kind: k,
    creditCost: cost,
    durationSec: sec,
  };
}

/** 积分 → 可解析的文案分钟数（界面双显示：M = N × 0.5，取整到整数分钟） */
function minutesOfCredits(credits) {
  return Math.round((Number(credits) || 0) * MINUTES_PER_CREDIT);
}

module.exports = {
  DB_COLLECTIONS,
  TASK_STATUS,
  MEMBER_TIERS,
  MEMBER_PLANS,
  RECHARGE_PRESETS,
  TRIAL_CREDIT,
  CREDIT_PER_YUAN,
  CREDIT_PER_YUAN_MEMBER,
  CUSTOM_MIN_YUAN,
  CUSTOM_MAX_YUAN,
  CREDIT_START_TEXT,
  CREDIT_PER_MIN_TEXT,
  VIDEO_TIER_SEC,
  CREDIT_VIDEO_SHORT,
  CREDIT_VIDEO_LONG,
  MINUTES_PER_CREDIT,
  MAX_DURATION_SEC,
  MAX_FILE_SIZE_BYTES,
  MAX_USER_CONCURRENT,
  RENEW_REMIND_DAYS,
  DUP_WINDOW_MS,
  computeCost,
  minutesOfCredits,
};
