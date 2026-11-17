/**
 * dsh-knowbase — Host 半
 *
 * P0: 服务骨架、数据目录、状态接口
 * P1: 知识库增删查、文档导入、切块、全文检索
 *
 * 设计约束：
 *   - 不写 profile 配置文件
 *   - 所有资源注册通过 ctx.effect / ctx.on，卸载自动清理
 *   - 可选依赖用 ctx.get() 检查
 */

import { homedir } from 'node:os'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'

import { KnowledgeStore, titleFromFilename } from './lib/store.js'
import { extractDocument, isSupportedExtension, unsupportedReason } from './lib/extract.js'
import { chunkSections } from './lib/chunk.js'
import {
  createEmbedder,
  cosine,
  fromBlob,
  toBlob,
  normalize,
  fuseResults,
  modelIdOf,
  hashText,
} from './lib/embed.js'

const VERSION = '0.2.0'
const STAGE = 'P1'

/** 单文件大小上限：50MB */
const MAX_FILE_BYTES = 50 * 1024 * 1024

function defaultDataRoot() {
  const configured = process.env.DSH_KNOWBASE_DIR
  if (configured && configured.trim() !== '') return configured

  const dshHome = process.env.DSH_HOME
  if (dshHome && dshHome.trim() !== '') return join(dshHome, 'knowbase')

  return join(homedir(), '.dsh', 'knowbase')
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** 构造凭据记录键：<scope>/<id> */
function credentialKey(scope, id) {
  return `${scope}/${id}`
}

function fail(code, message, status = 400) {
  return json({ ok: false, error: { code, message } }, status)
}

class KnowledgeBase {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.dataRoot = config.dataRoot?.trim() || defaultDataRoot()
    this.store = new KnowledgeStore(this.dataRoot)
    this.ready = false
    this.readyError = null
    this.importing = new Map()
    this.apiKeyCache = ''
    this.embedderCache = null
  }

  async start() {
    try {
      await this.store.open()
      this.store.ensureDefaultCollection()
      // 预加载 API Key（凭据库或本地文件），失败不影响启动
      this.apiKeyCache = await this.loadApiKey()
      this.ready = true
    } catch (error) {
      this.ready = false
      this.readyError = error instanceof Error ? error.message : String(error)
    }
  }

  stop() {
    this.store.close()
  }

  status() {
    let counts = { collections: 0, documents: 0, chunks: 0 }
    if (this.ready) {
      try {
        counts = this.store.counts()
      } catch {
        // 统计失败不影响状态返回
      }
    }
    return {
      version: VERSION,
      stage: STAGE,
      ready: this.ready,
      readyError: this.readyError,
      dataRoot: this.dataRoot,
      counts,
      capabilities: {
        ingest: this.ready,
        search: this.ready,
        rerank: false,
        ocr: false,
        fetch: false,
      },
    }
  }

  /** 列出所有知识库 */
  listCollections() {
    return this.store.listCollections()
  }

  createCollection(name, description) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) throw new Error('知识库名称不能为空')
    if (trimmed.length > 60) throw new Error('知识库名称过长（最多 60 字）')
    return this.store.createCollection(trimmed, String(description ?? '').trim())
  }

  deleteCollection(id) {
    const collection = this.store.getCollection(id)
    if (!collection) throw new Error('知识库不存在')
    // 连带清理文件副本
    const docs = this.store.listDocuments(id)
    for (const doc of docs) {
      this.store.removeFile(doc.sha256, doc.ext).catch(() => {})
    }
    this.store.deleteCollection(id)
  }

  listDocuments(collectionId) {
    return this.store.listDocuments(collectionId)
  }

  listChunks(documentId) {
    return this.store.listChunks(documentId)
  }

  /**
   * 导入一个文件。
   * @param {{ name: string, buffer: Buffer, collectionId: number }} input
   */
  async importFile({ name, buffer, collectionId }) {
    if (!this.ready) throw new Error('知识库尚未就绪')

    const collection = this.store.getCollection(collectionId)
    if (!collection) throw new Error('目标知识库不存在')

    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(`文件过大（${Math.round(buffer.length / 1024 / 1024)}MB），上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`)
    }

    // 统一为不带点的小写扩展名（.DOCX → docx），避免后续比较出错
    const ext = extname(name).toLowerCase().replace(/^\./, '')
    if (!isSupportedExtension(ext)) throw new Error(unsupportedReason(ext))

    const sha256 = this.store.hashOf(buffer)
    const duplicate = this.store.findDocumentByHash(collectionId, sha256)
    if (duplicate) {
      return { duplicate: true, documentId: duplicate.id, title: duplicate.title, chunkCount: duplicate.chunk_count }
    }

    const docId = this.store.createDocument({
      collectionId,
      title: titleFromFilename(name),
      filename: name,
      ext,
      size: buffer.length,
      sha256,
    })

    try {
      const extracted = await extractDocument(buffer, ext)

      // 扫描件：存下来但标记需要 OCR
      if (extracted.scanned) {
        await this.store.saveFile(sha256, ext, buffer)
        this.store.updateDocumentStatus(docId, 'needs-ocr', {
          error: '该 PDF 没有文字层（扫描件），需要启用 OCR 才能抽取内容',
          pageCount: extracted.meta?.pages ?? null,
          chunkCount: 0,
        })
        return { documentId: docId, scanned: true, chunkCount: 0 }
      }

      const sections = extracted.sections.filter((s) => s.text && s.text.trim())
      if (sections.length === 0) throw new Error('文档中没有可提取的文字')

      const chunks = chunkSections(sections)
      if (chunks.length === 0) throw new Error('切块结果为空')

      await this.store.saveFile(sha256, ext, buffer)
      this.store.replaceChunks(docId, chunks)
      this.store.updateDocumentStatus(docId, 'ready', {
        pageCount: extracted.meta?.pages ?? null,
        chunkCount: chunks.length,
      })

      return { documentId: docId, chunkCount: chunks.length, pages: extracted.meta?.pages ?? null }
    } catch (error) {
      this.store.updateDocumentStatus(docId, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  deleteDocument(id) {
    const doc = this.store.getDocument(id)
    if (!doc) throw new Error('文档不存在')
    this.store.deleteDocument(id)
    this.store.removeFile(doc.sha256, doc.ext).catch(() => {})
  }

  /** 重新切块（不改原文件） */
  async reindexDocument(id) {
    const doc = this.store.getDocument(id)
    if (!doc) throw new Error('文档不存在')

    this.store.updateDocumentStatus(id, 'pending', { error: null })

    try {
      const buffer = await this.store.readFile(doc.sha256, doc.ext)
      const extracted = await extractDocument(buffer, doc.ext)

      if (extracted.scanned) {
        this.store.updateDocumentStatus(id, 'needs-ocr', { error: '扫描件需要 OCR' })
        return { chunkCount: 0 }
      }

      const sections = extracted.sections.filter((s) => s.text && s.text.trim())
      if (sections.length === 0) throw new Error('文档中没有可提取的文字')

      const chunks = chunkSections(sections)
      this.store.replaceChunks(id, chunks)
      this.store.updateDocumentStatus(id, 'ready', {
        pageCount: extracted.meta?.pages ?? null,
        chunkCount: chunks.length,
      })
      return { chunkCount: chunks.length }
    } catch (error) {
      this.store.updateDocumentStatus(id, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  search(query, options) {
    return this.store.search(query, options)
  }

  /* ────────────────────── 嵌入配置 ────────────────────── */

  /** 读取嵌入配置（存在 settings 表里） */
  getEmbedConfig() {
    return this.store.getSetting('embed', {
      provider: 'none',   // none | api | local
      api: { baseUrl: '', model: '', dimension: 0, batchSize: 16 },
      local: { modelDir: '' },
    })
  }

  /** API Key 存放位置：优先 DSH 凭据库，读不到则用插件配置文件（均不进 settings 明文） */
  async loadApiKey() {
    try {
      const credentials = this.ctx?.get?.('credentials')
      if (credentials?.readRecord) {
        const record = await credentials.readRecord(credentialKey('dsh-knowbase', 'embed-api'))
        const value = record?.value ?? record?.secret
        if (typeof value === 'string' && value !== '') return value
      }
    } catch {
      // 凭据服务不可用时回落到本地文件
    }
    try {
      const raw = await readFile(this.secretPath(), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed?.apiKey === 'string' ? parsed.apiKey : ''
    } catch {
      return ''
    }
  }

  async saveApiKey(apiKey) {
    const trimmed = String(apiKey ?? '').trim()
    // 先尝试 DSH 凭据库（不进任何配置文件）
    try {
      const credentials = this.ctx?.get?.('credentials')
      if (credentials?.modifyRecord) {
        await credentials.modifyRecord(credentialKey('dsh-knowbase', 'embed-api'), async () => (trimmed ? { value: trimmed } : undefined))
        this.apiKeyCache = trimmed
        return { stored: 'credentials' }
      }
    } catch {
      // 落到本地文件
    }
    if (trimmed === '') {
      await unlink(this.secretPath()).catch(() => {})
    } else {
      // 权限收紧：仅当前用户可读写
      await writeFile(this.secretPath(), JSON.stringify({ apiKey: trimmed }), { mode: 0o600 })
    }
    this.apiKeyCache = trimmed
    return { stored: 'file' }
  }

  secretPath() {
    return join(this.dataRoot, 'secrets.json')
  }

  hasApiKey() {
    return typeof this.apiKeyCache === 'string' && this.apiKeyCache !== ''
  }

  /** 保存嵌入配置。API Key 单独走凭据，不写进这里 */
  setEmbedConfig(patch) {
    const current = this.getEmbedConfig()
    const next = {
      ...current,
      ...patch,
      api: { ...current.api, ...(patch.api ?? {}) },
      local: { ...current.local, ...(patch.local ?? {}) },
    }
    this.store.setSetting('embed', next)
    this.embedderCache = null
    return next
  }

  /** 当前 embedder（含缓存），未配置返回 null */
  embedder() {
    const config = this.getEmbedConfig()
    if (config.provider === 'none') return null

    const apiKey = this.apiKeyCache ?? ''
    const cacheKey = `${config.provider}|${JSON.stringify(config.api)}|${apiKey}`

    if (this.embedderCache?.key === cacheKey) return this.embedderCache.embedder

    const embedder = createEmbedder({
      provider: config.provider,
      api: { ...config.api, apiKey: apiKey ?? '' },
      local: config.local,
    })
    this.embedderCache = { key: cacheKey, embedder }
    return embedder
  }

  /** 测试嵌入服务连通性 */
  async testEmbedder(patch) {
    if (patch) this.setEmbedConfig(patch)
    const embedder = this.embedder()
    if (!embedder) throw new Error('尚未选择嵌入方式')
    const result = await embedder.test()
    // 测试成功后把实际维度写回配置
    if (result.dimension) this.setEmbedConfig({ api: { dimension: result.dimension } })
    return { ...result, modelId: embedder.id }
  }

  /* ────────────────────── 向量索引 ────────────────────── */

  /** 当前模型下、某库的向量覆盖情况 */
  embedStatus(collectionId = null) {
    const embedder = this.embedder()
    if (!embedder) {
      return { configured: false, modelId: null, embedded: 0, total: this.store.countChunks(collectionId), complete: false }
    }
    const modelId = embedder.id
    const embedded = this.store.countEmbeddings(modelId, collectionId)
    const total = this.store.countChunks(collectionId)
    return {
      configured: true,
      modelId,
      label: embedder.label,
      embedded,
      total,
      complete: total > 0 && embedded >= total,
    }
  }

  /**
   * 为某库补齐向量。分批调用 API，边算边写库，可被中断。
   * @param {{ collectionId: number|null, onProgress?: (done:number,total:number)=>void, signal?: AbortSignal }} options
   */
  async embedCollection({ collectionId = null, onProgress, signal } = {}) {
    const embedder = this.embedder()
    if (!embedder) throw new Error('尚未配置嵌入模型，请先在设置里接入')

    const modelId = embedder.id
    let done = 0
    const total = this.store.countEmbeddings(modelId, collectionId) === 0
      ? this.store.countChunks(collectionId)
      : this.store.countChunks(collectionId)

    // 逐批处理，避免一次拉太多
    for (;;) {
      if (signal?.aborted) throw new Error('已取消')
      const pending = this.store.chunksNeedingEmbedding(modelId, collectionId, 64)
      if (pending.length === 0) break

      const texts = pending.map((row) => row.text)
      const vectors = await embedder.embed(texts)

      const rows = []
      for (let i = 0; i < pending.length; i++) {
        const vec = normalize(Float32Array.from(vectors[i]))
        rows.push({
          chunkId: pending[i].chunk_id,
          dimension: vec.length,
          vec: toBlob(vec),
          textHash: hashText(pending[i].text),
        })
      }
      this.store.saveEmbeddings(modelId, rows)

      done += pending.length
      onProgress?.(done, total)
    }

    return { modelId, embedded: this.store.countEmbeddings(modelId, collectionId), total }
  }

  /* ────────────────────── 混合检索 ────────────────────── */

  /**
   * 语义检索：向量相似度 + 关键词，融合排序。
   * @returns {Promise<{ hits: Array, mode: 'hybrid'|'keyword', note?: string }>}
   */
  async semanticSearch(query, { collectionId = null, limit = 10, useVector = true } = {}) {
    const keywordHits = this.store.search(query, { collectionId, limit: limit * 3 })

    if (!useVector) return { hits: keywordHits.slice(0, limit), mode: 'keyword' }

    const embedder = this.embedder()
    if (!embedder) {
      return {
        hits: keywordHits.slice(0, limit),
        mode: 'keyword',
        note: '未配置嵌入模型，当前仅用关键词检索',
      }
    }

    const status = this.embedStatus(collectionId)
    if (status.embedded === 0) {
      return {
        hits: keywordHits.slice(0, limit),
        mode: 'keyword',
        note: '该库还没有向量索引，仅用关键词检索。可在设置里点「建立向量索引」',
      }
    }

    // 查询向量
    let queryVector
    try {
      const [vec] = await embedder.embed([query])
      queryVector = normalize(Float32Array.from(vec))
    } catch (error) {
      return {
        hits: keywordHits.slice(0, limit),
        mode: 'keyword',
        note: `生成查询向量失败（${error instanceof Error ? error.message : String(error)}），回退到关键词检索`,
      }
    }

    // 全量打分（10 万块以内暴力扫描够用）
    const rows = this.store.listVectors(collectionId, status.modelId)
    const scored = []
    for (const row of rows) {
      const vec = fromBlob(row.vec)
      const score = cosine(queryVector, vec)
      scored.push({
        id: row.chunk_id,
        text: row.text,
        page: row.page,
        heading: row.heading,
        document_id: row.document_id,
        title: row.title,
        collection_id: row.collection_id,
        similarity: score,
      })
    }

    scored.sort((a, b) => b.similarity - a.similarity)
    const vectorHits = scored.slice(0, limit * 3)

    const hits = fuseResults(keywordHits, vectorHits, { limit })
    return { hits, mode: 'hybrid', note: status.complete ? undefined : '部分文档尚未建立向量索引' }
  }
}

export function apply(ctx, config) {
  const kb = new KnowledgeBase(ctx, config ?? {})

  ctx.effect(() => {
    kb.start()
    return () => kb.stop()
  }, 'dsh-knowbase: lifecycle')

  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    if (connection?.fetch?.register === undefined) return

    const disposers = []

    /** 注册一条路由 */
    const route = (path, handler) => {
      disposers.push(
        connection.fetch.register({
          path,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {}
              return await handler(body ?? {})
            } catch (error) {
              return fail('dsh-knowbase/internal', error instanceof Error ? error.message : String(error), 500)
            }
          },
        }),
      )
    }

    route('/api/dsh-knowbase/status', () => json({ ok: true, value: kb.status() }))

    route('/api/dsh-knowbase/collections', (body) => {
      if (body.action === 'create') {
        const created = kb.createCollection(body.name, body.description)
        return json({ ok: true, value: created })
      }
      if (body.action === 'delete') {
        kb.deleteCollection(Number(body.id))
        return json({ ok: true, value: { deleted: true } })
      }
      return json({ ok: true, value: kb.listCollections() })
    })

    route('/api/dsh-knowbase/documents', (body) => {
      if (body.action === 'list') {
        return json({ ok: true, value: kb.listDocuments(Number(body.collectionId)) })
      }
      if (body.action === 'delete') {
        kb.deleteDocument(Number(body.id))
        return json({ ok: true, value: { deleted: true } })
      }
      if (body.action === 'chunks') {
        return json({ ok: true, value: kb.listChunks(Number(body.id)) })
      }
      if (body.action === 'reindex') {
        const result = kb.reindexDocument(Number(body.id))
        return result.then((value) => json({ ok: true, value }))
      }
      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    route('/api/dsh-knowbase/search', async (body) => {
      const query = String(body.query ?? '').trim()
      if (!query) return fail('dsh-knowbase/empty-query', '查询内容不能为空')

      const result = await kb.semanticSearch(query, {
        collectionId: body.collectionId ? Number(body.collectionId) : null,
        limit: Math.min(Number(body.limit ?? 10), 50),
        useVector: body.useVector !== false,
      })
      return json({ ok: true, value: result })
    })

    /* ── 嵌入设置 ── */
    route('/api/dsh-knowbase/embed', async (body) => {
      if (body.action === 'get') {
        const config = kb.getEmbedConfig()
        // 只回传是否已配置 Key，绝不回传明文
        return json({
          ok: true,
          value: {
            ...config,
            api: { ...config.api, hasKey: kb.hasApiKey() },
            status: kb.embedStatus(body.collectionId ? Number(body.collectionId) : null),
          },
        })
      }
      if (body.action === 'set') {
        const saved = kb.setEmbedConfig(body.config ?? {})
        // API Key 单独存放，绝不写进 settings
        if (typeof body.apiKey === 'string') await kb.saveApiKey(body.apiKey)
        return json({ ok: true, value: { ...saved, api: { ...saved.api, hasKey: kb.hasApiKey() } } })
      }
      if (body.action === 'test') {
        const result = await kb.testEmbedder(body.config)
        return json({ ok: true, value: result })
      }
      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    /* ── 建立向量索引 ── */
    route('/api/dsh-knowbase/embed/build', async (body) => {
      const collectionId = body.collectionId ? Number(body.collectionId) : null
      const result = await kb.embedCollection({ collectionId })
      return json({ ok: true, value: result })
    })

    route('/api/dsh-knowbase/embed/status', (body) =>
      json({ ok: true, value: kb.embedStatus(body.collectionId ? Number(body.collectionId) : null) }))

    /* ── 删除向量索引 ── */
    route('/api/dsh-knowbase/embed/clear', (body) => {
      const embedder = kb.embedder()
      if (!embedder) return fail('dsh-knowbase/no-embedder', '尚未配置嵌入模型')
      kb.store.clearEmbeddings(embedder.id, body.collectionId ? Number(body.collectionId) : null)
      return json({ ok: true, value: { cleared: true } })
    })

    // 上传：base64 传输（P1 用简单方式，P2 视需要换流式）
    route('/api/dsh-knowbase/upload', async (body) => {
      const { files, collectionId } = body
      if (!Array.isArray(files) || files.length === 0) return fail('dsh-knowbase/no-file', '没有收到文件')

      const results = []
      for (const file of files) {
        const name = String(file?.name ?? '未命名')
        try {
          const buffer = Buffer.from(String(file?.data ?? ''), 'base64')
          if (buffer.length === 0) throw new Error('文件内容为空')
          const outcome = await kb.importFile({
            name,
            buffer,
            collectionId: Number(collectionId),
          })
          results.push({ name, ok: true, ...outcome })
        } catch (error) {
          results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return json({ ok: true, value: results })
    })

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 卸载时忽略个别路由的清理失败
        }
      }
    }
  })
}

export { KnowledgeBase, VERSION, STAGE, defaultDataRoot, MAX_FILE_BYTES }
