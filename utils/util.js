const uiFeedback = require('./feedback');
const { splitParagraphs } = require('./paragraphs');
// utils/util.js - 通用工具

/** 轻提示 */
function toast(title, icon) {
  uiFeedback.showToast({ title: title || '', icon: icon || 'none', duration: 1800 });
}

/** 秒 → mm:ss */
function durationText(sec) {
  if (!sec && sec !== 0) return '';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

/** 平台 code → 展示名（code 与云端 providers.PLATFORM_LABEL 保持一致） */
const PLATFORM_MAP = {
  video_channel: '视频号',
  shipinhao: '视频号',
  channels: '视频号',
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  xhs: '小红书',
  bilibili: 'B 站',
  bzhan: 'B 站',
  local: '本地视频',
  other: '其他平台',
};

function platformName(code) {
  if (!code) return '';
  return PLATFORM_MAP[String(code).toLowerCase()] || code;
}

/** 历史数据里可能出现的平台别名 → 归一为规范 code（不归一，本地兜底过滤会漏） */
const PLATFORM_ALIAS = {
  shipinhao: 'video_channel',
  channels: 'video_channel',
  weixin: 'video_channel',
  xhs: 'xiaohongshu',
  bzhan: 'bilibili',
  bili: 'bilibili',
  kwai: 'kuaishou',
};

/**
 * 平台 code 规范化
 * ⚠️ 只此一份实现 —— 文案库列表页 / 提取结果页 /「我的」页最近一条记录都用它。
 *    原先副本写在 pages/history/history.js 里，2026-09-26「我的」页要用同一口径时
 *    提升到此（同 thumbColor / timeLabel / detectPlatform 的规矩：算法不许多副本）
 */
function normPlatform(code) {
  const c = String(code || '').toLowerCase();
  return PLATFORM_ALIAS[c] || c || 'other';
}

/**
 * 缩略块兜底配色（https 封面 / 视频首帧都拿不到时才用）
 * 与首页鲜绿主题一致的浅薄荷、青柠和中性底色，按记录稳定循环
 *
 * ⚠️ 只此一份实现 —— 文案库列表页与提取结果页共用。
 *    同一个 _id 在两处必须得到同一个颜色，否则同一个视频在列表和详情里
 *    「缩略块颜色不一样」，正是用户 2026-09-26 要求修的那类不一致。
 *    （同 detectPlatform 的规矩：算法不许多副本，四处漂移 = 线上割裂）
 */
const THUMB_COLORS = ['#E8FAEF', '#EEF8DC', '#E2F5E8', '#F3F9E9', '#E8EEEA'];

/** 按 _id 稳定取兜底色（按数组下标取的话，筛选 / 分页一变颜色就跟着跳） */
function thumbColor(id) {
  const s = String(id || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return THUMB_COLORS[h % THUMB_COLORS.length];
}

/** 数字千分位：1286 → 1,286 */
function thousands(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return v.toLocaleString('en-US');
}

/**
 * 大数缩写（「我的」页统计用）
 *   12640 → 1.26万？不 —— 统一保留 1 位小数：1.3万
 *   126400 → 12.6万      123456789 → 1.23亿
 * 规则：<1万 原样（带千分位）；≥1万 除以万保留 1 位（.0 去掉）；≥1亿 除以亿保留 2 位
 * ⚠️ 前端只做**展示**缩写，云端仍存原值，不参与任何计算
 */
function shortNumber(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return '0';
  if (v < 10000) return thousands(v);
  const trim = (s) => String(s).replace(/\.?0+$/, '');
  if (v < 100000000) return trim((v / 10000).toFixed(1)) + '万';
  return trim((v / 100000000).toFixed(2)) + '亿';
}

/**
 * 卡片上的时间标签：fromNow 去掉「今天」前缀
 * 文案库卡片上方已有「今天 / 昨天 / 更早」分组标题，再写一次「今天 16:29」是重复信息
 * → 今天只留纯时刻 HH:mm；跨天沿用 fromNow 的输出（昨天 15:51 / 9 月 12 日）
 *
 * ⚠️ 不动 fromNow 本身 —— 别的页面在用。
 * ⚠️ 只此一份实现：文案库列表页与提取结果页的时间口径必须一致（用户 2026-09-26 要求）
 */
function timeLabel(ts) {
  return fromNow(ts).replace(/^今天\s*/, '');
}

/** 时间戳 → 相对时间（刚刚 / n 分钟前 / 今天 HH:mm / 昨天 HH:mm / M 月 D 日） */
function fromNow(ts) {
  if (!ts) return '';
  const d = toDate(ts);
  if (!d) return '';
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';

  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (isSameDay(d, now)) return '今天 ' + hm;

  const yest = new Date(now.getTime() - 24 * 3600 * 1000);
  if (isSameDay(d, yest)) return '昨天 ' + hm;

  if (d.getFullYear() === now.getFullYear()) {
    return d.getMonth() + 1 + ' 月 ' + d.getDate() + ' 日';
  }
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

/** 时间戳 → 本地日期戳 YYYY-MM-DD（避免 toISOString 的时区漂移） */
function localDateStr(ts) {
  const d = toDate(ts);
  if (!d) return '';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 时间戳 → 今天 14:32 这类展示 */
function timeHM(ts) {
  const d = toDate(ts);
  if (!d) return '';
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 安全转 Date（兼容秒 / 毫秒 / 字符串） */
function toDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
  let n = ts;
  if (typeof ts === 'string' && /^\d+$/.test(ts)) n = Number(ts);
  if (typeof n === 'number') {
    if (n < 1e12) n = n * 1000; // 秒 → 毫秒
    const d = new Date(n);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 会员档位 → 展示名
 * ⚠️ 键名必须与云端 `_common/consts.js#MEMBER_TIERS` 的**取值**一一对应
 *    （monthly / quarterly / yearly / unlimited）。
 */
const TIER_TEXT = {
  monthly: '月卡会员',
  quarterly: '季卡会员',
  yearly: '年卡会员',
  unlimited: '不限次会员',
};

/**
 * ⭐ 会员状态**唯一解析入口**（2026-09-29）
 *
 * 为什么必须收敛：
 *   云端 `getUser` / `ensureUser` 返回的是 `userCenterSummary().membership`，形状为
 *     `{ tier, status, expires_at, unlimited, quota:{monthly,total,used,remaining} }`；
 *   而历史页面（首页 / 会员中心）按 `user.member.{active, expire_at, quota_total, used}` 取值 ——
 *   那套字段**云端从来不返回** → 恒判「未开通」（2026-09-29 事故：买了月卡，首页仍显示未开通）。
 *   → 各页一律调本函数，**禁止再自行解析 membership**。
 *
 * ⚠️ 出参约定（与项目「拿不到的数显示「—」，不伪造 0」一致）：
 *    未开通 / 拿到 null 时，各 Text 字段给**空串**，由调用方决定占位文案（如「未开通」「—」）。
 *
 * @param {object} user getUser / ensureUser 的返回
 * @returns {{active:boolean,tier:string,tierText:string,unlimited:boolean,
 *            daysLeft:number,total:number,used:number,remaining:number,hasQuota:boolean,
 *            daysText:string,quotaText:string,summaryText:string}}
 */
function membershipInfo(user) {
  const m = (user && (user.membership || user.member)) || {};
  const tier = String(m.tier || 'none');
  // 兼容两种形状：云端 status==='active'；老形状 active===true
  const active = !!tier && tier !== 'none' && (m.status === 'active' || m.active === true);
  const unlimited = active && (m.unlimited === true || tier === 'unlimited');

  const end = active ? toDate(m.expires_at || m.expire_at) : null;
  const daysLeft = end ? Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86400000)) : 0;

  // ⚠️ 不限次档的 quota 是 null —— 与「未开通」同为 null，故必须靠 unlimited / active 区分
  const q = active && m.quota ? m.quota : null;
  const total = q ? Number(q.total) || 0 : 0;
  const used = q ? Number(q.used) || 0 : 0;
  const rawRemain = q ? Number(q.remaining) : NaN;
  const remaining = isFinite(rawRemain) ? Math.max(0, rawRemain) : Math.max(0, total - used);
  const hasQuota = active && !unlimited && total > 0;

  const tierText = TIER_TEXT[tier] || '会员';
  // 「剩余 30 天」；到期当天为 0 → 文案给「今日到期」，仍然算 active（云端 expires_at 未过）
  const daysText = active ? (daysLeft > 0 ? '剩余 ' + daysLeft + ' 天' : '今日到期') : '';
  // 「396 积分」/「不限次」；未开通 → 空串（调用方自己给「未开通」）
  // ⭐ 2026-10-16 v5：会员额度单位由「次」改为「积分」（与充值积分同单位）
  const quotaText = !active ? '' : unlimited ? '不限次' : hasQuota ? remaining + ' 积分' : '';

  return {
    active,
    tier,
    tierText,
    unlimited,
    daysLeft,
    total,
    used,
    remaining,
    hasQuota,
    daysText,
    quotaText,
    // 一行式摘要：「月卡会员 · 剩余 30 天 / 396 积分」；未开通 → '未开通'
    summaryText: active
      ? tierText + ' · ' + (daysText || '生效中') + (quotaText ? ' / ' + quotaText : '')
      : '未开通',
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * 从链接识别平台。
 * ⚠️ 必须与云端 cloud-common/providers.js 的 detectPlatform 保持同表同序，
 *    否则会出现「前端说已识别视频号、后端说不支持」的割裂。
 *    域名变体很多（视频号尤其：小程序卡片 / 公众号文章内嵌 / 微信短链各不同），
 *    匹配要「够用且不漏」；识别不出返回 ''（由调用方决定提示还是放行）。
 */
function detectPlatform(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return '';
  if (/channels\.weixin\.qq\.com|finder\.video\.qq\.com|video\.qq\.com|v\.qq\.com|mp\.weixin\.qq\.com|weixin\.qq\.com|wxaurl\.cn|weixin110\.qq\.com/.test(u)) return 'video_channel';
  if (/douyin\.com|iesdouyin|snssdk\.com|amemv\.com/.test(u)) return 'douyin';
  if (/kuaishou\.com|chenzhongtech|gifshow\.com|kwai\.com/.test(u)) return 'kuaishou';
  if (/xiaohongshu\.com|xhslink|xhscdn/.test(u)) return 'xiaohongshu';
  if (/bilibili\.com|b23\.tv|acg\.tv/.test(u)) return 'bilibili';
  return '';
}

/** 该平台是否在承诺支持范围内（与云端一致） */
function isSupportedPlatform(code) {
  return !!PLATFORM_MAP[code] && code !== 'other' && code !== 'local';
}

/**
 * 链接是否合法。
 * 允许两种形态：① 完整 http(s) 链接；② 裸域名（channels.weixin.qq.com/web/... ，
 * 视频号某些入口「复制链接」给的就是不带协议头的裸域名，后端会自动补 https://）。
 * 原正则的裸域名分支要求「域名/单段纯字母数字路径」，多段路径 / 带 query 一律判非法。
 */
function isValidUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (/^https?:\/\/[^\s]+$/i.test(u)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(u);
}

/**
 * 「链接可解析性」预检 —— 拦掉**不是单条视频页**的链接（2026-10-18）
 *
 * ⭐ 动因（有数据支撑，别删）：后台 tasks 按链接形态统计（视频号 99 条）——
 *      weixin.qq.com/sph       成功 73 / 失败  9   ← 正常单条视频页
 *      mp.weixin.qq.com/s      成功  0 / 失败 11   ← 公众号文章，**从来没成功过**
 *      finder.video.qq.com     成功  0 / 失败  5   ← 视频 CDN 直链，解析接口不认
 *      channels.…/effect       成功  0 / 失败  1   ← 视频号「创作工具/特效」功能页
 *    用户要白等 8.7 秒才看到「解析失败」（不扣费，但体验差，还污染后台失败率）。
 *
 * ⚠️ 只做**黑名单**（已证实的非内容页），绝不做白名单 —— 各平台分享短链形态太多，
 *    白名单必然误伤正常链接。
 * ⚠️ 必须与云端 cloud-common/providers.js#linkPageIssue **同表同序**（同 detectPlatform 的约定）。
 *
 * @returns {null | {code:string, msg:string}} null = 通过
 */
function linkPageIssue(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return null;

  // ① 公众号文章：不是视频，没有音视频轨
  if (/^https?:\/\/mp\.weixin\.qq\.com\/s(\/|\?|#|$)/.test(u)) {
    return {
      code: 'article',
      msg: '这是公众号文章链接，不是视频。请打开视频后点「分享」→「复制链接」再粘贴',
    };
  }
  // ② 视频号功能页（创作工具 / 特效 / 个人主页等）：没有具体的一条视频
  if (/^https?:\/\/channels\.weixin\.qq\.com\/(effect|platform|home|login|creator|dashboard)\b/.test(u)) {
    return {
      code: 'channel_page',
      msg: '这是视频号的功能页，不是某条视频。请打开那个视频，点右上角「···」→ 分享 → 复制链接',
    };
  }
  // ③ 视频 CDN 直链：虽然指向视频文件，但解析接口只认「视频页链接」
  if (/^https?:\/\/finder\.video\.qq\.com\//.test(u)) {
    return {
      code: 'cdn',
      msg: '这是视频文件地址，不是视频页链接。请回到视频页面点「分享」→「复制链接」',
    };
  }
  return null;
}

/** 从混杂文本中抽出 http 链接（抖音复制出来常带口令） */
function extractUrl(text) {
  const t = String(text || '');
  const m = t.match(/https?:\/\/[^\s，,。、"'）)]+/i);
  return m ? m[0] : '';
}

// 阅读分段统一在 paragraphs.js 中实现，不按固定字数截断句子或单词。

/* ══════════════════════════════════════════════════════════════════════════
   本地视频「即时封面」缓存（2026-09-27 用户反馈）

   问题：本地视频在列表 / 详情页原先靠 `<video>` 显示首帧当封面，而 `<video>` 在首帧
        解出来之前是一块**纯黑** → 进历史页先看到黑图，过一两秒才变出画面。
   做法：选视频时 `wx.chooseMedia` 已顺带返回「视频缩略图临时文件路径」
        （`tempFiles[].thumbTempFilePath`），上传视频时把它**转存到用户持久目录**
        （temp 文件会被系统清理，必须转存），列表直接用它当封面 →
        `<image>` 立即出图（且是本地文件，零网络等待），黑图过程消失。

   实现要点：
   - 落盘名 = 由**云存储 fileID** 派生的稳定名 → 读取时靠「文件是否存在」判断，
     不需要额外映射表；同名覆盖，天然幂等。
   - 读不到（换设备 / 清了缓存 / 老记录）→ 返回 ''，调用方自动回落 `<video>` 首帧，不报错。
   - ⚠️ 只此一份实现：pages/loading（写）、pages/history、pages/result（读）共用。
   ══════════════════════════════════════════════════════════════════════════ */
const LV_THUMB_PREFIX = 'lvthumb_';
const LV_THUMB_KEEP = 80; // 最多保留张数（一张几十 KB，防用户目录无限增长）
const LV_THUMB_INDEX = 'lv_thumb_index';

/** 稳定短散列（djb2 → base36）：把长 fileID 收成一个能当文件名的串 */
function lvHash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** fileID → 本地缩略图路径（纯字符串拼装，不碰文件系统） */
function lvThumbPath(fileID) {
  return wx.env.USER_DATA_PATH + '/' + LV_THUMB_PREFIX + lvHash(fileID) + '.jpg';
}

/** 裁剪：超过 LV_THUMB_KEEP 张时按写入顺序删最旧的（索引丢失也不影响读取） */
function pruneLocalThumbs(fs, justAdded) {
  try {
    let q = wx.getStorageSync(LV_THUMB_INDEX);
    if (!Array.isArray(q)) q = [];
    q = q.filter((p) => typeof p === 'string' && p && p !== justAdded);
    q.push(justAdded);
    while (q.length > LV_THUMB_KEEP) {
      const old = q.shift();
      try {
        fs.unlinkSync(old);
      } catch (e) {
        /* 文件可能早已不在，忽略 */
      }
    }
    wx.setStorageSync(LV_THUMB_INDEX, q);
  } catch (e) {
    /* 裁剪失败不影响主流程 */
  }
}

/**
 * 转存缩略图（失败静默 —— 拿不到就回落 <video> 首帧，绝不影响上传主流程）
 * @param {string} fileID 云存储 fileID（视频上传完拿到）
 * @param {string} tempThumbPath wx.chooseMedia 给的视频缩略图临时路径
 * @returns {string} 转存后的本地路径；失败返回 ''
 */
function cacheLocalThumb(fileID, tempThumbPath) {
  if (!fileID || !tempThumbPath) return '';
  try {
    const fs = wx.getFileSystemManager();
    const dest = lvThumbPath(fileID);
    fs.copyFileSync(tempThumbPath, dest);
    pruneLocalThumbs(fs, dest);
    return dest;
  } catch (e) {
    return '';
  }
}

/** 取本地缩略图路径（不存在返回 ''）；fileID 为空直接短路，不做文件系统调用 */
function localThumbSrc(fileID) {
  if (!fileID) return '';
  try {
    const p = lvThumbPath(fileID);
    wx.getFileSystemManager().accessSync(p);
    return p;
  } catch (e) {
    return '';
  }
}

/**
 * 本机持久文件是否还在（历史记录缓存里存的封面路径要用它二次校验）
 * ⚠️ 微信会清理小程序的文件缓存 → 缓存的路径随时可能变成死链，
 *    死链交给 <image> 只会触一次 binderror + 白图，不如提前判掉。
 * @param {string} p 本地路径（http(s):// 与 cloud:// 一律返回 false，它们不是本机文件）
 */
function localFileExists(p) {
  if (typeof p !== 'string' || !p) return false;
  if (/^(https?|cloud):\/\//i.test(p)) return false;
  try {
    wx.getFileSystemManager().accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  toast,
  durationText,
  cacheLocalThumb,
  localThumbSrc,
  localFileExists,
  platformName,
  normPlatform,
  thumbColor,
  THUMB_COLORS,
  thousands,
  shortNumber,
  fromNow,
  timeLabel,
  localDateStr,
  timeHM,
  toDate,
  TIER_TEXT,
  membershipInfo,
  detectPlatform,
  isSupportedPlatform,
  isValidUrl,
  linkPageIssue,
  extractUrl,
  splitParagraphs,
  PLATFORM_MAP,
};
