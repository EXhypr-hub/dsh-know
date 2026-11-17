/**
 * 文本切块。
 *
 * 中文没有空格，按词切会把句子切碎。这里的策略是分层的：
 *   1. 优先在标题/空行处切（结构边界）
 *   2. 其次在句末标点处切（句边界）
 *   3. 仍超长才硬切，并保留尾部重叠，避免跨块丢失语义
 */

/** 默认参数（P1 固定，P3 起可由设置页覆盖） */
export const DEFAULT_CHUNK = Object.freeze({
  /** 单块目标长度（字符数） */
  size: 500,
  /** 相邻块的重叠长度 */
  overlap: 80,
  /** 块的最小长度，低于此值并入上一块 */
  minSize: 60,
})

const SENTENCE_END = /[。！？；.!?;]\s*|\n{2,}/

/** 把超长段落按句切，再按长度组装 */
function splitParagraph(paragraph, { size, overlap, minSize }) {
  const text = paragraph.trim()
  if (!text) return []
  if (text.length <= size) return [text]

  // 先切成句子（保持句子完整）
  const sentences = []
  let buffer = ''
  for (const char of text) {
    buffer += char
    if (SENTENCE_END.test(char)) {
      sentences.push(buffer)
      buffer = ''
    }
  }
  if (buffer.trim()) sentences.push(buffer)

  // 组装：尽量在句子边界处断开，不跨句硬切
  const chunks = []
  let current = ''

  for (const sentence of sentences) {
    // 句子本身比 size 还长——这是唯一需要硬切的情况
    if (sentence.length > size) {
      if (current.trim()) {
        chunks.push(current.trim())
        current = ''
      }
      let rest = sentence
      while (rest.length > size) {
        chunks.push(rest.slice(0, size))
        // 硬切时才用重叠，且重叠从切点回退到最近的句子边界
        const tailStart = Math.max(0, size - overlap)
        rest = rest.slice(tailStart)
      }
      current = rest
      continue
    }

    // 正常情况：放得下就继续累积
    if (current.length + sentence.length <= size) {
      current += sentence
      continue
    }

    // 放不下 → 在当前块结束处断开（此处必然是句子边界）
    if (current.trim()) chunks.push(current.trim())

    // 重叠：从刚结束的块里取尾部若干**完整句子**，而不是硬截字符
    const overlapText = lastCompleteSentences(current, overlap)
    current = overlapText + sentence
  }

  if (current.trim()) chunks.push(current.trim())

  // 合并过短的块（但不要制造超长块）
  const merged = []
  for (const chunk of chunks) {
    if (
      merged.length > 0
      && chunk.length < minSize
      && merged[merged.length - 1].length + chunk.length <= size * 1.5
    ) {
      merged[merged.length - 1] += chunk
    } else {
      merged.push(chunk)
    }
  }
  return merged
}

/**
 * 从一块文本的尾部取出若干**完整句子**，总长不超过 budget。
 * 这样重叠部分不会把一个句子从中间劈开。
 */
function lastCompleteSentences(text, budget) {
  if (budget <= 0 || !text) return ''
  // 从尾部向前找句子边界
  const parts = text.split(/(?<=[。！？；.!?;\n])/)
  let taken = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const piece = parts[i]
    if (!piece) continue
    if (taken.length + piece.length > budget) break
    taken = piece + taken
  }
  return taken
}

/**
 * 判断一行像不像代码。
 *
 * 目的：代码行不应该各自成块。整段代码合在一起才有检索价值，
 * 单行 "int sum = 0;" 被检索出来对回答没有任何帮助。
 */
