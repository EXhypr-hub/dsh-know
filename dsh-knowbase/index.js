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
import { join, extname, dirname, basename, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink, stat, readdir, rm, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

import { KnowledgeStore, titleFromFilename } from './lib/store.js'
import { extractDocument, isSupportedExtension, unsupportedReason } from './lib/extract.js'
import { chunkSections } from './lib/chunk.js'
import { applyRerank } from './lib/rerank.js'
import { registerTools } from './lib/tools.js'
import { buildSkill } from './lib/skill.js'
import { sha256Of } from './lib/models.js'
import { isPrivateHost, checkRobots, waitForSlot } from './lib/fetch-policy.js'
import { sourceForHost, sourcesByTopic } from './lib/sources.js'
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

const VERSION = '0.4.0'
const STAGE = 'P5'

/** 单文件大小上限：50MB */
const MAX_FILE_BYTES = 50 * 1024 * 1024
/** 单次批量导入的文件数上限（计划书 5.3-4） */
const MAX_INGEST_FILES = 200

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

/** 递归收集目录下的可导入文件 */
async function collectFiles(dir, depth = 0) {
  if (depth > 8) return []
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full, depth + 1)))
    } else if (entry.isFile() && isSupportedExtension(extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

/** 递归复制目录，跳过另一个目录内部的路径 */
async function copyDir(from, to, onProgress) {
  let copied = 0
  const walk = async (src, dst) => {
    await mkdir(dst, { recursive: true })
    let entries
    try {
      entries = await readdir(src, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const s = join(src, entry.name)
      const d = join(dst, entry.name)
      if (entry.isDirectory()) {
        await walk(s, d)
      } else if (entry.isFile()) {
        await copyFile(s, d)
        copied++
        if (copied % 20 === 0) onProgress?.({ done: copied })
      }
    }
  }
  await walk(from, to)
  onProgress?.({ done: copied })
  return copied
}

/**
 * 校验复制是否完整：逐文件比对大小与哈希。
 * 只校验目标目录里存在的文件，源目录多出来的会单独报告。
 */
async function verifyCopy(from, to) {
  const mismatch = []
  let checked = 0

  const walk = async (src, dst) => {
    let entries
    try {
      entries = await readdir(src, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const s = join(src, entry.name)
      const d = join(dst, entry.name)
      if (entry.isDirectory()) {
        await walk(s, d)
        continue
      }
      if (!entry.isFile()) continue

      // WAL/SHM 是运行期临时文件，迁移后重新生成，不参与校验
      if (/-wal$|-shm$/.test(entry.name)) continue

      try {
        const [srcInfo, dstInfo] = await Promise.all([stat(s), stat(d)])
        if (srcInfo.size !== dstInfo.size) {
          mismatch.push(`${entry.name}（大小 ${srcInfo.size} ≠ ${dstInfo.size}）`)
          continue
        }
        const [a, b] = await Promise.all([readFile(s), readFile(d)])
        if (await sha256Of(a) !== await sha256Of(b)) {
          mismatch.push(`${entry.name}（哈希不同）`)
          continue
        }
        checked++
      } catch (error) {
        mismatch.push(`${entry.name}（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
  }

  await walk(from, to)
  return { ok: mismatch.length === 0, checked, mismatch }
}

/** 本地推理依赖是否可用（只探测，不加载） */async function localLibraryAvailable() {
  try {
    await import('@huggingface/transformers')
    return true
  } catch {
    return false
  }
}

/** 插件自身的目录（用于在其下执行 npm install / 查找 node_modules） */
function packageDir() {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * 找一个可用的 npm 可执行文件。
 *
 * 本机实测：在 MSYS bash 里直接敲 `npm` 会 exit 126，必须用完整路径。
 * DSH 的 Host 进程里 process.execPath 可能指向 Electron 而不是 node，
 * 所以优先扫描 PATH，而不是只看 node 同目录。
 */
function findNpm() {
  const isWin = process.platform === 'win32'
  const names = isWin ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm']
  const sep = isWin ? ';' : ':'

  const dirs = String(process.env.PATH ?? '')
    .split(sep)
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)

  for (const dir of dirs) {
    for (const name of names) {
      try {
        const candidate = join(dir, name)
        if (existsSync(candidate)) return candidate
      } catch {
        // 忽略非法路径项，继续找
      }
    }
  }

  // 最后兜底：交给 shell 解析 PATH
  return isWin ? 'npm.cmd' : 'npm'
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
    /** 可中断的长任务：id → { controller, state, done, total } */
    this.tasks = new Map()
    this.apiKeyCache = ''
    this.embedderCache = null
    this.rerankerCache = null
    this.downloadProgress = null
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

  /**
   * 批量导入文件或目录（供 kb_ingest 工具使用）。
   * @param {{ paths: string[], collectionId: number, sessionId?: string|null, cwd?: string }} input
   */
  async ingestPaths({ paths, collectionId, cwd, signal, task }) {
    const baseDir = cwd || this.lastCwd || process.cwd()
    const results = []

    // 先展开成文件清单，好在开始前就判断数量是否超限
    const planned = []
    for (const raw of paths) {
      const target = isAbsolute(raw) ? raw : resolve(baseDir, raw)
      try {
        const info = await stat(target)
        if (info.isDirectory()) {
          for (const file of await collectFiles(target)) planned.push(file)
        } else if (info.isFile()) {
          planned.push(target)
        } else {
          results.push({ path: target, ok: false, error: '既不是文件也不是目录' })
        }
      } catch (error) {
        results.push({
          path: target,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // 单次任务上限：超过就停下来问，而不是闷头跑到底
    if (planned.length > MAX_INGEST_FILES) {
      throw new Error(
        `一次最多导入 ${MAX_INGEST_FILES} 个文件，这次选了 ${planned.length} 个。`
        + '请分批导入，或只选中一个较小的目录。',
      )
    }

    this.touchTask(task, { total: planned.length })

    let done = 0
    for (const file of planned) {
      this.throwIfAborted(signal, '导入')
      const outcome = await this.#ingestOne(file, collectionId)
      results.push(outcome)
      done++
      this.touchTask(task, { done })
    }

    return results
  }

  /** 内部：导入单个文件路径 */
  async #ingestOne(filePath, collectionId) {
    try {
      const info = await stat(filePath)
      if (info.size > MAX_FILE_BYTES) {
        return {
          path: filePath,
          ok: false,
          error: `文件过大（${Math.round(info.size / 1024 / 1024)}MB）`,
        }
      }
      const buffer = await readFile(filePath)
      const outcome = await this.importFile({
        name: basename(filePath),
        buffer,
        collectionId,
      })
      return {
        path: filePath,
        ok: true,
        documentId: outcome.documentId,
        chunkCount: outcome.chunkCount ?? 0,
        duplicate: outcome.duplicate === true,
        scanned: outcome.scanned === true,
      }
    } catch (error) {
      return {
        path: filePath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 抓取一个网址并存库（供 kb_source_fetch 工具使用）。
   *
   * 安全约束（计划书 5.3）：
   *   - 只允许 http/https
   *   - 拒绝内网地址，防止被诱导探测局域网
   *   - 体积上限
   *   - 记录来源 URL 与抓取时间
   */
  async fetchSource({ url, collectionId, title, signal }) {
    // 1. 总开关：关着就完全不联网
    const policy = this.getFetchConfig()
    if (!policy.enabled) {
      throw new Error('联网抓取未开启。请在「抓取设置」里打开开关，或让用户手动把文件拖进来。')
    }

    this.throwIfAborted(signal, '抓取')

    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('网址格式不正确')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('只支持 http/https 网址')
    }

    // 2. 内网地址一律拒绝，防止被诱导探测局域网
    if (isPrivateHost(parsed.hostname)) {
      throw new Error(`拒绝访问内网地址：${parsed.hostname}`)
    }

    // 3. 可选白名单：只有用户明确填了才生效
    if (policy.whitelist.length > 0) {
      const host = parsed.hostname.toLowerCase()
      const hit = policy.whitelist.some((w) => host === w || host.endsWith(`.${w}`))
      if (!hit) {
        throw new Error(`该站点不在白名单内（${host}）。可在「抓取设置」里添加或清空白名单。`)
      }
    }

    // 4. 遵守 robots.txt
    const robots = await checkRobots(parsed.href)
    if (!robots.allowed) {
      throw new Error(`被站点规则拒绝：${robots.reason ?? 'robots.txt 不允许'}`)
    }

    // 5. 同站点限速，别把人网站打垮
    await waitForSlot(parsed.hostname)

    // 6. 已知权威来源：带上许可提示，便于回答时如实告知
    const known = sourceForHost(parsed.hostname)

    let response
    try {
      // 用户取消与 30 秒超时任一触发都会中断请求
      const timeout = AbortSignal.timeout(30000)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      response = await fetch(parsed.href, {
        redirect: 'follow',
        signal: combined,
        headers: {
          'user-agent': 'dsh-knowbase/0.4 (+local knowledge base)',
          accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5',
        },
      })
    } catch (error) {
      if (signal?.aborted) {
        const aborted = new Error('抓取已取消')
        aborted.code = 'ABORTED'
        throw aborted
      }
      throw new Error(`抓取失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? '（可能需要登录，插件不会绕过）'
        : response.status === 404 ? '（页面不存在）' : ''
      throw new Error(`抓取失败：HTTP ${response.status}${hint}`)
    }

    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_FILE_BYTES) {
      throw new Error(`文件过大（${Math.round(declared / 1024 / 1024)}MB），上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) throw new Error('抓到的内容为空')
    if (buffer.length > MAX_FILE_BYTES) throw new Error('内容超过体积上限')

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
    const name = this.#nameForFetched(parsed, contentType, title)

    const outcome = await this.importFile({
      name,
      buffer,
      collectionId,
    })

    // 来源留痕：抓来的文档必须能追溯，并带上站点声明的许可
    if (outcome.documentId) {
      this.store.setDocumentSource(outcome.documentId, {
        sourceUrl: parsed.href,
        license: known?.license ?? null,
        fetchedAt: Date.now(),
      })
    }

    return {
      documentId: outcome.documentId,
      title: title || name,
      url: parsed.href,
      contentType: contentType || 'unknown',
      bytes: buffer.length,
      chunkCount: outcome.chunkCount ?? 0,
      duplicate: outcome.duplicate === true,
      scanned: outcome.scanned === true,
      // 引用这些资料时需要如实说明的限制
      source: known
        ? { name: known.name, license: known.license, verified: known.verified }
        : { name: parsed.hostname, license: '未知许可——请用户自行确认能否使用', verified: null },
    }
  }

  /** 根据 content-type 与网址推断一个带扩展名的文件名 */
  #nameForFetched(parsed, contentType, title) {
    const fromUrl = basename(parsed.pathname || '')
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(fromUrl)

    let ext = 'html'
    if (contentType.includes('pdf')) ext = 'pdf'
    else if (contentType.includes('wordprocessingml')) ext = 'docx'
    else if (contentType.includes('spreadsheetml')) ext = 'xlsx'
    else if (contentType.includes('presentationml')) ext = 'pptx'
    else if (contentType.includes('markdown')) ext = 'md'
    else if (contentType.includes('text/plain')) ext = 'txt'
    else if (hasExt) ext = fromUrl.split('.').pop().toLowerCase()

    const stem = (title || fromUrl || parsed.hostname || 'page')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .slice(0, 120) || 'page'

    return `${stem}.${ext}`
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

  /** 确保存在至少一个库，返回第一个 */
  ensureDefaultCollection() {
    return this.store.ensureDefaultCollection()
  }

  /**
   * 按名称或 id 找知识库。
   * 工具调用里模型可能给名字、也可能给数字 id，这里都接受。
   */
  resolveCollection(nameOrId) {
    const raw = nameOrId === null || nameOrId === undefined ? '' : String(nameOrId).trim()
    if (raw === '') return null

    const list = this.store.listCollections()

    // 纯数字按 id 匹配
    if (/^\d+$/.test(raw)) {
      const byId = list.find((c) => c.id === Number(raw))
      if (byId) return byId
    }

    // 精确名 → 忽略大小写 → 包含
    return list.find((c) => c.name === raw)
      ?? list.find((c) => c.name.toLowerCase() === raw.toLowerCase())
      ?? list.find((c) => c.name.includes(raw) || raw.includes(c.name))
      ?? null
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
  /** 嵌入配置默认值（新增字段时旧配置也能补齐） */
  static get EMBED_DEFAULTS() {
    return {
      provider: 'none',   // none | api | local
      api: { baseUrl: '', model: '', dimension: 0, batchSize: 16, timeoutMs: 30000, retries: 2 },
      local: {
        modelId: '',
        modelDir: '',
        mirror: 'hf-mirror',
        dimension: 0,
        dtype: 'q8',      // q8 / q4 / fp16 / fp32
        threads: 0,       // 0 = 交给运行时决定
      },
      /** 首次引导是否已完成 */
      onboarded: false,
    }
  }

  getEmbedConfig() {
    const stored = this.store.getSetting('embed', null)
    const defaults = KnowledgeBase.EMBED_DEFAULTS
    if (!stored) return defaults

    // 深度合并：老版本存的配置缺少 local.modelId 等新字段时补上默认值
    return {
      ...defaults,
      ...stored,
      api: { ...defaults.api, ...(stored.api ?? {}) },
      local: { ...defaults.local, ...(stored.local ?? {}) },
    }
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

  /**
   * 当前 embedder（含缓存）。异步是因为本地实现要动态 import。
   * 未配置返回 null。
   */
  async embedder() {
    const config = this.getEmbedConfig()
    if (config.provider === 'none') return null

    const apiKey = this.apiKeyCache ?? ''
    const cacheKey = `${config.provider}|${JSON.stringify(config.api)}|${JSON.stringify(config.local)}|${apiKey}`

    if (this.embedderCache?.key === cacheKey) return this.embedderCache.embedder

    const embedder = await createEmbedder({
      provider: config.provider,
      api: { ...config.api, apiKey: apiKey ?? '' },
      local: {
        ...config.local,
        modelsDir: join(this.dataRoot, 'models'),
      },
    })
    this.embedderCache = { key: cacheKey, embedder }
    return embedder
  }

  /** 同步读取已缓存的 embedder（不创建），用于同步方法 */
  cachedEmbedder() {
    return this.embedderCache?.embedder ?? null
  }

  /** 测试嵌入服务连通性 */
  async testEmbedder(patch) {
    if (patch) this.setEmbedConfig(patch)
    const embedder = await this.embedder()
    if (!embedder) throw new Error('尚未选择嵌入方式')
    const result = await embedder.test()
    // 测试成功后把实际维度写回配置（本地与 API 都要记）
    if (result.dimension) {
      const provider = this.getEmbedConfig().provider
      if (provider === 'local') this.setEmbedConfig({ local: { dimension: result.dimension } })
      else this.setEmbedConfig({ api: { dimension: result.dimension } })
    }
    return { ...result, modelId: embedder.id }
  }

  /** 当前重排器（含缓存），未配置返回 null */
  async reranker() {
    const config = this.getRerankConfig()
    if (config.provider === 'none') return null

    const apiKey = this.apiKeyCache ?? ''
    const cacheKey = `rr|${JSON.stringify(config)}|${apiKey}`

    if (this.rerankerCache?.key === cacheKey) return this.rerankerCache.reranker

    const { createReranker } = await import('./lib/rerank.js')
    const reranker = await createReranker(
      { ...config, api: { ...config.api, apiKey } },
      { modelsDir: join(this.dataRoot, 'models') },
    )
    this.rerankerCache = { key: cacheKey, reranker }
    return reranker
  }

  /** 读取重排配置 */
  getRerankConfig() {
    const stored = this.store.getSetting('rerank', null)
    const defaults = {
      provider: 'none',      // none | api | local
      api: { baseUrl: '', model: '', topN: 8, timeoutMs: 20000, style: 'openai' },
      local: { modelKey: 'bge-reranker-v2-m3', modelId: '', mirror: 'hf-mirror', topN: 8 },
    }
    if (!stored) return defaults
    return {
      ...defaults,
      ...stored,
      api: { ...defaults.api, ...(stored.api ?? {}) },
      local: { ...defaults.local, ...(stored.local ?? {}) },
    }
  }

  /** 保存重排配置 */
  setRerankConfig(patch) {
    const current = this.getRerankConfig()
    const next = {
      ...current,
      ...patch,
      api: { ...current.api, ...(patch.api ?? {}) },
      local: { ...current.local, ...(patch.local ?? {}) },
    }
    this.store.setSetting('rerank', next)
    this.rerankerCache = null
    return next
  }

  /** 测试重排服务 */
  async testReranker(patch) {
    if (patch) this.setRerankConfig(patch)
    const reranker = await this.reranker()
    if (!reranker) throw new Error('尚未配置重排方式')
    return reranker.test()
  }

  /* ────────────────────── 导出 ────────────────────── */

  /**
   * 导出引用清单（Markdown）。
   * 用途：交作业、写综述、备份"我有哪些资料"。
   */
  async exportCitations(collectionId = null) {
    const collections = collectionId
      ? [this.store.getCollection(collectionId)].filter(Boolean)
      : this.store.listCollections()

    if (collections.length === 0) throw new Error('没有可导出的知识库')

    const lines = [
      '# 知识库引用清单',
      '',
      `导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
    ]

    let total = 0
    for (const collection of collections) {
      const docs = this.store.listDocuments(collection.id)
      lines.push(`## ${collection.name}`, '')
      if (docs.length === 0) {
        lines.push('_（空）_', '')
        continue
      }
      lines.push('| 文档 | 类型 | 页数 | 块数 | 来源 | 许可 |')
      lines.push('|---|---|---|---|---|---|')
      for (const doc of docs) {
        total++
        const kind = String(doc.ext ?? '').replace(/^\./, '').toUpperCase()
        const pages = doc.page_count ?? '—'
        const source = doc.source_url ? `[链接](${doc.source_url})` : '本地文件'
        const license = doc.license ? doc.license.replace(/\|/g, '\\|') : '未标注'
        const title = String(doc.title).replace(/\|/g, '\\|')
        lines.push(`| ${title} | ${kind} | ${pages} | ${doc.chunk_count} | ${source} | ${license} |`)
      }
      lines.push('')
    }

    lines.push('---', '', `共 ${total} 份文档。`, '')

    const dir = join(this.dataRoot, 'exports')
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = join(dir, `引用清单-${stamp}.md`)
    await writeFile(file, lines.join('\n'), 'utf8')

    return { path: file, count: total, collections: collections.length }
  }

  /* ────────────────────── 数据目录 ────────────────────── */

  /** 当前配置的数据目录（设置优先于构造参数） */
  getDataRoot() {
    const stored = this.store.getSetting('dataRoot', null)
    return typeof stored === 'string' && stored.trim() !== '' ? stored.trim() : this.dataRoot
  }

  /**
   * 改数据目录。
   *
   * 只写设置，不立刻搬——搬数据是重活，得用户明确点「立即迁移」。
   * 改完提示重启生效，避免运行中两套路径打架。
   */
  setDataRoot(next) {
    const target = String(next ?? '').trim()
    if (target === '') throw new Error('路径不能为空')
    if (target === this.dataRoot) {
      this.store.setSetting('dataRoot', '')
      return { dataRoot: this.dataRoot, changed: false, restart: false }
    }
    this.store.setSetting('dataRoot', target)
    return { dataRoot: target, changed: true, restart: true }
  }

  /**
   * 迁移数据到新目录。
   *
   * 顺序刻意如此：先复制 → 再校验 → 校验通过才提示可以删旧的。
   * 任何一步失败都不动原数据，宁可多占一份空间也不能丢。
   */
  async migrateDataRoot(next, { dryRun = false } = {}) {
    const target = String(next ?? '').trim()
    if (target === '') throw new Error('路径不能为空')
    if (target === this.dataRoot) throw new Error('新目录与当前目录相同')

    const task = this.createTask(`迁移数据到 ${target}`, 3)
    try {
      this.store.setSetting('dataRoot', target)
      if (dryRun) {
        this.settleTask(task, 'done')
        return { ok: true, dryRun: true, target, note: '仅记录路径，重启后在新目录建库' }
      }

      // 1. 关库，保证 sqlite 处于一致状态
      this.store.close()
      this.touchTask(task, { done: 1 })

      // 2. 复制整个数据目录
      await mkdir(target, { recursive: true })
      await copyDir(this.dataRoot, target, async (done) => this.touchTask(task, { done: done.done }))
      this.touchTask(task, { done: 2 })

      // 3. 校验：逐文件比对大小与哈希
      const report = await verifyCopy(this.dataRoot, target)
      this.touchTask(task, { done: 3 })

      if (!report.ok) {
        // 校验失败：把路径改回去，让插件继续用老目录
        this.store.setSetting('dataRoot', '')
        this.settleTask(task, 'failed', `校验失败：${report.mismatch.slice(0, 3).join('; ')}`)
        throw new Error(
          `复制后校验不一致，已取消迁移并切回原目录。不一致的文件：${report.mismatch.slice(0, 3).join('、')}`,
        )
      }

      this.settleTask(task, 'done')
      return {
        ok: true,
        target,
        copied: report.checked,
        note: '校验通过。确认新目录可用后，可手动删除旧目录以释放空间。',
      }
    } catch (error) {
      if (task.state === 'running') this.settleTask(task, 'failed', error)
      throw error
    } finally {
      // 无论成败都把库重新打开，插件不能处于无库状态
      try {
        this.store = new KnowledgeStore(this.dataRoot)
        await this.store.open()
      } catch {
        // 重开失败留给下次启动兜底
      }
    }
  }

  /* ────────────────────── 长任务 ────────────────────── */

  /**
   * 建一个可中断的任务。
   * 抓取和批量导入都走这里，这样界面能显示进度、也能一键取消。
   */
  createTask(label, total = 0) {
    const id = randomUUID()
    const task = {
      id,
      label,
      controller: new AbortController(),
      state: 'running',
      startedAt: Date.now(),
      settledAt: null,
      done: 0,
      total,
      error: null,
    }
    this.tasks.set(id, task)
    // 只保留最近 30 条，避免长期运行后无限增长
    if (this.tasks.size > 30) {
      const oldest = [...this.tasks.values()]
        .filter((t) => t.state !== 'running')
        .sort((a, b) => a.startedAt - b.startedAt)[0]
      if (oldest) this.tasks.delete(oldest.id)
    }
    return task
  }

  /** 更新任务进度 */
  touchTask(task, patch) {
    if (!task) return
    Object.assign(task, patch)
  }

  /** 结束任务 */
  settleTask(task, state, error = null) {
    if (!task) return
    task.state = state
    task.settledAt = Date.now()
    task.error = error ? String(error) : null
  }

  /** 取消一个任务 */
  cancelTask(id) {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`找不到任务「${id}」`)
    if (task.state !== 'running') {
      return { id, state: task.state, note: '任务已结束，无需取消' }
    }
    task.controller.abort()
    task.state = 'cancelled'
    task.settledAt = Date.now()
    return { id, state: 'cancelled' }
  }

  /** 列出任务（去掉不可序列化的 controller） */
  listTasks() {
    return [...this.tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ controller, ...rest }) => rest)
  }

  /** 若已取消则抛出 */
  throwIfAborted(signal, what) {
    if (signal?.aborted) {
      const error = new Error(`${what}已取消`)
      error.code = 'ABORTED'
      throw error
    }
  }

  /* ────────────────────── 存储统计 ────────────────────── */

  /**
   * 统计磁盘占用。
   * 分别算索引、原文件副本、本地模型三块，界面用它判断空间够不够。
   */
  async usage() {
    const dirSize = async (dir) => {
      let total = 0
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return 0
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        try {
          if (entry.isDirectory()) total += await dirSize(full)
          else if (entry.isFile()) total += (await stat(full)).size
        } catch {
          // 单个文件读不到就跳过，不因为一个坏文件让统计失败
        }
      }
      return total
    }

    const [files, models] = await Promise.all([
      dirSize(this.store.filesDir),
      dirSize(join(this.dataRoot, 'models')),
    ])

    let index = 0
    for (const name of ['kb.sqlite', 'kb.sqlite-wal', 'kb.sqlite-shm']) {
      try {
        index += (await stat(join(this.dataRoot, name))).size
      } catch {
        // 文件不存在就跳过
      }
    }

    const counts = this.store.counts()
    return {
      dataRoot: this.dataRoot,
      bytes: { index, files, models, total: index + files + models },
      // 每份文档的平均占用，帮助用户估算还能放多少
      perDocument: counts.documents > 0
        ? Math.round((index + files) / counts.documents)
        : null,
      counts,
    }
  }

  /* ────────────────────── 全局清理 ────────────────────── */

  /** 删除整个知识库（索引 + 文件副本），可选是否连本地模型一起删 */
  async wipe({ keepModels = true, confirm = '' } = {}) {
    // 二次确认：必须原样输入指定短语，防止误触
    if (confirm !== '删除全部') {
      throw new Error('需要二次确认：请原样输入「删除全部」')
    }
    this.store.close()

    for (const name of ['kb.sqlite', 'kb.sqlite-wal', 'kb.sqlite-shm']) {
      try {
        await unlink(join(this.dataRoot, name))
      } catch {
        // 不存在就跳过
      }
    }

    try {
      await rm(this.store.filesDir, { recursive: true, force: true })
    } catch {
      // 目录可能已不存在
    }

    if (!keepModels) {
      try {
        await rm(join(this.dataRoot, 'models'), { recursive: true, force: true })
      } catch {
        // 同上
      }
    }

    // 重新建一个空库，让插件继续可用
    this.store = new KnowledgeStore(this.dataRoot)
    await this.store.open()
    this.store.ensureDefaultCollection()

    return { ok: true, keptModels: keepModels }
  }

  /** 读取抓取配置 */
  getFetchConfig() {
    const stored = this.store.getSetting('fetch', null)
    const defaults = {
      enabled: false,          // 默认关闭：关着完全不联网
      whitelist: [],           // 可选；空数组表示不限制
      minIntervalMs: 2000,
      maxBytes: 100 * 1024 * 1024,
    }
    if (!stored) return defaults
    return {
      ...defaults,
      ...stored,
      whitelist: Array.isArray(stored.whitelist)
        ? stored.whitelist.map((w) => String(w).trim().toLowerCase()).filter(Boolean)
        : [],
    }
  }

  /** 保存抓取配置 */
  setFetchConfig(patch) {
    const current = this.getFetchConfig()
    const next = {
      ...current,
      ...patch,
      whitelist: patch?.whitelist !== undefined
        ? (Array.isArray(patch.whitelist)
          ? patch.whitelist.map((w) => String(w).trim().toLowerCase()).filter(Boolean)
          : [])
        : current.whitelist,
    }
    this.store.setSetting('fetch', next)
    return next
  }

  /** 权威来源清单（按主题分组） */
  listSources() {
    return sourcesByTopic()
  }

  /* ────────────────────── 向量索引 ────────────────────── */

  /** 当前模型下、某库的向量覆盖情况 */
  /**
   * 当前模型下、某库的向量覆盖情况。
   *
   * modelId 直接从配置推算，不依赖 embedder 实例是否已创建——
   * 否则刚启动（实例还没建）会把已有的索引误报成"未配置"。
   */
  embedStatus(collectionId = null) {
    const config = this.getEmbedConfig()
    if (config.provider === 'none') {
      return {
        configured: false,
        modelId: null,
        embedded: 0,
        total: this.store.countChunks(collectionId),
        complete: false,
      }
    }

    const modelId = this.expectedModelId()
    const embedded = this.store.countEmbeddings(modelId, collectionId)
    const total = this.store.countChunks(collectionId)
    return {
      configured: true,
      provider: config.provider,
      modelId,
      label: this.modelLabel(),
      embedded,
      total,
      complete: total > 0 && embedded >= total,
    }
  }

  /** 依据配置推算当前模型标识（不创建实例） */
  expectedModelId() {
    const config = this.getEmbedConfig()
    if (config.provider === 'api') {
      return modelIdOf('api', config.api.model ?? '', config.api.dimension ?? 0)
    }
    if (config.provider === 'local') {
      const ref = config.local.modelDir || config.local.modelId || 'none'
      return `local:${ref}:${config.local.dimension ?? 0}`
    }
    return 'none'
  }

  /** 当前模型的可读名称 */
  modelLabel() {
    const config = this.getEmbedConfig()
    if (config.provider === 'api') return `${config.api.model || '未命名'}（API）`
    if (config.provider === 'local') {
      const ref = config.local.modelDir || config.local.modelId || '未选择'
      return `${ref}（本地）`
    }
    return '未配置'
  }

  /**
   * 为某库补齐向量。分批调用 API，边算边写库，可被中断。
   * @param {{ collectionId: number|null, onProgress?: (done:number,total:number)=>void, signal?: AbortSignal }} options
   */
  async embedCollection({ collectionId = null, onProgress, signal } = {}) {
    const embedder = await this.embedder()
    if (!embedder) throw new Error('尚未配置嵌入模型，请先在设置里接入')

    /*
     * 关键：先把维度确定下来，再开始写向量。
     * modelId 里包含维度，若中途才得知真实维度，前半段写进去的向量
     * 就会挂在另一个 modelId 下，表现为「刚建完索引却检索不到」。
     */
    if (embedder.dimensionResolved === 0) {
      const probe = await embedder.test()
      if (!probe.dimension) throw new Error('无法确定向量维度，请先点「测试连接」确认服务正常')
      embedder.dimension = probe.dimension
      embedder.dimensionResolved = probe.dimension
    }
    this.setEmbedConfig({ api: { dimension: embedder.dimensionResolved } })

    // 配置刚被改写，缓存已清空，重新取一个 id 稳定的实例
    const stable = await this.embedder()
    if (!stable) throw new Error('嵌入配置保存失败')

    const modelId = stable.id
    let done = 0
    const total = this.store.countChunks(collectionId)

    for (;;) {
      if (signal?.aborted) throw new Error('已取消')
      const pending = this.store.chunksNeedingEmbedding(modelId, collectionId, 64)
      if (pending.length === 0) break

      const texts = pending.map((row) => row.text)
      const vectors = await stable.embed(texts)

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

    return {
      modelId,
      embedded: this.store.countEmbeddings(modelId, collectionId),
      total,
      dimension: stable.dimensionResolved,
    }
  }

  /* ────────────────────── 混合检索 ────────────────────── */

  /**
   * 语义检索：向量相似度 + 关键词，融合排序。
   * @returns {Promise<{ hits: Array, mode: 'hybrid'|'keyword', note?: string }>}
   */
  async semanticSearch(query, { collectionId = null, limit = 10, useVector = true } = {}) {
    const keywordHits = this.store.search(query, { collectionId, limit: limit * 3 })

    if (!useVector) return { hits: keywordHits.slice(0, limit), mode: 'keyword' }

    const embedder = await this.embedder()
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

    // 先融合出一批候选（多取一些给重排挑）
    const candidateLimit = Math.max(limit, 20)
    let hits = fuseResults(keywordHits, vectorHits, { limit: candidateLimit })

    let rerankNote
    let reranked = false
    const reranker = await this.reranker()
    if (reranker?.configured && hits.length > 1) {
      try {
        const results = await reranker.rerank(query, hits)
        hits = applyRerank(hits, results, limit)
        reranked = true
      } catch (error) {
        rerankNote = `重排失败（${error instanceof Error ? error.message : String(error)}），已按融合分数返回`
        hits = hits.slice(0, limit)
      }
    } else {
      hits = hits.slice(0, limit)
    }

    return {
      hits,
      mode: reranked ? 'hybrid+rerank' : 'hybrid',
      reranked,
      note: rerankNote ?? (status.complete ? undefined : '部分文档尚未建立向量索引'),
    }
  }
}

export function apply(ctx, config) {
  const kb = new KnowledgeBase(ctx, config ?? {})

  ctx.effect(() => {
    kb.start()
    return () => kb.stop()
  }, 'dsh-knowbase: lifecycle')

  /* ── 智能体工具：让模型能自己查库、导入、抓资料 ── */
  ctx.inject(['tools'], (scope) => {
    const tools = scope.get('tools')
    if (tools?.register === undefined) return undefined
    try {
      return registerTools(scope, kb)
    } catch (error) {
      scope.logger?.warn?.('dsh-knowbase: 工具注册失败 %s', error instanceof Error ? error.message : String(error))
      return undefined
    }
  })

  /* ── 技能：教模型什么时候查库、怎么建专题库 ── */
  ctx.inject(['skills'], (scope) => {
    const skills = scope.get('skills')
    if (skills?.register === undefined) return undefined
    try {
      return skills.register(buildSkill())
    } catch (error) {
      scope.logger?.warn?.('dsh-knowbase: 技能注册失败 %s', error instanceof Error ? error.message : String(error))
      return undefined
    }
  })

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
    route('/api/dsh-knowbase/embed/clear', async (body) => {
      const modelId = kb.expectedModelId()
      if (modelId === 'none') return fail('dsh-knowbase/no-embedder', '尚未配置嵌入模型')
      kb.store.clearEmbeddings(modelId, body.collectionId ? Number(body.collectionId) : null)
      return json({ ok: true, value: { cleared: true } })
    })

    /* ── 本地模型管理 ── */
    route('/api/dsh-knowbase/models', async (body) => {
      const modelsDir = join(kb.dataRoot, 'models')

      if (body.action === 'catalog') {
        const { MODEL_CATALOG, MIRRORS, listLocalModels } = await import('./lib/models.js')
        const local = await listLocalModels(modelsDir)
        return json({
          ok: true,
          value: {
            catalog: Object.entries(MODEL_CATALOG).map(([id, spec]) => ({
              id,
              name: spec.name,
              dim: spec.dim,
              sizeMB: spec.sizeMB,
              note: spec.note,
            })),
            mirrors: MIRRORS.map((m) => ({ id: m.id, label: m.label })),
            local,
            // 本地推理库是否已安装：没装时界面给出安装指引，而不是让用户点了才报错
            libAvailable: await localLibraryAvailable(),
            installHint: '在插件目录下执行：npm install @huggingface/transformers',
          },
        })
      }

      if (body.action === 'list') {
        const { listLocalModels } = await import('./lib/models.js')
        return json({ ok: true, value: await listLocalModels(modelsDir) })
      }

      if (body.action === 'remove') {
        const { removeLocalModel } = await import('./lib/models.js')
        await removeLocalModel(modelsDir, String(body.modelId ?? ''))
        return json({ ok: true, value: { removed: true } })
      }

      if (body.action === 'inspect') {
        const { inspectLocalModel } = await import('./lib/models.js')
        return json({ ok: true, value: await inspectLocalModel(modelsDir, String(body.modelId ?? '')) })
      }

      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    /* ── 模型下载（长任务，单独一条路由）── */
    route('/api/dsh-knowbase/models/download', async (body) => {
      const { downloadModel } = await import('./lib/models.js')
      const modelsDir = join(kb.dataRoot, 'models')
      const result = await downloadModel({
        modelId: String(body.modelId ?? ''),
        modelsDir,
        onProgress: (done, total, detail) => {
          kb.downloadProgress = { done, total, detail, at: Date.now() }
        },
      })
      kb.downloadProgress = null
      return json({ ok: true, value: result })
    })

    route('/api/dsh-knowbase/models/progress', () =>
      json({ ok: true, value: kb.downloadProgress ?? null }))

    /* ── 一键安装本地推理依赖 ── */
    route('/api/dsh-knowbase/models/install-lib', async () => {
      if (kb.installState?.running) {
        return json({ ok: true, value: { started: false, reason: '已经在安装了' } })
      }
      if (await localLibraryAvailable()) {
        return json({ ok: true, value: { started: false, reason: '依赖已安装' } })
      }

      const npm = findNpm()
      const cwd = packageDir()
      /*
       * 依赖默认已随插件预装（见 package.json 的 dependencies）。
       * 这条一键安装是兜底：node_modules 被误删或换机器拷贝源码后用它恢复。
       * 不带包名安装，按 package.json 的版本装全部依赖。
       */
      const args = ['install', '--no-audit', '--no-fund']

      kb.installState = {
        running: true,
        startedAt: Date.now(),
        lines: [`准备执行：${npm} ${args.join(' ')}`, `工作目录：${cwd}`],
        error: null,
      }

      // 后台执行，路由立即返回；前端轮询进度
      // Windows 上 .cmd 需要经由 cmd.exe 调用；不用 shell:true 以避免参数拼接告警
      const child = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', npm, ...args], {
            cwd,
            windowsHide: true,
            env: { ...process.env, npm_config_yes: 'true' },
          })
        : spawn(npm, args, {
            cwd,
            windowsHide: true,
            env: { ...process.env, npm_config_yes: 'true' },
          })

      const push = (text) => {
        if (!text) return
        for (const line of String(text).split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed) kb.installState.lines.push(trimmed.slice(0, 500))
        }
        // 只保留最近 200 行，避免无限增长
        if (kb.installState.lines.length > 200) {
          kb.installState.lines = kb.installState.lines.slice(-200)
        }
      }

      child.stdout?.on('data', (buf) => push(buf.toString('utf8')))
      child.stderr?.on('data', (buf) => push(buf.toString('utf8')))

      child.on('error', (error) => {
        kb.installState.running = false
        kb.installState.error = `无法启动 npm：${error.message}`
      })

      child.on('close', async (code) => {
        kb.installState.running = false
        kb.installState.exitCode = code
        // 装完立即探测，确认是否真的可用
        kb.installState.available = await localLibraryAvailable()
        if (code !== 0 && !kb.installState.error) {
          kb.installState.error = `npm 退出码 ${code}`
        }
      })

      return json({ ok: true, value: { started: true, npm, cwd } })
    })

    route('/api/dsh-knowbase/models/install-progress', async () => {
      const state = kb.installState
      if (!state) {
        return json({ ok: true, value: { running: false, available: await localLibraryAvailable(), lines: [] } })
      }
      return json({
        ok: true,
        value: {
          running: state.running,
          available: state.available ?? (state.running ? null : await localLibraryAvailable()),
          error: state.error,
          exitCode: state.exitCode,
          lines: state.lines.slice(-40),
          elapsedMs: Date.now() - state.startedAt,
        },
      })
    })

    /* ── 导出与数据目录 ── */
    route('/api/dsh-knowbase/export', async (body) =>
      json({
        ok: true,
        value: await kb.exportCitations(
          body.collectionId === undefined || body.collectionId === null
            ? null
            : Number(body.collectionId),
        ),
      }))

    route('/api/dsh-knowbase/data-root', async (body) => {
      if (body.action === 'get') {
        return json({
          ok: true,
          value: { current: kb.dataRoot, configured: kb.getDataRoot() },
        })
      }
      if (body.action === 'set') {
        return json({ ok: true, value: kb.setDataRoot(body.path) })
      }
      if (body.action === 'migrate') {
        return json({ ok: true, value: await kb.migrateDataRoot(body.path, { dryRun: body.dryRun === true }) })
      }
      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    /* ── 长任务、存储统计、全局清理 ── */
    route('/api/dsh-knowbase/task', (body) => {
      if (body.action === 'list') return json({ ok: true, value: kb.listTasks() })
      if (body.action === 'cancel') {
        return json({ ok: true, value: kb.cancelTask(String(body.id ?? '')) })
      }
      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    route('/api/dsh-knowbase/usage', async () =>
      json({ ok: true, value: await kb.usage() }))

    route('/api/dsh-knowbase/wipe', async (body) => {
      const result = await kb.wipe({
        keepModels: body.keepModels !== false,
        confirm: String(body.confirm ?? ''),
      })
      return json({ ok: true, value: result })
    })

    /* ── 抓取设置与权威来源清单 ── */
    route('/api/dsh-knowbase/fetch', (body) => {
      if (body.action === 'get') {
        return json({ ok: true, value: kb.getFetchConfig() })
      }
      if (body.action === 'set') {
        return json({ ok: true, value: kb.setFetchConfig(body.config ?? {}) })
      }
      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    route('/api/dsh-knowbase/sources', () =>
      json({ ok: true, value: kb.listSources() }))

    /* ── 重排设置 ── */
    route('/api/dsh-knowbase/rerank', async (body) => {
      if (body.action === 'get') {
        return json({ ok: true, value: kb.getRerankConfig() })
      }
      if (body.action === 'set') {
        return json({ ok: true, value: kb.setRerankConfig(body.config ?? {}) })
      }
      if (body.action === 'test') {
        const result = await kb.testReranker(body.config)
        return json({ ok: true, value: result })
      }
      return fail('dsh-knowbase/bad-action', '未知操作')
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
