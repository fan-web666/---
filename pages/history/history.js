// pages/history/history.js - 历史记录（蓝湖稿 04copylibrary；页内标题 2026-09-27 由「文案库」改为「历史记录」）
// 业务逻辑复用 Pixso 版（listCopywritings / getCopywriting / deleteCopywriting，action 名不变）
const { call, handleError } = require('../../utils/api');
const {
  toast,
  platformName,
  normPlatform,
  thumbColor,
  timeLabel,
  localDateStr,
  localThumbSrc,
  localFileExists,
} = require('../../utils/util');
const tracker = require('../../utils/tracker');
const thumbs = require('../../utils/history-thumbs');
const searchText = require('../../utils/search-text');
// ⭐ 2026-10-13：结果页详情缓存（view_result_*）。
//    列表接口 listCopywritings 已经把详情整份带回（detail = shapeCopywriting()，与详情接口同构），
//    所以点击进入时可以先把它写进缓存 → 结果页 onLoad 直接命中缓存，**零请求直显**，不再白屏等网络。
const cache = require('../../utils/view-cache');

const app = getApp();

/**
 * 平台筛选分类（用户 2026-09-26 要求：由设计稿的 4 个槽位「全部/视频号/抖音/筛选⌄」
 * 扩为「全部 + 6 个平台」，一行放不下 → 容器 flex-wrap 自动排成 2 行）
 *
 * ⚠️ id 直接用云端 source_platform 的规范 code —— 服务端按等值过滤，
 *    这样就不需要旧版那张「短名 → code」映射表了（漏一处就一条都匹配不到）。
 */
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'video_channel', label: '视频号' },
  { id: 'douyin', label: '抖音' },
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'bilibili', label: 'B站' },
  { id: 'kuaishou', label: '快手' },
  { id: 'local', label: '本地视频' },
  // ⭐ 2026-09-29 用户：「记录里的分类标签加个『其他』标签」。
  //    必要性：云端 detectPlatform 只认 5 个平台（视频号/抖音/快手/小红书/B站），
  //    微博等链接**照样能解析成功**（parseLink 不硬拒），落库 source_platform = 'other'
  //    —— 以前这些记录在列表里显示「其他平台」，却**没有任何筛选标签能筛到它们**。
  //    标签与行内来源统一显示「其他平台」，筛选键保持 other。
  //    ⚠️ id 必须是 'other'（= 云端 detectPlatform 的兜底 code），不能写 'other_platform'。
  { id: 'other', label: '其他平台' },
];

/* PLATFORM_ALIAS / normPlatform 已提到 utils/util.js ——
   「我的」页的「最近一条记录」要用同一口径（平台名 + 缩略色 + 时间），
   两页各写一份必然漂移，故只留一份实现（同 thumbColor / timeLabel 的处理） */

// 缩略色块的兜底配色 thumbColor()：已提到 utils/util.js ——
// 提取结果页要用同一套颜色（同一个 _id 两边必须同色），副本会漂移，故只留一份实现
const PAGE_SIZE = 20;
const HISTORY_CACHE = 'copy_history_view_v1';
function owner() { return (app.globalData.user || {})._id || ''; }
function readHistory() {
  try {
    const c = wx.getStorageSync(HISTORY_CACHE);
    if (!owner() || !c || c.uid !== owner() || !Array.isArray(c.all)) return null;
    c.all = c.all.map(row => {
      const source = row.coverSource || row.cover || '';
      // ⭐ 2026-10-15：显示值优先「本机缩略图」（本机文件，零网络直显）；
      //    ⚠️ 缓存里的本机路径必须**二次校验** —— 微信会清小程序文件缓存，
      //       老路径随时是死链，交给 <image> 只会白图 + 一次 binderror，不如提前判掉。
      const localCover = localFileExists(row.localCover) ? row.localCover : '';
      const cached = thumbs.local(owner(), row._id, source);
      const remote = /^(https:\/\/|cloud:\/\/)/i.test(source) ? source : '';
      const cover = localCover || cached || remote;
      // ⚠️ 失败标记只对**同一个显示值**成立：本机缩略图失效后显示值换成了云端封面，
      //    上一轮那条（针对死链的）失败记录必须清掉 —— 否则它会永久遮住一个其实能加载的封面
      //    （wxml 的 wx:if="{{it.cover && !it.coverFail}}"，一遮就退回占位图）。
      const coverFail = (!localCover && !cached) && row.cover === cover ? !!row.coverFail : false;
      return Object.assign({}, row, {
        coverSource: source,
        localCover,
        cover,
        coverFail,
      });
    });
    c.groups = (c.groups || []).map(g => Object.assign({}, g, { items: g.items.map(row => c.all.find(it => it._id === row._id) || row) }));
    return c;
  } catch (_) { return null; }
}
const initial = readHistory();

