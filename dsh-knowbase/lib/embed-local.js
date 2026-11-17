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
import { MODEL_CATALOG, inspectLocalModel } from './models.js'

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
    /** 量化精度：q8（默认）/ q4 / fp16 / fp32 */
    this.dtype = ['q8', 'q4', 'fp16', 'fp32'].includes(config?.dtype) ? config.dtype : 'q8'
    /** 推理线程数；0 或未填表示交给运行时决定 */
    this.threads = Number.isFinite(Number(config?.threads)) ? Number(config.threads) : 0
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

  /**
   * 解析模型加载来源。
   *
   * 关键：下载器把文件放在 models/<modelId>/，而 transformers 自己下载时
   * 用的是仓库名（如 BAAI/bge-m3）。不识别这个差异的话，
   * 用户明明下载过模型，插件还会再从镜像拉一遍。
   */
  async resolveSource() {
    if (this.modelDir) return this.modelDir

    if (this.modelId && this.modelsDir) {
      const info = await inspectLocalModel(this.modelsDir, this.modelId)
      if (info.complete) return info.dir
    }

    const spec = MODEL_CATALOG[this.modelId]
    // 已知模型用仓库名；未知的当作仓库名直接用
    return spec?.repo ?? this.modelId
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

      /*
       * 重要：transformers 默认把模型缓存在
       * node_modules/@huggingface/transformers/.cache/ 里。
       * 那意味着重装依赖会丢模型，而且数据不在用户指定的目录。
       * 显式指到数据目录下的 models/hf-cache。
       */
      if (this.modelsDir) {
        env.cacheDir = join(this.modelsDir, 'hf-cache')
      }
      env.useFSCache = true

      /*
       * 线程数。ONNX Runtime 默认会吃满所有核心，
       * 在大模型上这会让整台机器卡住，所以允许用户限一下。
       */
      if (Number.isFinite(this.threads) && this.threads > 0) {
        try {
          env.backends.onnx.wasm.numThreads = this.threads
          if (env.backends.onnx.wasm.proxy !== undefined) {
            env.backends.onnx.wasm.proxy = false
          }
        } catch {
          // 后端不支持线程设置时忽略，不影响推理
        }
      }

      // 决定从哪里加载模型：
      //   1. 用户手动指定的目录
      //   2. 下载器已经下好的 models/<id>
      //   3. 否则用 catalog 里的仓库名，交给镜像现拉
      const source = await this.resolveSource()

      /*
       * 量化精度。
       * q8 体积小、速度可接受，是默认；
       * q4 更省内存但精度略降；fp16/fp32 基本不损失精度但吃内存。
       */
      const extractor = await pipeline('feature-extraction', source, {
        dtype: this.dtype === 'q8' ? 'q8' : this.dtype,
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
