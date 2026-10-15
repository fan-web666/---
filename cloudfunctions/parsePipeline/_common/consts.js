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
// ⚠️ 2026-10-15 额度上调（月 60→80 / 季 180→240 / 年 720→800），**价格一分没动**
//    ⇒ 微信后台已发布的 4 个会员道具（¥9.9 / ¥25 / ¥68 / ¥19.9）**无需重新发布**。
//    quotaMonthly 是「月均」口径，仅为展示与旧数据兼容，**不参与扣减**（扣减只认 quotaTotal / quota.remaining）。
//    单次成本 = priceCents/100 ÷ quotaTotal（月 ¥0.124 / 季 ¥0.104 / 年 ¥0.085），端上按同一公式现算，不另存常量。
const MEMBER_PLANS = {
  vip_month: { id: 'vip_month', tier: MEMBER_TIERS.MONTHLY, priceCents: 990, durationDays: 30, quotaMonthly: 80, quotaTotal: 80, unlimited: false },
  vip_quarter: { id: 'vip_quarter', tier: MEMBER_TIERS.QUARTERLY, priceCents: 2500, durationDays: 90, quotaMonthly: 80, quotaTotal: 240, unlimited: false },
  vip_year: { id: 'vip_year', tier: MEMBER_TIERS.YEARLY, priceCents: 6800, durationDays: 365, quotaMonthly: 67, quotaTotal: 800, unlimited: false },
  vip_unlimited: { id: 'vip_unlimited', tier: MEMBER_TIERS.UNLIMITED, priceCents: 1990, durationDays: 30, unlimited: true },
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

// 自定义充值金额范围（元）
// ⚠️ 必须与端上 config/pricing.js 的 CUSTOM_MIN / CUSTOM_MAX 同值，改一处必改两处。
//    代币模式下任意金额都能下单，这里只是业务侧风控上限（同时也是与「代币比例」无关的独立约束）。
const CUSTOM_MIN_YUAN = 1;
const CUSTOM_MAX_YUAN = 200;

// 非会员单次解析消耗（时长阶梯）
const CREDIT_BASIC = 5; //  ≤10min
const CREDIT_DOUBLE = 10; // 10~30min
const MAX_DURATION_SEC = 30 * 60; //  >30min 拒绝
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // ≤100MB（PRD 6.3）
const MAX_USER_CONCURRENT = 3; // 单用户同时 ≤3 个任务

// 会员到期提醒：到期前 3 天 / 1 天（PRD 6.3/6.4）
const RENEW_REMIND_DAYS = [3, 1];

// 同视频当日去重窗口（毫秒）
const DUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 按视频时长算扣费档（PRD v0.3.8 时长阶梯）
 * @returns {{allowed:boolean, level:'basic'|'double'|'reject', creditCost:number, quotaUnits:number}}
 */
function computeCost(durationSec) {
  const sec = Number(durationSec) || 0;
  if (sec <= 0) return { allowed: true, level: 'basic', creditCost: CREDIT_BASIC, quotaUnits: 1 };
  if (sec <= 10 * 60) return { allowed: true, level: 'basic', creditCost: CREDIT_BASIC, quotaUnits: 1 };
  if (sec <= MAX_DURATION_SEC) return { allowed: true, level: 'double', creditCost: CREDIT_DOUBLE, quotaUnits: 2 };
  return { allowed: false, level: 'reject', creditCost: 0, quotaUnits: 0 };
}

module.exports = {
  DB_COLLECTIONS,
  TASK_STATUS,
  MEMBER_TIERS,
  MEMBER_PLANS,
  RECHARGE_PRESETS,
  TRIAL_CREDIT,
  CREDIT_PER_YUAN,
  CUSTOM_MIN_YUAN,
  CUSTOM_MAX_YUAN,
  CREDIT_BASIC,
  CREDIT_DOUBLE,
  MAX_DURATION_SEC,
  MAX_FILE_SIZE_BYTES,
  MAX_USER_CONCURRENT,
  RENEW_REMIND_DAYS,
  DUP_WINDOW_MS,
  computeCost,
};
