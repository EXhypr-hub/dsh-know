/**
 * 本地嵌入 provider：用 @huggingface/transformers + ONNX 在本机算向量。
 *
 * 设计要点：
 *   1. 依赖按需加载——没装 transformers 插件也要能启动，只在用户真的选本地时才报错
 *   2. 模型首次使用才加载，加载后缓存在实例里
 *   3. 镜像地址必须显式设置（实测：只设 HF_ENDPOINT 环境变量无效，
 *      必须在 import 之后改 env.remoteHost）
 *   4. 推理是 CPU 密集的，用串行队列避免并发把机器拖死
 */

import { join } from 'node:path'

/** 镜像到 env.remoteHost 的映射 */
const MIRROR_HOSTS = {
  'hf-mirror': 'https://hf-mirror.com',
  modelscope: 'https://modelscope.cn/models',
  hf: 'https://huggingface.co',
}

export class LocalEmbedder {
  constructor(config) {
    // config: { modelId?, modelDir?, modelsDir, mirror?, dimension? }
    this.modelId = String(config?.modelId ?? '').trim()
    this.modelDir = String(config?.modelDir ?? '').trim()
    this.modelsDir = String(config?.modelsDir ?? '').trim()
    this.mirror = MIRROR_HOSTS[config?.mirror] ? config.mirror : 'hf-mirror'
    this.dimension = Number(config?.dimension ?? 0)
    this.pipeline = null
    this.loading = null
    this.queue = Promise.resolve()
  }

  get configured() {
    return this.modelId !== '' || this.modelDir !== ''
  }

  /** 模型标识：本地目录优先，否则用模型键 */
  get modelRef() {
    return this.modelDir || this.modelId
  }

  get id() {
    return `local:${this.modelRef || 'none'}:${this.dimension}`
  }

  get label() {
    if (!this.configured) return '本地模型（未选择）'
    return `${this.modelRef}（本地）`
  }

  /** 懒加载依赖，给出可操作的中文提示 */
  async loadLibrary() {
    try {
      return await import('@huggingface/transformers')
    } catch {
      throw new Error(
        '本地模型需要 @huggingface/transformers 依赖，但当前没有安装。'
        + '解决办法：接入 API 方式（推荐），或在插件目录执行 npm install @huggingface/transformers。',
      )
    }
  }

  /** 首次使用时加载模型 */
  async ensurePipeline(onProgress) {
    if (this.pipeline) return this.pipeline
    if (this.loading) return this.loading

    this.loading = (async () => {
      if (!this.configured) throw new Error('尚未选择本地模型')

      const lib = await this.loadLibrary()
      const { pipeline, env } = lib

      // 实测：环境变量 HF_ENDPOINT 在 import 之后设置无效，必须改 env
      env.remoteHost = MIRROR_HOSTS[this.mirror]
      env.remotePathTemplate = '{model}/resolve/{revision}/'
      env.allowRemoteModels = true
      env.allowLocalModels = true

      // 优先用本地目录（下载器已把文件放好），否则交给库自己去镜像拉
      const source = this.modelDir || this.modelId

      const extractor = await pipeline('feature-extraction', source, {
        quantized: true,
        progress_callback: (event) => {
          if (event?.status === 'progress' && typeof event.progress === 'number') {
            onProgress?.(event.file ?? '', Math.round(event.progress))
          }
        },
      })

      this.pipeline = extractor
      return extractor
    })()

    try {
      return await this.loading
    } finally {
      this.loading = null
    }
  }

  /** 串行执行，避免多批并发把 CPU 打满 */
  enqueue(task) {
    const run = this.queue.then(task, task)
    // 队列本身不因单次失败而中断
    this.queue = run.catch(() => {})
    return run
  }

  async embedBatch(texts, onProgress) {
    return this.enqueue(async () => {
      const extractor = await this.ensurePipeline(onProgress)
      const output = await extractor(texts, { pooling: 'mean', normalize: true })
      const dims = output.dims ?? []
      const dim = dims[dims.length - 1] ?? 0
      if (dim === 0) throw new Error('本地模型返回了空向量')

      if (this.dimension === 0) this.dimension = dim

      // output.data 是一维展平数组，按 dim 切回每条文本
      const flat = output.data
      const vectors = []
      for (let i = 0; i < texts.length; i++) {
        vectors.push(Array.from(flat.slice(i * dim, (i + 1) * dim)))
      }
      return vectors
    })
  }

  async embed(texts, onProgress) {
    const out = []
    const batchSize = 8
    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize)
      const vectors = await this.embedBatch(slice)
      out.push(...vectors)
      onProgress?.(Math.min(i + slice.length, texts.length), texts.length)
    }
    return out
  }

  async test() {
    const started = Date.now()
    const vectors = await this.embedBatch(['本地模型测试'], (file, pct) => {
      this.lastProgress = { file, pct }
    })
    return {
      ok: true,
      dimension: vectors[0].length,
      ms: Date.now() - started,
      local: true,
    }
  }

  /** 已加载则释放，避免长时间占用内存 */
  async dispose() {
    if (this.pipeline?.dispose) {
      try {
        await this.pipeline.dispose()
      } catch {
        // 释放失败不影响流程
      }
    }
    this.pipeline = null
  }
}

/** 从模型目录推断模型键 */
export function localModelDirOf(modelsDir, modelId) {
  return join(modelsDir, modelId)
}
