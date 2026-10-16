// pages/settings/settings.js - 提取设置（新稿无此屏，按规范补）
// 业务逻辑复用 Pixso 版，storage key 保持 'extract_settings'（老设置可直接读到）
// ⚠️ 修正 Pixso 版遗留缺陷：原文件 onLoad 里用了 app.globalData 却没有 const app = getApp()
//    → 进页面即抛错。此处补上。
const pricing = require('../../config/pricing');
const { toast, platformName, detectPlatform } = require('../../utils/util');
const tracker = require('../../utils/tracker');

const app = getApp();

const STORE_KEY = 'extract_settings';

const DEFAULT_FORM = {
  mode: 'full',
  language: '中文（简体）',
  languageLabel: '中文（简体）',
  // 默认：自动补标点 = 开，保留时间轴 = 关
  autoPunct: true,
  keepTimeline: false,
};

Page({
  data: {
    // 状态栏高度（自定义导航栏占位）
    statusBarH: 0,
    // 导航行右侧安全边距 rpx（避让微信胶囊，app.js 按真机算好；196 为兜底）
    navSafeRightRpx: 196,

    modes: pricing.EXTRACT_MODES,
    languages: pricing.LANGUAGES,
    chargeText: '视频 10 分钟以内 ' + pricing.CREDIT_VIDEO_SHORT + ' 积分、10~30 分钟 ' + pricing.CREDIT_VIDEO_LONG +
      ' 积分；文案起步 ' + pricing.CREDIT_START_TEXT + ' 积分 + 每分钟 ' + pricing.CREDIT_PER_MIN_TEXT + ' 积分',

    form: Object.assign({}, DEFAULT_FORM),

    link: {
      title: '尚未选择视频链接',
      sub: '回到首页粘贴链接后再来设置',
    },
  },

  onLoad(options) {
    // 从首页带入的链接（若有）
    this.url = options && options.url ? decodeURIComponent(options.url) : '';
    this.setData({
      statusBarH: app.globalData.navStatusH || 0,
      navSafeRightRpx: app.globalData.navSafeRightRpx || 196,
    });
    this.loadSettings();
    this.applyLink();
  },

  /* ---------- 持久化 ---------- */

  loadSettings() {
    try {
      const saved = wx.getStorageSync(STORE_KEY);
      if (saved && typeof saved === 'object') {
        const form = Object.assign({}, DEFAULT_FORM, saved);
        form.languageLabel = form.language;
        this.setData({ form });
      }
    } catch (e) {
      // 忽略：storage 不可用时用默认值
    }
  },

  saveSettings() {
    try {
      wx.setStorageSync(STORE_KEY, this.data.form);
    } catch (e) {
      // 忽略
    }
  },

  applyLink() {
    const url = (this.url || '').trim();
    if (!url) return;
    const code = detectPlatform(url);
    const platform = code ? platformName(code) : '未知平台';
    this.setData({
      link: {
        title: platform + ' · ' + (url.length > 40 ? url.slice(0, 40) + '…' : url),
        sub: '设置会在本次提取生效',
      },
    });
  },

  /* ---------- 交互 ---------- */

  pickMode(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || id === this.data.form.mode) return;
    this.setData({ 'form.mode': id });
    this.saveSettings();
    tracker.track('settings_mode', { mode: id });
  },

  pickLanguage() {
    const list = this.data.languages;
    wx.showActionSheet({
      itemList: list,
      success: (r) => {
        const language = list[r.tapIndex];
        this.setData({ 'form.language': language, 'form.languageLabel': language });
        this.saveSettings();
      },
    });
  },

  toggle(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    const val = !this.data.form[key];
    const patch = {};
    patch['form.' + key] = val;
    this.setData(patch);
    this.saveSettings();
    tracker.track('settings_toggle', { key, val });
  },

  resetAll() {
    wx.showModal({
      title: '恢复默认设置',
      content: '提取内容、文案语言、补标点与时间轴都会回到默认值。',
      confirmText: '恢复默认',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ form: Object.assign({}, DEFAULT_FORM) });
        this.saveSettings();
        toast('已恢复默认', 'success');
      },
    });
  },

  /* ---------- 导航 ---------- */

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    return { title: '把视频里的好文案，变成你的素材库，支持视频提取', path: '/pages/index/index' };
  },
});
