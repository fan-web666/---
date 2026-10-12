/**
 * x-video-dialog · 视频教程弹层（2026-10-12 新增，**超出设计稿**）
 *
 * 用途：使用说明页（pages/forward）的「视频教程」入口 —— 点开看完整操作演示，并支持下载到相册。
 *
 * 用法：
 *   <x-video-dialog show="{{videoShow}}" file-id="{{guideVideoFileId}}" bind:close="closeGuideVideo" />
 *
 * ⚠️ 五条设计约束（都由真实平台限制倒推出来的，改之前先看清）：
 *   ① 视频只能放**云存储**：主包 ≤2MB、单个分包也 ≤2MB，8MB 级视频不可能打进包内。
 *   ② `<video src>` **不认 cloud:// fileID** → 必须先 `wx.cloud.getTempFileURL` 换 https 临时链接。
 *      ⚠️ 该接口失败时 `tempFileURL` 仍是 fileID 原值 → **必须判 https 前缀**，否则 video 拿到
 *         cloud:// 直接黑屏（不报错，最难查）。
 *   ③ 弹层用 `wx:if` 整体挂载/销毁 —— video 是原生组件，用 display:none 隐藏**视频仍会继续播**（还出声）。
 *   ④ 「下载到相册」= `wx.cloud.downloadFile` → `wx.saveVideoToPhotosAlbum`；用户拒绝过相册权限后
 *      系统**不再弹授权框**，只能引导 `wx.openSetting` 手动开，否则表现为「点了没反应」。
 *   ⑤ 布局用**全屏 + flex + object-fit:contain**，不做动态比例计算：
 *      本视频教程是**竖屏 576×1280**，若塞进窄卡片会被压得很小；全屏后横竖屏都能撑满可用高度。
 *      ⇒ 竖屏视频两侧自然留黑边，不裁切、不拉伸（绝不为了填满而裁掉演示画面）。
 */
Component({
  properties: {
    /** 是否显示（页面控制） */
    show: { type: Boolean, value: false },
    /** 云存储 fileID（cloud:// 开头）；也兼容 http(s) 直链（换托管时不用改组件） */
    fileId: { type: String, value: '' },
    /** 标题 */
    title: { type: String, value: '视频教程' },
  },

  data: {
    src: '',
    loading: false,
    failed: false,
    downloading: false,
  },

  observers: {
    /** 打开时才解析链接（页面里常挂着组件但不点开，不做无谓请求）；关闭时清空，避免残留旧链接 */
    show(v) {
      if (v) this.resolve();
      else this.setData({ src: '', loading: false, failed: false });
    },
  },

  methods: {
    /* 空方法：仅用于 catchtouchmove 阻断背景滚动穿透 */
    noop() {},

    /** fileID → 可播放的 https 临时链接 */
    resolve() {
      const fileId = String(this.data.fileId || '').trim();
      this.setData({ src: '', loading: false, failed: false });
      if (!fileId) { this.setData({ failed: true }); return; }

      // 非云存储 ID：直接当链接用（video 组件要求该域名已在后台配过合法域名）
      if (!/^cloud:\/\//.test(fileId)) { this.setData({ src: fileId }); return; }

      if (!wx.cloud || !wx.cloud.getTempFileURL) { this.setData({ failed: true }); return; }

      this.setData({ loading: true });
      wx.cloud.getTempFileURL({
        fileList: [fileId],
        success: (res) => {
          const item = (res && res.fileList && res.fileList[0]) || {};
          const url = String(item.tempFileURL || '');
          if (/^https?:\/\//.test(url)) this.setData({ src: url, loading: false });
          else this.setData({ failed: true, loading: false });
        },
        fail: () => this.setData({ failed: true, loading: false }),
      });
    },

    /** 有链接却放不出来（临时链接过期 / 文件被删）→ 给可读提示，别留黑屏 */
    onVideoError() {
      this.setData({ failed: true });
    },

    onClose() {
      this.triggerEvent('close');
    },

    /** 下载到相册（三段：取临时文件 → 存相册 → 被拒时引导开权限） */
    onDownload() {
      const fileId = String(this.data.fileId || '').trim();
      if (!fileId || this.data.downloading) return;
      this.setData({ downloading: true });
      wx.showLoading({ title: '正在准备…', mask: true });

      const done = () => { wx.hideLoading(); this.setData({ downloading: false }); };

      const save = (filePath) => {
        wx.saveVideoToPhotosAlbum({
          filePath,
          success: () => { done(); wx.showToast({ title: '已保存到相册', icon: 'success' }); },
          fail: (err) => {
            done();
            const msg = String((err && err.errMsg) || '');
            // 用户拒绝过相册权限 → 系统不再弹窗，只能引导去设置页手动开
            if (/auth|deny|authorize/i.test(msg)) this.guideAuth();
            else wx.showToast({ title: '保存失败，请重试', icon: 'none' });
          },
        });
      };

      if (!/^cloud:\/\//.test(fileId)) {
        wx.downloadFile({
          url: fileId,
          success: (r) => save(r.tempFilePath),
          fail: () => { done(); wx.showToast({ title: '下载失败，请检查网络', icon: 'none' }); },
        });
        return;
      }

      wx.cloud.downloadFile({
        fileID: fileId,
        success: (r) => save(r.tempFilePath),
        fail: () => { done(); wx.showToast({ title: '下载失败，请检查网络', icon: 'none' }); },
      });
    },

    /** 相册权限被拒：系统不再弹窗 → 请用户去设置页手动打开 */
    guideAuth() {
      wx.showModal({
        title: '需要相册权限',
        content: '保存视频需要「保存到相册」权限，去设置里打开就能下载了。',
        confirmText: '去设置',
        success: (r) => { if (r.confirm) wx.openSetting({}); },
      });
    },
  },
});
