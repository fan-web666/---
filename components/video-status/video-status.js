const video = require('../../utils/video-session');
Component({
  properties: { location: { type: String, value: 'index' }, feedback: { type: Boolean, value: true }, enabled: { type: Boolean, value: true, observer() { if (this.apply) this.apply(video.snapshot()); } } },
  data: { visible: false, snap: {}, showDialog: false, dialogTitle: '', dialogContent: '', confirmText: '知道了', canRetry: false },
  lifetimes: {
    attached() { this._unsub = video.subscribe(s => this.apply(s)); },
    detached() { if (this._unsub) this._unsub(); },
  },
  pageLifetimes: {
    show() { this._visible = true; video.setForeground(true); this.apply(video.snapshot()); },
    hide() { this._visible = false; video.setForeground(false); },
  },
  methods: {
    apply(s) {
      if (s.phase === 'idle') this.setData({ showDialog: false });
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      const route = page && page.route;
      const top = !route || route === 'pages/' + this.properties.location + '/' + this.properties.location;
      let visible = this.properties.enabled && s.phase !== 'idle' && s.mode === 'both';
      if (this.properties.location === 'result' && page && page.options && s.copyId && page.options.id !== s.copyId) visible = false;
      const textLabel = s.copyPhase === 'done' ? '文案已完成' : s.copyPhase === 'cancelled' ? '文案已取消' : s.copyPhase === 'failed' ? '文案提取未完成' : s.copyPhase === 'running' ? '文案提取 ' + s.copyPercent + '%' : '文案等待中';
      this.setData({ location: this.properties.location, visible, snap: s, textLabel, retryable: ['save_failed', 'ready', 'submit_retry'].indexOf(s.phase) >= 0 || !!s.error });
      if (!this.properties.feedback || !top || this._visible === false || !s.notice) return;
      if (s.mode === 'both' && this.properties.location === 'loading') return;
      const notice = video.consumeNotice();
      if (!notice) return;
      const saved = notice === 'saved', saveFailed = notice === 'save_failed';
      this.setData({ showDialog: true, canRetry: saveFailed || notice === 'submit_retry',
        dialogTitle: saved ? '视频已保存' : saveFailed ? '视频已提取，尚未保存' : '视频提取未完成',
        dialogContent: saved ? '视频提取成功，已保存至本地相册。\n提取记录可在「我的 · 积分与订单」查看。'
          : saveFailed ? '相册权限未开启或保存未完成。\n请重试保存，不会重复扣除提取积分。' : s.error || '视频未提取成功，未扣除视频积分。',
        confirmText: saved ? '知道了' : saveFailed ? '重试保存' : notice === 'submit_retry' ? '继续提交' : '知道了' });
    },
    confirm() { const retry = this.data.canRetry; this.setData({ showDialog: false }); if (retry) video.retry(); },
    close() { this.setData({ showDialog: false }); },
    retry() { video.retry(); },
    noop() {},
  },
});
