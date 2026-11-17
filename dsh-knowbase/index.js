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
import { readFile, writeFile, unlink, stat, statfs, readdir, rm, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

import { KnowledgeStore, titleFromFilename } from './lib/store.js'
import { extractDocument, isSupportedExtension, unsupportedReason } from './lib/extract.js'
import { chunkSections } from './lib/chunk.js'
import { applyRerank } from './lib/rerank.js'
import { registerTools } from './lib/tools.js'
import { buildSkill } from './lib/skill.js'
import { sha256Of } from './lib/models.js'
import { detectHostCapabilities, describeHostCapabilities } from './lib/compat.js'
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

const VERSION = '0.6.0'
const STAGE = 'RC'

/** 单文件大小上限：50MB */
const MAX_FILE_BYTES = 50 * 1024 * 1024
/** 单次批量导入的文件数上限（计划书 5.3-4） */
const MAX_INGEST_FILES = 200

/**
 * 探测一个目录能否写入：建一个临时目录再立刻删掉。
 * 失败不抛错，只返回 false——只读挂载点也应当出现在列表里。
 */
async function canWriteTo(dir) {
  const probe = join(dir, `.kb-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    await mkdir(probe)
    await rm(probe, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 清洗来自用户输入的配置对象。
 *
 * 现有配置合并都用对象展开语法，实测不会被 `__proto__` 污染原型
 * （展开走 CreateDataProperty，不触发 setter）。这里再做一道显式过滤，
 * 防止将来有人改成 Object.assign 或递归 merge 时重新引入风险。
 */
function sanitizeConfig(value, depth = 0) {
  if (depth > 5) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeConfig(item, depth + 1))
      .filter((item) => item !== undefined)
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const cleaned = sanitizeConfig(item, depth + 1)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

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
    /** OCR 引擎缓存 */
    this.ocrCache = null
    /** 磁盘列表缓存（30 秒） */
    this.drivesCache = null
    /** 向量缓存：key = collectionId|modelId，值已反序列化成 Float32Array */
    this.vectorCache = new Map()
    /** 宿主能力探测结果（版本适配用） */
    this.hostCapabilities = null
    this.capabilityNote = ''
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
      // 版本适配：让界面和日志能看到宿主 API 是否齐全
      compatibility: {
        usable: this.hostCapabilities?.usable !== false,
        note: this.capabilityNote || undefined,
        missing: this.hostCapabilities?.missing ?? [],
      },
      stage: STAGE,
      ready: this.ready,
      readyError: this.readyError,
      dataRoot: this.dataRoot,
      counts,
      capabilities: {
        ingest: this.ready,
        search: this.ready,
        // 重排/OCR/抓取都按「当前配置是否真的可用」报告，
        // 而不是写死 false——否则界面无法反映真实状态
        rerank: this.getRerankConfig().provider !== 'none',
        ocr: this.getOcrConfig().provider !== 'none',
        fetch: this.getFetchConfig().enabled,
        localRerank: this.getRerankConfig().provider === 'local',
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
    this.invalidateVectorCache()
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

      // 扫描件：OCR 开着就当场识别，否则标记待处理
      if (extracted.scanned) {
        await this.store.saveFile(sha256, ext, buffer)

        const ocrConfig = this.getOcrConfig()
        if (ocrConfig.provider !== 'none' && ext === 'pdf') {
          try {
            this.store.updateDocumentStatus(docId, 'processing', { chunkCount: 0 })
            const ocrText = await this.#ocrPdf(buffer, docId)
            if (ocrText.trim() !== '') {
              const ocrChunks = chunkSections([{ text: ocrText }])
              if (ocrChunks.length > 0) {
                this.store.replaceChunks(docId, ocrChunks)
                this.store.updateDocumentStatus(docId, 'ready', {
                  pageCount: extracted.meta?.pages ?? null,
                  chunkCount: ocrChunks.length,
                  error: null,
                })
                return { documentId: docId, scanned: true, ocr: true, chunkCount: ocrChunks.length }
              }
            }
            // OCR 没认出字：退回待处理，并说明原因
            this.store.updateDocumentStatus(docId, 'needs-ocr', {
              error: 'OCR 已执行但没有识别出文字，可能是空白页或图片质量太低',
              pageCount: extracted.meta?.pages ?? null,
              chunkCount: 0,
            })
            return { documentId: docId, scanned: true, ocr: false, chunkCount: 0 }
          } catch (error) {
            this.store.updateDocumentStatus(docId, 'needs-ocr', {
              error: `OCR 失败：${error instanceof Error ? error.message : String(error)}`,
              pageCount: extracted.meta?.pages ?? null,
              chunkCount: 0,
            })
            return { documentId: docId, scanned: true, ocr: false, chunkCount: 0 }
          }
        }

        this.store.updateDocumentStatus(docId, 'needs-ocr', {
          error: '该 PDF 没有文字层（扫描件）。到「OCR 设置」里开启识别，或在文档行点「重新解析」重试',
          pageCount: extracted.meta?.pages ?? null,
          chunkCount: 0,
        })
        return { documentId: docId, scanned: true, chunkCount: 0 }
      }

      const sections = extracted.sections.filter((s) => s.text && s.text.trim())
      if (sections.length === 0) throw new Error('文档中没有可提取的文字')

      const chunks = chunkSections(sections, this.getChunkConfig(collectionId))
      if (chunks.length === 0) throw new Error('切块结果为空')

      await this.store.saveFile(sha256, ext, buffer)
      this.store.replaceChunks(docId, chunks)
      this.invalidateVectorCache()
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
    this.invalidateVectorCache()
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

      const chunks = chunkSections(sections, this.getChunkConfig(doc.collection_id))
      this.store.replaceChunks(id, chunks)
      this.invalidateVectorCache()
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
        device: 'cpu',    // cpu / dml（实测 dml 更慢，默认 cpu）
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
        // credentials-local 的 api-key 记录把密钥放在 key 字段；兼容旧数据里的 value/secret
        const value = record?.key ?? record?.value ?? record?.secret
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
    const key = credentialKey('dsh-knowbase', 'embed-api')
    // 先尝试 DSH 凭据库（不进任何配置文件）
    try {
      const credentials = this.ctx?.get?.('credentials')
      if (credentials?.modifyRecord) {
        // records 必须带 kind：写成 { value } 会让凭据库在下次启动时解析失败，
        // 进而使 credentials 这个必需插件无法激活、整个 host 启动中止。
        if (trimmed) {
          await credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: trimmed }))
        } else if (credentials.deleteRecord) {
          await credentials.deleteRecord(key)
        } else {
          await credentials.modifyRecord(key, async () => ({ kind: 'api-key' }))
        }
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
    patch = sanitizeConfig(patch ?? {}) ?? {}
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
    patch = sanitizeConfig(patch ?? {}) ?? {}
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

  /**
   * 实测 CPU vs DirectML 的速度差。
   *
   * 不替用户下结论，而是把真实数字摆出来——
   * 本机实测 DML 慢 3 倍多，但换台机器、换模型可能不同。
   * 用户点一下就知道自己这台值不值得开 GPU。
   */
  async benchDevice() {
    const config = this.getEmbedConfig()
    if (config.provider !== 'local') {
      throw new Error('需要先把嵌入方式设为「本地模型」，才能测本地推理速度')
    }

    const { LocalEmbedder } = await import('./lib/embed-local.js')
    const modelsDir = join(this.dataRoot, 'models')
    const sample = '光合作用把光能转化为化学能，储存在有机物中'
    const results = []
    const task = this.createTask('测速', 2)

    try {
      for (const device of ['cpu', 'dml']) {
        this.throwIfAborted(task.controller.signal, '测速')
        const started = Date.now()
        try {
          const embedder = new LocalEmbedder({
            ...config.local,
            modelsDir,
            device,
          })
          // 首次调用含模型加载，从第二次开始计时才准
          await embedder.embed([sample])
          const warm = Date.now()
          await embedder.embed([sample, sample, sample])
          const perCall = (Date.now() - warm) / 3
          results.push({
            device,
            ok: true,
            loadMs: warm - started,
            perMs: Number(perCall.toFixed(1)),
          })
          await embedder.dispose?.()
        } catch (error) {
          results.push({
            device,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        this.touchTask(task, { done: results.length })
      }

      this.settleTask(task, 'done')

      const cpu = results.find((r) => r.device === 'cpu' && r.ok)
      const dml = results.find((r) => r.device === 'dml' && r.ok)
      let verdict = null
      if (cpu && dml) {
        const ratio = dml.perMs / cpu.perMs
        verdict = {
          faster: ratio < 1 ? 'dml' : 'cpu',
          ratio: Number(ratio.toFixed(2)),
          summary: ratio < 1
            ? `你这台机器上 DirectML 快 ${(1 / ratio).toFixed(1)} 倍，可以试试开 GPU`
            : `你这台机器上 CPU 快 ${ratio.toFixed(1)} 倍，建议保持 CPU`,
        }
      }

      return { results, verdict, model: config.local.modelId || config.local.modelDir || '本地模型' }
    } catch (error) {
      this.settleTask(task, 'failed', error)
      throw error
    }
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

  /* ────────────────────── 切块与检索设置（库级）────────────────────── */

  /**
   * 读某个库的切块配置。
   * 没单独设过就回落到全局默认——这样各库可以不同，但不必每个都填。
   */
  getChunkConfig(collectionId = null) {
    const defaults = {
      smart: true,
      separator: '\n\n',
      size: 1024 / 1.6,   // 界面按 token 显示，内部按字符算
      overlap: 200 / 1.6,
      minSize: 60,
    }
    if (collectionId === null || collectionId === undefined) return defaults

    const stored = this.store.getSetting(`chunk.${collectionId}`, null)
    if (!stored || typeof stored !== 'object') return defaults
    return { ...defaults, ...stored }
  }

  /** 保存切块配置，值域在这里夹住 */
  setChunkConfig(collectionId, patch = {}) {
    patch = sanitizeConfig(patch ?? {}) ?? {}
    if (collectionId === null || collectionId === undefined) {
      throw new Error('必须指定知识库')
    }
    const current = this.getChunkConfig(collectionId)
    const next = { ...current }

    if (patch.smart !== undefined) next.smart = patch.smart === true

    if (patch.separator !== undefined) {
      const sep = String(patch.separator)
      if (sep.trim() === '') throw new Error('分隔符不能为空')
      next.separator = sep
    }

    if (patch.size !== undefined) {
      const size = Number(patch.size)
      if (!Number.isFinite(size)) throw new Error('分段大小必须是数字')
      // 100–4000 字符；太小的块没有检索价值，太大的块稀释相似度
      next.size = Math.min(4000, Math.max(100, size))
    }

    if (patch.overlap !== undefined) {
      const overlap = Number(patch.overlap)
      if (!Number.isFinite(overlap)) throw new Error('重叠大小必须是数字')
      // 重叠不能超过块大小的一半，否则会无限自我覆盖
      next.overlap = Math.min(next.size / 2, Math.max(0, overlap))
    }

    if (patch.minSize !== undefined) {
      next.minSize = Math.min(500, Math.max(0, Number(patch.minSize) || 0))
    }

    this.store.setSetting(`chunk.${collectionId}`, next)
    return next
  }

  /** 恢复默认切块配置 */
  resetChunkConfig(collectionId) {
    this.store.setSetting(`chunk.${collectionId}`, null)
    return this.getChunkConfig(collectionId)
  }

  /** 读某个库的检索设置（当前只有 Top K） */
  getSearchSettings(collectionId = null) {
    const defaults = { topK: 6 }
    if (collectionId === null || collectionId === undefined) return defaults
    const stored = this.store.getSetting(`search.${collectionId}`, null)
    if (!stored || typeof stored !== 'object') return defaults
    return { ...defaults, ...stored }
  }

  /** 保存检索设置 */
  setSearchSettings(collectionId, patch = {}) {
    patch = sanitizeConfig(patch ?? {}) ?? {}
    if (collectionId === null || collectionId === undefined) {
      throw new Error('必须指定知识库')
    }
    const current = this.getSearchSettings(collectionId)
    const next = { ...current }
    if (patch.topK !== undefined) {
      const topK = Number(patch.topK)
      if (!Number.isFinite(topK)) throw new Error('Top K 必须是数字')
      next.topK = Math.min(50, Math.max(1, Math.round(topK)))
    }
    this.store.setSetting(`search.${collectionId}`, next)
    return next
  }

  /** 恢复默认检索设置 */
  resetSearchSettings(collectionId) {
    this.store.setSetting(`search.${collectionId}`, null)
    return this.getSearchSettings(collectionId)
  }

  /**
   * 笔记入库：用户直接写一段文字，不走文件上传。
   * 内部按 .txt 处理，复用同一套抽取与切块流程。
   */
  async createNote({ collectionId, title, text }) {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('笔记内容不能为空')
    const name = `${String(title ?? '').trim() || '未命名笔记'}.txt`
    return this.importFile({
      name,
      buffer: Buffer.from(body, 'utf8'),
      collectionId,
    })
  }

  /* ────────────────────── 向量缓存 ────────────────────── */

  /**
   * 取某个库在某个模型下的向量，命中缓存就不重复反序列化。
   *
   * 单次检索会碰全部向量；不缓存的话每问一次就把几万个 BLOB 解开一遍。
   */
  #vectorsOf(collectionId, modelId) {
    const key = `${collectionId ?? 'all'}|${modelId}`
    const cached = this.vectorCache.get(key)
    if (cached) return cached

    const rows = this.store.listVectors(collectionId, modelId).map((row) => ({
      ...row,
      vector: fromBlob(row.vec),
    }))

    // 只缓存有限的几组，避免长期运行后无限增长
    if (this.vectorCache.size >= 8) {
      const oldest = this.vectorCache.keys().next().value
      if (oldest !== undefined) this.vectorCache.delete(oldest)
    }
    this.vectorCache.set(key, rows)
    return rows
  }

  /**
   * 索引发生变化时清空向量缓存。
   * 导入、删除、重建、清空索引都要调。
   */
  invalidateVectorCache() {
    this.vectorCache.clear()
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

  /* ────────────────────── OCR ────────────────────── */

  /** 读取 OCR 配置 */
  getOcrConfig() {
    const stored = this.store.getSetting('ocr', null)
    const defaults = {
      provider: 'none',      // none | vision | ocr-api | local
      style: 'openai',       // openai | ocr-endpoint
      baseUrl: '',
      model: '',
      maxPages: 10,
      scale: 2,
      timeoutMs: 90000,
      language: '中英混合',
    }
    if (!stored) return defaults
    return { ...defaults, ...stored }
  }

  /** 保存 OCR 配置 */
  setOcrConfig(patch) {
    patch = sanitizeConfig(patch ?? {}) ?? {}
    const current = this.getOcrConfig()
    // apiKey 单独处理，不进 settings
    const { apiKey, ...rest } = patch ?? {}
    const next = { ...current, ...rest }
    this.store.setSetting('ocr', next)
    if (typeof apiKey === 'string') this.store.setSetting('ocrKey', apiKey)
    this.ocrCache = null
    return next
  }

  /** 当前是否已存 OCR Key（不返回明文） */
  hasOcrKey() {
    const key = this.store.getSetting('ocrKey', '')
    return typeof key === 'string' && key.trim() !== ''
  }

  /** 造一个 OCR 实例 */
  async ocrEngine() {
    const config = this.getOcrConfig()
    if (config.provider === 'none') return null

    const cacheKey = `ocr|${JSON.stringify(config)}|${this.store.getSetting('ocrKey', '')}`
    if (this.ocrCache?.key === cacheKey) return this.ocrCache.engine

    // 本地识别：完全离线，不需要 Key
    if (config.provider === 'local') {
      const { LocalOcr } = await import('./lib/ocr-local.js')
      const engine = new LocalOcr({
        modelsDir: join(this.dataRoot, 'models'),
        langs: this.getOcrLangs(),
      })
      this.ocrCache = { key: cacheKey, engine }
      return engine
    }

    const { VisionOcr } = await import('./lib/ocr.js')
    const engine = new VisionOcr({
      ...config,
      apiKey: this.store.getSetting('ocrKey', ''),
    })
    this.ocrCache = { key: cacheKey, engine }
    return engine
  }

  /** 本地 OCR 要用的语言（默认中英） */
  getOcrLangs() {
    const stored = this.store.getSetting('ocrLangs', null)
    return Array.isArray(stored) && stored.length > 0 ? stored : ['chi_sim', 'eng']
  }

  /** 设置本地 OCR 语言 */
  setOcrLangs(langs) {
    const list = Array.isArray(langs) ? langs.filter((l) => typeof l === 'string' && l !== '') : []
    this.store.setSetting('ocrLangs', list.length > 0 ? list : ['chi_sim', 'eng'])
    this.ocrCache = null
    return this.getOcrLangs()
  }

  /** 列出本地语言包状态 */
  async ocrLangStatus() {
    const { listLangs } = await import('./lib/ocr-local.js')
    const modelsDir = join(this.dataRoot, 'models')
    const available = await listLangs(modelsDir)
    const selected = this.getOcrLangs()
    return {
      available,
      selected,
      // 缺的包首次识别时会自动下
      missing: available.filter((l) => selected.includes(l.lang) && !l.downloaded).map((l) => l.lang),
    }
  }

  /** 下载一个语言包 */
  async downloadOcrLang(lang) {
    const { downloadLang } = await import('./lib/ocr-local.js')
    const modelsDir = join(this.dataRoot, 'models')
    const task = this.createTask(`下载 OCR 语言包 ${lang}`, 1)
    try {
      const result = await downloadLang(modelsDir, lang, {
        signal: task.controller.signal,
        onProgress: (message) => this.touchTask(task, { note: message }),
      })
      this.settleTask(task, 'done')
      this.ocrCache = null
      return result
    } catch (error) {
      this.settleTask(task, 'failed', error)
      throw error
    }
  }

  /** 测试 OCR：造一张小图跑一遍 */
  async testOcr(patch) {
    if (patch) this.setOcrConfig(patch)
    const engine = await this.ocrEngine()
    if (!engine) throw new Error('尚未配置 OCR 服务')
    return engine.test()
  }

  /** 内部：把一个 PDF 交给 OCR，返回拼接后的文本 */
  async #ocrPdf(buffer, docId) {
    const config = this.getOcrConfig()
    const engine = await this.ocrEngine()
    if (!engine) throw new Error('OCR 未配置')

    const task = this.createTask(`OCR 识别`, 0)
    try {
      const { renderPdfPages } = await import('./lib/ocr.js')
      const pages = await renderPdfPages(buffer, {
        maxPages: config.maxPages,
        scale: config.scale,
        signal: task.controller.signal,
        onProgress: (page, total) => this.touchTask(task, { done: page, total }),
      })

      const parts = []
      for (const page of pages) {
        this.throwIfAborted(task.controller.signal, 'OCR')
        const text = await engine.recognizeImage(page.png, { signal: task.controller.signal })
        if (text.trim() !== '') {
          parts.push(`【第 ${page.page} 页】\n${text}`)
        }
        this.touchTask(task, { done: page.page })
      }

      this.settleTask(task, 'done')
      return parts.join('\n\n')
    } catch (error) {
      this.settleTask(task, 'failed', error)
      throw error
    }
  }

  /* ────────────────────── 磁盘探测 ────────────────────── */

  /**
   * 列出本机可用于存数据的磁盘。
   *
   * 为什么不写死 C/D：不同机器盘符数量差别很大，
   * 有的只有一个 C，有的分了好几个区。
   *
   * @param {{ refresh?: boolean }} options 传 refresh 跳过 30 秒缓存
   */
  async listDrives({ refresh = false } = {}) {
    const now = Date.now()
    if (!refresh && this.drivesCache && now - this.drivesCache.at < 30_000) {
      return this.drivesCache.value
    }

    const candidates = []

    if (process.platform === 'win32') {
      // 逐个试 A–Z，能 statfs 成功的就是存在的盘
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        candidates.push({ path: `${letter}:`, probe: `${letter}:/` })
      }
    } else {
      candidates.push({ path: '/', probe: '/' })
      // macOS 的外接卷、Linux 的挂载点
      for (const [base, kind] of [['/Volumes', 'mac'], ['/mnt', 'linux'], ['/media', 'linux']]) {
        let entries = []
        try {
          entries = await readdir(base, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          candidates.push({ path: join(base, entry.name), probe: join(base, entry.name), kind })
        }
      }
    }

    const drives = []
    for (const candidate of candidates) {
      let stats
      try {
        stats = await statfs(candidate.probe)
      } catch {
        continue // 盘不存在或不可访问
      }

      const blockSize = Number(stats.bsize)
      const totalBytes = Number(stats.blocks) * blockSize
      const freeBytes = Number(stats.bavail) * blockSize
      if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue

      drives.push({
        path: candidate.path,
        label: candidate.path,
        totalBytes,
        freeBytes,
        // 可写性单独探测，只读挂载点也列出来但标成不可写
        writable: await canWriteTo(candidate.probe),
      })
    }

    this.drivesCache = { at: now, value: drives }
    return drives
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
    patch = sanitizeConfig(patch ?? {}) ?? {}
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
      this.invalidateVectorCache()

      done += pending.length
      onProgress?.(done, total)
    }

    this.invalidateVectorCache()

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
  async semanticSearch(query, { collectionId = null, limit = null, useVector = true } = {}) {
    // 没显式给 limit 时，用该库配置的 Top K（默认 6）
    if (limit === null || limit === undefined) {
      limit = this.getSearchSettings(collectionId).topK
    }
    limit = Math.min(50, Math.max(1, Math.round(Number(limit) || 6)))

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

    /*
     * 全量打分（10 万块以内暴力扫描够用）。
     *
     * 性能：向量以 BLOB 存在 SQLite 里，每次检索都 fromBlob 一遍很浪费。
     * 这里按「库 + 模型」缓存已经反序列化好的 Float32Array，
     * 索引变动时由 invalidateVectorCache() 清掉。
     */
    const rows = this.#vectorsOf(collectionId, status.modelId)
    const scored = []
    for (const row of rows) {
      const score = cosine(queryVector, row.vector)
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

  /*
   * 版本适配：先探测宿主能力，再决定注册哪些东西。
   *
   * 不猜版本号——直接看 API 在不在。缺关键 API 时记录明确诊断，
   * 而不是抛异常让整个插件加载失败（那样用户只会看到一句看不懂的报错）。
   */
  const caps = detectHostCapabilities(ctx)
  kb.hostCapabilities = caps
  kb.capabilityNote = describeHostCapabilities(caps)

  if (!caps.usable) {
    // 关键 API 缺失：不注册路由，但把原因留在状态里供界面/日志读取
    try {
      ctx.logger?.error?.('dsh-knowbase: %s', kb.capabilityNote)
    } catch {
      // logger 可能不存在，静默
    }
    return
  }

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

    /* ── 磁盘探测 ── */
    route('/api/dsh-knowbase/drives', async (body) =>
      json({ ok: true, value: await kb.listDrives({ refresh: body.refresh === true }) }))

    /* ── 切块设置 / 检索设置 / 笔记 ── */
    route('/api/dsh-knowbase/chunk-config', (body) => {
      const id = body.collectionId === undefined || body.collectionId === null
        ? null
        : Number(body.collectionId)
      if (body.action === 'get') return json({ ok: true, value: kb.getChunkConfig(id) })
      if (body.action === 'set') return json({ ok: true, value: kb.setChunkConfig(id, body.config ?? {}) })
      if (body.action === 'reset') return json({ ok: true, value: kb.resetChunkConfig(id) })
      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    route('/api/dsh-knowbase/search-settings', (body) => {
      const id = body.collectionId === undefined || body.collectionId === null
        ? null
        : Number(body.collectionId)
      if (body.action === 'get') return json({ ok: true, value: kb.getSearchSettings(id) })
      if (body.action === 'set') return json({ ok: true, value: kb.setSearchSettings(id, body.settings ?? {}) })
      if (body.action === 'reset') return json({ ok: true, value: kb.resetSearchSettings(id) })
      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    route('/api/dsh-knowbase/note', async (body) => {
      const id = body.collectionId === undefined || body.collectionId === null
        ? null
        : Number(body.collectionId)
      const collection = id === null ? kb.ensureDefaultCollection() : kb.store.getCollection(id)
      if (!collection) return fail('dsh-knowbase/no-collection', '目标知识库不存在')
      return json({
        ok: true,
        value: await kb.createNote({
          collectionId: collection.id,
          title: body.title,
          text: body.text,
        }),
      })
    })

    /* ── OCR ── */
    route('/api/dsh-knowbase/ocr', async (body) => {
      if (body.action === 'get') {
        return json({
          ok: true,
          value: { ...kb.getOcrConfig(), hasKey: kb.hasOcrKey() },
        })
      }
      if (body.action === 'set') {
        const value = kb.setOcrConfig(body.config ?? {})
        return json({ ok: true, value: { ...value, hasKey: kb.hasOcrKey() } })
      }
      if (body.action === 'test') {
        return json({ ok: true, value: await kb.testOcr(body.config) })
      }
      if (body.action === 'langs') {
        return json({ ok: true, value: await kb.ocrLangStatus() })
      }
      if (body.action === 'setLangs') {
        const langs = kb.setOcrLangs(body.langs)
        return json({ ok: true, value: { langs, status: await kb.ocrLangStatus() } })
      }
      if (body.action === 'downloadLang') {
        return json({ ok: true, value: await kb.downloadOcrLang(String(body.lang ?? '')) })
      }
      return fail('dsh-knowbase/bad-action', '未知操作')
    })

    /* ── 导出与数据目录 ── */
    route('/api/dsh-knowbase/bench-device', async () =>
      json({ ok: true, value: await kb.benchDevice() }))

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
    route('/api/dsh-knowbase/fetch', async (body) => {
      if (body.action === 'get') {
        return json({ ok: true, value: kb.getFetchConfig() })
      }
      if (body.action === 'set') {
        return json({ ok: true, value: kb.setFetchConfig(body.config ?? {}) })
      }
      /* 前端「链接」数据源走这里：抓一个 URL 并入库 */
      if (body.action === 'url') {
        const id = body.collectionId === undefined || body.collectionId === null
          ? null
          : Number(body.collectionId)
        const collection = id === null ? kb.ensureDefaultCollection() : kb.store.getCollection(id)
        if (!collection) return fail('dsh-knowbase/no-collection', '目标知识库不存在')
        return json({
          ok: true,
          value: await kb.fetchSource({
            url: String(body.url ?? ''),
            collectionId: collection.id,
            title: body.title ? String(body.title) : undefined,
          }),
        })
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
