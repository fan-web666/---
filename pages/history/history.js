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
} = require('../../utils/util');
const tracker = require('../../utils/tracker');

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
  //    ⚠️ 2026-09-29 用户要求标签文字用「其他」（不用「其他平台」，否则一行文字太多）。
  //       行内来源文字仍走 platformName('other') = 「其他平台」，此处只改筛选标签本身。
  //    ⚠️ id 必须是 'other'（= 云端 detectPlatform 的兜底 code），不能写 'other_platform'。
  { id: 'other', label: '其他' },
];

/* PLATFORM_ALIAS / normPlatform 已提到 utils/util.js ——
   「我的」页的「最近一条记录」要用同一口径（平台名 + 缩略色 + 时间），
   两页各写一份必然漂移，故只留一份实现（同 thumbColor / timeLabel 的处理） */

// 缩略色块的兜底配色 thumbColor()：已提到 utils/util.js ——
// 提取结果页要用同一套颜色（同一个 _id 两边必须同色），副本会漂移，故只留一份实现
const PAGE_SIZE = 20;

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

    keyword: '',
    activeFilter: 'all',
    filters: FILTERS,

    groups: [],
    total: 0,
    hasMore: false,
    loading: true,
    refreshing: false,
  },

  onLoad() {
    this.page = 1;
    this.all = [];
    this.searchTimer = null;
    this.setData({ statusBarH: app.globalData.navStatusH || 0, navSafeRightRpx: app.globalData.navSafeRightRpx || 196 });
  },

  onShow() {
    this.page = 1;
    // silent=true：进页面自动加载，失败不弹提示（用户没主动操作）
    this.load(true, null, true);
  },

  /** scroll-view 触底 */
  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return;
    this.page += 1;
    this.load(false);
  },

  /** 下拉刷新 */
  onRefresh() {
    this.page = 1;
    this.setData({ refreshing: true });
    this.load(true, () => this.setData({ refreshing: false }));
  },

  /* ---------- 数据 ---------- */

  async load(reset, done, silent) {
    if (!app.globalData.cloudReady) {
      this.setData({ loading: false, groups: [], total: 0, hasMore: false });
      if (done) done();
      return;
    }

    if (reset) this.setData({ loading: true });

    const params = { page: this.page, pageSize: PAGE_SIZE };
    if (this.data.keyword) params.keyword = this.data.keyword;
    if (this.data.activeFilter !== 'all') params.platform = this.data.activeFilter;

    try {
      const res = await call('listCopywritings', params);
      const list = (res && res.list) || [];
      const total = (res && res.total) || 0;

      const mapped = list.map((it) => this.formatItem(it));

      this.all = reset ? mapped : this.all.concat(mapped);
      const hasMore = this.all.length < total;

      const view = this.visible(this.all);
      this.setData({
        groups: this.groupByDate(view),
        // 「共 N 条」按当前筛选后的条数展示
        total: view.length,
        hasMore,
        loading: false,
      });
    } catch (e) {
      // 自动加载（silent）不弹提示；下拉刷新 / 触底加载属用户主动操作，正常提示
      handleError(e, '', { silent: !!silent });
      this.setData({ loading: false });
      if (reset) this.setData({ groups: [], total: 0, hasMore: false });
    }

    if (done) done();
  },

  /** 本地兜底过滤（服务端已按平台过滤，这里再兜一层，切回来不丢） */
  visible(list) {
    const f = this.data.activeFilter;
    if (f === 'all') return list;
    return list.filter((it) => it.platform === f);
  },

  formatItem(it) {
    const code = normPlatform(it.source_platform);
    const time = timeLabel(it.created_at);
    // 字数：云端 char_count（云端落库时按 transcript 长度写入）。
    // 老数据可能是 0 → 该段直接不显示，不写「0 字」这种占位（见下方 filter(Boolean)）
    const chars = Number(it.char_count) || 0;
    const cover = String(it.cover_url || '');
    // ⭐ 本地视频封面：优先用「选视频时留下的缩略图」（本地文件，立即出图），
    //    详见 utils/util.js 的 cacheLocalThumb / localThumbSrc。
    //    ⚠️ 没有它时（老记录 / 换设备 / 清了缓存）才回落 <video> 首帧 —— 那条路会先黑一下。
    const localThumb = localThumbSrc(it.local_video_id);
    return {
      _id: it._id,
      title: it.video_title || '未命名视频',
      // 用户 2026-09-26：格式对齐参考图「抖音 · 642 字 · 14:32」
      meta: [platformName(code), chars ? chars + ' 字' : '', time].filter(Boolean).join(' · '),
      platform: code,
      created_at: it.created_at,
      dateKey: localDateStr(it.created_at),

      // 缩略图三级降级：原视频封面 → 本地视频缩略图（本地文件，即时）→ 视频首帧 → 设计稿色块
      // ① 封面：收 https 与 cloud:// —— http 图片在真机上必然加载失败，收进来只会白请求 + 控制台刷错误
      //    ⭐ cloud:// 是 2026-09-28 新增的「封面转存云存储」fileID：平台直链带签名、几小时~一两天就 403，
      //       转存后永久有效，历史页不会再整片变绿块
      cover: (/^(https:\/\/|cloud:\/\/)/i.test(cover) ? cover : '') || localThumb,
      coverFail: false,
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
    if (Object.keys(patch).length) this.setData(patch);
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
    this.setData({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page = 1;
      this.load(true);
    }, 400);
  },

  onFilter(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.activeFilter) return;
    this.setData({ activeFilter: id }, () => {
      this.page = 1;
      this.all = [];
      this.load(true);
    });
    tracker.track('history_filter', { platform: id });
  },

  /* 「筛选⌄」下拉已随分类铺开取消（用户 2026-09-26：全部平台各占一个胶囊） */

  openDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    tracker.track('history_open_detail');
    wx.navigateTo({ url: '/pages/result/result?id=' + id });
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
          this.page = 1;
          this.load(true);
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
