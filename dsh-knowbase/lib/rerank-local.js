/**
 * 本地重排：用 ONNX 交叉编码器在本机给「查询-文档」对打分。
 *
 * 与嵌入的本地实现共享同一套约束：
 *   - 依赖懒加载，没装 @huggingface/transformers 时给出可操作提示
 *   - 模型缓存放数据目录，不污染 node_modules
 *   - 镜像必须改 env.remoteHost（实测 HF_ENDPOINT 环境变量无效）
 *
 * 与嵌入的关键区别：
 *   交叉编码器一次只处理一个「查询 + 一条文档」，输出一个相关性 logit，
 *   需要 sigmoid 归一化成 0–1 的分数。不能用 text-classification pipeline，
 *   那条路会给出 LABEL_0/score=1 这种无意义结果。
 */

import { join } from 'node:path'

const MIRROR_HOSTS = {
  'hf-mirror': 'https://hf-mirror.com',
  modelscope: 'https://modelscope.cn/models',
  hf: 'https://huggingface.co',
}

/** 可选模型清单：中文场景优先 bge-reranker-v2-m3 */
export const RERANK_MODELS = {
  'bge-reranker-v2-m3': {
    name: 'BGE Reranker v2 m3',
    repo: 'onnx-community/bge-reranker-v2-m3-ONNX',
    sizeMB: 580,
    note: '多语言，中文效果最好（推荐）',
  },
  'ms-marco-minilm': {
    name: 'MS MARCO MiniLM L6',
    repo: 'Xenova/ms-marco-MiniLM-L-6-v2',
    sizeMB: 23,
    note: '极小极快，仅适合英文',
  },
}

/** sigmoid：把 logit 压到 0–1 */
function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x))
  const e = Math.exp(x)
  return e / (1 + e)
}

export class LocalReranker {
  constructor(config) {
    const key = String(config?.modelKey ?? 'bge-reranker-v2-m3')
    this.modelKey = RERANK_MODELS[key] ? key : 'bge-reranker-v2-m3'
    this.spec = RERANK_MODELS[this.modelKey]
    this.modelId = String(config?.modelId ?? '').trim() || this.spec.repo
    this.modelsDir = String(config?.modelsDir ?? '').trim()
    this.mirror = MIRROR_HOSTS[config?.mirror] ? config.mirror : 'hf-mirror'
    this.topN = Number(config?.topN ?? 8)
    this.maxLength = Number(config?.maxLength ?? 512)

    this.tokenizer = null
    this.model = null
    this.loading = null
    this.queue = Promise.resolve()
  }

  get configured() {
    return this.modelId !== ''
  }

  get label() {
    if (!this.configured) return '本地重排（未选择模型）'
    return `${this.spec.name}（本地）`
  }

  async loadLibrary() {
    try {
      return await import('@huggingface/transformers')
    } catch {
      throw new Error(
        '本地重排需要 @huggingface/transformers 依赖，但当前没有安装。'
        + '该依赖已随插件预装；若被误删，可在「本地模型」区块点一键安装，'
        + '或改用 API 重排。',
      )
    }
  }

  /** 首次使用时加载 tokenizer 与模型 */
  async ensureModel(onProgress) {
    if (this.model) return this.model
    if (this.loading) return this.loading

    this.loading = (async () => {
      if (!this.configured) throw new Error('尚未选择本地重排模型')

      const lib = await this.loadLibrary()
      const { AutoTokenizer, AutoModelForSequenceClassification, env } = lib

      env.remoteHost = MIRROR_HOSTS[this.mirror]
      env.remotePathTemplate = '{model}/resolve/{revision}/'
      env.allowRemoteModels = true
      env.allowLocalModels = true
      if (this.modelsDir) env.cacheDir = join(this.modelsDir, 'hf-cache')
      env.useFSCache = true

      onProgress?.('加载分词器…', 0)
      this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId)

      onProgress?.('加载模型…', 30)
      this.model = await AutoModelForSequenceClassification.from_pretrained(this.modelId, {
        dtype: 'q8',
      })

      return this.model
    })()

    try {
      return await this.loading
    } finally {
      this.loading = null
    }
  }

  /** 串行执行，避免并发把 CPU 打满 */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  /**
   * 对候选文档打分。
   * @param {string} query
   * @param {Array<{text: string}>} candidates
   * @returns {Promise<Array<{index: number, score: number}>>} 按分数降序
   */
  async rerank(query, candidates) {
    if (candidates.length === 0) return []

    return this.enqueue(async () => {
      const model = await this.ensureModel()
      const tok = this.tokenizer

      // 一次前向处理同一查询下的所有候选，比逐条快得多
      const pairs = candidates.map((c) => `${query} </s> ${c.text}`)
      const inputs = await tok(pairs, {
        padding: true,
        truncation: true,
        max_length: this.maxLength,
      })
      const output = await model(inputs)

      const flat = output.logits.data
      const results = candidates.map((_, index) => ({
        index,
        score: sigmoid(Number(flat[index])),
      }))

      return results.sort((a, b) => b.score - a.score)
    })
  }

  /** 连通性测试：用一对明显相关、一对无关的文本验证区分度 */
  async test(onProgress) {
    const started = Date.now()
    await this.ensureModel(onProgress)

    const query = '光合作用如何进行能量转换'
    const relevant = '光合作用把光能转化为化学能，储存在有机物中'
    const irrelevant = '本章介绍矩阵的特征值与特征向量'

    const results = await this.rerank(query, [{ text: relevant }, { text: irrelevant }])
    const top = results[0]
    const bottom = results[results.length - 1]
    const spread = top.score - bottom.score

    return {
      ok: true,
      local: true,
      ms: Date.now() - started,
      results: results.length,
      // 区分度太低说明模型不适合该语言，值得提醒
      sane: spread > 0.05,
      spread: Number(spread.toFixed(3)),
      topScore: Number(top.score.toFixed(3)),
      bottomScore: Number(bottom.score.toFixed(3)),
      model: this.label,
    }
  }

  async dispose() {
    this.model = null
    this.tokenizer = null
  }
}
