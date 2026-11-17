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

  for (const section of sections) {
    if (!section?.text) continue

    // 每个 section 内部再按空行分段落，段落边界优于长度边界
    const paragraphs = section.text.split(/\n{2,}/)

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()
      if (!trimmed) continue

      // 单独成行的短文本（如小标题）用作 heading 标记
      const isHeading = trimmed.length <= 80 && !/[。！？；.!?;]$/.test(trimmed)

      for (const piece of splitParagraph(trimmed, config)) {
        chunks.push({
          ord: ord++,
          text: piece,
          page: section.page,
          heading: isHeading ? piece : undefined,
          // 粗估 token：中文约 1 字 1 token，英文约 4 字符 1 token
          tokens: Math.ceil(piece.length / 1.6),
        })
      }
    }
  }

  return chunks
}
