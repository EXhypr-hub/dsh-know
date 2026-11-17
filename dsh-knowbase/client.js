/**
 * dsh-knowbase — Client 半
 *
 * P0: 侧栏图标 + 页面框架
 * P1: 库管理、拖拽导入、文档列表、检索测试
 *
 * 样式只用主题变量 --dsw-alias-*，深浅色自动适配；
 * 动效遵守 prefers-reduced-motion。
 */

window.__ModuleLoader__.load({
  id: 'dsh-knowbase',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    /* ══════════════════════════ 样式 ══════════════════════════ */

    const STYLE_ID = 'dsh-knowbase/styles'

    const css = `
.kb-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 13px;
  line-height: 1.55;
}

/* ── 顶栏 ── */
.kb-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
  min-width: 0;
}
.kb-header-text { min-width: 0; flex: 1; }
.kb-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; }
.kb-subtitle {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kb-badge {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.kb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.kb-dot-on { background: var(--dsw-alias-state-success-primary); }
.kb-dot-off { background: var(--dsw-alias-state-error-primary); }

/* ── 主区 ── */
.kb-main { flex: 1; min-height: 0; display: flex; }
.kb-side {
  width: 208px;
  flex: none;
  border-right: 1px solid var(--dsw-alias-border-l1);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.kb-side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  letter-spacing: 0.04em;
  flex: none;
}
.kb-side-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 8px; }
.kb-coll {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms ease;
}
.kb-coll:hover { background: var(--dsw-alias-bg-layer-2); }
.kb-coll-on { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.kb-coll-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-coll-count {
  flex: none;
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}

.kb-content { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 16px 20px 24px; }

/* ── 按钮 ── */
.kb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 13px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease, opacity 150ms ease;
}
.kb-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.kb-btn:disabled { cursor: default; }
/* 禁用态统一为中性底色 + 可读文字。
   注意：这些规则必须排在 .kb-btn-primary 之后，
   否则同优先级下会被普通态的背景色覆盖，出现白底白字。 */
/* 主按钮：用品牌色做半透明底 + 品牌色描边文字。
   不依赖未知取值的填充色 token——DSH 深色主题下 button-primary-fill
   可能是接近白色的值，会让按钮看起来是"白块"。 */
.kb-btn-primary {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, var(--dsw-alias-bg-layer-1));
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}
.kb-btn-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, var(--dsw-alias-bg-layer-1));
}

/* 禁用态必须排在 .kb-btn-primary 之后（同优先级，后写者生效） */
.kb-btn:disabled {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  opacity: 1;
}
.kb-btn-primary:disabled {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.kb-btn-sm { padding: 3px 9px; font-size: 11px; }
.kb-btn-danger { color: var(--dsw-alias-state-error-primary); }

/* ── 拖放区 ── */
.kb-drop {
  border: 1.5px dashed var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 26px 20px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  transition: border-color 180ms ease, background-color 180ms ease, transform 180ms ease;
  cursor: pointer;
}
.kb-drop:hover { border-color: var(--dsw-alias-brand-primary); }
.kb-drop-on {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
  transform: scale(1.005);
}
.kb-drop-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.kb-drop-hint { font-size: 11.5px; }
.kb-drop-input { display: none; }

/* ── 上传进度 ── */
.kb-progress { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.kb-progress-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  padding: 5px 9px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
}
.kb-progress-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-progress-state { flex: none; color: var(--dsw-alias-label-secondary); }
.kb-progress-ok { color: var(--dsw-alias-state-success-primary); }
.kb-progress-err { color: var(--dsw-alias-state-error-primary); }

/* ── 区块 ── */
.kb-section { margin-top: 18px; }
.kb-section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
}
.kb-section-title { font-size: 12.5px; font-weight: 600; margin: 0; }
.kb-section-meta { color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-variant-numeric: tabular-nums; }

/* ── 文档表 ── */
.kb-docs { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.kb-doc {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  transition: background-color 150ms ease;
}
.kb-doc:last-child { border-bottom: 0; }
.kb-doc:hover { background: var(--dsw-alias-bg-layer-2); }
.kb-doc-name { flex: 1; min-width: 0; }
.kb-doc-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.kb-doc-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 1px; }
.kb-doc-actions { display: flex; gap: 5px; flex: none; opacity: 0; transition: opacity 150ms ease; }
.kb-doc:hover .kb-doc-actions, .kb-doc:focus-within .kb-doc-actions { opacity: 1; }

.kb-status {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.kb-status-ready { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
.kb-status-ocr { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); }
.kb-status-failed { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); }

/* ── 检索 ── */
.kb-search-bar { display: flex; gap: 8px; }
.kb-search-bar .kb-btn { flex: none; min-width: 60px; }
.kb-input {
  flex: 1;
  min-width: 0;
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  outline: none;
  transition: border-color 150ms ease;
}
.kb-input:focus { border-color: var(--dsw-alias-brand-primary); }
.kb-input::placeholder { color: var(--dsw-alias-label-secondary); }

.kb-hits { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.kb-hit {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.kb-hit-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 5px; font-size: 11.5px; flex-wrap: wrap; }
.kb-hit-doc { font-weight: 600; color: var(--dsw-alias-label-primary); }
.kb-hit-page { color: var(--dsw-alias-label-secondary); }
.kb-hit-sep { color: var(--dsw-alias-label-secondary); opacity: 0.5; }
.kb-hit-text {
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 5.2em;
  overflow: hidden;
  position: relative;
}
.kb-hit-text-open { max-height: none; }
.kb-hit-toggle { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-brand-primary); background: 0; border: 0; cursor: pointer; padding: 0; font: inherit; }
.kb-mark { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent); border-radius: 3px; padding: 0 1px; }

/* ── 空状态 / 提示 ── */
.kb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 40px 20px;
  text-align: center;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 12px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
}
.kb-empty-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }
.kb-empty-hint { font-size: 12px; max-width: 380px; }

.kb-notice {
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 11.5px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 10px;
}
.kb-notice-err { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l2)); }

/* ── 右侧栏面板 ── */
.kb-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  gap: 8px;
  padding: 10px 12px 8px;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}
.kb-pane-head { flex: none; }
.kb-select {
  width: 100%;
  padding: 6px 9px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  outline: none;
}
.kb-select:focus { border-color: var(--dsw-alias-brand-primary); }
.kb-pane-search { flex: none; display: flex; gap: 6px; }
.kb-pane-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-pane-body .kb-empty { padding: 24px 14px; }
.kb-pane-body .kb-hit { padding: 8px 10px; }
.kb-pane-body .kb-hit-text { font-size: 12px; max-height: 4.2em; }
.kb-pane-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}

/* ── 设置面板 ── */
.kb-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.kb-field-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.kb-field-hint { font-size: 10.5px; color: var(--dsw-alias-label-secondary); opacity: 0.85; }
.kb-field-row { display: flex; gap: 8px; align-items: center; }
.kb-field-row .kb-input { flex: 1; }

.kb-status-line {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  background: var(--dsw-alias-bg-layer-2);
  margin-bottom: 10px;
}
.kb-ok { color: var(--dsw-alias-state-success-primary); }
.kb-warn { color: var(--dsw-alias-state-warn-primary); }
.kb-err { color: var(--dsw-alias-state-error-primary); }

.kb-tabs { display: flex; gap: 2px; margin-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.kb-tab {
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 150ms ease, border-color 150ms ease;
}
.kb-tab:hover { color: var(--dsw-alias-label-primary); }
.kb-tab-on { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }

.kb-mode-chip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.kb-mode-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }

/* ── 本地模型列表 ── */
.kb-model-list { display: flex; flex-direction: column; gap: 6px; }
.kb-model {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  transition: border-color 150ms ease, background-color 150ms ease;
}
.kb-model:hover { background: var(--dsw-alias-bg-layer-2); }
.kb-model-on {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-1));
}
.kb-model-main { flex: 1; min-width: 0; }
.kb-model-name { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; }
.kb-model-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.kb-model-actions { flex: none; display: flex; gap: 5px; }

/* ── 代码片段 / 安装日志 ── */
.kb-code {
  display: block;
  margin-top: 6px;
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11.5px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: all;
}
.kb-code-log {
  max-height: 130px;
  overflow-y: auto;
  user-select: text;
  opacity: 0.85;
  font-size: 11px;
  line-height: 1.5;
}
.kb-install-status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  margin-bottom: 6px;
}
.kb-details { margin-top: 8px; font-size: 11.5px; }
.kb-details summary {
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  user-select: none;
}
.kb-details summary:hover { color: var(--dsw-alias-label-primary); }

/* ── 抓取设置 ── */
.kb-textarea {
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
}
.kb-textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.kb-textarea::placeholder { color: var(--dsw-alias-label-secondary); opacity: 0.8; }

/* ── 来源清单 ── */
.kb-sources {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.kb-source-group { display: flex; flex-direction: column; gap: 6px; }
.kb-source-topic {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  letter-spacing: 0.03em;
}
.kb-source {
  padding: 8px 11px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.kb-source-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.kb-source-name { font-size: 12px; font-weight: 600; }
.kb-source-host {
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
}
.kb-source-use { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }
.kb-source-license {
  font-size: 11px;
  color: var(--dsw-alias-state-warn-primary);
  margin-top: 2px;
  opacity: 0.9;
}

/* ── 动效 ── */
@keyframes kb-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.kb-fade-in { animation: kb-fade-in 220ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }
@keyframes kb-spin { to { transform: rotate(360deg); } }
.kb-spin { animation: kb-spin 900ms linear infinite; display: inline-block; }

@media (prefers-reduced-motion: reduce) {
  .kb-fade-in { animation: none; }
  .kb-spin { animation: none; }
  .kb-drop { transition: none; }
  .kb-drop-on { transform: none; }
}

/* ── 图标：一律按传入尺寸固定，绝不撑满父容器 ── */
.kb-icon { display: block; color: inherit; flex: none; }
`

    /*
     * 样式注入。
     * 用 CSS 内容的指纹做 key：内容变了就重建 style 标签，
     * 否则热更新后页面会继续沿用旧样式（改了等于没改）。
     */
    const CSS_VERSION = (() => {
      let hash = 0
      for (let i = 0; i < css.length; i++) {
        hash = ((hash << 5) - hash + css.charCodeAt(i)) | 0
      }
      return `${STYLE_ID}/${(hash >>> 0).toString(36)}`
    })()

    function useStyles() {
      useEffect(() => {
        if (document.querySelector(`style[data-plugin-css="${CSS_VERSION}"]`) !== null) return
        // 清掉本插件的旧样式，避免多份规则叠加
        for (const stale of document.querySelectorAll('style[data-plugin="dsh-knowbase"]')) {
          stale.remove()
        }
        const el = document.createElement('style')
        el.dataset.plugin = 'dsh-knowbase'
        el.dataset.pluginCss = CSS_VERSION
        el.textContent = css
        document.head.appendChild(el)
      }, [])
    }

    /* ══════════════════════════ 界面文案字典 ══════════════════════════ */

    /*
     * 内联字典：client.js 是浏览器模块，没有打包器，
     * 无法 import lib/dict.js 或 locale/*.json。
     * locale/*.json 只保留 meta 供插件管理器显示。
     */
    const DICT = {
  zh: {
    /* 顶栏 */
    'header.title': '本地知识库',
    'header.subtitle': '文档导入 · 语义检索 · 权威来源采集',
    'header.ready': '已就绪',
    'header.notReady': '未就绪',
    'header.connecting': '连接中…',
    'header.docCount': '{n} 份文档',

    /* 通用按钮 */
    'common.save': '保存',
    'common.saving': '保存中…',
    'common.cancel': '取消',
    'common.delete': '删除',
    'common.remove': '移除',
    'common.test': '测试连接',
    'common.testing': '测试中…',
    'common.retry': '重试',
    'common.expand': '展开',
    'common.collapse': '收起',
    'common.expandAll': '展开全文',
    'common.loading': '加载中…',
    'common.enabled': '已开启',
    'common.disabled': '已关闭',

    /* 左栏 */
    'side.collections': '知识库',
    'side.new': '新建知识库',
    'side.empty': '还没有知识库',
    'side.namePlaceholder': '知识库名称',
    'side.create': '创建',
    'side.deleteConfirm': '删除知识库「{name}」及其中的全部文档？此操作不可恢复。',
    'side.rightClickHint': '{n} 份文档 · 右键删除',

    /* 拖放区 */
    'drop.title': '把文件拖到这里，或点击选择',
    'drop.dragging': '松开即可导入',
    'drop.busy': '正在导入…',
    'drop.hint': '支持 PDF、Word、PPT、Excel、Markdown、TXT、HTML · 单文件 ≤ 50MB',

    /* 文档表 */
    'docs.title': '文档',
    'docs.meta': '{docs} 份 · {chunks} 块',
    'docs.empty': '这个知识库里还没有文档，拖一份进来试试。',
    'docs.statusReady': '已入库',
    'docs.statusOcr': '需 OCR',
    'docs.statusFailed': '失败',
    'docs.statusPending': '处理中',
    'docs.rebuild': '重建',
    'docs.deleteConfirm': '删除「{title}」？',

    /* 检索 */
    'search.title': '检索测试',
    'search.meta': '验证入库效果',
    'search.placeholder': '输入关键词，试试能不能查到…',
    'search.button': '检索',
    'search.searching': '检索中',
    'search.noHits': '没有找到包含「{query}」的内容',
    'search.modeHybrid': '语义 + 关键词',
    'search.modeKeyword': '仅关键词',
    'search.modeRerank': '语义 + 关键词 + 重排',
    'search.tip': '没有命中。可以换关键词再试',

    /* 空状态 */
    'empty.noCollection': '左侧还没有知识库',
    'empty.noCollectionHint': '点左上角「+」新建一个，然后拖入文件。',
    'empty.noHits': '没有命中',

    /* 设置：嵌入 */
    'embed.title': '检索设置',
    'embed.meta': '接入嵌入模型，启用语义检索',
    'embed.way': '嵌入方式',
    'embed.none': '不使用（仅关键词检索）',
    'embed.api': 'API / 本地服务（OpenAI 兼容）',
    'embed.local': '本地模型（需先下载）',
    'embed.provider': '服务商',
    'embed.custom': '自定义…',
    'embed.baseUrl': '服务地址',
    'embed.baseUrlHint': '填到 /v1 为止，插件会拼上 /embeddings',
    'embed.model': '模型',
    'embed.apiKey': 'API Key',
    'embed.apiKeySaved': '已保存',
    'embed.apiKeyPlaceholder': '粘贴 API Key（本地服务可留空）',
    'embed.batchSize': '批大小',
    'embed.build': '建立向量索引',
    'embed.building': '建立中…',
    'embed.indexReady': '向量索引就绪',
    'embed.indexPartial': '索引不完整',
    'embed.notConfigured': '未配置嵌入',
    'embed.complete': '索引完成 · 共 {n} 条向量',
    'embed.testOk': '连接成功 · {dim} 维 · 耗时 {ms}ms',

    /* 设置：重排 */
    'rerank.title': '重排设置',
    'rerank.meta': '从候选里精排，提高相关性（可选）',
    'rerank.way': '重排方式',
    'rerank.none': '不使用（直接返回融合结果）',
    'rerank.api': 'API（OpenAI 兼容 /rerank）',
    'rerank.topN': '保留条数',

    /* 设置：抓取 */
    'fetch.title': '抓取设置',
    'fetch.meta': '联网取权威资料，含来源清单与防护',
    'fetch.on': '已允许联网抓取',
    'fetch.off': '已关闭（完全不联网）',
    'fetch.whitelist': '站点白名单（可留空）',
    'fetch.showSources': '查看权威来源（{n}）',
    'fetch.hideSources': '收起来源清单',

    /* 本地模型 */
    'models.mirror': '下载镜像',
    'models.title': '本地模型',
    'models.download': '下载',
    'models.use': '选用',
    'models.selected': '已选中',
    'models.downloaded': '已下载',
    'models.progress': '下载中 {done}/{total} · {detail}',
  },

  en: {
    'header.title': 'Local knowledge base',
    'header.subtitle': 'Document import · semantic search · authoritative sources',
    'header.ready': 'Ready',
    'header.notReady': 'Not ready',
    'header.connecting': 'Connecting…',
    'header.docCount': '{n} documents',

    'common.save': 'Save',
    'common.saving': 'Saving…',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.remove': 'Remove',
    'common.test': 'Test connection',
    'common.testing': 'Testing…',
    'common.retry': 'Retry',
    'common.expand': 'Expand',
    'common.collapse': 'Collapse',
    'common.expandAll': 'Show full text',
    'common.loading': 'Loading…',
    'common.enabled': 'On',
    'common.disabled': 'Off',

    'side.collections': 'Collections',
    'side.new': 'New collection',
    'side.empty': 'No collections yet',
    'side.namePlaceholder': 'Collection name',
    'side.create': 'Create',
    'side.deleteConfirm': 'Delete collection "{name}" and all its documents? This cannot be undone.',
    'side.rightClickHint': '{n} documents · right-click to delete',

    'drop.title': 'Drop files here, or click to choose',
    'drop.dragging': 'Release to import',
    'drop.busy': 'Importing…',
    'drop.hint': 'PDF, Word, PowerPoint, Excel, Markdown, TXT, HTML · up to 50MB per file',

    'docs.title': 'Documents',
    'docs.meta': '{docs} files · {chunks} chunks',
    'docs.empty': 'No documents in this collection yet. Drop one in to try.',
    'docs.statusReady': 'Indexed',
    'docs.statusOcr': 'Needs OCR',
    'docs.statusFailed': 'Failed',
    'docs.statusPending': 'Processing',
    'docs.rebuild': 'Reindex',
    'docs.deleteConfirm': 'Delete "{title}"?',

    'search.title': 'Search test',
    'search.meta': 'Check what was indexed',
    'search.placeholder': 'Type keywords to see if they can be found…',
    'search.button': 'Search',
    'search.searching': 'Searching',
    'search.noHits': 'Nothing found for "{query}"',
    'search.modeHybrid': 'Semantic + keyword',
    'search.modeKeyword': 'Keyword only',
    'search.modeRerank': 'Semantic + keyword + rerank',
    'search.tip': 'No match. Try different keywords',

    'empty.noCollection': 'No collection on the left',
    'empty.noCollectionHint': 'Click "+" at the top left to create one, then drop files in.',
    'empty.noHits': 'No match',

    'embed.title': 'Retrieval settings',
    'embed.meta': 'Connect an embedding model to enable semantic search',
    'embed.way': 'Embedding method',
    'embed.none': 'None (keyword search only)',
    'embed.api': 'API / local server (OpenAI compatible)',
    'embed.local': 'Local model (download first)',
    'embed.provider': 'Provider',
    'embed.custom': 'Custom…',
    'embed.baseUrl': 'Base URL',
    'embed.baseUrlHint': 'Fill up to /v1; the plugin appends /embeddings',
    'embed.model': 'Model',
    'embed.apiKey': 'API Key',
    'embed.apiKeySaved': 'Saved',
    'embed.apiKeyPlaceholder': 'Paste an API key (optional for local servers)',
    'embed.batchSize': 'Batch size',
    'embed.build': 'Build vector index',
    'embed.building': 'Building…',
    'embed.indexReady': 'Vector index ready',
    'embed.indexPartial': 'Index incomplete',
    'embed.notConfigured': 'No embedding configured',
    'embed.complete': 'Index built · {n} vectors',
    'embed.testOk': 'Connected · {dim} dimensions · {ms}ms',

    'rerank.title': 'Rerank settings',
    'rerank.meta': 'Re-score candidates for better relevance (optional)',
    'rerank.way': 'Rerank method',
    'rerank.none': 'None (return fused results)',
    'rerank.api': 'API (OpenAI compatible /rerank)',
    'rerank.topN': 'Keep top N',

    'fetch.title': 'Fetch settings',
    'fetch.meta': 'Collect authoritative material, with source list and safeguards',
    'fetch.on': 'Network fetching enabled',
    'fetch.off': 'Disabled (fully offline)',
    'fetch.whitelist': 'Domain allowlist (optional)',
    'fetch.showSources': 'Show authoritative sources ({n})',
    'fetch.hideSources': 'Hide source list',

    'models.mirror': 'Download mirror',
    'models.title': 'Local models',
    'models.download': 'Download',
    'models.use': 'Use',
    'models.selected': 'Selected',
    'models.downloaded': 'Downloaded',
    'models.progress': 'Downloading {done}/{total} · {detail}',
  },
}

    const LOCALE_NS = 'dsh-knowbase'

    /** 简单插值：{name} 由 params 替换 */
    function fmt(template, params) {
      if (!params) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      ))
    }

    /*
     * 翻译函数与订阅。
     * 语言切换时通过 locale/change 通知，已挂载的组件重渲染。
     *
     * 初始实现就用内置中文兜底，而不是返回 key——
     * 否则注册失败时界面会直接露出 header.title 这种原始 key。
     */
    let translate = (key, params) => fmt(DICT.zh[key] ?? key, params)
    const localeListeners = new Set()

    function setTranslator(fn) {
      translate = fn
      for (const listener of localeListeners) {
        try {
          listener()
        } catch {
          // 单个监听器失败不影响其他
        }
      }
    }

    /** 组件内取翻译函数，并订阅语言变化 */
    function useT() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((n) => n + 1)
        localeListeners.add(listener)
        return () => localeListeners.delete(listener)
      }, [])
      return translate
    }

    /* ══════════════════════════ 图标 ══════════════════════════ */

    /**
     * 书页图标。始终按传入的 size 渲染成固定尺寸，不撑满父容器。
     * @param size    图标边长（px）
     * @param active  选中态加粗描边
     */
    function KnowledgeIcon({ size = 20, active = false }) {
      return h('svg', {
        className: 'kb-icon',
        width: size,
        height: size,
        viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, stroke: 'currentColor',
        strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H9a2 2 0 0 1 2 2v13a1.6 1.6 0 0 0-1.6-1.6H5.5A1.5 1.5 0 0 1 4 15.9z' }),
        h('path', { d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H15a2 2 0 0 0-2 2v13a1.6 1.6 0 0 1 1.6-1.6h3.9A1.5 1.5 0 0 0 20 15.9z' }),
      )
    }

    /* ══════════════════════════ 接口封装 ══════════════════════════ */

    async function api(path, body) {
      const res = await fetch(`api/dsh-knowbase/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => null)
      if (!data || data.ok !== true) {
        throw new Error(data?.error?.message ?? `请求失败（${res.status}）`)
      }
      return data.value
    }

    /* ══════════════════════════ 工具 ══════════════════════════ */

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
      return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
    }

    function highlight(text, keyword) {
      const q = String(keyword ?? '').trim()
      if (!q || !text) return text
      const index = text.toLowerCase().indexOf(q.toLowerCase())
      if (index < 0) return text
      return [
        text.slice(0, index),
        h('mark', { className: 'kb-mark', key: 'm' }, text.slice(index, index + q.length)),
        text.slice(index + q.length),
      ]
    }

    /** 把 File 读成 base64（去掉 data URL 前缀） */
    function readAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    /* ══════════════════════════ 主页面 ══════════════════════════ */

    function Panel() {
      useStyles()
      const t = useT()

      const [status, setStatus] = useState(null)
      const [collections, setCollections] = useState([])
      const [activeId, setActiveId] = useState(null)
      const [documents, setDocuments] = useState([])
      const [error, setError] = useState(null)

      const [dragging, setDragging] = useState(false)
      const [uploads, setUploads] = useState([])
      const [busy, setBusy] = useState(false)

      const [query, setQuery] = useState('')
      const [hits, setHits] = useState(null)
      const [searching, setSearching] = useState(false)
      const [expanded, setExpanded] = useState(new Set())

      const [creating, setCreating] = useState(false)
      const [newName, setNewName] = useState('')
      const [tab, setTab] = useState('docs')
      const [searchMode, setSearchMode] = useState(null)

      const fileInputRef = useRef(null)
      const searchSeq = useRef(0)

      /* ── 刷新 ── */
      const refreshStatus = useCallback(async () => {
        try {
          const value = await api('status')
          setStatus(value)
        } catch (err) {
          setError(err.message)
        }
      }, [])

      const refreshCollections = useCallback(async () => {
        try {
          const value = await api('collections', { action: 'list' })
          setCollections(value)
          setActiveId((current) => {
            if (current !== null && value.some((c) => c.id === current)) return current
            return value[0]?.id ?? null
          })
        } catch (err) {
          setError(err.message)
        }
      }, [])

      const refreshDocuments = useCallback(async (collectionId) => {
        if (collectionId === null) { setDocuments([]); return }
        try {
          const value = await api('documents', { action: 'list', collectionId })
          setDocuments(value)
        } catch (err) {
          setError(err.message)
        }
      }, [])

      useEffect(() => { refreshStatus() }, [refreshStatus])
      useEffect(() => { refreshCollections() }, [refreshCollections])
      useEffect(() => { refreshDocuments(activeId) }, [activeId, refreshDocuments])

      /**
       * 切换知识库：同时清空上一个库的检索状态。
       * 只改 activeId 会留下旧的命中结果，让人以为新库里也有这些内容。
       */
      const switchCollection = useCallback((id) => {
        if (id === activeId) return
        // 让在途检索的返回作废，避免旧库结果写回新库
        searchSeq.current++
        setActiveId(id)
        setHits(null)
        setQuery('')
        setSearchMode(null)
        setExpanded(new Set())
        setError(null)
        setSearching(false)
      }, [activeId])

      /* ── 建库 ── */
      const submitCreate = useCallback(async () => {
        const name = newName.trim()
        if (!name) return
        setBusy(true)
        try {
          await api('collections', { action: 'create', name })
          setNewName('')
          setCreating(false)
          await refreshCollections()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [newName, refreshCollections])

      /* ── 删库 ── */
      const removeCollection = useCallback(async (id, name) => {
        if (!window.confirm(`删除知识库「${name}」及其中的全部文档？此操作不可恢复。`)) return
        try {
          await api('collections', { action: 'delete', id })
          await refreshCollections()
        } catch (err) {
          setError(err.message)
        }
      }, [refreshCollections])

      /* ── 上传 ── */
      const uploadFiles = useCallback(async (fileList) => {
        const files = [...fileList].filter(Boolean)
        if (files.length === 0 || activeId === null) return

        setError(null)
        setBusy(true)
        const entries = files.map((file) => ({
          key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          state: 'reading',
          message: '',
        }))
        setUploads((prev) => [...entries, ...prev].slice(0, 12))

        try {
          const payload = []
          for (let i = 0; i < files.length; i++) {
            const base64 = await readAsBase64(files[i])
            payload.push({ name: files[i].name, data: base64 })
            setUploads((prev) => prev.map((u) => (u.key === entries[i].key ? { ...u, state: 'queued' } : u)))
          }

          setUploads((prev) => prev.map((u) => (entries.some((e) => e.key === u.key) ? { ...u, state: 'importing' } : u)))

          const results = await api('upload', { files: payload, collectionId: activeId })

          setUploads((prev) => prev.map((u) => {
            const index = entries.findIndex((e) => e.key === u.key)
            if (index < 0) return u
            const result = results[index]
            if (!result) return { ...u, state: 'error', message: '无返回结果' }
            if (!result.ok) return { ...u, state: 'error', message: result.error }
            if (result.duplicate) return { ...u, state: 'done', message: '已存在，跳过' }
            if (result.scanned) return { ...u, state: 'done', message: '扫描件，需 OCR' }
            return { ...u, state: 'done', message: `${result.chunkCount} 块` }
          }))

          await Promise.all([refreshDocuments(activeId), refreshCollections(), refreshStatus()])
        } catch (err) {
          setError(err.message)
          setUploads((prev) => prev.map((u) => (entries.some((e) => e.key === u.key) ? { ...u, state: 'error', message: err.message } : u)))
        } finally {
          setBusy(false)
        }
      }, [activeId, refreshDocuments, refreshCollections, refreshStatus])

      /* ── 拖放 ── */
      const onDrop = useCallback((event) => {
        event.preventDefault()
        setDragging(false)
        if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files)
      }, [uploadFiles])

      const onDragOver = useCallback((event) => {
        event.preventDefault()
        setDragging(true)
      }, [])

      const onDragLeave = useCallback((event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        setDragging(false)
      }, [])

      /* ── 文档操作 ── */
      const removeDocument = useCallback(async (id, title) => {
        if (!window.confirm(`删除「${title}」？`)) return
        try {
          await api('documents', { action: 'delete', id })
          // 命中结果可能引用被删文档，一并清掉避免悬空
          setHits(null)
          setSearchMode(null)
          await Promise.all([refreshDocuments(activeId), refreshCollections(), refreshStatus()])
        } catch (err) {
          setError(err.message)
        }
      }, [activeId, refreshDocuments, refreshCollections, refreshStatus])

      const reindexDocument = useCallback(async (id) => {
        setBusy(true)
        try {
          await api('documents', { action: 'reindex', id })
          await refreshDocuments(activeId)
        } catch (err) {
          setError(err.message)
          await refreshDocuments(activeId)
        } finally {
          setBusy(false)
        }
      }, [activeId, refreshDocuments])

      /* ── 检索 ── */
      const runSearch = useCallback(async () => {
        const q = query.trim()
        if (!q) { setHits(null); return }

        // 请求序号：切库或再次检索后，旧请求的返回不再写入状态
        const seq = ++searchSeq.current
        const targetId = activeId

        setSearching(true)
        setError(null)
        try {
          const value = await api('search', { query: q, collectionId: targetId, limit: 20 })
          if (seq !== searchSeq.current) return
          // 兼容两种返回：旧版数组 / 新版 { hits, mode, note }
          const list = Array.isArray(value) ? value : (value?.hits ?? [])
          setHits(list)
          setSearchMode(Array.isArray(value) ? null : { mode: value?.mode, note: value?.note })
          setExpanded(new Set())
        } catch (err) {
          if (seq === searchSeq.current) setError(err.message)
        } finally {
          if (seq === searchSeq.current) setSearching(false)
        }
      }, [query, activeId])

      const toggleExpand = useCallback((id) => {
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      /* ── 派生 ── */
      const activeCollection = useMemo(
        () => collections.find((c) => c.id === activeId) ?? null,
        [collections, activeId],
      )

      const totalChunks = activeCollection?.chunk_count ?? 0

      const statusText = !status ? t('header.connecting') : status.ready ? t('header.ready') : t('header.notReady')
      const dotClass = !status ? 'kb-dot' : status.ready ? 'kb-dot kb-dot-on' : 'kb-dot kb-dot-off'

      const canIngest = activeId !== null && status?.ready === true

      /* ══════════════════════════ 渲染 ══════════════════════════ */

      return h('div', { className: 'kb-root' },

        /* 顶栏 */
        h('header', { className: 'kb-header' },
          h(KnowledgeIcon, { size: 22, active: true }),
          h('div', { className: 'kb-header-text' },
            h('h1', { className: 'kb-title' }, t('header.title')),
            h('div', { className: 'kb-subtitle' }, t('header.subtitle')),
          ),
          h('span', { className: 'kb-badge' },
            h('span', { className: dotClass }),
            statusText,
            status?.version ? ` · v${status.version}` : '',
            status?.counts ? ` · ${status.counts.documents} 份文档` : '',
          ),
        ),

        /* 主区 */
        h('div', { className: 'kb-main' },

          /* 左：库列表 */
          h('aside', { className: 'kb-side' },
            h('div', { className: 'kb-side-head' },
              h('span', null, t('side.collections')),
              h('button', {
                className: 'kb-btn kb-btn-sm',
                style: { marginLeft: 'auto' },
                onClick: () => setCreating((v) => !v),
                title: '新建知识库',
              }, '+'),
            ),

            creating
              ? h('div', { style: { padding: '0 10px 8px' } },
                  h('input', {
                    className: 'kb-input',
                    placeholder: t('side.namePlaceholder'),
                    value: newName,
                    autoFocus: true,
                    onChange: (e) => setNewName(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') submitCreate()
                      if (e.key === 'Escape') { setCreating(false); setNewName('') }
                    },
                  }),
                  h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                    h('button', { className: 'kb-btn kb-btn-sm kb-btn-primary', disabled: busy || !newName.trim(), onClick: submitCreate }, t('side.create')),
                    h('button', { className: 'kb-btn kb-btn-sm', onClick: () => { setCreating(false); setNewName('') } }, t('common.cancel')),
                  ),
                )
              : null,

            h('div', { className: 'kb-side-list' },
              collections.length === 0
                ? h('div', { className: 'kb-subtitle', style: { padding: '8px 10px' } }, t('side.empty'))
                : collections.map((collection) => h('button', {
                    key: collection.id,
                    className: `kb-coll${collection.id === activeId ? ' kb-coll-on' : ''}`,
                    onClick: () => switchCollection(collection.id),
                    onContextMenu: (e) => { e.preventDefault(); removeCollection(collection.id, collection.name) },
                    title: `${collection.document_count} 份文档 · 右键删除`,
                  },
                    h('span', { className: 'kb-coll-name' }, collection.name),
                    h('span', { className: 'kb-coll-count' }, collection.document_count),
                  )),
            ),
          ),

          /* 右：内容 */
          h('main', { className: 'kb-content' },

            error ? h('div', { className: 'kb-notice kb-notice-err kb-fade-in' }, error) : null,

            !status?.ready && status?.readyError
              ? h('div', { className: 'kb-notice kb-notice-err' }, `数据目录不可用：${status.readyError}`)
              : null,

            activeId === null
              ? h('div', { className: 'kb-empty kb-fade-in' },
                  h(KnowledgeIcon, { size: 32 }),
                  h('div', { className: 'kb-empty-title' }, t('empty.noCollection')),
                  h('div', { className: 'kb-empty-hint' }, t('empty.noCollectionHint')),
                )
              : h(React.Fragment, null,

                  /* 拖放区 */
                  h('div', {
                    className: `kb-drop${dragging ? ' kb-drop-on' : ''}`,
                    onDrop,
                    onDragOver,
                    onDragLeave,
                    onClick: () => fileInputRef.current?.click(),
                    role: 'button',
                    tabIndex: 0,
                    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() },
                  },
                    h('div', { className: 'kb-drop-title' },
                      dragging ? t('drop.dragging') : busy ? t('drop.busy') : t('drop.title')),
                    h('div', { className: 'kb-drop-hint' },
                      t('drop.hint')),
                    h('input', {
                      ref: fileInputRef,
                      type: 'file',
                      multiple: true,
                      className: 'kb-drop-input',
                      accept: '.pdf,.docx,.pptx,.xlsx,.md,.markdown,.txt,.csv,.html,.htm',
                      onChange: (e) => { uploadFiles(e.target.files); e.target.value = '' },
                    }),
                  ),

                  /* 上传进度 */
                  uploads.length > 0
                    ? h('div', { className: 'kb-progress' },
                        uploads.map((item) => h('div', { key: item.key, className: 'kb-progress-item kb-fade-in' },
                          h('span', { className: 'kb-progress-name' }, item.name),
                          h('span', {
                            className: `kb-progress-state${
                              item.state === 'done' ? ' kb-progress-ok' : item.state === 'error' ? ' kb-progress-err' : ''
                            }`,
                          },
                            item.state === 'reading' ? '读取中…'
                              : item.state === 'queued' ? '排队…'
                              : item.state === 'importing' ? h('span', null, h('span', { className: 'kb-spin' }, '◐'), ' 解析中')
                              : item.state === 'done' ? `✓ ${item.message}`
                              : `✕ ${item.message}`,
                          ),
                        )),
                      )
                    : null,

                  /* 文档列表 */
                  h('section', { className: 'kb-section' },
                    h('div', { className: 'kb-section-head' },
                      h('h2', { className: 'kb-section-title' }, '文档'),
                      h('span', { className: 'kb-section-meta' },
                        `${documents.length} 份 · ${totalChunks} 块`),
                    ),

                    documents.length === 0
                      ? h('div', { className: 'kb-empty' },
                          h('div', { className: 'kb-empty-hint' }, t('docs.empty')),
                        )
                      : h('div', { className: 'kb-docs kb-fade-in' },
                          documents.map((doc) => h('div', { key: doc.id, className: 'kb-doc' },
                            h('div', { className: 'kb-doc-name' },
                              h('div', { className: 'kb-doc-title' }, doc.title),
                              h('div', { className: 'kb-doc-sub' },
                                `${String(doc.ext ?? '').replace(/^\./, '').toUpperCase()} · ${formatBytes(doc.size)} · ${doc.chunk_count} 块`
                                + (doc.page_count ? ` · ${doc.page_count} 页` : ''),
                              ),
                            ),
                            h('span', {
                              className: `kb-status${
                                doc.status === 'ready' ? ' kb-status-ready'
                                  : doc.status === 'needs-ocr' ? ' kb-status-ocr'
                                  : doc.status === 'failed' ? ' kb-status-failed' : ''
                              }`,
                              title: doc.error ?? '',
                            },
                              doc.status === 'ready' ? t('docs.statusReady')
                                : doc.status === 'needs-ocr' ? t('docs.statusOcr')
                                : doc.status === 'failed' ? t('docs.statusFailed')
                                : t('docs.statusPending'),
                            ),
                            h('div', { className: 'kb-doc-actions' },
                              h('button', {
                                className: 'kb-btn kb-btn-sm',
                                disabled: busy,
                                onClick: () => reindexDocument(doc.id),
                                title: '重新解析并切块',
                              }, t('docs.rebuild')),
                              h('button', {
                                className: 'kb-btn kb-btn-sm kb-btn-danger',
                                onClick: () => removeDocument(doc.id, doc.title),
                              }, t('common.delete')),
                            ),
                          )),
                        ),
                  ),

                  /* 检索测试 */
                  h('section', { className: 'kb-section' },
                    h('div', { className: 'kb-section-head' },
                      h('h2', { className: 'kb-section-title' }, t('search.title')),
                      h('span', { className: 'kb-section-meta' }, t('search.meta')),
                      searchMode?.mode
                        ? h('span', {
                            className: `kb-mode-chip${searchMode.mode === 'hybrid' ? ' kb-mode-ok' : ''}`,
                            style: { marginLeft: 'auto' },
                          }, searchMode.mode === 'hybrid' ? t('search.modeHybrid') : t('search.modeKeyword'))
                        : null,
                    ),
                    searchMode?.note
                      ? h('div', { className: 'kb-notice', style: { marginBottom: 8 } }, searchMode.note)
                      : null,
                    h('div', { className: 'kb-search-bar' },
                      h('input', {
                        className: 'kb-input',
                        placeholder: t('search.placeholder'),
                        value: query,
                        onChange: (e) => setQuery(e.target.value),
                        onKeyDown: (e) => { if (e.key === 'Enter') runSearch() },
                      }),
                      h('button', {
                        className: 'kb-btn kb-btn-primary',
                        disabled: searching || !query.trim(),
                        onClick: runSearch,
                      }, searching ? t('search.searching') : t('search.button')),
                    ),

                    hits !== null
                      ? hits.length === 0
                        ? h('div', { className: 'kb-notice', style: { marginTop: 10 } },
                            `没有找到包含「${query.trim()}」的内容`)
                        : h('div', { className: 'kb-hits' },
                            hits.map((hit) => h('div', { key: hit.id, className: 'kb-hit kb-fade-in' },
                              h('div', { className: 'kb-hit-head' },
                                h('span', { className: 'kb-hit-doc' }, hit.title),
                                hit.page ? h('span', { className: 'kb-hit-sep' }, '·') : null,
                                hit.page ? h('span', { className: 'kb-hit-page' }, `第 ${hit.page} 页`) : null,
                                hit.heading ? h('span', { className: 'kb-hit-sep' }, '·') : null,
                                hit.heading ? h('span', { className: 'kb-hit-page' }, hit.heading) : null,
                              ),
                              h('div', {
                                className: `kb-hit-text${expanded.has(hit.id) ? ' kb-hit-text-open' : ''}`,
                              },
                                highlight(hit.text, query),
                              ),
                              hit.text.length > 140
                                ? h('button', {
                                    className: 'kb-hit-toggle',
                                    onClick: () => toggleExpand(hit.id),
                                  }, expanded.has(hit.id) ? t('common.collapse') : t('common.expandAll'))
                                : null,
                            )),
                          )
                      : null,
                  ),

                  /* 设置 */
                  h('section', { className: 'kb-section' },
                    h('div', { className: 'kb-section-head' },
                      h('h2', { className: 'kb-section-title' }, t('embed.title')),
                      h('span', { className: 'kb-section-meta' }, t('embed.meta')),
                    ),
                    h(SettingsPanel, {
                      collectionId: activeId,
                      onChanged: () => { refreshStatus(); refreshDocuments(activeId) },
                    }),
                  ),

                  /* 重排设置 */
                  h('section', { className: 'kb-section' },
                    h('div', { className: 'kb-section-head' },
                      h('h2', { className: 'kb-section-title' }, t('rerank.title')),
                      h('span', { className: 'kb-section-meta' }, t('rerank.meta')),
                    ),
                    h(RerankPanel, {
                      collectionId: activeId,
                      onChanged: () => refreshStatus(),
                    }),
                  ),

                  /* 抓取设置 */
                  h('section', { className: 'kb-section' },
                    h('div', { className: 'kb-section-head' },
                      h('h2', { className: 'kb-section-title' }, t('fetch.title')),
                      h('span', { className: 'kb-section-meta' }, t('fetch.meta')),
                    ),
                    h(FetchPanel, null),
                  ),
                ),
          ),
        ),
      )
    }

    /* ══════════════════════════ 右侧栏面板 ══════════════════════════ */

    /**
     * 聊天时并排可用的知识库面板：选库 → 搜 → 看结果。
     * 比左侧主面板窄，所以布局更紧凑。
     */
    function SidePane() {
      useStyles()
      const t = useT()

      const [status, setStatus] = useState(null)
      const [collections, setCollections] = useState([])
      const [activeId, setActiveId] = useState(null)
      const [query, setQuery] = useState('')
      const [hits, setHits] = useState(null)
      const [searching, setSearching] = useState(false)
      const [error, setError] = useState(null)
      const [expanded, setExpanded] = useState(new Set())

      const refresh = useCallback(async () => {
        try {
          const [stat, cols] = await Promise.all([api('status'), api('collections', { action: 'list' })])
          setStatus(stat)
          setCollections(cols)
          setActiveId((cur) => (cur !== null && cols.some((c) => c.id === cur) ? cur : cols[0]?.id ?? null))
        } catch (err) {
          setError(err.message)
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const runSearch = useCallback(async () => {
        const q = query.trim()
        if (!q) { setHits(null); return }
        setSearching(true)
        setError(null)
        try {
          const value = await api('search', { query: q, collectionId: activeId, limit: 20 })
          setHits(Array.isArray(value) ? value : (value?.hits ?? []))
          setExpanded(new Set())
        } catch (err) {
          setError(err.message)
        } finally {
          setSearching(false)
        }
      }, [query, activeId])

      const toggleExpand = useCallback((id) => {
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      const activeCollection = collections.find((c) => c.id === activeId) ?? null

      return h('div', { className: 'kb-pane' },

        /* 库选择 */
        h('div', { className: 'kb-pane-head' },
          h('select', {
            className: 'kb-select',
            value: activeId ?? '',
            onChange: (e) => {
              // 换库时把上一个库的查询与结果一起清掉
              setActiveId(Number(e.target.value))
              setHits(null)
              setQuery('')
              setExpanded(new Set())
              setError(null)
            },
            'aria-label': '选择知识库',
          },
            collections.length === 0
              ? h('option', { value: '' }, '没有知识库')
              : collections.map((c) => h('option', { key: c.id, value: c.id }, `${c.name}（${c.document_count}）`)),
          ),
        ),

        /* 搜索框 */
        h('div', { className: 'kb-pane-search' },
          h('input', {
            className: 'kb-input',
            placeholder: '搜索这个知识库…',
            value: query,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') runSearch() },
          }),
          h('button', {
            className: 'kb-btn kb-btn-primary kb-btn-sm',
            disabled: searching || !query.trim(),
            onClick: runSearch,
          }, searching ? '…' : '搜'),
        ),

        error ? h('div', { className: 'kb-notice kb-notice-err' }, error) : null,

        /* 结果 */
        h('div', { className: 'kb-pane-body' },
          hits === null
            ? h('div', { className: 'kb-empty' },
                h(KnowledgeIcon, { size: 26 }),
                h('div', { className: 'kb-empty-title' }, activeCollection ? activeCollection.name : '暂无知识库'),
                h('div', { className: 'kb-empty-hint' },
                  activeCollection
                    ? `${activeCollection.document_count} 份文档 · ${activeCollection.chunk_count} 块，输入关键词开始搜索`
                    : '先在左侧「知识库」里新建一个'),
              )
            : hits.length === 0
              ? h('div', { className: 'kb-notice' }, `没有找到「${query.trim()}」`)
              : h('div', { className: 'kb-hits' },
                  hits.map((hit) => h('div', { key: hit.id, className: 'kb-hit kb-fade-in' },
                    h('div', { className: 'kb-hit-head' },
                      h('span', { className: 'kb-hit-doc' }, hit.title),
                      hit.page ? h('span', { className: 'kb-hit-page' }, `P${hit.page}`) : null,
                    ),
                    h('div', {
                      className: `kb-hit-text${expanded.has(hit.id) ? ' kb-hit-text-open' : ''}`,
                    }, highlight(hit.text, query)),
                    hit.text.length > 90
                      ? h('button', {
                          className: 'kb-hit-toggle',
                          onClick: () => toggleExpand(hit.id),
                        }, expanded.has(hit.id) ? t('common.collapse') : t('common.expand'))
                      : null,
                  )),
                ),
        ),

        /* 底部状态 */
        h('div', { className: 'kb-pane-foot' },
          h('span', { className: status?.ready ? 'kb-dot kb-dot-on' : 'kb-dot kb-dot-off' }),
          h('span', null, status?.ready ? `v${status.version}` : '未就绪'),
          h('span', { style: { marginLeft: 'auto' } }, status?.counts ? `${status.counts.chunks} 块` : ''),
        ),
      )
    }

    /* ══════════════════════════ 服务商预设 ══════════════════════════ */

    /**
     * 内置常见嵌入服务商。选一个就自动填好地址与模型名，
     * 用户只需贴 Key；想用别家就选「自定义」自己填。
     */
    const EMBED_PROVIDERS = [
      {
        id: 'custom',
        label: '自定义…',
        baseUrl: '',
        hint: '自己填任意 OpenAI 兼容地址与模型名。',
        models: [],
      },
      {
        id: 'siliconflow',
        label: '硅基流动 SiliconFlow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        keyUrl: 'https://cloud.siliconflow.cn/account/ak',
        hint: '国内直连快，注册送额度。',
        models: [
          { id: 'BAAI/bge-m3', dim: 1024, note: '多语言，8K 上下文，综合最稳（推荐）' },
          { id: 'Pro/BAAI/bge-m3', dim: 1024, note: 'bge-m3 增强版' },
          { id: 'Qwen/Qwen3-Embedding-8B', dim: 4096, note: 'MTEB 多语言第一，效果最好，价格较高' },
          { id: 'Qwen/Qwen3-Embedding-4B', dim: 2560, note: '效果与成本折中' },
          { id: 'Qwen/Qwen3-Embedding-0.6B', dim: 1024, note: '轻量，快且便宜' },
          { id: 'BAAI/bge-large-zh-v1.5', dim: 1024, note: '纯中文优化，512 上下文' },
          { id: 'BAAI/bge-large-en-v1.5', dim: 1024, note: '纯英文优化，512 上下文' },
          { id: 'netease-youdao/bce-embedding-base_v1', dim: 768, note: '网易有道，中文短文本，512 上下文' },
        ],
      },
      {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        keyUrl: 'https://platform.openai.com/api-keys',
        hint: '国内可能需要代理。',
        models: [
          { id: 'text-embedding-3-small', dim: 1536, note: '便宜，够用（推荐）' },
          { id: 'text-embedding-3-large', dim: 3072, note: '效果更好，价格更高' },
          { id: 'text-embedding-ada-002', dim: 1536, note: '旧版，仅兼容用' },
        ],
      },
      {
        id: 'dashscope',
        label: '阿里云百炼 DashScope',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        keyUrl: 'https://bailian.console.aliyun.com/',
        hint: '通义千问系列，国内稳定。',
        models: [
          { id: 'text-embedding-v3', dim: 1024, note: '通义 v3，中英文（推荐）' },
          { id: 'text-embedding-v2', dim: 1536, note: '上一代' },
          { id: 'text-embedding-v1', dim: 1536, note: '旧版，仅兼容用' },
        ],
      },
      {
        id: 'zhipu',
        label: '智谱 AI BigModel',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
        hint: '国内可用，有免费额度。',
        models: [
          { id: 'embedding-3', dim: 2048, note: '最新，中英文（推荐）' },
          { id: 'embedding-2', dim: 1024, note: '上一代' },
        ],
      },
      {
        id: 'qianfan',
        label: '百度千帆 ERNIE',
        baseUrl: 'https://qianfan.baidubce.com/v2',
        keyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
        hint: '百度文心一言平台，国内可用。',
        models: [
          { id: 'embedding-v1', dim: 384, note: '基础向量化，短文本（推荐）' },
          { id: 'bge-large-zh', dim: 1024, note: 'BGE 中文大模型，512 token 上限' },
          { id: 'bge-large-en', dim: 1024, note: 'BGE 英文大模型' },
          { id: 'tao-8k', dim: 1024, note: '支持 8K 长文本' },
        ],
      },
      {
        id: 'cohere',
        label: 'Cohere',
        baseUrl: 'https://api.cohere.ai/compatibility/v1',
        keyUrl: 'https://dashboard.cohere.com/api-keys',
        hint: '国外服务，国内可能需要代理。',
        models: [
          { id: 'embed-multilingual-v3.0', dim: 1024, note: '多语言，跨 100+ 语言（推荐）' },
          { id: 'embed-english-v3.0', dim: 1024, note: '英文优化' },
          { id: 'embed-multilingual-light-v3.0', dim: 384, note: '轻量多语言' },
          { id: 'embed-english-light-v3.0', dim: 384, note: '轻量英文' },
        ],
      },
      {
        id: 'jina',
        label: 'Jina AI',
        baseUrl: 'https://api.jina.ai/v1',
        keyUrl: 'https://jina.ai/embeddings/',
        hint: '支持超长上下文（32K），有免费额度。',
        models: [
          { id: 'jina-embeddings-v4', dim: 2048, note: '最新，32K 上下文，多模态（推荐）' },
          { id: 'jina-embeddings-v3', dim: 1024, note: '多语言，8K 上下文' },
          { id: 'jina-clip-v2', dim: 1024, note: '文图混合嵌入' },
        ],
      },
      {
        id: 'voyage',
        label: 'Voyage AI',
        baseUrl: 'https://api.voyageai.com/v1',
        keyUrl: 'https://dash.voyageai.com/api-keys',
        hint: '检索效果好，32K 上下文。',
        models: [
          { id: 'voyage-3', dim: 1024, note: '通用，质量最高（推荐）' },
          { id: 'voyage-3-lite', dim: 512, note: '低延迟低成本' },
          { id: 'voyage-multilingual-2', dim: 1024, note: '多语言检索优化' },
          { id: 'voyage-large-2', dim: 1536, note: '上一代大模型' },
        ],
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        hint: '注意：DeepSeek 目前未公开嵌入接口。此项保留占位，实际请改用其他服务商。',
        models: [],
      },
      {
        id: 'ollama',
        label: '本地 Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        hint: '完全本地，无需 Key。先执行 ollama pull <模型名>。',
        models: [
          { id: 'bge-m3', dim: 1024, note: '多语言，8K 上下文（推荐）' },
          { id: 'qwen3-embedding', dim: 1024, note: '通义 Qwen3 嵌入系列' },
          { id: 'nomic-embed-text', dim: 768, note: '英文强，轻量' },
          { id: 'nomic-embed-text-v2-moe', dim: 768, note: 'nomic v2 MoE' },
          { id: 'mxbai-embed-large', dim: 1024, note: '英文强' },
          { id: 'snowflake-arctic-embed', dim: 1024, note: '英文' },
          { id: 'snowflake-arctic-embed2', dim: 1024, note: '英文 v2' },
          { id: 'all-minilm', dim: 384, note: '极小极快，精度一般' },
          { id: 'embeddinggemma', dim: 768, note: 'Google Gemma 嵌入' },
          { id: 'granite-embedding', dim: 384, note: 'IBM，轻量' },
          { id: 'bge-large', dim: 1024, note: 'BGE 大模型' },
        ],
      },
      {
        id: 'lmstudio',
        label: '本地 LM Studio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        hint: '完全本地，无需 Key。在 LM Studio 中加载嵌入模型后启动本地服务端。',
        models: [
          { id: 'text-embedding-nomic-embed-text-v1.5', dim: 768, note: 'LM Studio 常见默认模型' },
          { id: 'text-embedding-bge-m3', dim: 1024, note: '如已下载 bge-m3' },
        ],
      },
      {
        id: 'xinference',
        label: '本机 Xinference',
        baseUrl: 'http://127.0.0.1:9997/v1',
        hint: '完全本地，无需 Key。需先启动 Xinference 并加载嵌入模型。',
        models: [
          { id: 'bge-m3', dim: 1024, note: '多语言（推荐）' },
          { id: 'bge-large-zh-v1.5', dim: 1024, note: '中文' },
          { id: 'jina-embeddings-v2-base-zh', dim: 768, note: 'Jina 中文' },
        ],
      },
    ]

    /** 根据地址反查匹配的服务商（用于回显下拉框） */
    function providerOfBaseUrl(baseUrl) {
      const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '')
      if (!normalized) return 'custom'
      const hit = EMBED_PROVIDERS.find(
        (p) => p.id !== 'custom' && p.baseUrl.replace(/\/+$/, '') === normalized,
      )
      return hit ? hit.id : 'custom'
    }

    /* ══════════════════════════ 设置面板 ══════════════════════════ */

    function SettingsPanel({ collectionId, onChanged }) {
      const t = useT()
      const [config, setConfig] = useState(null)
      const [embedStatus, setEmbedStatus] = useState(null)
      const [apiKey, setApiKey] = useState('')
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)
      const [building, setBuilding] = useState(null)
      const [providerId, setProviderId] = useState('custom')

      const load = useCallback(async () => {
        try {
          const value = await api('embed', { action: 'get', collectionId })
          setConfig(value)
          setEmbedStatus(value.status)
          setProviderId(providerOfBaseUrl(value.api?.baseUrl))
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        }
      }, [collectionId])

      useEffect(() => { load() }, [load])

      /*
       * 关键修复：用函数式更新读取最新状态再合并。
       * 之前直接用外层 config 变量，连续输入时拿到的是旧快照，
       * 导致后输入的字段覆盖掉先输入的字段（模型名被清空就是这么来的）。
       */
      const patchApi = useCallback((patch) => {
        setConfig((cur) => (cur === null ? cur : { ...cur, api: { ...cur.api, ...patch } }))
      }, [])

      const patchLocal = useCallback((patch) => {
        setConfig((cur) => (cur === null ? cur : { ...cur, local: { ...cur.local, ...patch } }))
      }, [])

      const patchProvider = useCallback((id) => {
        setConfig((cur) => (cur === null ? cur : { ...cur, provider: id }))
      }, [])

      /** 选择服务商预设：一键填好地址，并默认选中第一个模型 */
      const chooseProvider = useCallback((id) => {
        setProviderId(id)
        const preset = EMBED_PROVIDERS.find((p) => p.id === id)
        if (!preset || id === 'custom') return
        const first = preset.models?.[0]
        setConfig((cur) => (cur === null ? cur : {
          ...cur,
          api: {
            ...cur.api,
            baseUrl: preset.baseUrl,
            model: first?.id ?? '',
            dimension: first?.dim ?? 0,
          },
        }))
      }, [])

      const currentPreset = EMBED_PROVIDERS.find((p) => p.id === providerId)

      /** 把当前状态整理成后端要的形状 */
      const snapshot = useCallback(() => ({
        provider: config.provider,
        api: {
          baseUrl: config.api.baseUrl,
          model: config.api.model,
          dimension: config.api.dimension,
          batchSize: config.api.batchSize,
        },
        local: { modelDir: config.local.modelDir },
      }), [config])

      const save = useCallback(async () => {
        setBusy('save')
        setMessage(null)
        try {
          await api('embed', {
            action: 'set',
            config: snapshot(),
            ...(apiKey !== '' ? { apiKey } : {}),
          })
          setApiKey('')
          await load()
          setMessage({ kind: 'ok', text: '已保存' })
          onChanged?.()
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }, [snapshot, apiKey, load, onChanged])

      const test = useCallback(async () => {
        setBusy('test')
        setMessage(null)
        try {
          await api('embed', {
            action: 'set',
            config: snapshot(),
            ...(apiKey !== '' ? { apiKey } : {}),
          })
          const result = await api('embed', { action: 'test' })
          setMessage({
            kind: 'ok',
            text: `连接成功 · ${result.dimension} 维 · 耗时 ${result.ms}ms`,
          })
          setApiKey('')
          await load()
          onChanged?.()
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }, [snapshot, apiKey, load, onChanged])

      const buildIndex = useCallback(async () => {
        setBusy('build')
        setMessage(null)
        setBuilding({ done: 0, total: embedStatus?.total ?? 0 })
        try {
          const result = await api('embed/build', { collectionId })
          setMessage({ kind: 'ok', text: `索引完成 · 共 ${result.embedded} 条向量` })
          await load()
          onChanged?.()
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
          setBuilding(null)
        }
      }, [collectionId, embedStatus, load, onChanged])

      if (config === null) return h('div', { className: 'kb-notice' }, '加载设置中…')

      const modeLabel = embedStatus?.configured
        ? (embedStatus.complete ? '向量索引就绪' : '索引不完整')
        : '未配置嵌入'

      return h('div', null,

        message
          ? h('div', {
              className: `kb-notice${message.kind === 'err' ? ' kb-notice-err' : ''} kb-fade-in`,
            }, message.text)
          : null,

        /* 当前状态 */
        h('div', { className: 'kb-status-line' },
          h('span', { className: embedStatus?.complete ? 'kb-dot kb-dot-on' : 'kb-dot' }),
          h('span', null, modeLabel),
          embedStatus?.label ? h('span', { style: { opacity: 0.7 } }, `· ${embedStatus.label}`) : null,
          h('span', { style: { marginLeft: 'auto' } },
            `${embedStatus?.embedded ?? 0} / ${embedStatus?.total ?? 0} 块`),
        ),

        /* 嵌入方式 */
        h('div', { className: 'kb-field' },
          h('label', { className: 'kb-field-label' }, t('embed.way')),
          h('select', {
            className: 'kb-select',
            value: config.provider,
            onChange: (e) => patchProvider(e.target.value),
          },
            h('option', { value: 'none' }, t('embed.none')),
            h('option', { value: 'api' }, t('embed.api')),
            h('option', { value: 'local' }, t('embed.local')),
          ),
        ),

        /* ── 本地模型选择 ── */
        config.provider === 'local'
          ? h(React.Fragment, null,
              h(LocalModelPicker, {
                collectionId,
                config,
                patchLocal,
                onChanged,
              }),
            )
          : null,

        config.provider === 'api'
          ? h(React.Fragment, null,

              /* 服务商预设 */
              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' }, t('embed.provider')),
                h('select', {
                  className: 'kb-select',
                  value: providerId,
                  onChange: (e) => chooseProvider(e.target.value),
                },
                  EMBED_PROVIDERS.map((p) => h('option', { key: p.id, value: p.id }, p.label)),
                ),
                currentPreset?.hint
                  ? h('div', { className: 'kb-field-hint' }, currentPreset.hint)
                  : h('div', { className: 'kb-field-hint' },
                      '选一个服务商可自动填好地址与模型；也可以自己填任意 OpenAI 兼容地址。'),
              ),

              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' }, t('embed.baseUrl')),
                h('input', {
                  className: 'kb-input',
                  placeholder: 'https://api.example.com/v1',
                  value: config.api.baseUrl,
                  onChange: (e) => {
                    patchApi({ baseUrl: e.target.value })
                    setProviderId(providerOfBaseUrl(e.target.value))
                  },
                }),
                h('div', { className: 'kb-field-hint' }, '填到 /v1 为止，插件会拼上 /embeddings'),
              ),

              /* 模型：有预设列表就下拉选，否则手填；两种情况都可手动改 */
              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' },
                  t('embed.model'),
                  currentPreset?.models?.length
                    ? h('span', { className: 'kb-mode-chip', style: { marginLeft: 8 } },
                        `${currentPreset.models.length} 个可选`)
                    : null,
                ),

                currentPreset?.models?.length
                  ? h('select', {
                      className: 'kb-select',
                      value: currentPreset.models.some((m) => m.id === config.api.model)
                        ? config.api.model
                        : '__custom__',
                      onChange: (e) => {
                        const value = e.target.value
                        if (value === '__custom__') return
                        const picked = currentPreset.models.find((m) => m.id === value)
                        patchApi({ model: value, dimension: picked?.dim ?? 0 })
                      },
                    },
                      currentPreset.models.map((m) =>
                        h('option', { key: m.id, value: m.id },
                          `${m.id}${m.dim ? `（${m.dim} 维）` : ''}${m.note ? ` · ${m.note}` : ''}`,
                        ),
                      ),
                      h('option', { value: '__custom__' }, '自定义模型名…'),
                    )
                  : null,

                h('input', {
                  className: 'kb-input',
                  placeholder: currentPreset?.models?.length ? '也可以直接输入模型标识' : '例如 BAAI/bge-m3',
                  value: config.api.model,
                  onChange: (e) => {
                    // 手动输入即视为自定义，清掉预设维度由服务返回决定
                    patchApi({ model: e.target.value, dimension: 0 })
                  },
                  style: currentPreset?.models?.length ? { marginTop: 6 } : undefined,
                }),

                h('div', { className: 'kb-field-hint' },
                  currentPreset?.models?.length
                    ? '从上面选一个，或直接在输入框写服务商文档里的模型标识（大小写与斜杠要一致）。'
                    : '写服务商文档里的模型标识，大小写与斜杠要一致。'),
              ),

              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' },
                  t('embed.apiKey'),
                  config.api.hasKey
                    ? h('span', { className: 'kb-mode-chip kb-mode-ok', style: { marginLeft: 8 } }, '已保存')
                    : null,
                ),
                h('input', {
                  className: 'kb-input',
                  type: 'password',
                  placeholder: config.api.hasKey ? '已保存，留空则不修改' : '粘贴 API Key（本地服务可留空）',
                  value: apiKey,
                  onChange: (e) => setApiKey(e.target.value),
                }),
                h('div', { className: 'kb-field-hint' },
                  currentPreset?.keyUrl
                    ? h('span', null,
                        '获取 Key：',
                        h('a', {
                          href: currentPreset.keyUrl,
                          target: '_blank',
                          rel: 'noreferrer',
                          style: { color: 'var(--dsw-alias-brand-primary)' },
                        }, currentPreset.keyUrl),
                        ' · 存在凭据库或 secrets.json，不写进设置文件')
                    : '存在 DSH 凭据库或数据目录的 secrets.json，不会写进设置文件'),
              ),

              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' }, t('embed.batchSize')),
                h('input', {
                  className: 'kb-input',
                  type: 'number',
                  min: 1, max: 64,
                  value: config.api.batchSize,
                  onChange: (e) => patchApi({ batchSize: Number(e.target.value) || 16 }),
                }),
                h('div', { className: 'kb-field-hint' }, '一次请求发送多少条文本，默认 16，太大可能被限流'),
              ),
            )
          : null,

        /* 操作按钮 */
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
          h('button', {
            className: 'kb-btn',
            disabled: busy !== '',
            onClick: save,
          }, busy === 'save' ? t('common.saving') : t('common.save')),

          config.provider === 'api'
            ? h('button', {
                className: 'kb-btn',
                disabled: busy !== '',
                onClick: test,
              }, busy === 'test' ? t('common.testing') : t('common.test'))
            : null,

          h('button', {
            className: 'kb-btn kb-btn-primary',
            disabled: busy !== '' || !embedStatus?.configured,
            onClick: buildIndex,
          }, busy === 'build' ? t('embed.building') : t('embed.build')),
        ),

        building
          ? h('div', { className: 'kb-notice', style: { marginTop: 10 } },
              `正在建立索引… ${building.done} / ${building.total}`)
          : null,

        h('div', { className: 'kb-field-hint', style: { marginTop: 12 } },
          '换嵌入模型后向量维度会变，旧索引不能混用，需要重新点「建立向量索引」。'),
      )
    }

    /* ══════════════════════════ 本地模型选择器 ══════════════════════════ */

    function LocalModelPicker({ collectionId, config, patchLocal, onChanged }) {
      const t = useT()
      const [catalog, setCatalog] = useState([])
      const [installed, setInstalled] = useState([])
      const [mirrors, setMirrors] = useState([])
      const [libAvailable, setLibAvailable] = useState(true)
      const [installHint, setInstallHint] = useState('')
      const [installing, setInstalling] = useState(false)
      const [installLog, setInstallLog] = useState([])
      const [installError, setInstallError] = useState(null)
      const [busy, setBusy] = useState('')
      const [progress, setProgress] = useState(null)
      const [message, setMessage] = useState(null)

      const load = useCallback(async () => {
        try {
          const value = await api('models', { action: 'catalog' })
          setCatalog(value.catalog ?? [])
          setInstalled(value.local ?? [])
          setMirrors(value.mirrors ?? [])
          setLibAvailable(value.libAvailable !== false)
          setInstallHint(value.installHint ?? '')
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        }
      }, [])

      useEffect(() => { load() }, [load])

      /* 下载期间轮询进度 */
      useEffect(() => {
        if (busy !== 'download') return undefined
        const timer = setInterval(async () => {
          try {
            const p = await api('models/progress')
            if (p) setProgress(p)
          } catch {
            // 忽略单次轮询失败
          }
        }, 800)
        return () => clearInterval(timer)
      }, [busy])

      /* 安装依赖：启动后轮询进度 */
      const installLibrary = useCallback(async () => {
        setInstalling(true)
        setInstallError(null)
        setInstallLog(['正在启动安装…'])
        try {
          const started = await api('models/install-lib')
          if (!started.started) {
            setInstallLog([started.reason ?? '无需安装'])
            if (started.reason === '依赖已安装') {
              setLibAvailable(true)
              setInstalling(false)
            }
            return
          }
        } catch (err) {
          setInstallError(err.message)
          setInstalling(false)
        }
      }, [])

      useEffect(() => {
        if (!installing) return undefined
        let alive = true
        const timer = setInterval(async () => {
          if (!alive) return
          try {
            const p = await api('models/install-progress')
            setInstallLog(p.lines?.length ? p.lines : ['（等待输出…）'])
            if (p.error) setInstallError(p.error)
            if (!p.running) {
              alive = false
              clearInterval(timer)
              setInstalling(false)
              if (p.available) {
                setLibAvailable(true)
                setMessage({ kind: 'ok', text: '依赖安装完成，现在可以使用本地模型了' })
              } else if (p.error) {
                setInstallError(p.error)
              } else {
                setInstallError('安装结束，但依赖仍不可用')
              }
            }
          } catch {
            // 单次轮询失败不终止
          }
        }, 1000)
        return () => { alive = false; clearInterval(timer) }
      }, [installing])

      const isInstalled = (id) => installed.some((m) => m.id === id && m.complete)

      const download = useCallback(async (id) => {
        setBusy('download')
        setMessage(null)
        setProgress({ done: 0, total: 1, detail: '准备中…' })
        try {
          await api('models/download', { modelId: id })
          setMessage({ kind: 'ok', text: '下载完成' })
          await load()
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
          setProgress(null)
        }
      }, [load])

      const remove = useCallback(async (id) => {
        if (!window.confirm('删除这个本地模型？')) return
        setBusy('remove')
        try {
          await api('models', { action: 'remove', modelId: id })
          await load()
          setMessage({ kind: 'ok', text: '已删除' })
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }, [load])

      return h('div', null,

        /* 依赖未安装：给一键安装，而不是只给命令 */
        libAvailable
          ? null
          : h('div', { className: 'kb-notice kb-notice-err' },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '本地推理依赖未安装'),
              h('div', null, '要用本地模型算向量，需要先装一个推理库（约 473MB）。'),

              installing
                ? h('div', { style: { marginTop: 8 } },
                    h('div', { className: 'kb-install-status' },
                      h('span', { className: 'kb-spin' }, '◐'),
                      h('span', null, '正在安装，可能需要 1–3 分钟…'),
                    ),
                    h('pre', { className: 'kb-code kb-code-log' },
                      installLog.slice(-12).join('\n') || '（等待输出…）'),
                  )
                : h('div', { style: { marginTop: 8 } },
                    h('button', {
                      className: 'kb-btn kb-btn-primary kb-btn-sm',
                      onClick: installLibrary,
                    }, '一键安装依赖'),

                    installError
                      ? h('div', { className: 'kb-err', style: { marginTop: 6 } },
                          `安装失败：${installError}`)
                      : null,

                    h('details', { className: 'kb-details' },
                      h('summary', null, '安装失败时的手动方式'),
                      h('code', { className: 'kb-code' }, installHint || 'npm install @huggingface/transformers'),
                      h('div', { className: 'kb-field-hint', style: { marginTop: 4 } },
                        '在插件目录执行上述命令。也可以把「嵌入方式」切回「API」——已验证可用。'),
                    ),
                  ),
            ),

        message
          ? h('div', { className: `kb-notice${message.kind === 'err' ? ' kb-notice-err' : ''}` }, message.text)
          : null,

        /* 镜像选择 */
        h('div', { className: 'kb-field' },
          h('label', { className: 'kb-field-label' }, t('models.mirror')),
          h('select', {
            className: 'kb-select',
            value: config.local.mirror ?? 'hf-mirror',
            onChange: (e) => patchLocal({ mirror: e.target.value }),
          },
            (mirrors.length ? mirrors : [{ id: 'hf-mirror', label: 'HF 镜像（国内快）' }])
              .map((m) => h('option', { key: m.id, value: m.id }, m.label)),
          ),
          h('div', { className: 'kb-field-hint' },
            '国内直连 huggingface.co 经常失败，建议保持 HF 镜像。'),
        ),

        /* 模型列表 */
        h('div', { className: 'kb-field' },
          h('label', { className: 'kb-field-label' }, t('models.title')),
          h('div', { className: 'kb-model-list' },
            catalog.map((m) => {
              const done = isInstalled(m.id)
              const selected = config.local.modelId === m.id
              return h('div', {
                key: m.id,
                className: `kb-model${selected ? ' kb-model-on' : ''}`,
              },
                h('div', { className: 'kb-model-main' },
                  h('div', { className: 'kb-model-name' },
                    m.name,
                    done
                      ? h('span', { className: 'kb-mode-chip kb-mode-ok', style: { marginLeft: 6 } }, t('models.downloaded'))
                      : null,
                  ),
                  h('div', { className: 'kb-model-sub' },
                    `${m.dim} 维 · 约 ${m.sizeMB >= 1000 ? (m.sizeMB / 1000).toFixed(1) + 'GB' : m.sizeMB + 'MB'} · ${m.note}`),
                ),
                h('div', { className: 'kb-model-actions' },
                  done
                    ? h(React.Fragment, null,
                        h('button', {
                          className: 'kb-btn kb-btn-sm',
                          disabled: busy !== '',
                          onClick: () => {
                            patchLocal({ modelId: m.id, dimension: m.dim })
                            onChanged?.()
                          },
                        }, selected ? t('models.selected') : t('models.use')),
                        h('button', {
                          className: 'kb-btn kb-btn-sm kb-btn-danger',
                          disabled: busy !== '',
                          onClick: () => remove(m.id),
                        }, t('common.delete')),
                      )
                    : h('button', {
                        className: 'kb-btn kb-btn-sm kb-btn-primary',
                        disabled: busy !== '',
                        onClick: () => download(m.id),
                      }, t('models.download')),
                ),
              )
            }),
          ),
        ),

        progress
          ? h('div', { className: 'kb-notice' },
              `下载中 ${progress.done}/${progress.total} · ${progress.detail ?? ''}`)
          : null,

        /* 手动指定目录 */
        h('div', { className: 'kb-field' },
          h('label', { className: 'kb-field-label' }, '或手动指定模型目录'),
          h('input', {
            className: 'kb-input',
            placeholder: '例如 D:\\models\\bge-m3',
            value: config.local.modelDir ?? '',
            onChange: (e) => patchLocal({ modelDir: e.target.value }),
          }),
          h('div', { className: 'kb-field-hint' },
            '已有 transformers 格式模型时可直接填路径，支持 ONNX。留空则用上面选中的模型。'),
        ),
      )
    }

    /* ══════════════════════════ 本地模型选择器结束 ══════════════════════════ */

    /* ══════════════════════════ 重排设置 ══════════════════════════ */

    /** 常见重排模型，选了自动填地址 */
    const RERANK_PRESETS = [
      { id: 'custom', label: '自定义…', baseUrl: '', model: '' },
      { id: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-reranker-v2-m3' },
      { id: 'jina', label: 'Jina AI', baseUrl: 'https://api.jina.ai/v1', model: 'jina-reranker-v2-base-multilingual' },
      { id: 'cohere', label: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', model: 'rerank-v3.5', style: 'cohere' },
      { id: 'voyage', label: 'Voyage AI', baseUrl: 'https://api.voyageai.com/v1', model: 'rerank-2' },
    ]

    function RerankPanel({ collectionId, onChanged }) {
      const t = useT()
      const [config, setConfig] = useState(null)
      const [presetId, setPresetId] = useState('custom')
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)

      const load = useCallback(async () => {
        try {
          const value = await api('rerank', { action: 'get' })
          setConfig(value)
          const hit = RERANK_PRESETS.find(
            (p) => p.id !== 'custom' && p.baseUrl === (value.api?.baseUrl ?? ''),
          )
          setPresetId(hit ? hit.id : 'custom')
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        }
      }, [])

      useEffect(() => { load() }, [load])

      const patchApi = useCallback((patch) => {
        setConfig((cur) => (cur === null ? cur : { ...cur, api: { ...cur.api, ...patch } }))
      }, [])

      const choosePreset = useCallback((id) => {
        setPresetId(id)
        const preset = RERANK_PRESETS.find((p) => p.id === id)
        if (!preset || id === 'custom') return
        setConfig((cur) => (cur === null ? cur : {
          ...cur,
          api: {
            ...cur.api,
            baseUrl: preset.baseUrl,
            model: preset.model,
            style: preset.style ?? 'openai',
          },
        }))
      }, [])

      const save = useCallback(async () => {
        setBusy('save')
        setMessage(null)
        try {
          await api('rerank', {
            action: 'set',
            config: { provider: config.provider, api: config.api },
          })
          setMessage({ kind: 'ok', text: '已保存' })
          onChanged?.()
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }, [config, onChanged])

      const test = useCallback(async () => {
        setBusy('test')
        setMessage(null)
        try {
          await api('rerank', {
            action: 'set',
            config: { provider: config.provider, api: config.api },
          })
          const r = await api('rerank', { action: 'test' })
          setMessage({
            kind: 'ok',
            text: `连接成功 · 返回 ${r.results} 条 · 耗时 ${r.ms}ms${r.sane ? '' : '（排序可能异常，请检查模型）'}`,
          })
          onChanged?.()
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }, [config, onChanged])

      if (config === null) return h('div', { className: 'kb-notice' }, '加载中…')

      return h('div', null,

        message
          ? h('div', { className: `kb-notice${message.kind === 'err' ? ' kb-notice-err' : ''} kb-fade-in` }, message.text)
          : null,

        h('div', { className: 'kb-field' },
          h('label', { className: 'kb-field-label' }, t('rerank.way')),
          h('select', {
            className: 'kb-select',
            value: config.provider,
            onChange: (e) => setConfig((cur) => ({ ...cur, provider: e.target.value })),
          },
            h('option', { value: 'none' }, t('rerank.none')),
            h('option', { value: 'api' }, t('rerank.api')),
          ),
          h('div', { className: 'kb-field-hint' },
            '重排会再发一次请求，能显著提升相关性，但会增加一点延迟和费用。'),
        ),

        config.provider === 'api'
          ? h(React.Fragment, null,
              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' }, t('embed.provider')),
                h('select', {
                  className: 'kb-select',
                  value: presetId,
                  onChange: (e) => choosePreset(e.target.value),
                }, RERANK_PRESETS.map((p) => h('option', { key: p.id, value: p.id }, p.label))),
              ),

              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' }, t('embed.baseUrl')),
                h('input', {
                  className: 'kb-input',
                  placeholder: 'https://api.siliconflow.cn/v1',
                  value: config.api.baseUrl,
                  onChange: (e) => patchApi({ baseUrl: e.target.value }),
                }),
              ),

              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' }, '模型名'),
                h('input', {
                  className: 'kb-input',
                  placeholder: '例如 BAAI/bge-reranker-v2-m3',
                  value: config.api.model,
                  onChange: (e) => patchApi({ model: e.target.value }),
                }),
                h('div', { className: 'kb-field-hint' },
                  '与嵌入共用同一个 API Key；若服务商不同，请换成对应的 Key。'),
              ),

              h('div', { className: 'kb-field' },
                h('label', { className: 'kb-field-label' }, t('rerank.topN')),
                h('input', {
                  className: 'kb-input',
                  type: 'number',
                  min: 1, max: 50,
                  value: config.api.topN,
                  onChange: (e) => patchApi({ topN: Number(e.target.value) || 8 }),
                }),
                h('div', { className: 'kb-field-hint' }, '重排后最终返回几条，默认 8'),
              ),
            )
          : null,

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
          h('button', { className: 'kb-btn', disabled: busy !== '', onClick: save },
            busy === 'save' ? t('common.saving') : t('common.save')),
          config.provider === 'api'
            ? h('button', { className: 'kb-btn', disabled: busy !== '', onClick: test },
                busy === 'test' ? t('common.testing') : t('common.test'))
            : null,
        ),
      )
    }

    /* ══════════════════════════ 重排设置结束 ══════════════════════════ */

    /* ══════════════════════════ 抓取设置 ══════════════════════════ */

    function FetchPanel() {
      const t = useT()
      const [config, setConfig] = useState(null)
      const [sources, setSources] = useState([])
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)
      const [showSources, setShowSources] = useState(false)
      const [whitelistText, setWhitelistText] = useState('')

      const load = useCallback(async () => {
        try {
          const [cfg, list] = await Promise.all([
            api('fetch', { action: 'get' }),
            api('sources'),
          ])
          setConfig(cfg)
          setSources(list ?? [])
          setWhitelistText((cfg.whitelist ?? []).join('\n'))
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        }
      }, [])

      useEffect(() => { load() }, [load])

      const save = useCallback(async (patch) => {
        setBusy('save')
        setMessage(null)
        try {
          const next = await api('fetch', {
            action: 'set',
            config: {
              ...(patch ?? {}),
              whitelist: whitelistText.split('\n').map((s) => s.trim()).filter(Boolean),
            },
          })
          setConfig(next)
          setMessage({ kind: 'ok', text: '已保存' })
        } catch (err) {
          setMessage({ kind: 'err', text: err.message })
        } finally {
          setBusy('')
        }
      }, [whitelistText])

      const toggle = useCallback(async () => {
        const next = !config.enabled
        setConfig((cur) => ({ ...cur, enabled: next }))
        await save({ enabled: next })
      }, [config, save])

      if (config === null) return h('div', { className: 'kb-notice' }, '加载中…')

      const totalSources = sources.reduce((n, g) => n + g.sources.length, 0)

      return h('div', null,

        message
          ? h('div', { className: `kb-notice${message.kind === 'err' ? ' kb-notice-err' : ''} kb-fade-in` }, message.text)
          : null,

        /* 总开关 */
        h('div', { className: 'kb-status-line' },
          h('span', { className: config.enabled ? 'kb-dot kb-dot-on' : 'kb-dot' }),
          h('span', null, config.enabled ? t('fetch.on') : t('fetch.off')),
          h('button', {
            className: 'kb-btn kb-btn-sm',
            style: { marginLeft: 'auto' },
            disabled: busy !== '',
            onClick: toggle,
          }, config.enabled ? '关闭' : '开启'),
        ),

        h('div', { className: 'kb-field-hint', style: { marginBottom: 10 } },
          config.enabled
            ? '开启后模型可通过 kb_source_fetch 取公开资料。仍会遵守：只走 http/https、拒绝内网地址、读 robots.txt、同站点间隔 2 秒、单文件 ≤100MB、记录来源。'
            : '关闭时插件完全不访问网络，只用你自己拖进来的文件。'),

        /* 可选白名单 */
        h('div', { className: 'kb-field' },
          h('label', { className: 'kb-field-label' }, t('fetch.whitelist')),
          h('textarea', {
            className: 'kb-textarea',
            rows: 3,
            placeholder: '留空 = 不限制，允许任意公开站点\n需要更严时，一行填一个域名，例如：\narxiv.org\nopenstax.org',
            value: whitelistText,
            onChange: (e) => setWhitelistText(e.target.value),
          }),
          h('div', { className: 'kb-field-hint' },
            whitelistText.trim()
              ? '已启用白名单：只允许这些域名及其子域名。'
              : '留空表示不限制——这是你要求的「不要白名单硬约束」。'),
        ),

        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
          h('button', { className: 'kb-btn', disabled: busy !== '', onClick: () => save() },
            busy === 'save' ? t('common.saving') : t('common.save')),
          h('button', {
            className: 'kb-btn',
            onClick: () => setShowSources((v) => !v),
          }, showSources ? '收起来源清单' : `查看权威来源（${totalSources}）`),
        ),

        /* 权威来源清单 */
        showSources
          ? h('div', { className: 'kb-sources kb-fade-in' },
              sources.map((group) => h('div', { key: group.topic, className: 'kb-source-group' },
                h('div', { className: 'kb-source-topic' }, group.label),
                group.sources.map((s) => h('div', { key: s.id, className: 'kb-source' },
                  h('div', { className: 'kb-source-head' },
                    h('span', { className: 'kb-source-name' }, s.name),
                    h('span', { className: 'kb-source-host' }, s.host),
                  ),
                  h('div', { className: 'kb-source-use' }, s.use),
                  h('div', { className: 'kb-source-license' }, `许可：${s.license}`),
                )),
              )),
              h('div', { className: 'kb-field-hint', style: { marginTop: 8 } },
                '这是一份「质量有保证的起点」，不是限制。清单外站点同样可以抓，只要开关打开。'),
            )
          : null,
      )
    }

    /* ══════════════════════════ 抓取设置结束 ══════════════════════════ */

    /* ══════════════════════════ 注册 ══════════════════════════ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        /*
         * 注册界面字典并接上翻译函数。
         * 若 locale 服务不可用（或字典缺 key），回落到内置中文，
         * 避免界面上直接露出 header.title 这种原始 key。
         */
        try {
          const locale = ctx.locale
          if (locale?.register) {
            for (const [localeId, dict] of Object.entries(DICT)) {
              locale.register(LOCALE_NS, localeId, dict)
            }
            const bound = locale.bind?.(LOCALE_NS)
            setTranslator((key, params) => {
              const raw = bound ? bound(key) : undefined
              const value = raw && raw !== key ? raw : (DICT.zh[key] ?? key)
              return fmt(value, params)
            })
          } else {
            setTranslator((key, params) => fmt(DICT.zh[key] ?? key, params))
          }
        } catch {
          // 注册失败时仍用中文，不影响功能
          setTranslator((key, params) => fmt(DICT.zh[key] ?? key, params))
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dsh-knowbase',
              order: 30,
              label: () => '知识库',
            },
            (props) => h(KnowledgeIcon, {
              size: typeof props?.size === 'number' ? props.size : 20,
              active: props?.active === true,
            }),
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-knowbase' }, Panel),
        )

        /* ── 右侧栏：聊天时可并排搜索 ── */
        ctx.inject(['sidebarRightTabs'], (scope) => {
          const tabs = scope.sidebarRightTabs
          if (tabs === undefined || typeof tabs.register !== 'function') return

          const disposers = []
          try {
            disposers.push(
              tabs.register({
                id: 'dsh-knowbase',
                kind: 'dsh-knowbase',
                title: () => '知识库',
                guide: [{
                  id: 'dsh-knowbase',
                  order: 30,
                  title: () => '知识库',
                  description: () => '在对话旁直接搜索本地知识库，命中结果带文档名与页码。',
                }],
              }),
            )
            disposers.push(
              scope.slots.inject('sidebar.right.pane.tab', () =>
                scope.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-knowbase' }, SidePane),
              ),
            )
          } catch {
            for (const dispose of disposers) dispose()
            return
          }

          return () => {
            for (const dispose of disposers) dispose()
          }
        })
      },
    }
  },
})
