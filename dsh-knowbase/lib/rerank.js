/**
 * 重排（rerank）。
 *
 * 检索时先粗召回一批候选（关键词 + 向量融合），再用重排模型精排。
 * 重排比嵌入贵，所以只对少量候选做（默认 20 条）。
 *
 * 支持两种后端：
 *   1. OpenAI 兼容的 /rerank 接口（硅基流动、Cohere、Jina 都提供）
 *   2. 关闭（不重排，直接用融合分数）
 */

/** 归一化重排配置 */
export function resolveRerankConfig(raw) {
  const cfg = raw ?? {}
  return {
    provider: ['none', 'api'].includes(cfg.provider) ? cfg.provider : 'none',
    api: {
      baseUrl: String(cfg.api?.baseUrl ?? '').trim().replace(/\/+$/, ''),
      model: String(cfg.api?.model ?? '').trim(),
      topN: clamp(Number(cfg.api?.topN ?? 8), 1, 50),
      timeoutMs: clamp(Number(cfg.api?.timeoutMs ?? 20000), 1000, 120000),
      // 有些服务（Cohere）要求传 documents 数组，有些接受 texts；用这个开关切换
      style: cfg.api?.style === 'cohere' ? 'cohere' : 'openai',
    },
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 重排器：把「查询 + 候选文档」发到服务，拿回相关性分数。
 */
export class ApiReranker {
  constructor(config) {
    const resolved = resolveRerankConfig(config)
    this.provider = resolved.provider
    this.baseUrl = resolved.api.baseUrl
    this.model = resolved.api.model
    this.topN = resolved.api.topN
    this.timeoutMs = resolved.api.timeoutMs
    this.style = resolved.api.style
    this.apiKey = String(config?.api?.apiKey ?? '')
  }

  get configured() {
    return this.provider === 'api' && this.baseUrl !== '' && this.model !== ''
  }

  get label() {
    return this.configured ? `${this.model}（重排 API）` : '未配置重排'
  }

  /** 构造请求体，兼容两种常见风格 */
  buildBody(query, documents, topN) {
    if (this.style === 'cohere') {
      return {
        model: this.model,
        query,
        documents,
        top_n: topN,
        // Cohere v2 rerank 的字段名
        ...(this.model.startsWith('rerank-v3') ? {} : {}),
      }
    }
    return {
      model: this.model,
      query,
      documents,
      top_n: topN,
      return_documents: false,
    }
  }

  /**
   * 对候选文档重排。
   * @param {string} query
   * @param {Array<{text: string}>} candidates
   * @returns {Promise<Array<{index: number, score: number}>>} 按分数降序
   */
  async rerank(query, candidates) {
    if (!this.configured) throw new Error('尚未配置重排服务')
    if (candidates.length === 0) return []

    const documents = candidates.map((c) => c.text)
    const topN = Math.min(this.topN, documents.length)

    const res = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(this.buildBody(query, documents, topN)),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const hint =
        res.status === 401 ? 'API Key 无效'
        : res.status === 404 ? '地址或模型名不正确（该服务可能不支持 /rerank）'
        : res.status === 429 ? '请求过于频繁'
        : `服务返回 ${res.status}`
      throw new Error(`${hint}${detail ? `：${detail.slice(0, 160)}` : ''}`)
    }

    const data = await res.json()
    const results = data?.results ?? data?.data
    if (!Array.isArray(results)) throw new Error('重排服务返回格式不符合预期')

    return results
      .map((item) => ({
        index: Number(item.index ?? 0),
        score: Number(item.relevance_score ?? item.score ?? 0),
      }))
      .filter((item) => Number.isFinite(item.index) && item.index >= 0 && item.index < candidates.length)
      .sort((a, b) => b.score - a.score)
  }

  /** 连通性测试 */
  async test() {
    if (!this.configured) throw new Error('请先填写重排服务地址与模型名')
    const started = Date.now()
    const results = await this.rerank('测试查询', [
      { text: '这是一段与查询相关的测试文本' },
      { text: '完全无关的另一段内容' },
    ])
    return {
      ok: true,
      ms: Date.now() - started,
      results: results.length,
      // 相关内容应排第一，否则说明配置可能有问题
      sane: results.length > 0 && results[0].score >= (results[1]?.score ?? -1),
    }
  }
}

/**
 * 应用重排结果：把候选按新分数重排，并只保留前 N 条。
 * 若重排不可用，原样返回前 N 条。
 */
export function applyRerank(candidates, reranked, limit) {
  if (!Array.isArray(reranked) || reranked.length === 0) {
    return candidates.slice(0, limit).map((c) => ({ ...c, rerankScore: null }))
  }
  const out = []
  const seen = new Set()
  for (const item of reranked) {
    const candidate = candidates[item.index]
    if (!candidate || seen.has(item.index)) continue
    seen.add(item.index)
    out.push({ ...candidate, rerankScore: item.score })
    if (out.length >= limit) break
  }
  // 重排只返回了部分时，用剩余候选补足
  if (out.length < limit) {
    for (let i = 0; i < candidates.length && out.length < limit; i++) {
      if (seen.has(i)) continue
      out.push({ ...candidates[i], rerankScore: null })
    }
  }
  return out
}