/* 卡片内的时间展示 timeLabel()：已提到 utils/util.js ——
   提取结果页要显示同一个时间口径（结果页不该出现列表里没有的「今天」前缀），
   两页各写一份必然漂移，故只留一份实现 */

/**
 * 取记录 id —— 兼容两种调用来源：
 * ① WXML 的 bind/catch 事件对象（catchtap="copyOne" 只能拿到事件）
 * ② 长按菜单里直接传 id 字符串（this.copyOne(id)）
 * 不统一的话，catchtap 那条路径拿到的 id 会是 undefined，点了没反应
 */
function pickId(e) {
  if (typeof e === 'string') return e;
  return (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || '';
}

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    navSafeRightRpx: 196,

    keyword: initial ? initial.keyword : '',
    activeFilter: initial ? initial.activeFilter : 'all',
    filters: FILTERS,

    groups: initial ? initial.groups : [],
    total: initial ? initial.total : 0,
    hasMore: initial ? initial.hasMore : false,
    scrollTop: initial ? initial.scrollTop : 0,
    loading: !initial,
    refreshing: false,
    searching: false,
    searchError: false,
  },

  onLoad() {
    const c = readHistory();
    this.page = c ? c.page : 1;
    this.all = c ? c.all : [];
    this._cached = !!c;
    this._owner = owner();
    this._loadedQuery = c ? JSON.stringify([c.keyword, c.activeFilter]) : '';
    this._scrollTop = c ? c.scrollTop : 0;
    this._request = 0;
    this._disposed = false;
    // ⭐ 2026-10-13：列表项里带回的详情，**只留内存**，两个用途：
    //    ① 点击进入详情前预热缓存 → 结果页直显
    //    ② 搜索输入时先本地匹配给出即时反馈（不必干等云端正则查询）
    //    ⚠️ 绝不塞进 this.all —— saveHistory() 会把 this.all 整个写进 storage，全文进去直接爆容量
    this._details = {};
    // 无关键词结果 = 全量基底。搜索结果会覆盖 this.all，所以本地过滤必须拿这份稳定快照当基底
    this._fullAll = null;
    this.setData(c ? { keyword: c.keyword, activeFilter: c.activeFilter, groups: this.groupByDate(c.all.filter(row => c.activeFilter === 'all' || row.platform === c.activeFilter)), total: c.total, hasMore: c.hasMore, scrollTop: c.scrollTop, loading: false } : { keyword: '', activeFilter: 'all', groups: [], total: 0, hasMore: false, scrollTop: 0, loading: true });
    this.searchTimer = null;
    this.setData({ statusBarH: app.globalData.navStatusH || 0, navSafeRightRpx: app.globalData.navSafeRightRpx || 196 });
    this.warmThumbs();
  },

  onShow() {
    if (this._owner !== owner()) {
      this._owner = owner(); this.all = []; this.page = 1; this._cached = false;
      this.setData({ groups: [], total: 0, hasMore: false, scrollTop: 0, loading: true });
    }
    // silent=true：进页面自动加载，失败不弹提示（用户没主动操作）
    this.load(true, null, true);
  },

  /** scroll-view 触底 */
  onReachBottom() {
    if (!this.data.hasMore || this._fetching) return;
    this.page += 1;
    this.load(false);
  },

  /** 下拉刷新 */
  onRefresh() {
    this.setData({ refreshing: true });
    this.load(true, () => this.setData({ refreshing: false }));
  },

  /* ---------- 数据 ---------- */

  async load(reset, done, silent) {
    if (!app.globalData.cloudReady) {
      this.setData({ loading: false, searching: false, searchError: !!this.data.keyword.trim() });
      if (done) done();
      return;
    }

    const ticket = ++this._request;
    const uid = owner();
    this._fetching = true;
    if (reset && !this._cached) this.setData({ loading: true });

    const params = { page: this.page, pageSize: PAGE_SIZE };
    if (this.data.keyword) params.keyword = this.data.keyword;
    if (this.data.activeFilter !== 'all') params.platform = this.data.activeFilter;

    try {
      const pages = reset && silent && this._cached ? Math.min(this.page, 10) : 1;
      const res = await call('listCopywritings', Object.assign({}, params, { page: reset ? 1 : this.page }));
      let list = (res && res.list) || [];
      const total = (res && res.total) || 0;
      const lastPage = Math.max(1, Math.min(pages, Math.ceil(total / PAGE_SIZE)));
      if (lastPage > 1) {
        const rest = await Promise.all(Array.from({ length: lastPage - 1 }, (_, i) => call('listCopywritings', Object.assign({}, params, { page: i + 2 }))));
        rest.forEach(r => { list = list.concat((r && r.list) || []); });
      }
      if (ticket !== this._request || this._disposed || uid !== owner()) return;

      const mapped = list.map((it) => this.formatItem(it));

      this.all = reset ? mapped : this.all.concat(mapped);
      if (reset) this.page = lastPage;
      // 无关键词的这次结果 = 全量快照（供搜索时本地即时过滤，见 applyLocalFilter）
      if (!params.keyword) this._fullAll = this.all;
      const hasMore = this.all.length < total;

      const view = this.visible(this.all);
      const patch = {
        groups: this.groupByDate(view),
        // 「共 N 条」按当前筛选后的条数展示
        total,
        hasMore,
        loading: false,
      };
      // Unchanged keyed rows do not need another render or image reload.
      if (JSON.stringify(this.data.groups) !== JSON.stringify(patch.groups) || this.data.total !== patch.total || this.data.hasMore !== patch.hasMore || this.data.loading) this.setData(patch);
      this._cached = true;
      this._loadedQuery = JSON.stringify([this.data.keyword, this.data.activeFilter]);
      this.saveHistory();
      this.warmThumbs();
    } catch (e) {
      // 自动加载（silent）不弹提示；下拉刷新 / 触底加载属用户主动操作，正常提示
      if (ticket !== this._request || this._disposed || uid !== owner()) return;
      handleError(e, '', { silent: !!silent });
      this.setData({ loading: false });
      if (this.data.keyword && !silent) this.setData({ searchError: true });
      if (!reset) this.page = Math.max(1, this.page - 1);
    } finally {
      if (ticket === this._request) {
        this._fetching = false;
        if (this.data.searching) this.setData({ searching: false });
        if (done && !this._disposed) done();
      }
    }
  },

  saveHistory() {
    if (!owner() || owner() !== this._owner || !this._cached || this._loadedQuery !== JSON.stringify([this.data.keyword, this.data.activeFilter])) return;
    const all = this.all.slice(0, 200).map(row => Object.assign({}, row, { cover: thumbs.local(owner(), row._id, row.coverSource || row.cover) || row.cover }));
    try { wx.setStorageSync(HISTORY_CACHE, { uid: owner(), all, groups: this.groupByDate(this.visible(all)), keyword: this.data.keyword, activeFilter: this.data.activeFilter, total: this.data.total, page: Math.max(1, Math.ceil(all.length / PAGE_SIZE)), hasMore: this.data.hasMore || all.length < this.all.length, scrollTop: this._scrollTop || 0 }); } catch (_) {}
  },
  onHistoryScroll(e) { this._scrollTop = e.detail.scrollTop || 0; },
  onHide() { this.saveHistory(); },
  onUnload() { this.saveHistory(); this._disposed = true; this._request++; clearTimeout(this.searchTimer); },
  warmThumbs() {
    const uid = this._owner;
    // ⚠️ 本机缩略图本身已经是本地文件（零网络），再往 history-thumbs 目录拷一份纯属浪费，
    //    还会挤占那 32MB 配额 → 只预热真正需要走网络的封面（https / cloud://）。
    (this.all || []).filter(row => row.cover && !row.coverFail && !localFileExists(row.localCover)).forEach(row => {
      thumbs.warm(uid, row._id, row.coverSource || row.cover).then(path => {
        // Save the local path for the NEXT view, never swap a visible image's src.
        if (path && !this._disposed && uid === owner()) this.saveHistory();
      });
    });
  },

  /** 本地兜底过滤（服务端已按平台过滤，这里再兜一层，切回来不丢） */
  visible(list) {
    const f = this.data.activeFilter;
    if (f === 'all') return list;
    return list.filter((it) => it.platform === f);
  },

  formatItem(it) {
    // 列表接口已把详情整份带回（与详情接口同构）→ 留在内存，供详情预热 / 本地即时搜索
    if (it && it._id && it.detail) this._details[it._id] = it.detail;
    const code = normPlatform(it.source_platform);
    const time = timeLabel(it.created_at);
    // 字数：云端 char_count（云端落库时按 transcript 长度写入）。
    // 老数据可能是 0 → 该段直接不显示，不写「0 字」这种占位（见下方 filter(Boolean)）
    const chars = Number(it.char_count) || 0;
    const cover = String(it.cover_url || '');
    // ⭐ 本地视频封面：优先用「选视频时留下的缩略图」（本机文件，立即出图，零网络等待），
    //    详见 utils/util.js 的 cacheLocalThumb / localThumbSrc。
    //    ⚠️ 没有它时（老记录 / 换设备 / 清了缓存）才回落「云端封面」——
    //       2026-10-15 起本地视频的封面也会转存云存储并落库成 cover_url，不再只靠本机文件。
    //    再没有才回落 <video> 首帧（那条路会先黑一下），最后才是色块。
    const localThumb = localThumbSrc(it.local_video_id);
    // 云端封面才是长期稳定的那一个 → 缓存键（coverSource）以它为准；本机缩略图只作「首帧直显」
    const cloudCover = /^(https:\/\/|cloud:\/\/)/i.test(cover) ? cover : '';
    const source = cloudCover || localThumb;
    const prior = (this.all || []).find(row => row._id === it._id && (row.coverSource || row.cover) === source);
    return {
      _id: it._id,
      title: it.video_title || '未命名视频',
      titleParts: searchText.parts(it.video_title || '未命名视频', this.data.keyword),
      snippet: it.search_snippet || '',
      snippetParts: searchText.parts(it.search_snippet || '', this.data.keyword),
      // 用户 2026-09-26：格式对齐参考图「抖音 · 642 字 · 14:32」
      meta: [platformName(code), chars ? chars + ' 字' : '', time].filter(Boolean).join(' · '),
      platform: code,
      created_at: it.created_at,
      dateKey: localDateStr(it.created_at),

      // 缩略图三级降级：本机缩略图（零网络直显）→ 云端封面（cloud:// / https，长期有效）
      //                → 视频首帧（云存储 fileID，交 <video> 显示）→ 设计稿色块
      // ① 封面：收 https 与 cloud:// —— http 图片在真机上必然加载失败，收进来只会白请求 + 控制台刷错误
      //    ⭐ cloud:// 是 2026-09-28 新增的「封面转存云存储」fileID：平台直链带签名、几小时~一两天就 403，
      //       转存后永久有效，历史页不会再整片变绿块
      //    ⭐ 2026-10-15 本地视频也走同一条路（选片缩略图转存云存储）→ 换设备 / 清缓存后封面仍在
      coverSource: source,
      // localCover：本机缩略图（秒开用）。保留它在行上，缓存行下次回读时才能二次校验它是否还在
      localCover: localThumb,
      // src 一经确定就不轻易换（先沿用上一次已显示的那张），避免 <image> 重新加载闪一下
      cover: prior && prior.cover ? prior.cover : localThumb || thumbs.local(owner(), it._id, source) || source,
      coverFail: prior ? !!prior.coverFail : false,
      // ② 首帧：本地视频在云端存的是云存储 fileID，可长期有效 → 交给 <video> 显示第一帧
      //    平台视频的 CDN 直链带签名时效与防盗链，列表里逐个起播放器既慢又大概率黑屏，不取
      //    ⚠️ 已有本地缩略图时不再挂 <video>（那是黑图来源），见上方 localThumb
      videoSrc: localThumb ? '' : it.local_video_id || '',
      // ③ 兜底色块
      thumbBg: thumbColor(it._id),
    };
  },

  /** 封面加载失败（平台封面 URL 带签名时效，过期会 403）→ 该条降级为色块/首帧 */
  onCoverError(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // 只更新这一条，避免整表 setData
    const patch = {};
    this.data.groups.forEach((g, gi) => {
      g.items.forEach((it, ii) => {
        if (it._id === id) patch['groups[' + gi + '].items[' + ii + '].coverFail'] = true;
      });
    });
    if (Object.keys(patch).length) {
      this.setData(patch);
      const row = this.all.find(it => it._id === id);
      if (row) row.coverFail = true;
      this.saveHistory();
    }
  },

  /** 按 今天 / 昨天 / 更早 分组 */
  groupByDate(list) {
    const now = new Date();
    const todayKey = localDateStr(now.getTime());
    const yestKey = localDateStr(now.getTime() - 86400000);

    const buckets = {};
    const order = [];
    for (const it of list) {
      let label;
      if (it.dateKey === todayKey) label = '今天';
      else if (it.dateKey === yestKey) label = '昨天';
      else label = '更早';

      if (!buckets[label]) {
        buckets[label] = { label, count: 0, items: [] };
        order.push(label);
      }
      buckets[label].items.push(it);
      buckets[label].count += 1;
    }
    return order.map((k) => buckets[k]);
  },

  /* ---------- 交互 ---------- */

  onSearch(e) {
    const keyword = e.detail.value || '';
    this._request++;
    this._fetching = false;
    this.setData({ keyword, searching: !!keyword.trim(), searchError: false });
    // ⭐ 2026-10-13：先本地即时过滤一版，再去打云端。
    //    否则从「敲第一个字」到「云端结果返回」之间列表**毫无变化**（400ms 防抖 + 云端正则全表扫描
    //    通常 0.3~2s），用户体感就是「搜索没有任何反应」。云端返回后会整体覆盖这一版（它才是权威口径）。
    this.applyLocalFilter(keyword);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page = 1;
      this.load(true);
    }, 400);
  },

  onSearchConfirm() {
    clearTimeout(this.searchTimer); this.page=1;
    this.setData({ searching: !!this.data.keyword.trim(), searchError: false });
    this.applyLocalFilter(this.data.keyword);
    this.load(true);
  },

  /**
   * 一键清除搜索（搜索框右侧 ×）
   * ① 作废在途请求（_request++）—— 否则清空后云端可能把上一次搜索的结果盖回来；
   * ② 先用本地全量快照立刻还原列表（不等网络），再拉一次云端全量做权威校正；
   * ③ 不碰 scrollTop，用户停留在原位置。
   */
  onClearSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this._request++;
    this._fetching = false;
    this.page = 1;
    this.setData({ keyword: '', searching: false, searchError: false });
    this.applyLocalFilter('');
    this.load(true);
  },

  /**
   * 本地即时过滤（乐观反馈，非权威）
   * ⚠️ 覆盖范围 = 已加载进内存的记录（含列表带回的 detail 全文）；云端正则查询才是完整口径，
   *    400ms 后的 load() 会用云端结果整体覆盖 → 本方法只负责「别让用户盯着不动的列表干等」。
   * ⚠️ 命中 0 条时**故意不动列表**：否则会先闪一个空态、云端返回后又变回满屏，观感反而更差。
   */
  applyLocalFilter(keyword) {
    const key = String(keyword || '').trim().toLowerCase();
    const base = (this._fullAll && this._fullAll.length ? this._fullAll : this.all) || [];
    // 清空关键词 → 立刻回到本地全量（云端随后再校正），并把上一轮的匹配片段清掉
    if (!key) {
      const view0 = this.visible(base).map((row) =>
        row.snippet ? Object.assign({}, row, { snippet: '', snippetParts: [] }) : row
      );
      this.setData({ groups: this.groupByDate(view0), total: view0.length });
      return;
    }
    const hit = base.filter((row) => this.localHit(row, key));
    if (!hit.length) return;
    const view = this.visible(hit).map((row) => this.withLocalSnippet(row));
    this.setData({ groups: this.groupByDate(view), total: view.length });
  },

  /**
   * 按当前关键词重算「文案匹配 · …」片段（本地阶段也要有，否则输入瞬间卡片上没有匹配上下文）
   * ⚠️ 返回**新对象**，绝不改 this.all / this._fullAll 里的原行 —— 那是本地过滤的稳定快照，
   *    就地改会让「换关键词再搜」拿到被污染的数据。
   */
  withLocalSnippet(row) {
    const snip = searchText.snippet((this._details || {})[row._id], this.data.keyword);
    if (snip === (row.snippet || '')) return row;
    return Object.assign({}, row, {
      snippet: snip,
      snippetParts: snip ? searchText.parts(snip, this.data.keyword) : [],
    });
  },

  /**
   * 本地匹配口径 —— 必须与云端 cloud-common/copy-search.js 的 FIELDS 对齐：
   * 标题 / 来源平台 / 金句 / 要点（标题+正文）/ 原文案（含分段）。改一处必须同步另一处。
   */
  localHit(row, key) {
    const d = (this._details || {})[row._id] || null;
    const bag = [row.title, row.platform, row.meta];
    if (d) {
      const s = d.structured || {};
      bag.push(d.transcript, d.content, s.hook);
      (s.highlights || []).forEach((h) => bag.push(h));
      (s.points || []).forEach((p) => bag.push((p && p.title) || '', (p && p.text) || ''));
      (d.segments || []).forEach((x) => bag.push((x && x.text) || ''));
    }
    return bag.some((t) => String(t || '').toLowerCase().includes(key));
  },

  onFilter(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.activeFilter) return;
    this.setData({ activeFilter: id }, () => {
      this._request++;
      this._fetching = false;
      this.page = 1;
      const view = this.visible(this.all);
      this.setData({ groups: this.groupByDate(view), total: view.length });
      this.load(true);
    });
    tracker.track('history_filter', { platform: id });
  },

  /* 「筛选⌄」下拉已随分类铺开取消（用户 2026-09-26：全部平台各占一个胶囊） */

  openDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // ⭐ 2026-10-13：进详情前把列表已带回的详情写进结果页缓存 → 结果页 onLoad 直接命中，
    //    首帧就是完整内容（没有 loading 白屏），随后 result 页自己再静默校正一次。
    //    ⚠️ 写失败（storage 满等）不影响进去，只是退回「先 loading 再出内容」的老行为。
    const pre = this._details && this._details[id];
    if (pre) cache.write('result_' + id, pre);
    tracker.track('history_open_detail');
    wx.navigateTo({ url: '/pages/result/result?id=' + id + (this.data.keyword.trim() ? '&keyword=' + encodeURIComponent(this.data.keyword.trim()) : '') });
  },

  onLongPress(e) {
    const id = pickId(e);
    if (!id) return;
    wx.showActionSheet({
      itemList: ['复制文案', '删除记录'],
      success: (r) => {
        if (r.tapIndex === 0) this.copyOne(id);
        if (r.tapIndex === 1) this.deleteOne(id);
      },
      fail: () => {},
    });
  },

  /** 从已加载列表里按 id 取整条（删除确认里要显示标题，防误删） */
  findItem(id) {
    return (this.all || []).find((it) => it._id === id) || null;
  },

  async copyOne(e) {
    const id = pickId(e);
    if (!id) return;
    try {
      const detail = await call('getCopywriting', { id });
      const text = (detail && (detail.transcript || detail.content)) || '';
      if (!text) return toast('这条还没有文案');
      wx.setClipboardData({
        data: text,
        success: () => toast('文案已复制', 'success'),
      });
      tracker.track('history_copy');
    } catch (err) {
      handleError(err, '复制失败');
    }
  },

  /**
   * 删除记录
   * ⚠️ 用户 2026-09-26 明确要求：**必须有确认过程，不能点一下就没**
   *    → 先弹 wx.showModal（标题 + 记录名 + 后果说明），确认按钮单独标红，默认焦点在「取消」
   */
  deleteOne(e) {
    const id = pickId(e);
    if (!id) return;

    const it = this.findItem(id);
    const full = (it && it.title) || '';
    // 标题可能很长（列表里最多显示 2 行）→ 弹窗里截到 20 字，避免撑爆对话框
    const name = full.length > 20 ? full.slice(0, 20) + '…' : full;

    wx.showModal({
      title: '删除这条记录？',
      // ⚠️ 2026-09-29 用户：「不给 7 天内可恢复的功能，实际也没做，取消这部分说明」
      //    移除「7 天内可恢复」承诺 —— 产品**没有恢复入口**，写了属于误导。
      //    ⚠️ 后端软删（deleted 标记）保留不动：那是数据安全网，不是对用户的功能承诺。
      content: name
        ? '「' + name + '」将从历史记录移除。'
        : '该记录将从历史记录移除。',
      confirmText: '删除',
      confirmColor: '#E5484D', // 破坏性操作标红，与「取消」形成视觉区分
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return; // 取消 → 什么都不做
        wx.showLoading({ title: '删除中', mask: true });
        try {
          await call('deleteCopywriting', { id });
          wx.hideLoading();
          toast('已删除', 'success');
          tracker.track('history_delete');
          this._request++; // Do not let an older background response restore a deleted row.
          this.all = this.all.filter(row => row._id !== id);
          const view = this.visible(this.all);
          this.setData({ groups: this.groupByDate(view), total: view.length });
          this.saveHistory();
          this.load(true, null, true);
        } catch (err) {
          wx.hideLoading();
          handleError(err, '删除失败');
        }
      },
    });
  },

  /* ---------- 导航 ---------- */

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  goMine() {
    wx.reLaunch({ url: '/pages/mine/mine' });
  },

  onShareAppMessage() {
    return { title: '我提取的视频文案都在这里', path: '/pages/history/history' };
  },
});
