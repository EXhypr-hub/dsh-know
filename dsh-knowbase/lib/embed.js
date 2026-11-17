/**
 * 嵌入与重排：可切换的 provider 抽象。
 *
 * P2 支持两种嵌入方式：
 *   1. OpenAI 兼容 API（/v1/embeddings）—— 立即可用，无需下模型
 *   2. 本地模型 —— 需先把模型下载到 models/ 目录（P3 做下载器）
 *
 * 重排 P2 先留接口，实现放到 P3。
 *
 * 关键约束：不同模型算出的向量不能混用。每次嵌入都记录 modelId，
 * 检索时比对，不一致就拒绝并提示重建索引。
 */

import { createHash } from 'node:crypto'

/** 余弦相似度。向量已做 L2 归一化时等价于点积。 */
export function cosine(a, b) {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** L2 归一化（原地） */
export function normalize(vector) {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  if (sum === 0) return vector
  const inv = 1 / Math.sqrt(sum)
  for (let i = 0; i < vector.length; i++) vector[i] *= inv
  return vector
}

/** float32 数组 ↔ Buffer，便于存进 SQLite BLOB */
export function toBlob(vector) {
  return Buffer.from(new Float32Array(vector).buffer)
}

export function fromBlob(buffer) {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  return new Float32Array(ab)
}

/** 归一化的模型标识，用于判断向量是否兼容 */
export function modelIdOf(provider, model, dimension) {
  return `${provider}:${model}:${dimension}`
}

/* ────────────────────────── Provider：OpenAI 兼容 API ────────────────────────── */

export class ApiEmbedder {
  /**
   * @param {{ baseUrl: string, apiKey: string, model: string, dimension?: number, batchSize?: number, timeoutMs?: number }} config
   */
  constructor(config) {
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '')
    this.apiKey = config.apiKey ?? ''
    this.model = config.model ?? 'text-embedding-3-small'
    this.dimension = config.dimension ?? 0
    this.batchSize = Math.max(1, Math.min(config.batchSize ?? 16, 64))
    this.timeoutMs = config.timeoutMs ?? 30000
    this.dimensionResolved = this.dimension
  }

  get id() {
    return modelIdOf('api', this.model, this.dimensionResolved)
  }

  get label() {
    return `${this.model}（API）`
  }

  /** 发一次请求，返回向量数组 */
  async embedBatch(texts) {
    if (!this.baseUrl) throw new Error('尚未配置嵌入服务地址')
    if (!this.model) throw new Error('尚未配置嵌入模型名')

    const url = `${this.baseUrl}/embeddings`
    const headers = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const hint = res.status === 401 ? 'API Key 无效或未配置'
        : res.status === 404 ? '地址或模型名不正确'
        : res.status === 429 ? '请求过于频繁，请稍后重试'
        : `服务返回 ${res.status}`
      throw new Error(`${hint}${detail ? `：${detail.slice(0, 200)}` : ''}`)
    }

    const data = await res.json()
    const items = data?.data
    if (!Array.isArray(items) || items.length !== texts.length) {
      throw new Error('服务返回的数据格式不符合预期')
    }

    // 按 index 排序，防止服务端乱序
    const sorted = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const vectors = sorted.map((item) => {
      const emb = item.embedding
      if (!Array.isArray(emb) || emb.length === 0) throw new Error('返回了空向量')
      return emb
    })

    if (this.dimensionResolved === 0) this.dimensionResolved = vectors[0].length
    return vectors
  }

  /** 批量嵌入，自动分批 */
  async embed(texts, onProgress) {
    const out = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const slice = texts.slice(i, i + this.batchSize)
      const vectors = await this.embedBatch(slice)
      // 首次得到真实维度时同步到实例，保证本批次内 id 稳定
      if (this.dimensionResolved === 0 && vectors.length > 0) {
        this.dimensionResolved = vectors[0].length
      }
      out.push(...vectors)
      onProgress?.(Math.min(i + slice.length, texts.length), texts.length)
    }
    return out
  }

  /** 连通性测试：发一个最小请求 */
  async test() {
    const started = Date.now()
    const vectors = await this.embedBatch(['测试'])
    const ms = Date.now() - started
    if (this.dimensionResolved === 0) this.dimensionResolved = vectors[0].length
    return { ok: true, dimension: vectors[0].length, ms }
  }
}

/* ────────────────────────── Provider 工厂 ────────────────────────── */

/**
 * 依据配置创建 embedder。
 * 本地实现拆在 embed-local.js，这里用动态 import 按需加载，
 * 这样没装 transformers 依赖时插件仍可正常启动。
 *
 * @param {{ provider: string, api: object, local: object }} config
 */
export async function createEmbedder(config) {
  const provider = config?.provider ?? 'none'

  if (provider === 'api') return new ApiEmbedder(config.api ?? {})

  if (provider === 'local') {
    // 动态加载，避免没装 transformers 时影响插件启动
    const { LocalEmbedder } = await import('./embed-local.js')
    return new LocalEmbedder(config.local ?? {})
  }

  return null
}

/* ────────────────────────── 混合检索融合 ────────────────────────── */

/**
 * 把关键词结果与向量结果融合成一份排序列表。
 *
 * 采用 Reciprocal Rank Fusion（RRF）：
 *   score = Σ 1 / (k + rank)
 * 它不需要两边的分数可比，只看名次，实践中很稳。
 */
export function fuseResults(keywordHits, vectorHits, { k = 60, limit = 10 } = {}) {
  const merged = new Map()

  const add = (hit, source, rank) => {
    const key = hit.id
    const existing = merged.get(key)
    const contribution = 1 / (k + rank + 1)
    if (existing) {
      existing.score += contribution
      existing.sources.add(source)
    } else {
      merged.set(key, { ...hit, score: contribution, sources: new Set([source]) })
    }
  }

  keywordHits.forEach((hit, rank) => add(hit, 'keyword', rank))
  vectorHits.forEach((hit, rank) => add(hit, 'vector', rank))

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => ({ ...hit, sources: [...hit.sources] }))
}

/** 文本指纹，用于判断切块是否变化 */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)
}
