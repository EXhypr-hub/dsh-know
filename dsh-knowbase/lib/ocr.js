/**
 * OCR：把扫描件里的字认出来。
 *
 * 为什么需要它：
 *   扫描版 PDF 没有文字层，直接抽取只能得到 0 个字。
 *   这类文件必须先把页面渲染成图片，再交给能看图的模型识别。
 *
 * 实现路线（计划书 4.1 的第①②种）：
 *   1. 视觉模型 API —— OpenAI 兼容的 /chat/completions，传 base64 图片
 *   2. 专用 OCR API —— 部分服务商提供 /v1/ocr
 * 本地 OCR 需要 PaddleOCR 这类重依赖，本插件不做。
 *
 * 代价必须说清楚：开启后扫描页的**图片**会发往所配置的 API。
 */

import { createCanvas } from '@napi-rs/canvas'

/** 单页渲染的最大边长，防止超大页把内存吃光 */
const MAX_EDGE = 2048

/** 单次 OCR 最多处理多少页（防止一口气烧掉大量额度） */
export const MAX_OCR_PAGES = 20

/** 默认要求模型只做转录，不要解释 */
const OCR_PROMPT = [
  '请把这张图片里的所有文字按原有顺序转录出来。',
  '要求：',
  '1. 只输出文字本身，不要加任何解释、标题或总结。',
  '2. 保留段落换行；表格用制表符对齐。',
  '3. 看不清的字用 □ 代替，不要猜测。',
  '4. 如果图片里没有文字，只输出空。',
].join('\n')

/** 归一化 OCR 配置 */
export function resolveOcrConfig(raw) {
  const cfg = raw ?? {}
  const provider = ['none', 'vision', 'ocr-api'].includes(cfg.provider) ? cfg.provider : 'none'
  const style = cfg.style === 'ocr-endpoint' ? 'ocr-endpoint' : 'openai'
  return {
    provider,
    style,
    baseUrl: String(cfg.baseUrl ?? '').trim().replace(/\/+$/, ''),
    model: String(cfg.model ?? '').trim(),
    apiKey: String(cfg.apiKey ?? ''),
    maxPages: clampNumber(Number(cfg.maxPages ?? 10), 1, MAX_OCR_PAGES),
    scale: clampNumber(Number(cfg.scale ?? 2), 1, 3),
    timeoutMs: clampNumber(Number(cfg.timeoutMs ?? 90000), 5000, 300000),
    language: String(cfg.language ?? '中英混合').slice(0, 40),
  }
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 把一个 PDF 的若干页渲染成 PNG。
 *
 * 用 @napi-rs/canvas（预编译二进制，无需本地编译），
 * 配合 pdfjs 的 legacy build 在 Node 里完成渲染。
 *
 * @returns {Promise<Array<{page: number, png: Buffer}>>}
 */
export async function renderPdfPages(buffer, options = {}) {
  const { maxPages = 10, scale = 2, fromPage = 1, onProgress, signal } = options

  let pdfjs
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch (error) {
    throw new Error(`PDF 渲染组件不可用：${error instanceof Error ? error.message : String(error)}`)
  }

  // pdfjs 在 Node 里对全局 DOMMatrix 有依赖，@napi-rs/canvas 提供了它
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise

  const total = Math.min(doc.numPages, maxPages)
  const pages = []

  try {
    for (let pageNumber = fromPage; pageNumber <= total; pageNumber++) {
      if (signal?.aborted) throw new Error('OCR 已取消')

      const page = await doc.getPage(pageNumber)
      const base = page.getViewport({ scale: 1 })
      // 限制单边尺寸，长页面等比缩小
      const fit = Math.min(1, MAX_EDGE / Math.max(base.width, base.height))
      const viewport = page.getViewport({ scale: scale * fit })

      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height))
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, viewport.width, viewport.height)

      await page.render({ canvasContext: context, viewport, canvas }).promise
      pages.push({ page: pageNumber, png: canvas.toBuffer('image/png') })

      page.cleanup?.()
      onProgress?.(pageNumber, total)
    }
  } finally {
    await doc.cleanup()
  }

  return pages
}

/**
 * 视觉模型 OCR：把页面图片发给 OpenAI 兼容的 /chat/completions。
 */
export class VisionOcr {
  constructor(config) {
    this.config = resolveOcrConfig(config)
  }

  get configured() {
    return this.config.provider !== 'none'
      && this.config.baseUrl !== ''
      && this.config.model !== ''
  }

  get label() {
    if (!this.configured) return '未配置 OCR'
    return `${this.config.model}（${this.config.provider === 'ocr-api' ? 'OCR 接口' : '视觉模型'}）`
  }

  /** 识别一张图片，返回纯文本 */
  async recognizeImage(pngBuffer, { signal } = {}) {
    if (!this.configured) throw new Error('尚未配置 OCR 服务')

    const base64 = pngBuffer.toString('base64')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

    try {
      return this.config.style === 'ocr-endpoint'
        ? await this.#callOcrEndpoint(base64, combined)
        : await this.#callVisionChat(base64, combined)
    } finally {
      clearTimeout(timeout)
    }
  }

  /** OpenAI 兼容的多模态对话 */
  async #callVisionChat(base64, signal) {
    const url = `${this.config.baseUrl}/chat/completions`
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `${OCR_PROMPT}\n语言提示：${this.config.language}` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        }],
      }),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`OCR 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`)
    }

    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('OCR 返回的不是 JSON，可能服务地址填错了')
    }

    const content = data?.choices?.[0]?.message?.content
    if (typeof content === 'string') return content.trim()
    // 有些服务把 content 拆成数组
    if (Array.isArray(content)) {
      return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('').trim()
    }
    throw new Error('OCR 返回结构异常：找不到 choices[0].message.content')
  }

  /** 专用 /ocr 接口（部分服务商） */
  async #callOcrEndpoint(base64, signal) {
    const url = `${this.config.baseUrl}/ocr`
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        image: base64,
        language: this.config.language,
      }),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`OCR 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`)
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('OCR 返回的不是 JSON')
    }
    return String(data?.text ?? data?.result ?? data?.data?.[0]?.text ?? '').trim()
  }

  /** 连通性测试：渲染一张小图跑一遍，确认真能识别 */
  async test() {
    const started = Date.now()
    const canvas = createCanvas(320, 90)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 320, 90)
    ctx.fillStyle = '#000000'
    ctx.font = '28px sans-serif'
    ctx.fillText('OCR TEST 123', 16, 56)

    const text = await this.recognizeImage(canvas.toBuffer('image/png'))
    return {
      ok: true,
      ms: Date.now() - started,
      model: this.label,
      sample: text.slice(0, 120),
      // 能认出来才算通
      recognized: /OCR|TEST|123/i.test(text),
    }
  }
}

/**
 * 判断一份 PDF 是否像「扫描件」而需要 OCR。
 *
 * 依据：抽取到的文字极少（平均每页不到 20 字），
 * 且页数不少——这种情况通常是整本扫描的，不是纯图片册。
 */
export function looksScanned({ textLength, pageCount }) {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return false
  if (pageCount < 2) return false
  return textLength / pageCount < 20
}
