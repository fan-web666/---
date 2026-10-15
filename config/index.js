// config/index.js - 全局配置（部署前必改项集中在此）
module.exports = {
  // 云开发环境 ID（微信开发者工具 → 云开发控制台顶部可查）
  cloudEnvId: 'cloud1-d7gise35e0871a08d',

  // 产品与品牌
  appName: '极速视频文案提取',
  slogan: '粘贴链接，一键提取文案',

  // 服务号（A 链路：接收视频号转发 → 客服消息回推）
  // serviceAccountName：展示与复制用名称（设计稿 14_93 一致）
  // serviceAccountGzhId：公众号原始 ID（gh_xxxxxxxx），用于 wx.openOfficialAccountProfile
  //   —— 需与小程序同主体或关联主体，基础库 3.7.10+；为空则降级为「复制名称」引导
  serviceAccountName: '予行-文案快提',
  serviceAccountGzhId: '',

  // 开发者微信号（「我的 › 帮助与反馈」弹窗里展示 + 一键复制）
  // ⚠️ 2026-09-28 用户要求：帮助与反馈点击后显示微信号，样式参考「知了随记」的「联系开发者」
  //   —— 与知了随记同一微信号，改这里即可同步两端。
  developerWechat: 'Nwlgps',

  // 服务号配置（A 链路：接收视频号转发 → 客服消息回推）
  wxCallbackToken: 'your-wechat-callback-token',
  wxGzhAppId: 'your-gzh-appid',
  wxGzhSecret: 'your-gzh-secret',

  // 云存储临时目录前缀
  tmpCloudDir: 'tmp/',

  // 使用说明页「视频教程」的视频（2026-10-12 新增）
  // ⚠️ 视频只能放**云存储**：主包 ≤2MB、单个分包也 ≤2MB，8MB 级视频打不进包内。
  // ⚠️ 这里填**云存储 fileID**（cloud:// 开头），不是控制台的「下载地址」：
  //    云开发控制台 → 存储 → 上传 mp4 → 点该文件名 → 复制 File ID → 粘到这里。
  // ⚠️ 云存储权限必须是「所有用户可读」（控制台 → 存储 → 权限设置），否则用户端拿不到临时链接。
  // 留空 → 使用说明页**不显示**该入口（不会出现「点了没反应」的坏入口）。
  guideVideoFileId: 'cloud://cloud1-d7gise35e0871a08d.636c-cloud1-d7gise35e0871a08d-1496075645/短视频文案提取流程.mp4',

  // 支持的平台（首页副标题用）
  platforms: ['抖音', '快手', '小红书', '视频号', 'B 站'],

  // 客户端向云函数 api 网关的超时提示
  apiTimeoutTip: '网络开小差了，请稍后重试',

  // 「我的」页「版本信息」展示值
  // ⚠️ 运行时优先用 wx.getAccountInfoSync().miniProgram.version（体验版/正式版可拿到真实版本号），
  //    取不到（开发者工具里常为空）才回落这里，别把这里当成唯一真相
  // ⭐ 2026-09-27 用户：「版本信息要与现有的版本一致，且需要动态更新，目前先按 1.0.0，
  //    等后期有发布其他版本再更新」→ 首发回落值定为 1.0.0（原 2.4.0 是内部迭代号，与发布版本无关）；
  //    以后每次在公众平台发布新版本，**无需改这里**，`miniProgram.version` 会自动返回真实版本号。
  version: '1.0.0',

  // 订阅消息模板 ID（原「我的」页「通知提醒」开关用）
  // ⚠️ 2026-09-27 用户决定移除该开关（「没有特别需求，感觉多余」）→ 端上已无入口，此字段暂留空置。
  //    恢复时填入模板 ID 即可（云端发送侧 cronDaily 走环境变量 RENEW_TEMPLATE_ID，与这里独立）。
  //    历史上留空的表现：开关提示「暂不可用」并**自动回弹**，绝不假装已开启（降级原则）。
  subscribeTmplIds: [],

  // 虚拟支付（积分充值 / 开通会员）
  // ⚠️ 三件事都做完才可置 enabled = true：
  //    ① MP 后台「虚拟支付」已开通并签约（【支付与交易】→ 虚拟支付）
  //    ② 云函数配好环境变量：VIRTUAL_PAY_READY / VIRTUAL_PAY_OFFER_ID /
  //       VIRTUAL_PAY_APPKEY / MINI_APPSECRET（还有可选 VIRTUAL_PAY_ENV / _SANDBOX_APPKEY）
  //    ③ 后台「代币配置」比例为 1 元 = 10 代币，且会员道具已发布生效（约 10 分钟）；
  //       2026-10-15 起**在售 3 个**（月 ¥9.9 / 季 ¥25 / 年 ¥68），不限次档已下架（入口已拦）
  // 置 true 后：充值走**代币模式**（任意金额，自定义金额可用）、会员走**道具模式**（3 个在售道具）。
  // ⚠️ 未置 true 时点击只给友好提示、**不发起任何请求**；云端另有第二道防线（绝不会误扣款）。
  pay: {
    enabled: true,
  },
};