export function looksLikeCode(line) {
  const raw = String(line ?? '')
  const t = raw.trim()
  if (t === '') return false

  // 行尾是代码符号
  if (/[{};]$/.test(t)) return true
  // 行首有缩进（2 空格或 tab）
  if (/^(\t| {2,})\S/.test(raw)) return true
  // 常见语句/声明开头
  if (/^(for|if|else|while|do|switch|case|break|continue|return|try|catch|finally|throw)\b/.test(t)) return true
  if (/^(int|float|double|long|short|char|boolean|bool|byte|void|String|var|const|let|function|def|class|struct|enum|interface)\b/.test(t)) return true
  if (/^(public|private|protected|static|final|abstract|synchronized)\b/.test(t)) return true
  if (/^(import|package|using|include|#include|#define)\b/.test(t)) return true
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(t)) return true
  // 注释
  if (/^(\/\/|\/\*|\*\/?|#(?!\s*[一二三四五六七八九十\d]+[.、])|--\s)/.test(t)) return true
  // 赋值或比较表达式
  if (/^[A-Za-z_$][\w$.[\]]*\s*[-+*/%]?=\s*\S/.test(t) && /[;=]$|\)$/.test(t)) return true
  return false
}

/**
 * 判断一段文字像不像标题。
 *
 * 之前用「≤80 字符且不以标点结尾」就判成标题，条件太宽，
 * 结果代码行、普通短句全被当成标题塞进 heading 字段。
 */
export function looksLikeHeading(line) {
  const t = String(line ?? '').trim()
  if (t === '' || t.length > 60) return false
  // 以句末标点结尾 → 是句子不是标题
  if (/[。！？；.!?;]$/.test(t)) return false
  // 含代码符号 → 不是标题
  if (/[{};=<>]|=>|::/.test(t)) return false
  // 含明显的代码关键字
  if (/^(for|if|while|return|int|float|double|void|public|private|static|class|import)\b/.test(t)) return false

  // Markdown 标题
  if (/^#{1,6}\s+\S/.test(t)) return true
  // 编号标题：1. / 1、/ (1)
  if (/^[（(]?\d{1,2}[.、)）]\s*\S/.test(t)) return true
  // 中文章节
  if (/^第[一二三四五六七八九十百\d]+[章节部分讲篇课]/.test(t)) return true
  // 短的纯中文短语（无标点），如「光反应」
  if (t.length <= 24 && /^[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9 、·\-—（）()《》]{0,23}$/.test(t)) return true

  return false
}

/**
 * 把抽取出的 sections 切成块。
 *
 * @param {Array<{text: string, page?: number}>} sections
 * @param {object} options
 * @returns {Array<{text: string, page?: number, heading?: string, ord: number, tokens: number}>}
 */
export function chunkSections(sections, options = {}) {
  const config = { ...DEFAULT_CHUNK, ...options }
  const chunks = []
  let ord = 0

  /** 当前段落的上下文标题 */
  let currentHeading

  for (const section of sections) {
    if (!section?.text) continue

    const paragraphs = section.text.split(/\n{2,}/)

    /** 累积的代码行 */
    let codeBuffer = []
    const flushCode = () => {
      if (codeBuffer.length === 0) return
      const code = codeBuffer.join('\n')
      // 代码整体成块；超长才按长度切
      const pieces = code.length <= config.size * 1.6
        ? [code]
        : splitParagraph(code, { ...config, size: config.size * 1.5 })
      for (const piece of pieces) {
        const text = piece.trim()
        if (!text) continue
        chunks.push({
          ord: ord++,
          text,
          page: section.page,
          heading: currentHeading,
          tokens: Math.ceil(text.length / 1.6),
          kind: 'code',
        })
      }
      codeBuffer = []
    }

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()
      if (!trimmed) continue

      // 整段都是代码行 → 累积，稍后合并
      const lines = trimmed.split('\n')
      const codeLines = lines.filter((l) => l.trim() !== '' && looksLikeCode(l))
      const isCodeBlock = codeLines.length >= Math.max(1, Math.ceil(lines.filter((l) => l.trim()).length * 0.6))

      if (isCodeBlock) {
        codeBuffer.push(...lines)
        continue
      }

      flushCode()

      // 标题行：记下来给后续块用，本身不单独成块
      if (looksLikeHeading(trimmed)) {
        currentHeading = trimmed.replace(/^#{1,6}\s+/, '')
        continue
      }

      for (const piece of splitParagraph(trimmed, config)) {
        const text = piece.trim()
        if (!text) continue
        chunks.push({
          ord: ord++,
          text,
          page: section.page,
          heading: currentHeading,
          tokens: Math.ceil(text.length / 1.6),
          kind: 'text',
        })
      }
    }

    flushCode()
  }

  return mergeTinyChunks(chunks, config)
}

/**
 * 合并过碎的块。
 *
 * 代码文档常有大量极短行；即便上面按代码块聚合了，
 * 仍可能残留碎片。这里把相邻的短块并到上下文里，保证每块信息量够。
 */
function mergeTinyChunks(chunks, config) {
  const minUseful = Math.max(40, Math.floor(config.minSize))
  const maxMerged = Math.floor(config.size * 1.8)
  const out = []

  for (const chunk of chunks) {
    const prev = out[out.length - 1]
    const tooSmall = chunk.text.length < minUseful
    const sameSource = prev
      && prev.page === chunk.page
      && (prev.kind === chunk.kind || chunk.kind === 'code')
    const fits = prev && prev.text.length + chunk.text.length + 1 <= maxMerged

    if (tooSmall && sameSource && fits) {
      prev.text = `${prev.text}\n${chunk.text}`
      prev.tokens = Math.ceil(prev.text.length / 1.6)
      continue
    }

    out.push({ ...chunk })
  }

  // 重新编号，保证 ord 连续
  return out.map((chunk, index) => ({ ...chunk, ord: index }))
}

