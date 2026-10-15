// config/pricing.js - 定价与会员档位（与 PRD 6.3/6.4 已拍板值对齐）
// 注意：云端以 cloud-common/consts.js 为准（同一套数字，勿单边改）

module.exports = {
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

  // 非会员单次解析消耗（按视频时长阶梯）
  CREDIT_BASIC: 5, //   ≤10min
  CREDIT_DOUBLE: 10, // 10~30min
  MAX_DURATION_SEC: 30 * 60, // >30min 拒绝

  // 扣分说明表（充值页展示）
  CREDIT_RULES: [
    { duration: '≤10 分钟', cost: '5 积分' },
    { duration: '10~30 分钟', cost: '10 积分' },
    { duration: '>30 分钟', cost: '拒绝并退回' },
  ],

  // 余额不足时的引导
  LOW_BALANCE_TIPS: [
    { scene: '偶尔缺分', action: '充值补齐' },
    { scene: '经常提取', action: '会员额度更划算' },
  ],

  // 会员档位（2026-10-15 额度上调：月 90 / 季 240 / 年 1000；不限次档 19.9/月）
  // ⚠️ 价格一分没动 ⇒ 微信后台已发布的会员道具无需重新发布。
  MEMBER_PLANS: [
    {
      id: 'vip_month',
      name: '月卡',
      price: 9.9,
      priceText: '¥9.9',
      durationDays: 30,
      quotaTotal: 90,
      meta: '90 次 · 30 天',
      desc: '每月 90 次解析额度',
    },
    {
      id: 'vip_quarter',
      name: '季卡',
      price: 25,
      priceText: '¥25',
      durationDays: 90,
      quotaTotal: 240,
      meta: '240 次 · 90 天 · 月均 ¥8.3',
      desc: '90 天共 240 次',
    },
    {
      id: 'vip_year',
      name: '年卡 · 推荐',
      price: 68,
      priceText: '¥68',
      durationDays: 365,
      quotaTotal: 1000,
      meta: '1000 次 · 365 天 · 月均 ¥5.7',
      desc: '365 天共 1000 次',
      recommend: true,
    },
    {
      id: 'vip_unlimited',
      name: '不限次档',
      price: 19.9,
      priceText: '¥19.9 / 月',
      durationDays: 30,
      unlimited: true,
      meta: '30 天不限次数 · 单日无上限',
      desc: '30 天不限次数',
    },
  ],

  // 会员权益表（会员中心展示）
  MEMBER_BENEFITS: [
    { label: '额度内解析', value: '不扣积分' },
    { label: '长视频（> 10 分钟）', value: '计 2 次' },
    { label: '单次最长', value: '30 分钟' },
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
