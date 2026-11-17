/**
 * 本地模型下载器。
 *
 * 目标：让用户不用命令行动手，也能把嵌入模型拉到本地。
 *
 * 现实约束（已实测）：
 *   - huggingface.co 在国内经常连不上，hf-mirror.com 可用
 *   - ModelScope 也稳定可用
 *
 * 因此按「镜像优先」的顺序尝试，逐个回退。
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile, stat, readdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/** 可下载的模型清单：只收录确认存在、且适合中文/多语言的 */
export const MODEL_CATALOG = {
  'bge-m3': {
    name: 'BGE-M3',
    dim: 1024,
    sizeMB: 2200,
    note: '多语言，8K 上下文，中文效果好（推荐）',
    repo: 'BAAI/bge-m3',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'model.onnx'],
  },
  'qwen3-embedding-0.6b': {
    name: 'Qwen3-Embedding-0.6B',
    dim: 1024,
    sizeMB: 620,
    note: '轻量，速度快，支持 100+ 语言',
    repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'],
  },
  'bge-small-zh': {
    name: 'BGE-Small-ZH',
    dim: 512,
    sizeMB: 95,
    note: '极小，纯中文，适合低配机器',
    repo: 'Xenova/bge-small-zh-v1.5',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'],
  },
}

/** 镜像列表，按顺序尝试 */
export const MIRRORS = [
  { id: 'hf-mirror', label: 'HF 镜像（国内快）', base: 'https://hf-mirror.com' },
  { id: 'modelscope', label: 'ModelScope（国内）', base: 'https://modelscope.cn/models' },
  { id: 'hf', label: 'HuggingFace 官方（可能需代理）', base: 'https://huggingface.co' },
]

/** 拼出某个镜像上某文件的下载地址 */
export function resolveUrl(mirrorBase, repo, file) {
  const base = mirrorBase.replace(/\/+$/, '')
  if (base.includes('modelscope.cn')) {
    // ModelScope 的原始文件地址格式不同
    return `${base}/${repo}/resolve/master/${file}`
  }
  return `${base}/${repo}/resolve/main/${file}`
}

/**
 * 下载一个模型到目标目录。
 *
 * @param {object} options
 * @param {string} options.modelId        模型键（MODEL_CATALOG 的 key）
 * @param {string} options.modelsDir      本地 models 目录
 * @param {Function} [options.onProgress] 进度回调 (done, total, detail)
 * @param {AbortSignal} [options.signal]
 */
export async function downloadModel({ modelId, modelsDir, onProgress, signal }) {
  const spec = MODEL_CATALOG[modelId]
  if (!spec) throw new Error(`未知的模型：${modelId}`)

  const targetDir = join(modelsDir, modelId)
  await mkdir(targetDir, { recursive: true })

  const total = spec.files.length
  let done = 0
  const failed = []

  for (const file of spec.files) {
    if (signal?.aborted) throw new Error('已取消下载')

    const dest = join(targetDir, file)
    const already = await fileExists(dest)
    if (already) {
      done++
      onProgress?.(done, total, `${file}（已存在）`)
      continue
    }

    await mkdir(dirname(dest), { recursive: true })

    let ok = false
    const errors = []
    for (const mirror of MIRRORS) {
      if (signal?.aborted) throw new Error('已取消下载')
      const url = resolveUrl(mirror.base, spec.repo, file)
      try {
        onProgress?.(done, total, `${file} ← ${mirror.label}`)
        const res = await fetch(url, {
          signal: signal ?? AbortSignal.timeout(180000),
          redirect: 'follow',
        })
        if (!res.ok) {
          errors.push(`${mirror.id}: HTTP ${res.status}`)
          continue
        }
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length === 0) {
          errors.push(`${mirror.id}: 内容为空`)
          continue
        }
        await writeFile(dest, buffer)
        ok = true
        break
      } catch (error) {
        errors.push(`${mirror.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (!ok) {
      failed.push({ file, errors })
      continue
    }
    done++
    onProgress?.(done, total, file)
  }

  if (failed.length > 0) {
    const summary = failed.map((f) => `${f.file}（${f.errors.join(' / ')}）`).join('；')
    throw new Error(`有 ${failed.length} 个文件下载失败：${summary}`)
  }

  return { modelId, dir: targetDir, dimension: spec.dim, files: spec.files }
}

/** 检查某模型本地是否完整 */
export async function inspectLocalModel(modelsDir, modelId) {
  const spec = MODEL_CATALOG[modelId]
  if (!spec) return { exists: false, complete: false, missing: [] }

  const dir = join(modelsDir, modelId)
  const missing = []
  let totalBytes = 0
  for (const file of spec.files) {
    const info = await stat(join(dir, file)).catch(() => null)
    if (!info) missing.push(file)
    else totalBytes += info.size
  }
  return {
    exists: missing.length < spec.files.length,
    complete: missing.length === 0,
    missing,
    dir,
    bytes: totalBytes,
    dimension: spec.dim,
  }
}

/** 列出本地已下载的模型 */
export async function listLocalModels(modelsDir) {
  let entries = []
  try {
    entries = await readdir(modelsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const info = await inspectLocalModel(modelsDir, entry.name)
    const spec = MODEL_CATALOG[entry.name]
    out.push({
      id: entry.name,
      name: spec?.name ?? entry.name,
      complete: info.complete,
      bytes: info.bytes,
      dimension: info.dimension,
      known: Boolean(spec),
    })
  }
  return out
}

/** 删除本地模型 */
export async function removeLocalModel(modelsDir, modelId) {
  await rm(join(modelsDir, modelId), { recursive: true, force: true })
}

async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.size > 0
  } catch {
    return false
  }
}

/** 计算文件哈希，用于校验完整性（可选） */
export async function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
