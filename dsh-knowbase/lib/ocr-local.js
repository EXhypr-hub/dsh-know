/**
 * 本地 OCR：用 tesseract.js 在本机识别，完全离线。
 *
 * 与视觉模型 API 的取舍：
 *   - 本地：免费、离线、隐私最好；但慢（每页 1–5 秒）、复杂排版准确率一般
 *   - API ：准、快（尤其复杂排版和表格）；但要 Key、要联网、按量计费
 *
 * 中文支持靠 chi_sim 语言包（约 1.7MB），首次使用下载一次。
 * 语言包本身是可选的，不下载也能用英文。
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** 可用语言包。体积是压缩后的下载大小 */
export const OCR_LANGS = {
  chi_sim: { name: '简体中文', sizeMB: 1.7 },
  chi_tra: { name: '繁体中文', sizeMB: 1.8 },
  eng: { name: '英文', sizeMB: 2.9 },
  jpn: { name: '日文', sizeMB: 2.2 },
  kor: { name: '韩文', sizeMB: 1.6 },
}

/**
 * 语言包镜像。
 * 实测 2026-11-17：cdn.jsdelivr.net 不通；unpkg 与 fastly.jsdelivr 可用。
 */
export const LANG_MIRRORS = [
  (lang) => `https://unpkg.com/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int/${lang}.traineddata.gz`,
  (lang) => `https://fastly.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
]

/** 语言包目录 */
export function langDir(modelsDir) {
  return join(modelsDir, 'tesseract')
}

/** 某个语言包是否已下载（解压后的文件才算数） */
export async function hasLang(modelsDir, lang) {
  try {
    const info = await stat(join(langDir(modelsDir), `${lang}.traineddata`))
    return info.size > 0
  } catch {
    return false
  }
}

/** 列出已下载的语言 */
export async function listLangs(modelsDir) {
  const result = []
  for (const lang of Object.keys(OCR_LANGS)) {
    result.push({ lang, ...OCR_LANGS[lang], downloaded: await hasLang(modelsDir, lang) })
  }
  return result
}

/**
 * 下载并解压一个语言包。
 * 逐个镜像重试，全部失败才报错。
 */
export async function downloadLang(modelsDir, lang, { onProgress, signal } = {}) {
  if (!OCR_LANGS[lang]) throw new Error(`不支持的语言：${lang}`)

  const dir = langDir(modelsDir)
  await mkdir(dir, { recursive: true })

  if (await hasLang(modelsDir, lang)) {
    return { lang, downloaded: true, skipped: true }
  }

  const errors = []
  for (const buildUrl of LANG_MIRRORS) {
    if (signal?.aborted) throw new Error('下载已取消')
    const url = buildUrl(lang)
    try {
      onProgress?.(`${lang} ← ${new URL(url).hostname}`)
      const response = await fetch(url, {
        signal: signal ?? AbortSignal.timeout(120000),
        redirect: 'follow',
      })
      if (!response.ok) {
        errors.push(`${new URL(url).hostname}: HTTP ${response.status}`)
        continue
      }

      const compressed = Buffer.from(await response.arrayBuffer())
      if (compressed.length === 0) {
        errors.push(`${new URL(url).hostname}: 内容为空`)
        continue
      }

      // 服务器给的是 gzip，解压后才是 tesseract 要的 traineddata
      let raw
      try {
        raw = gunzipSync(compressed)
      } catch {
        // 个别镜像可能直接给未压缩的
        raw = compressed
      }
      if (raw.length < 1000) {
        errors.push(`${new URL(url).hostname}: 解压后异常（${raw.length} 字节）`)
        continue
      }

      await writeFile(join(dir, `${lang}.traineddata`), raw)
      return { lang, downloaded: true, bytes: raw.length }
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`语言包 ${lang} 下载失败。已尝试：\n${errors.join('\n')}`)
}

/** 用 tesseract.js 做本地识别 */
export class LocalOcr {
  constructor(config) {
    this.modelsDir = String(config?.modelsDir ?? '')
    this.langList = Array.isArray(config?.langs) && config.langs.length > 0
      ? config.langs.filter((l) => OCR_LANGS[l])
      : ['chi_sim', 'eng']
    this.worker = null
    this.loading = null
    this.queue = Promise.resolve()
  }

  get configured() {
    return this.modelsDir !== ''
  }

  get label() {
    return `tesseract.js（本地 · ${this.langList.join('+')}）`
  }

  /** 懒加载 worker：第一次识别时才启动 */
  async ensureWorker(onProgress) {
    if (this.worker) return this.worker
    if (this.loading) return this.loading

    this.loading = (async () => {
      let createWorker
      try {
        ({ createWorker } = await import('tesseract.js'))
      } catch {
        throw new Error(
          '本地 OCR 需要 tesseract.js 依赖，但当前没装上。'
          + '重新安装插件，或改用「视觉模型 API」方式。',
        )
      }

      // 缺哪个语言包就补哪个
      for (const lang of this.langList) {
        if (!(await hasLang(this.modelsDir, lang))) {
          await downloadLang(this.modelsDir, lang, { onProgress: (_msg) => onProgress?.(lang, 0) })
        }
      }

      const dir = langDir(this.modelsDir)
      this.worker = await createWorker(this.langList, 1, {
        langPath: dir,
        cachePath: dir,
        gzip: false,   // 我们已经解压好了
        logger: (m) => {
          if (m?.status) onProgress?.(m.status, Math.round((m.progress ?? 0) * 100))
        },
      })
      return this.worker
    })()

    try {
      return await this.loading
    } finally {
      this.loading = null
    }
  }

  /** 串行化：tesseract 的 worker 不能并发调用 */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  /** 识别一张 PNG */
  async recognizeImage(pngBuffer, { onProgress } = {}) {
    return this.enqueue(async () => {
      const worker = await this.ensureWorker(onProgress)
      onProgress?.('识别中', 0)
      const { data } = await worker.recognize(pngBuffer)
      onProgress?.('完成', 100)
      // tesseract 的中文结果会在词之间插空格，这里把 CJK 之间的空格去掉
      return tidyText(data.text ?? '')
    })
  }

  /** 连通性测试：画一张图认一下 */
  async test() {
    const { createCanvas } = await import('@napi-rs/canvas')
    const started = Date.now()

    const canvas = createCanvas(420, 110)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 420, 110)
    ctx.fillStyle = '#000000'
    ctx.font = '34px sans-serif'
    ctx.fillText('OCR TEST 123', 20, 66)

    const text = await this.recognizeImage(canvas.toBuffer('image/png'))
    return {
      ok: true,
      local: true,
      ms: Date.now() - started,
      model: this.label,
      sample: text.trim().slice(0, 120),
      recognized: /OCR|TEST|123/i.test(text),
    }
  }

  /** 关闭 worker，释放内存 */
  async dispose() {
    if (this.worker) {
      try {
        await this.worker.terminate()
      } catch {
        // 关不掉就算了，进程退出会回收
      }
      this.worker = null
    }
  }
}

/**
 * 清理 tesseract 的输出：
 * 中文之间被插入的空格去掉，但英文单词间的空格要保留。
 */
export function tidyText(text) {
  return String(text ?? '')
    // CJK 字符之间的单个空格去掉
    .replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1')
    // 中文与标点之间的空格
    .replace(/([\u4e00-\u9fa5])[ \t]+(?=[，。、；：！？（）《》])/g, '$1')
    .replace(/([，。、；：！？（）《》])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1')
    // 多个空行压成一个
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
