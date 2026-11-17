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
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
}
.kb-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.kb-subtitle { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
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
.kb-btn:disabled { opacity: 0.45; cursor: default; }
.kb-btn-primary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: #fff;
}
.kb-btn-primary:hover:not(:disabled) { opacity: 0.9; background: var(--dsw-alias-brand-primary); }
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
.kb-hit-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; font-size: 11.5px; }
.kb-hit-doc { font-weight: 600; color: var(--dsw-alias-label-primary); }
.kb-hit-page { color: var(--dsw-alias-label-secondary); }
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

/* ── 侧栏图标：撑满按钮格 ── */
.kb-icon { display: block; width: 100%; height: 100%; color: inherit; }

/* ── 内容区图标：按传入尺寸固定，不撑满 ── */
.kb-icon-fixed { display: block; color: inherit; flex: none; }
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

    /* ══════════════════════════ 图标 ══════════════════════════ */

    /**
     * 书页图标。
     * @param size    图标边长（px）。fill=true 时忽略，改为撑满父容器。
     * @param fill    侧栏按钮用：撑满整个格子
     * @param active  选中态加粗描边
     */
    function KnowledgeIcon({ size = 20, active = false, fill = false }) {
      return h('svg', {
        className: fill ? 'kb-icon' : 'kb-icon-fixed',
        width: fill ? undefined : size,
        height: fill ? undefined : size,
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

      const fileInputRef = useRef(null)

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
        setSearching(true)
        setError(null)
        try {
          const value = await api('search', { query: q, collectionId: activeId, limit: 20 })
          setHits(value)
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

      /* ── 派生 ── */
      const activeCollection = useMemo(
        () => collections.find((c) => c.id === activeId) ?? null,
        [collections, activeId],
      )

      const totalChunks = activeCollection?.chunk_count ?? 0

      const statusText = !status ? '连接中…' : status.ready ? '已就绪' : '未就绪'
      const dotClass = !status ? 'kb-dot' : status.ready ? 'kb-dot kb-dot-on' : 'kb-dot kb-dot-off'

      const canIngest = activeId !== null && status?.ready === true

      /* ══════════════════════════ 渲染 ══════════════════════════ */

      return h('div', { className: 'kb-root' },

        /* 顶栏 */
        h('header', { className: 'kb-header' },
          h(KnowledgeIcon, { size: 22, active: true }),
          h('div', null,
            h('h1', { className: 'kb-title' }, '本地知识库'),
            h('div', { className: 'kb-subtitle' }, '文档导入 · 语义检索 · 权威来源采集'),
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
              h('span', null, '知识库'),
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
                    placeholder: '知识库名称',
                    value: newName,
                    autoFocus: true,
                    onChange: (e) => setNewName(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') submitCreate()
                      if (e.key === 'Escape') { setCreating(false); setNewName('') }
                    },
                  }),
                  h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                    h('button', { className: 'kb-btn kb-btn-sm kb-btn-primary', disabled: busy || !newName.trim(), onClick: submitCreate }, '创建'),
                    h('button', { className: 'kb-btn kb-btn-sm', onClick: () => { setCreating(false); setNewName('') } }, '取消'),
                  ),
                )
              : null,

            h('div', { className: 'kb-side-list' },
              collections.length === 0
                ? h('div', { className: 'kb-subtitle', style: { padding: '8px 10px' } }, '还没有知识库')
                : collections.map((collection) => h('button', {
                    key: collection.id,
                    className: `kb-coll${collection.id === activeId ? ' kb-coll-on' : ''}`,
                    onClick: () => setActiveId(collection.id),
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
                  h('div', { className: 'kb-empty-title' }, '左侧还没有知识库'),
                  h('div', { className: 'kb-empty-hint' }, '点左上角「+」新建一个，然后拖入文件。'),
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
                      dragging ? '松开即可导入' : busy ? '正在导入…' : '把文件拖到这里，或点击选择'),
                    h('div', { className: 'kb-drop-hint' },
                      '支持 PDF、Word、PPT、Excel、Markdown、TXT、HTML · 单文件 ≤ 50MB'),
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
                          h('div', { className: 'kb-empty-hint' }, '这个知识库里还没有文档，拖一份进来试试。'),
                        )
                      : h('div', { className: 'kb-docs kb-fade-in' },
                          documents.map((doc) => h('div', { key: doc.id, className: 'kb-doc' },
                            h('div', { className: 'kb-doc-name' },
                              h('div', { className: 'kb-doc-title' }, doc.title),
                              h('div', { className: 'kb-doc-sub' },
                                `${doc.ext.replace('.', '').toUpperCase()} · ${formatBytes(doc.size)} · ${doc.chunk_count} 块`
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
                              doc.status === 'ready' ? '已入库'
                                : doc.status === 'needs-ocr' ? '需 OCR'
                                : doc.status === 'failed' ? '失败'
                                : '处理中',
                            ),
                            h('div', { className: 'kb-doc-actions' },
                              h('button', {
                                className: 'kb-btn kb-btn-sm',
                                disabled: busy,
                                onClick: () => reindexDocument(doc.id),
                                title: '重新解析并切块',
                              }, '重建'),
                              h('button', {
                                className: 'kb-btn kb-btn-sm kb-btn-danger',
                                onClick: () => removeDocument(doc.id, doc.title),
                              }, '删除'),
                            ),
                          )),
                        ),
                  ),

                  /* 检索测试 */
                  h('section', { className: 'kb-section' },
                    h('div', { className: 'kb-section-head' },
                      h('h2', { className: 'kb-section-title' }, '检索测试'),
                      h('span', { className: 'kb-section-meta' }, '验证入库效果'),
                    ),
                    h('div', { className: 'kb-search-bar' },
                      h('input', {
                        className: 'kb-input',
                        placeholder: '输入关键词，试试能不能查到…',
                        value: query,
                        onChange: (e) => setQuery(e.target.value),
                        onKeyDown: (e) => { if (e.key === 'Enter') runSearch() },
                      }),
                      h('button', {
                        className: 'kb-btn kb-btn-primary',
                        disabled: searching || !query.trim(),
                        onClick: runSearch,
                      }, searching ? '检索中' : '检索'),
                    ),

                    hits !== null
                      ? hits.length === 0
                        ? h('div', { className: 'kb-notice', style: { marginTop: 10 } },
                            `没有找到包含「${query.trim()}」的内容`)
                        : h('div', { className: 'kb-hits' },
                            hits.map((hit) => h('div', { key: hit.id, className: 'kb-hit kb-fade-in' },
                              h('div', { className: 'kb-hit-head' },
                                h('span', { className: 'kb-hit-doc' }, hit.title),
                                hit.page ? h('span', { className: 'kb-hit-page' }, `第 ${hit.page} 页`) : null,
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
                                  }, expanded.has(hit.id) ? '收起' : '展开全文')
                                : null,
                            )),
                          )
                      : null,
                  ),
                ),
          ),
        ),
      )
    }

    /* ══════════════════════════ 注册 ══════════════════════════ */

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
            (props) => h(KnowledgeIcon, {
              size: typeof props?.size === 'number' ? props.size : 20,
              active: props?.active === true,
              fill: true,
            }),
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-knowbase' }, Panel),
        )
      },
    }
  },
})
