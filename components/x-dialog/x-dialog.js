/**
 * x-dialog · 自建说明弹窗（2026-09-27 新增，**超出设计稿**）
 *
 * 用途：替代原生 wx.showModal —— 原生弹窗的正文对齐由系统决定、无对齐参数，
 *       本组件把正文**固定为左对齐**，保证三页（forward / recharge / member）观感一致。
 *
 * 用法（页面侧统一封装，见各页 openDialog / onDialogConfirm / onDialogCancel）：
 *   <x-dialog show="{{dlg.show}}" title="{{dlg.title}}" content="{{dlg.content}}"
 *             confirm-text="{{dlg.confirmText}}" cancel-text="{{dlg.cancelText}}"
 *             show-cancel="{{dlg.showCancel}}"
 *             bind:confirm="onDialogConfirm" bind:cancel="onDialogCancel" />
 */
Component({
  properties: {
    /** 是否显示（页面用 dlg.show 控制） */
    show: { type: Boolean, value: false },
    /** 标题（居中）；空字符串则不渲染标题行 */
    title: { type: String, value: '' },
    /** 正文（左对齐）—— 支持 \n 换行，靠 .x-dialog__text 的 white-space: pre-wrap 生效 */
    content: { type: String, value: '' },
    /** 主按钮文案 */
    confirmText: { type: String, value: '知道了' },
    /** 次按钮文案（showCancel 为 false 时不显示） */
    cancelText: { type: String, value: '' },
    /** 是否显示次按钮（即原生 showCancel） */
    showCancel: { type: Boolean, value: false },
  },

  methods: {
    /* 空方法：仅用于 catchtap / catchtouchmove 阻断冒泡与背景滚动 */
    noop() {},

    onConfirmTap() {
      this.triggerEvent('confirm');
    },

    onCancelTap() {
      this.triggerEvent('cancel');
    },
  },
});
