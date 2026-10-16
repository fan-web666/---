// pages/usage/usage.js · 「积分与订单」子页（用户 2026-09-26 新增）
// ────────────────────────────────────────────────────────────────────────────
// 入口：「我的」页 › ④ 提取记录卡（原先跳文案库，现改为跳本页）
// 数据：call('listUsage') —— 一次拿全「消耗明细 + 汇总 + 会员额度 + 订单」
//   ⚠️ 主表是**服务端计费流水（tasks）**，不是历史文案 —— 文案表里没有计费字段。
//      因此在文案库删掉文案后，这里的消费追溯**依然完整**（用户拍板的口径）。
//
// 降级原则（与「我的」页一致）：
//   · 汇总拿不到 → 显示「—」，**不显示 0**（0 和「没拿到」必须长得不一样）
//   · 无记录 / 无订单 → 空态文案，不渲染假数据
//   · 自动加载失败 → 不弹 toast（用户没主动操作），改为把空态文案换成「加载失败」
// 删除：「⋯」= 只把该条流水**对本页隐藏**（hideUsage），**不动文案库里的内容**
const { call } = require('../../utils/api');
const {
  toast,
  platformName,
  normPlatform,
  shortNumber,
  // 时长 mm:ss —— 全站唯一实现（utils/util.js），本页不重复造
  durationText,
  // 会员档位展示名 —— 同上，唯一实现（2026-09-29 起本页不再自带副本）
  TIER_TEXT,
} = require('../../utils/util');
const tracker = require('../../utils/tracker');
const cache = require('../../utils/view-cache');
const dashboard = require('../../utils/dashboard');
const VIEW_FIELDS = ['list','page','total','hasMore','emptyText','monthCreditText','totalCreditText','quotaText','quotaPct','orders','scrollTop'];

const app = getApp();

/** task 结果 → 文案 */
const RESULT_TEXT = { ok: '解析成功', failed: '解析失败', doing: '处理中' };

/** 订单状态 → 文案 + 类名 */
const ORDER_STATE = {
  paid: { t: '已支付', c: 'x-st-ok' },
  finished: { t: '已完成', c: 'x-st-ok' },
  pending: { t: '待支付', c: '' },
  cancelled: { t: '已取消', c: '' },
  closed: { t: '已关闭', c: '' },
  refunded: { t: '已退款', c: '' },
};

/** ⚠️ 2026-09-29：原本页私有 `TIER_TEXT` 副本已删除 —— 档位展示名统一取自
 *  `utils/util.js#TIER_TEXT`（唯一实现），避免「我的/会员中心/本页」三处各写一份而漂移。
 *  本页额度数据来自 `listUsage` 的**扁平** `quota`（与 membership.quota 同源），逻辑未变。 */

