// utils/util.js - 通用工具

/** 轻提示 */
function toast(title, icon) {
  wx.showToast({ title: title || '', icon: icon || 'none', duration: 1800 });
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
  // 「60 次」/「不限次」；未开通 → 空串（调用方自己给「未开通」）
  const quotaText = !active ? '' : unlimited ? '不限次' : hasQuota ? remaining + ' 次' : '';

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
    // 一行式摘要：「月卡会员 · 剩余 30 天 / 60 次」；未开通 → '未开通'
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

/** 从混杂文本中抽出 http 链接（抖音复制出来常带口令） */
function extractUrl(text) {
  const t = String(text || '');
  const m = t.match(/https?:\/\/[^\s，,。、"'）)]+/i);
  return m ? m[0] : '';
}

/* ------------------------------------------------------------------ *
 * 口播逐字稿 → 段落
 * ⚠️ 这是「逐字稿分段」的唯一实现。云端若也需要分段，必须复用同一份算法，
 *    不要各写一套 —— 两边漂移会出现「详情页分了 6 段、复制出来的还是 1 段」。
 * ------------------------------------------------------------------ */

// 句末标点：命中的位置即一个「句子边界」（省略号要连着的两个一起吸收）
const SENT_END = '。！？!?；;…';
// 句末标点后可能跟的收尾符号，应归到上一句（如「……好了。”」）
const SENT_TAIL = '"”』」）)］]》>';
// 超长句拆分用的次级断点
const SOFT_BREAK = '，,、：:';

/** 按句读切句（单换行也是边界） */
function splitSentences(block) {
  const out = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === '\n') {
      flush();
      continue;
    }
    buf += ch;
    if (SENT_END.indexOf(ch) > -1) {
      // 「……」这类连续标点算一个句末
      while (i + 1 < block.length && SENT_END.indexOf(block[i + 1]) > -1) buf += block[++i];
      while (i + 1 < block.length && SENT_TAIL.indexOf(block[i + 1]) > -1) buf += block[++i];
      flush();
    }
  }
  flush();
  return out;
}

/** 拼接两个句子：中文直接接，英文/数字之间补空格，避免「wordanother」粘连 */
function joinSent(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? a + ' ' + b : a + b;
}

/**
 * 超长句硬拆：优先在逗号/顿号这类次级标点处断，实在没有标点才按字数切。
 * 只在单句超过 hardMax 时才会走到这里（ASR 偶尔会吐出一整段没标点的长句）。
 */
function hardBreak(s, max) {
  const out = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    buf += ch;
    if (SOFT_BREAK.indexOf(ch) > -1 && buf.length >= max * 0.5) {
      out.push(buf.trim());
      buf = '';
    } else if (buf.length >= max) {
      out.push(buf.trim());
      buf = '';
    }
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out.filter(Boolean);
}

/**
 * 逐字稿切成阅读友好的段落。
 *
 * 为什么需要它：ASR（whisper 的 json 格式）返回的是**一整段没有换行的文本**，
 * 直接渲染就是「一大坨」；字幕链路反过来 —— 每行一句，碎得看不出结构。
 * 这里统一按「句读 + 字数」重新聚合：
 *   ① 空行（\n\n）= 硬分段，保留已有的分段意图
 *   ② 单换行、句末标点 = 句子边界（字幕的一行一句会先散开、再按字数聚合）
 *   ③ 每段补足 softMin 字才允许断开；到了 softMin 且再加会超 softMax 就断开
 *   ④ 没标点的超长句按逗号/顿号再切，连逗号都没有才按字数硬切
 *
 * 阈值取值依据：正文 27rpx、卡片可用宽约 620rpx → 一行约 34 字，
 * softMax=120 约 3.5 行/段，是手机上比较舒服的阅读节奏。
 *
 * @param {string} text 逐字稿
 * @param {object} [opts]
 *   preserveBreaks 单换行也当硬分段（用于**用户手动编辑过**的文本，
 *                  尊重他手打的换行；默认 false，即字幕的「一行一句」会被聚合）
 *   softMin / softMax / hardMax 聚合阈值（字）
 * @returns {string[]} 段落数组
 */
function splitParagraphs(text, opts) {
  const o = opts || {};
  const softMin = o.softMin != null ? o.softMin : 50;
  const softMax = o.softMax != null ? o.softMax : 120;
  const hardMax = o.hardMax != null ? o.hardMax : 260;

  const raw = String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!raw) return [];

  // 用户自己打过换行的，一律尊重；只把超长的无标点段落再切开
  if (o.preserveBreaks) {
    return raw
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .reduce((acc, line) => acc.concat(line.length > hardMax ? hardBreak(line, softMax) : [line]), []);
  }

  const out = [];
  raw.split(/\n{2,}/).forEach((block) => {
    // 句子先散开，超长句再拆，然后按字数聚合
    const pieces = [];
    splitSentences(block).forEach((s) => {
      if (s.length > hardMax) hardBreak(s, softMax).forEach((x) => pieces.push(x));
      else pieces.push(s);
    });

    let cur = '';
    pieces.forEach((s) => {
      if (!cur) {
        cur = s;
        return;
      }
      if (cur.length >= softMin && cur.length + s.length > softMax) {
        out.push(cur);
        cur = s;
      } else {
        cur = joinSent(cur, s);
      }
    });
    if (cur) out.push(cur);
  });

  return out.filter(Boolean);
}

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

module.exports = {
  toast,
  durationText,
  cacheLocalThumb,
  localThumbSrc,
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
  extractUrl,
  splitParagraphs,
  PLATFORM_MAP,
};
