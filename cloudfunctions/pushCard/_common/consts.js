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
// ⚠️ 2026-10-15 定价体系重构：**价格一分没动**（¥9.9 / ¥25 / ¥68 / ¥19.9 全部不变）
//    ⇒ 微信后台已发布的虚拟支付道具**无需重新发布**，这次改的只是「额度」。
//    额度依据 = 新计费单位（文案每 3 分钟 1 单位 / 视频每 15 分钟 1 单位）＋ 守「售价 ≥ 2.5 倍成本」：
//      月 ¥9.9 → 60 单位（¥0.165/单位）｜季 ¥25 → 150（¥0.167）｜年 ¥68 → 400（¥0.170）
//    ⚠️ 老用户**存量额度不受影响**（额度只在购买/续费时按当时口径发放）。
//    quotaMonthly 是「月均」口径，仅为展示与旧数据兼容，**不参与扣减**（扣减只认 quotaTotal / quota.remaining）。
const MEMBER_PLANS = {
  vip_month: { id: 'vip_month', tier: MEMBER_TIERS.MONTHLY, priceCents: 990, durationDays: 30, quotaMonthly: 60, quotaTotal: 60, unlimited: false },
  vip_quarter: { id: 'vip_quarter', tier: MEMBER_TIERS.QUARTERLY, priceCents: 2500, durationDays: 90, quotaMonthly: 50, quotaTotal: 150, unlimited: false },
  vip_year: { id: 'vip_year', tier: MEMBER_TIERS.YEARLY, priceCents: 6800, durationDays: 365, quotaMonthly: 33, quotaTotal: 400, unlimited: false },
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

// 自定义充值金额范围（元）
// ⚠️ 必须与端上 config/pricing.js 的 CUSTOM_MIN / CUSTOM_MAX 同值，改一处必改两处。
//    代币模式下任意金额都能下单，这里只是业务侧风控上限（同时也是与「代币比例」无关的独立约束）。
const CUSTOM_MIN_YUAN = 1;
const CUSTOM_MAX_YUAN = 200;

// ⭐⭐⭐ 计费模型（2026-10-15 用户定稿：视频提取与文案提取**分开计费**）
//   规则一句话：视频「每 15 分钟 1 单位」，文案「每 3 分钟 1 单位」，两样都要就**相加**。
//   为什么粒度不同（是成本结构决定的，不是拍脑袋）：
//     · 视频提取只取源 + 存云存储 + CDN，成本 ≈ 0.012 + 0.003T 元；
//     · 文案提取还要跑 ASR（**按音频秒数计费**）+ LLM 整理，成本 ≈ 0.016 + 0.0145T 元；
//     文案成本随时长涨得快 5 倍 ⇒ 同一个粒度必然一边过收、一边亏本。
//   1 单位 = 5 积分（非会员）＝ 1 次会员额度；1 元 = 30 积分。
//   ⚠️ 时长由「扣费前读 MP4 头 1MB」得到（providers.js#probeDuration）；探测失败传 0 → 按最低档兜底。
const UNIT_TEXT_SEC = 3 * 60; // 文案：每 3 分钟 1 单位（≤30 分钟 → 最多 10 单位）
const UNIT_VIDEO_SEC = 15 * 60; // 视频：每 15 分钟 1 单位（≤30 分钟 → 最多 2 单位）
const CREDIT_PER_UNIT = 5; // 1 单位 = 5 积分（非会员）
const MAX_DURATION_SEC = 30 * 60; //  >30min 拒绝
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // ≤100MB（PRD 6.3）
const MAX_USER_CONCURRENT = 3; // 单用户同时 ≤3 个任务

// 会员到期提醒：到期前 3 天 / 1 天（PRD 6.3/6.4）
const RENEW_REMIND_DAYS = [3, 1];

// 同视频当日去重窗口（毫秒）
const DUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 时长 → 单位数（不足 1 个单位按 1 个单位；时长未知返回 1 = 最低档）
 * @param {number} durationSec 秒；0 = 未知
 * @param {'text'|'video'} kind
 */
function unitsFor(durationSec, kind) {
  const sec = Number(durationSec) || 0;
  const per = kind === 'video' ? UNIT_VIDEO_SEC : UNIT_TEXT_SEC;
  if (!(sec > 0)) return 1;
  return Math.max(1, Math.ceil(sec / per));
}

/**
 * 按「提取什么 + 时长」算扣费档
 *
 * ⭐ 视频提取与文案提取是**两个独立任务**（tasks.extract_kind = 'video' / 'text'）：
 *    同一条链接两样都要 → 建两个任务、各扣一次，天然就是「相加」，故这里不需要 kind='both'。
 *
 * @param {number} durationSec 秒；0 = 时长未知（探测失败 → 按最低档）
 * @param {'text'|'video'} kind 提取类型；⚠️ 缺省按 'text'（历史调用方都是文案链路）
 * @returns {{allowed:boolean, level:'basic'|'multi'|'reject', kind:string, units:number,
 *            videoUnits:number, textUnits:number, creditCost:number, quotaUnits:number}}
 *   creditCost —— 非会员扣的**积分**（单位数 × 5）
 *   quotaUnits —— 会员扣的**次数额度**（＝单位数）；与积分是两条独立口径，别联动
 */
function computeCost(durationSec, kind) {
  const k = kind === 'video' ? 'video' : 'text';
  const sec = Number(durationSec) || 0;
  if (sec > MAX_DURATION_SEC) {
    return { allowed: false, level: 'reject', kind: k, units: 0, videoUnits: 0, textUnits: 0, creditCost: 0, quotaUnits: 0 };
  }
  const units = unitsFor(sec, k);
  return {
    allowed: true,
    level: units > 1 ? 'multi' : 'basic',
    kind: k,
    units,
    videoUnits: k === 'video' ? units : 0,
    textUnits: k === 'text' ? units : 0,
    creditCost: units * CREDIT_PER_UNIT,
    quotaUnits: units,
  };
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
  UNIT_TEXT_SEC,
  UNIT_VIDEO_SEC,
  CREDIT_PER_UNIT,
  MAX_DURATION_SEC,
  MAX_FILE_SIZE_BYTES,
  MAX_USER_CONCURRENT,
  RENEW_REMIND_DAYS,
  DUP_WINDOW_MS,
  unitsFor,
  computeCost,
};