Page({
  data: {
    // 自定义导航栏占位
    statusBarH: 0,
    navSafeRightRpx: 196,

    refreshing: false,
    loading: false,

    // 消耗明细
    list: [],
    page: 1,
    total: 0,
    hasMore: false,
    emptyText: '还没有消耗记录',

    // 汇总（'—' = 云端没给，绝不伪造 0）
    monthCreditText: '—',
    totalCreditText: '—',
    quotaText: '—',
    quotaPct: 0,

    // 订单
    orders: [],
    scrollTop: 0,
    ...(cache.read('usage') || {}),
  },

  onLoad() {
    const c = cache.read('usage');
    cache.patch(this,c || {list:[],page:1,total:0,hasMore:false,emptyText:'还没有消耗记录',monthCreditText:'—',totalCreditText:'—',quotaText:'—',quotaPct:0,orders:[],scrollTop:0});
    this._cached = !!c;
    this._owner = cache.uid();
    this._request = 0;
    const raw=dashboard.read('usage');if(raw)this.applyBackground(raw);
    if(!c&&!raw)this.setData({loading:true});
    this._dashboardOff=dashboard.subscribe((type,data)=>{if(type==='usage')this.applyBackground(data);});
    this.setData({ statusBarH: app.globalData.navStatusH || 0, navSafeRightRpx: app.globalData.navSafeRightRpx || 196 });
    tracker.track('usage_view');
  },

  onShow() {
    // 每次进页都拉最新（消耗是会变的；从别处返回时也应是新数据）
    dashboard.refresh();
  },

  /* ---------- 拉取 ---------- */
  applyBackground(res) {
    if(this._disposed||this._busy)return;
    if((res._pages||1)<this.data.page)return;
    cache.patch(this,{...this.applySummary(res),list:(res.list||[]).map(formatUsage),page:res._pages||1,total:res.total||0,hasMore:!!res.hasMore,orders:(res.orders||[]).map(formatOrder),loading:false,emptyText:'还没有消耗记录'});
    this._cached=true;this.saveView();
  },

  /** 首屏 / 下拉刷新：重置到第 1 页 */
  reload() {
    if (!app.globalData.cloudReady) return Promise.resolve();
    const ticket = ++this._request, uid = cache.uid();
    this._busy = true;
    if (!this._cached) this.setData({ loading: true });
    const depth = Math.min(this.data.page || 1, 10);
    return call('listUsage', { page: 1 })
      .then(async (res) => {
        const lastPage = Math.max(1, Math.min(depth, Math.ceil((res.total || 0) / 20)));
        let list = res.list || [];
        if (lastPage > 1) {
          const rest = await Promise.all(Array.from({length:lastPage-1},(_,i)=>call('listUsage',{page:i+2})));
          rest.forEach(r=>{list=list.concat(r.list||[]);});
        }
        if (ticket !== this._request || this._disposed || uid !== cache.uid()) return;
        cache.patch(this, {
          ...this.applySummary(res),
          list: list.map(formatUsage),
          page: lastPage,
          total: res.total || 0,
          hasMore: list.length < (res.total || 0),
          orders: (res.orders || []).map(formatOrder),
          loading: false,
          emptyText: '还没有消耗记录',
        });
        this._cached = true;
        this.saveView();
      })
      .catch((err) => {
        if (ticket !== this._request || this._disposed || uid !== cache.uid()) return;
        // 自动加载失败：不弹 toast，把空态文案换掉即可（用户没主动操作）
        this.setData({ loading: false, ...(this._cached ? {} : {emptyText:'加载失败，下拉可重试'}) });
        console.warn('[usage] listUsage 失败', err && (err.msg || err.errMsg || err));
      }).finally(()=>{if(ticket===this._request)this._busy=false;});
  },

  /** 上拉加载下一页 */
  loadMore() {
    if (this._busy || this.data.loading || !this.data.hasMore) return Promise.resolve();
    const next = this.data.page + 1;
    const ticket=++this._request,uid=cache.uid();
    this.setData({ loading: true });
    return call('listUsage', { page: next })
      .then((res) => {
        if(ticket!==this._request||this._disposed||uid!==cache.uid())return;
        this.setData({
          list: this.data.list.concat((res.list || []).map(formatUsage)),
          page: next,
          total: res.total || 0,
          hasMore: !!res.hasMore,
          loading: false,
        });
        this.saveView();
      })
      .catch(() => {if(ticket===this._request&&!this._disposed)this.setData({ loading: false });});
  },

  onPull() {
    this.setData({ refreshing: true });
    return this.reload().then(() => this.setData({ refreshing: false }));
  },

  onReach() {
    this.loadMore();
  },

  /* ---------- 汇总整形 ---------- */

  applySummary(res) {
    const s = res.summary || null;
    const q = res.quota || null;
    const tier = res.tier || 'none';

    const patch = {
      // ⚠️ 云端聚合拿不到时给 null → 显示「—」
      monthCreditText: !s || s.month_credit == null ? this.data.monthCreditText : shortNumber(s.month_credit),
      totalCreditText: !s || s.total_credit == null ? this.data.totalCreditText : shortNumber(s.total_credit),
    };

    if (q && q.total > 0) {
      patch.quotaText = '已用 ' + q.used + ' / ' + q.total + ' 次';
      patch.quotaPct = Math.max(0, Math.min(100, Math.round((q.used / q.total) * 100)));
    } else if (tier === 'unlimited') {
      patch.quotaText = '不限次';
      patch.quotaPct = 0;
    } else if (tier && tier !== 'none') {
      // 是会员但没拿到额度字段 → 不编数字
      patch.quotaText = this.data.quotaText;
      patch.quotaPct = this.data.quotaPct;
    } else {
      patch.quotaText = '未开通';
      patch.quotaPct = 0;
    }

    return patch;
  },

  /* ---------- 交互 ---------- */

  /** 「⋯」：从本页移除一条流水（只隐藏，不动文案库） */
  onRemove(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || '';
    if (!id) return;

    wx.showModal({
      title: '从本页移除',
      content: '只会从这份消费明细里移除，文案库里的内容不受影响。',
      confirmText: '移除',
      confirmColor: '#16854A',
      success: (r) => {
        if (!r.confirm) return;
        call('hideUsage', { task_id: id })
          .then(() => {
            const list = this.data.list.filter((x) => x._id !== id);
            this.setData({
              list,
              total: Math.max(0, this.data.total - 1),
              emptyText: list.length ? '还没有消耗记录' : '还没有消耗记录',
            });
            this._request++;
            this._busy = false;
            this.saveView();
            toast('已移除');
          })
          .catch((err) => toast((err && err.msg) || '移除失败，请稍后重试'));
      },
    });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/mine/mine' }); // 直接进入本页时的兜底
  },
  saveView() {
    if (!this._cached || this._owner !== cache.uid()) return;
    const snapshot = {};
    VIEW_FIELDS.forEach(k=>{snapshot[k]=this.data[k];});
    snapshot.list = snapshot.list.slice(0,200);
    snapshot.hasMore = snapshot.hasMore || snapshot.list.length < this.data.list.length;
    snapshot.page = Math.max(1,Math.ceil(snapshot.list.length/20));
    cache.write('usage',snapshot);
  },
  onScroll(e) { this._scrollTop=e.detail.scrollTop||0; },
  onHide() { if(this._scrollTop!==undefined)this.data.scrollTop=this._scrollTop; this.saveView(); },
  onUnload() { this.onHide(); this._disposed=true; this._request++; if(this._dashboardOff)this._dashboardOff(); },

  onShareAppMessage() {
    return { title: '把视频里的好文案，变成你的素材库，支持视频提取', path: '/pages/index/index' };
  },
});

