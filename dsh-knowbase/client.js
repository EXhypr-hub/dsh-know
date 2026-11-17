/**
 * dsh-knowbase — Client 半
 *
 * P0 提供两处界面：
 *   1. 左侧栏图标（sidebar.panellist）—— 全局入口
 *   2. 主面板页面（main，key = dsh-knowbase）—— 点图标后居中显示
 *
 * 样式只用主题变量 --dsw-alias-*，深浅色自动适配；
 * 动效遵守 prefers-reduced-motion。
 */

window.__ModuleLoader__.load({
  id: 'dsh-knowbase',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /* ────────────────────────────── 样式 ────────────────────────────── */

    const STYLE_ID = 'dsh-knowbase/styles'

    const css = `
.kb-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 13px;
  line-height: 1.55;
}

/* ── 顶栏 ── */
.kb-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
}
.kb-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.kb-subtitle {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
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
.kb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
  flex: none;
}
.kb-dot-on { background: var(--dsw-alias-state-success-primary); }
.kb-dot-off { background: var(--dsw-alias-state-error-primary); }

/* ── 内容区 ── */
.kb-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── 卡片 ── */
.kb-card {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 12px;
  padding: 16px 18px;
}
.kb-card-title {
  margin: 0 0 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.kb-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.kb-row:last-child { border-bottom: 0; }
.kb-key {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  min-width: 84px;
}
.kb-val {
  min-width: 0;
  word-break: break-all;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
}

/* ── 空状态 ── */
.kb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 44px 20px;
  text-align: center;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 12px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
}
.kb-empty-title {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
}
.kb-empty-hint { font-size: 12px; }

/* ── 阶段清单 ── */
.kb-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.kb-step {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 8px;
  transition: background-color 160ms ease, opacity 160ms ease;
}
.kb-step-icon {
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-border-l2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
}
.kb-step-done .kb-step-icon {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}
.kb-step-current {
  background: var(--dsw-alias-bg-layer-2);
}
.kb-step-current .kb-step-icon {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
  animation: kb-pulse 1.8s ease-in-out infinite;
}
.kb-step-pending { opacity: 0.62; }
.kb-step-name { font-size: 12px; }
.kb-step-tag {
  margin-left: auto;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}

/* ── 动效 ── */
@keyframes kb-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.92); }
}
@keyframes kb-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.kb-fade-in { animation: kb-fade-in 220ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }

@media (prefers-reduced-motion: reduce) {
  .kb-step-current .kb-step-icon { animation: none; }
  .kb-fade-in { animation: none; }
  .kb-step { transition: none; }
}

/* ── 侧栏图标 ── */
.kb-icon {
  display: block;
  width: 100%;
  height: 100%;
  color: inherit;
}
`

    function useStyles() {
      useEffect(() => {
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
        const el = document.createElement('style')
        el.dataset.plugin = 'dsh-knowbase'
        el.dataset.pluginCss = STYLE_ID
        el.textContent = css
        document.head.appendChild(el)
      }, [])
    }

    /* ────────────────────────────── 图标 ────────────────────────────── */

    function KnowledgeIcon({ size = 20, active = false }) {
      return h(
        'svg',
        {
          className: 'kb-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          stroke: 'currentColor',
          strokeWidth: active ? 1.9 : 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        // 书脊 + 书页，象征「库」
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H9a2 2 0 0 1 2 2v13a1.6 1.6 0 0 0-1.6-1.6H5.5A1.5 1.5 0 0 1 4 15.9z' }),
        h('path', { d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H15a2 2 0 0 0-2 2v13a1.6 1.6 0 0 1 1.6-1.6h3.9A1.5 1.5 0 0 0 20 15.9z' }),
      )
    }

    /* ────────────────────────────── 状态获取 ────────────────────────────── */

    function useStatus() {
      const [state, setState] = useState({ loading: true, data: null, error: null })

      const load = useCallback(async () => {
        try {
          const res = await fetch('api/dsh-knowbase/status', { method: 'POST' })
          const body = await res.json()
          if (body?.ok) setState({ loading: false, data: body.value, error: null })
          else setState({ loading: false, data: null, error: body?.error?.message ?? '接口返回异常' })
        } catch (error) {
          setState({ loading: false, data: null, error: error?.message ?? String(error) })
        }
      }, [])

      useEffect(() => {
        let alive = true
        const run = () => { if (alive) load() }
        run()
        const timer = setInterval(run, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      return state
    }

    /* ────────────────────────────── 主页面 ────────────────────────────── */

    const STEPS = [
      { id: 'P0', name: '插件骨架', note: '当前' },
      { id: 'P1', name: '导入与存储', note: '待做' },
      { id: 'P2', name: '检索', note: '待做' },
      { id: 'P3', name: '模型接入', note: '待做' },
      { id: 'P4', name: '权威来源采集', note: '待做' },
      { id: 'P5', name: '界面打磨', note: '待做' },
      { id: 'P6', name: '打包发布', note: '待做' },
    ]

    function Panel() {
      useStyles()
      const { loading, data, error } = useStatus()

      const statusText = loading ? '连接中…' : data?.ready ? '已就绪' : '未就绪'
      const dotClass = loading
        ? 'kb-dot'
        : data?.ready
          ? 'kb-dot kb-dot-on'
          : 'kb-dot kb-dot-off'

      return h(
        'div',
        { className: 'kb-root' },
        h(
          'header',
          { className: 'kb-header' },
          h(KnowledgeIcon, { size: 22, active: true }),
          h(
            'div',
            null,
            h('h1', { className: 'kb-title' }, '本地知识库'),
            h('div', { className: 'kb-subtitle' }, '文档导入 · 语义检索 · 权威来源采集'),
          ),
          h(
            'span',
            { className: 'kb-badge' },
            h('span', { className: dotClass }),
            statusText,
            data?.version ? ` · v${data.version}` : '',
          ),
        ),

        h(
          'div',
          { className: 'kb-body' },

          error
            ? h(
                'div',
                { className: 'kb-card kb-fade-in' },
                h('h2', { className: 'kb-card-title' }, '连接失败'),
                h('div', { className: 'kb-subtitle' }, error),
              )
            : null,

          // 空状态：P0 还没有库，如实说明
          h(
            'div',
            { className: 'kb-empty kb-fade-in' },
            h(KnowledgeIcon, { size: 34 }),
            h('div', { className: 'kb-empty-title' }, '还没有知识库'),
            h(
              'div',
              { className: 'kb-empty-hint' },
              '拖入文件与检索能力正在开发中（当前 P0：插件骨架）',
            ),
          ),

          // 运行时信息
          h(
            'section',
            { className: 'kb-card kb-fade-in' },
            h('h2', { className: 'kb-card-title' }, '运行时'),
            h(
              'div',
              { className: 'kb-row' },
              h('span', { className: 'kb-key' }, '版本'),
              h('span', { className: 'kb-val' }, data?.version ?? '—'),
            ),
            h(
              'div',
              { className: 'kb-row' },
              h('span', { className: 'kb-key' }, '数据目录'),
              h('span', { className: 'kb-val' }, data?.dataRoot ?? '—'),
            ),
            h(
              'div',
              { className: 'kb-row' },
              h('span', { className: 'kb-key' }, '状态'),
              h(
                'span',
                { className: 'kb-val' },
                loading ? '连接中' : data?.ready ? '目录可写，等待导入功能' : data?.readyError ?? '未知',
              ),
            ),
          ),

          // 阶段进度
          h(
            'section',
            { className: 'kb-card kb-fade-in' },
            h('h2', { className: 'kb-card-title' }, '开发进度'),
            h(
              'ul',
              { className: 'kb-steps' },
              STEPS.map((step) => {
                const current = step.id === data?.stage
                return h(
                  'li',
                  {
                    key: step.id,
                    className: [
                      'kb-step',
                      current ? 'kb-step-current' : 'kb-step-pending',
                    ].join(' '),
                  },
                  h('span', { className: 'kb-step-icon' }, current ? '●' : ''),
                  h('span', { className: 'kb-step-name' }, `${step.id} ${step.name}`),
                  h('span', { className: 'kb-step-tag' }, current ? '进行中' : '待做'),
                )
              }),
            ),
          ),
        ),
      )
    }

    /* ────────────────────────────── 注册 ────────────────────────────── */

    const LOCALE_NS = 'dsh-knowbase'

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dsh-knowbase',
              order: 30,
              label: () => '知识库',
            },
            (props) => h(KnowledgeIcon, { size: props?.size ?? 20, active: props?.active === true }),
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: 'dsh-knowbase' },
            Panel,
          ),
        )
      },
    }
  },
})
