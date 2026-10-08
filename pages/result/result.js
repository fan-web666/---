// pages/result/result.js - 提取结果（蓝湖稿 03result）
// 业务逻辑复用 Pixso 版（getCopywriting / updateCopywriting / deleteCopywriting，action 名不变）
const { call, handleError } = require('../../utils/api');
const {
  toast,
  platformName,
  thumbColor,
  durationText,
  timeLabel,
  toDate,
  splitParagraphs,
  localThumbSrc,
} = require('../../utils/util');
const tracker = require('../../utils/tracker');

const app = getApp();

// 分段默认指向「返回上一级」
function back() {
  const pages = getCurrentPages();
  if (pages.length > 1) wx.navigateBack();
  else wx.reLaunch({ url: '/pages/index/index' });
}

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    // 导航行右侧安全边距 rpx（避让微信胶囊，app.js 按真机算好；196 为兜底）
    navSafeRightRpx: 196,

    id: '',
    detail: null,
    loading: true,

    // 视图切换：structured = 结构化整理 / raw = 原文案
    // ⭐ 初始值跟随「我的 › 提取偏好设置」（本地偏好 copy_pref）：
    //    full → 停在原文案 / structured → 停在结构化整理；**没设置过则保持原默认（结构化）**
    //    用户 2026-09-26 新增该偏好行，若结果页不认，它就是个假开关
    tab: wx.getStorageSync('copy_pref') === 'full' ? 'raw' : 'structured',
    editing: false,
    draft: '',
  },

  onLoad(options) {
    this.id = (options && options.id) || '';
    this.raw = null;
    this.editedContent = null;
    this.setData({
      statusBarH: app.globalData.navStatusH || 0,
      navSafeRightRpx: app.globalData.navSafeRightRpx || 196,
    });
    this.load();
  },

  async load() {
    if (!this.id) return this.loadLatest();
    if (!app.globalData.cloudReady) return this.loadMock();
    try {
      const data = await call('getCopywriting', { id: this.id });
      if (!data) {
        this.setData({ loading: false, detail: null });
        return;
      }
      this.raw = data;
      this.applyDetail(this.format(data));
      tracker.track('result_view');
    } catch (e) {
      // 详情是进页面自动加载的，失败不弹提示（用户没主动操作）
      handleError(e, '', { silent: true });
      this.setData({ loading: false, detail: null });
    }
  },

  async loadLatest() {
    if (!app.globalData.cloudReady) return this.loadMock();
    try {
      const res = await call('listCopywritings', { page: 1, pageSize: 1 });
      const first = res && res.list && res.list[0];
      if (!first) {
        this.setData({ loading: false, detail: null });
        return;
      }
      this.id = first._id;
      this.raw = first;
      this.applyDetail(this.format(first));
    } catch (e) {
      this.setData({ loading: false, detail: null });
    }
  },

  /** 落数据：没有结构化结果时自动停在「原文案」，避免开局看到空态 */
  applyDetail(detail) {
    const patch = { detail, loading: false, draft: detail.transcript || '' };
    if (!detail.hasStructured && this.data.tab === 'structured') patch.tab = 'raw';
    this.setData(patch);
  },

  /**
   * 原始记录 → 页面模型
   *
   * ⭐ 用户 2026-09-26：顶部视频信息（缩略图 / 标题 / 信息行）**必须与文案库里的同一条一致**
   *    → 三项口径逐字对齐 pages/history/history.js 的 formatItem()，改一处必须同步另一处：
   *    ① 缩略图：同一个 _id 走同一个 thumbColor（已提为 utils/util.js 的公共实现），
   *              封面判据也相同（只收 https）；三条降级顺序也相同
   *    ② 标题：都用 video_title，缺省「未命名视频」
   *    ③ 信息行：platformName(code) · N 字 · timeLabel(created_at)
   */
  format(d) {
    const platform = platformName(d.source_platform);
    const transcript = String(d.transcript || d.content || '');
    // 字数：优先按当前 transcript 实时算（编辑保存后立刻准），老数据再回落云端的 char_count
    const chars = transcript.replace(/\s/g, '').length || Number(d.char_count) || 0;
    const cover = String(d.cover_url || '');
    // ⭐ 本地视频封面：优先用「选视频时留下的缩略图」（本地文件，立即出图，无黑图过程）
    //    ⚠️ 与 pages/history 同判据，改一处必须同步另一处（utils/util.js 内为唯一实现）
    const localThumb = localThumbSrc(d.local_video_id);

    /* ---------- ① 结构化整理（辅助视图） ---------- */
    const s = d.structured || {};
    const hook = String(s.hook || '').trim();
    const highlights = (Array.isArray(s.highlights) ? s.highlights : [])
      .filter((h) => h != null && h !== '')
      .map((h) => String(h).trim())
      .filter(Boolean);
    const points = (Array.isArray(s.points) ? s.points : [])
      .filter((p) => p != null && p !== '')
      .map((p) => ({
        type: (p && p.type) || 'point',
        title: String((p && p.title) || ''),
        text: String(typeof p === 'string' ? p : (p && p.text) || ''),
      }))
      .filter((p) => p.text || p.title)
      // 序号在过滤之后再编，避免出现「01 缺号直接跳 03」
      .map((p, i) => Object.assign(p, { no: (i + 1 < 10 ? '0' : '') + (i + 1) }));
    const hasStructured = !!(hook || highlights.length || points.length);

    /* ---------- ② 原文案（事实层，不删改） ---------- */
    let paragraphs = [];
    if (Array.isArray(d.segments) && d.segments.length) {
      paragraphs = d.segments
        .map((x) => ({
          time: x && x.start != null ? durationText(x.start) : '',
          text: (x && x.text) || '',
        }))
        .filter((p) => p.text);
    }
    if (!paragraphs.length) {
      // ⚠️ ASR（whisper 的 json 格式）返回的是一整段无换行文本，按 \n 切只会得到 1 段
      //    → 统一走 splitParagraphs 按句读 + 字数重新聚合（唯一实现在 utils/util.js）
      paragraphs = splitParagraphs(transcript).map((t) => ({ time: '', text: t }));
    }
    // i = wx:key 用的稳定序号（段落文本可能重复，wx:key="*this" 不适用对象数组）
    paragraphs = paragraphs.map((p, i) => Object.assign(p, { i }));

    return {
      title: d.video_title || '未命名视频',
      // 信息行与文案库同口径：平台 · 字数 · 时间（用户 2026-09-26 要求两边一致）
      metaLine: this.metaLine(platform, chars, d.created_at),
      // 留原料：编辑保存后要就地重算信息行（字数会变）
      charCount: chars,
      platform,
      // 缩略图三级降级，与历史列表页逐条对应（见 format 方法头 ⭐）：
      // ① https / cloud:// 封面（http 在真机必失败，不收；cloud:// 为 2026-09-28 新增的封面转存 fileID，
      //    平台直链几小时~一两天就 403，转存后永久有效）→ ② 本地视频缩略图（本地文件，即时）
      // → ③ 视频首帧（云存储 fileID，交 <video> 显示，无缩略图时才会走到）→ ④ 都没有才回落色块 + ▶
      cover: (/^(https:\/\/|cloud:\/\/)/i.test(cover) ? cover : '') || localThumb,
      coverFail: false,
      videoSrc: localThumb ? '' : d.local_video_id || '',
      thumbBg: thumbColor(d._id || this.id),
      countLine: '共 ' + paragraphs.length + ' 段 · ' + chars + ' 字',
      paragraphs,
      transcript,
      // 结构化整理：直接平铺，WXML 里读 detail.hook / detail.points
      hook,
      highlights,
      points,
      hasStructured,
      sourceUrl: d.source_url || '',
    };
  },

  /**
   * 视频信息行：平台 · 字数 · 时间 —— 与文案库列表页逐字一致
   * ⚠️ 不要再拼「视频」后缀（platform + '视频'）：platformName('local') 本身就是「本地视频」，
   *    拼出来成了「本地视频视频」（用户 2026-09-26 截图里就是这个 bug）
   */
  metaLine(platform, chars, ts) {
    const d = ts ? toDate(ts) : null;
    return (
      [platform, chars ? chars + ' 字' : '', d ? timeLabel(d.getTime()) : '']
        .filter(Boolean)
        .join(' · ') || '刚刚提取'
    );
  },

  /** 封面加载失败（平台封面 URL 带签名时效，过期会 403）→ 该卡降级为首帧 / 色块 */
  onCoverError() {
    this.setData({ 'detail.coverFail': true });
  },

  /* ---------- 视图切换 ---------- */

  switchTab(e) {
    const t = e.currentTarget.dataset.tab;
    if (!t || t === this.data.tab || this.data.editing) return;
    this.setData({ tab: t });
    tracker.track('result_switch_tab', { tab: t });
  },

  /* ---------- 编辑 ---------- */

  toggleEdit() {
    if (this.data.editing) return this.saveEdit();
    // 编辑的是「原文案」逐字稿；进编辑态自动切到原文案视图
    this.editedContent = this.data.detail ? this.data.detail.transcript || '' : '';
    this.setData({ editing: true, tab: 'raw', draft: this.editedContent });
    tracker.track('result_edit_start');
  },

  onEdit(e) {
    this.editedContent = e.detail.value;
  },

  async saveEdit() {
    const content = this.editedContent == null ? this.data.draft : this.editedContent;
    this.setData({ editing: false });

    if (content == null) return;
    if (this.data.detail && content === this.data.detail.transcript) return;

    // 本地立即更新视图（preserveBreaks：用户手打的换行一律尊重，不按字数重新聚合）
    // i = wx:key 用的稳定序号（段落文本可能重复，不能用 *this）
    const paragraphs = splitParagraphs(content, { preserveBreaks: true }).map((t, i) => ({
      i,
      time: '',
      text: t,
    }));

    const chars = content.replace(/\s/g, '').length;
    const cur = this.data.detail || {};
    this.setData({
      'detail.transcript': content,
      'detail.paragraphs': paragraphs,
      'detail.charCount': chars,
      // 信息行里的字数同步刷新 —— 否则编辑完顶部还挂着旧字数，与文案库对不上
      'detail.metaLine': this.metaLine(cur.platform, chars, this.raw && this.raw.created_at),
      'detail.countLine': '共 ' + paragraphs.length + ' 段 · ' + chars + ' 字',
    });

    if (!app.globalData.cloudReady) return;

    try {
      await call('updateCopywriting', { id: this.id, content });
      toast('已保存', 'success');
      tracker.track('result_edit_save');
    } catch (e) {
      handleError(e, '保存失败，稍后重试');
    }
  },

  /* ---------- 复制 ---------- */

  /** 结构化整理的复制文本（整理版，不含原文） */
  structuredCopyText() {
    const d = this.data.detail || {};
    const lines = [];
    if (d.title) lines.push('# ' + d.title);
    if (d.hook) lines.push('', '> ' + d.hook);
    if (d.highlights && d.highlights.length) {
      lines.push('', '## 金句');
      d.highlights.forEach((h) => lines.push('- ' + h));
    }
    if (d.points && d.points.length) {
      lines.push('', '## 内容要点');
      d.points.forEach((p, i) =>
        lines.push(i + 1 + '. ' + (p.title ? p.title + '：' : '') + p.text)
      );
    }
    return lines.join('\n');
  },

  /** 原文案的复制文本：按段落用空行分隔，粘到别处也是分好段的 */
  rawCopyText() {
    const d = this.data.detail || {};
    const ps = (d.paragraphs || []).map((p) => p.text).filter(Boolean);
    return ps.length ? ps.join('\n\n') : d.transcript || '';
  },

  /** 一键复制：跟随当前 tab */
  copyAll() {
    const isStructured = this.data.tab === 'structured' && !this.data.editing;
    const text = isStructured ? this.structuredCopyText() : this.rawCopyText();
    if (!text) return toast(isStructured ? '这条没有结构化整理结果' : '没有可复制的原文');
    wx.setClipboardData({
      data: text,
      success: () => {
        toast(isStructured ? '整理版已复制' : '原文已复制', 'success');
        tracker.track(isStructured ? 'result_copy_structured' : 'result_copy_raw');
      },
    });
  },

  /**
   * 段落长按 → 复制该段
   * ⚠️ 2026-09-29 用户：「提取结果的文字中要允许长按屏幕复制局部文字」
   *    → 长按划词由 WXML 内层 `<text selectable>` 承担（⚠️ 2026-09-29 修正：
   *      `selectable` 是 **text 组件专有属性**，写在 `view` 上会被静默忽略 —— 之前正是踩了这个坑），
   *      由用户自己拉选局部文字。此时**不能再叠加一个「复制整段」toast** ——
   *      会把系统菜单顶掉、并把长按语义从「选词」偷换成「整段复制」。
   *    → 故改为**放行系统文本选择**，本方法不再绑定。
   *    （此前的 handler 保留一份在下面，改名不挂事件，方便随时回退。）
   */
  copyParagraphLegacy(e) {
    const idx = e.currentTarget.dataset.index;
    const p = this.data.detail && this.data.detail.paragraphs[idx];
    if (!p) return;
    wx.setClipboardData({
      data: p.text,
      success: () => toast('该段已复制', 'success'),
    });
  },

  copySource() {
    const url = this.data.detail && this.data.detail.sourceUrl;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => toast('源链接已复制', 'success'),
    });
  },

  /* ---------- 重新提取 / 删除 ---------- */

  reExtract() {
    const url = this.data.detail && this.data.detail.sourceUrl;
    if (!url) {
      return wx.showModal({
        title: '无法重新提取',
        content: '这条记录没有保存源链接，请回首页粘贴链接重新提取。',
        showCancel: false,
      });
    }
    wx.showModal({
      title: '重新提取',
      content: '将按当前设置重新解析这条视频，会再次扣除积分（会员额度内不扣）。',
      confirmText: '开始',
      success: (r) => {
        if (!r.confirm) return;
        wx.redirectTo({ url: '/pages/loading/loading?url=' + encodeURIComponent(url) });
      },
    });
  },

  remove() {
    if (!this.id) return toast('这条记录还没有落库');
    wx.showModal({
      title: '删除记录',
      // ⚠️ 2026-09-29 移除「7 天内仍可恢复」——未做恢复入口，不能给用户这个承诺（与 pages/history 同步）
      content: '该记录将从历史记录移除，确定删除？',
      confirmColor: '#E5484D',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await call('deleteCopywriting', { id: this.id });
          toast('已删除', 'success');
          setTimeout(() => back(), 600);
        } catch (e) {
          handleError(e, '删除失败');
        }
      },
    });
  },

  /* ---------- 导航 ---------- */

  goBack() {
    back();
  },

  /** 导航右侧 •••：更多操作 */
  onMore() {
    wx.showActionSheet({
      itemList: ['复制源链接', '重新提取', '删除这条记录'],
      success: (r) => {
        if (r.tapIndex === 0) this.copySource();
        if (r.tapIndex === 1) this.reExtract();
        if (r.tapIndex === 2) this.remove();
      },
      fail: () => {},
    });
  },

  /* ---------- 演示数据（云环境未配置时） ---------- */

  loadMock() {
    const demo = {
      video_title: '演示结果 · 未配置云环境',
      source_platform: 'douyin',
      duration_sec: 204,
      created_at: Date.now(),
      elapsed_sec: 1.2,
      structured: {
        hook: '刷到好口播却只能手打记录？三步就能把它变成可编辑文案。',
        highlights: ['真正的起步，不是等准备好，而是先把第一条发出去。'],
        points: [
          {
            type: 'step',
            title: '开场钩子',
            text: '先分享一个多数人忽略的事实：做内容的人，最缺的不是灵感。',
          },
          { type: 'point', title: '核心观点', text: '持续输出的关键，是建立属于自己的素材库。' },
        ],
      },
      transcript: [
        '这是一条演示原文，说明云环境尚未配置。',
        '在 config/index.js 里填入 cloudEnvId 后，就会显示真实提取结果。',
        '分段、字数、来源链接都会根据真实数据自动计算。',
      ].join('\n'),
    };
    this.raw = demo;
    this.applyDetail(this.format(demo));
  },

  onShareAppMessage() {
    const t = (this.data.detail && this.data.detail.title) || '视频文案提取';
    return { title: t, path: '/pages/index/index' };
  },
});