/* ============================================================
 *  视图模型
 * ============================================================ */

/** 主行标题最多显示的字数（超出用 … 收尾，给右侧积分数据留白） */
const TITLE_MAX = 16;

/** 标题截断：超长 → 前 TITLE_MAX 字 + '…'（按字符切，emoji/生僻字不劈半） */
function clipTitle(s) {
  const chars = Array.from(String(s || ''));
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') + '…' : chars.join('');
}

/** 一条消费流水 → 列表行（⚠️ 只给识别信息，不给视频标题与正文） */
function formatUsage(it) {
  const code = normPlatform(it.platform);
  const dur = it.duration_sec > 0 ? durationText(it.duration_sec) : '';
  const cost = costOf(it);
  const plat = platformName(code);
  // ⭐ 2026-09-29 用户：「把视频的名称加上去，更清楚」
  //    后端 `shapeUsage` 一直带 `title`（= tasks.video_title），此前前端刻意弃用（原注释「不含视频标题」），现启用。
  //    ⚠️ 标题可能为空 —— 本地导入的视频没有来源标题 ⇒ 回退「平台 · 时长」，与改动前**逐字一致**，主行永不为空。
  //    ⚠️ 主行换成标题后，「视频号 / 本地视频」这个来源就没了 ⇒ 有标题时在副行补回来源；无标题时副行不重复。
  //    ⭐ 2026-09-29 用户：「20 个文字 + 省略号太靠近右边积分，改成 16 个字 + 省略号，多点留白」
  //    说明：原先**没有** JS 截断，是 `.x-use-t` 的 CSS 单行省略按容器宽度截的（约 20 字）。
  //    现改为显式截到 TITLE_MAX 字 + '…'，右侧留白由宽度自然让出；CSS 省略保留作最后兜底。
  //    ⚠️ 按「字符」而非 UTF-16 码元截断（Array.from）—— emoji / 生僻字不会被劈成半个。
  const name = String(it.title || '').trim();
  const metaBits = [stamp(it.ts), RESULT_TEXT[it.result] || ''];
  metaBits.unshift(it.extract_kind === 'video' ? '视频提取' : '文案提取');
  if (name) metaBits.unshift(plat);
  return {
    _id: it._id,
    // 主行：视频标题（超 16 字截断加省略号）；无标题 → 回退「平台 · 时长」
    title: name ? clipTitle(name) : [plat, dur].filter(Boolean).join(' · '),
    // 副行：来源（仅有标题时）· 时间 · 结果
    meta: metaBits.filter(Boolean).join(' · '),
    costText: cost.t,
    costCls: cost.c,
  };
}

/** 扣费文案：退还 > 积分 > 会员额度 > 不限次 > 未知 */
function costOf(it) {
  if (it.refunded) return { t: '已退还', c: 'x-cost-back' };
  if (it.pay_type === 'credit') return { t: '-' + (it.credit_cost || 0) + ' 积分', c: 'x-cost-credit' };
  if (it.pay_type === 'quota') return { t: '-' + (it.quota_used || 0) + ' 积分额度', c: 'x-cost-quota' };
  if (it.pay_type === 'unlimited') return { t: '不限次', c: 'x-cost-free' };
  return { t: '—', c: 'x-cost-none' };
}

/** 一条订单 → 列表行 */
function formatOrder(o) {
  const isMember = o.type === 'member';
  const st = ORDER_STATE[o.status] || { t: o.status || '', c: '' };
  return {
    _id: o._id,
    title: isMember
      ? TIER_TEXT[o.tier] || '会员'
      : '积分充值' + (o.credits ? '\u00A0·\u00A0' + o.credits + ' 积分' : ''),
    meta: stamp(o.ts),
    amountText: '¥' + (Number(o.amount_cents || 0) / 100).toFixed(2),
    stText: st.t,
    stCls: st.c,
  };
}

/* ---------- 小工具 ---------- */

/**
 * 时间戳 → MM-DD HH:mm
 * ⚠️ 本页**刻意不用** util 的 timeLabel（相对时间「今天 21:03 / 昨天 / 9 月 26 日」）：
 *    消费追溯要精确到分钟，相对标签会丢掉具体时间，跨月看也对不上账。
 */
function stamp(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
