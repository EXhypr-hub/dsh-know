/**
 * 文档文本抽取。
 *
 * 设计：只用 Node 内置能力 + 一个外部依赖（pdfjs-dist 处理 PDF）。
 * docx / xlsx / pptx 都是 ZIP 容器，用内置 zlib 自行解压，
 * 避免为每种格式引入一个第三方库。
 */

import { inflateRawSync } from 'node:zlib'

/* ────────────────────────── ZIP 读取（零依赖）────────────────────────── */

/**
 * 解析 ZIP 中央目录，返回可读取条目内容的句柄。
 * 只支持 stored / deflate 两种压缩方式，这正是 OOXML 使用的全部方式。
 */
export function openZip(buffer) {
  // End of Central Directory 签名 0x06054b50，从尾部向前找（注释最长 65535）
  let eocd = -1
  const start = Math.max(0, buffer.length - 22 - 65535)
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件')

  const count = buffer.readUInt16LE(eocd + 10)
  let p = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()

  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
    const method = buffer.readUInt16LE(p + 10)
    const compressedSize = buffer.readUInt32LE(p + 20)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const localOffset = buffer.readUInt32LE(p + 42)
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, { method, compressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name)
      if (!entry) return null
      const lh = entry.localOffset
      if (buffer.readUInt32LE(lh) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏')
      const nameLen = buffer.readUInt16LE(lh + 26)
      const extraLen = buffer.readUInt16LE(lh + 28)
      const dataStart = lh + 30 + nameLen + extraLen
      const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize)
      if (entry.method === 0) return raw
      if (entry.method === 8) return inflateRawSync(raw)
      throw new Error(`不支持的 ZIP 压缩方式: ${entry.method}`)
    },
    readText(name) {
      const buf = this.read(name)
      return buf === null ? null : buf.toString('utf8')
    },
  }
}

/* ────────────────────────── XML 文本抽取 ────────────────────────── */

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

function decodeXmlEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match) => {
    if (match in XML_ENTITIES) return XML_ENTITIES[match]
    const numeric = match.slice(2, -1)
    const code = numeric[0] === 'x' || numeric[0] === 'X'
      ? parseInt(numeric.slice(1), 16)
      : parseInt(numeric, 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : match
  })
}

/** 去掉所有标签，只保留文字 */
function stripTags(xml) {
  return decodeXmlEntities(xml.replace(/<[^>]*>/g, ''))
}

/* ────────────────────────── DOCX ────────────────────────── */

export function extractDocx(buffer) {
  const zip = openZip(buffer)
  const xml = zip.readText('word/document.xml')
  if (!xml) throw new Error('DOCX 缺少 word/document.xml')

  // 按段落 <w:p> 切开；段内 <w:t> 是文字，<w:br/> 是换行
  const paragraphs = []
  const blocks = xml.split(/<w:p[ >]/)
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]
    const parts = []
    const tokens = block.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g)
    for (const token of tokens) {
      if (token[1] !== undefined) parts.push(decodeXmlEntities(token[1]))
      else if (token[0].startsWith('<w:br')) parts.push('\n')
      else if (token[0].startsWith('<w:tab')) parts.push('\t')
    }
    const text = parts.join('').trim()
    if (text) paragraphs.push(text)
  }

  // 标题样式：<w:pStyle w:val="Heading1"/>
  const headings = []
  for (const match of xml.matchAll(/<w:pStyle\s+w:val="([^"]+)"/g)) {
    const style = match[1]
    if (/^Heading(\d)$/i.test(style)) headings.push(Number(RegExp.$1))
  }

  return { sections: paragraphs.map((text) => ({ text })), meta: { headings: headings.length } }
}

/* ────────────────────────── PPTX ────────────────────────── */

export function extractPptx(buffer) {
  const zip = openZip(buffer)
  const slides = zip.names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)[1])
      const nb = Number(b.match(/slide(\d+)\.xml/)[1])
      return na - nb
    })

  if (slides.length === 0) throw new Error('PPTX 中没有找到幻灯片')

  const sections = slides.map((name, index) => {
    const xml = zip.readText(name) ?? ''
    // <a:t> 是文本运行
    const texts = []
    for (const match of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
      const text = decodeXmlEntities(match[1]).trim()
      if (text) texts.push(text)
    }
    return { text: texts.join('\n'), page: index + 1 }
  })

  return { sections, meta: { slides: slides.length } }
}

/* ────────────────────────── XLSX ────────────────────────── */

export function extractXlsx(buffer) {
  const zip = openZip(buffer)

  // 共享字符串表
  const sharedXml = zip.readText('xl/sharedStrings.xml') ?? ''
  const shared = []
  for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = []
    for (const t of match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      texts.push(decodeXmlEntities(t[1]))
    }
    shared.push(texts.join(''))
  }

  // 工作表名与文件映射
  const workbookXml = zip.readText('xl/workbook.xml') ?? ''
  const relsXml = zip.readText('xl/_rels/workbook.xml.rels') ?? ''
  const relTarget = new Map()
  for (const match of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relTarget.set(match[1], match[2])
  }

  const sheetRefs = []
  for (const match of workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const name = decodeXmlEntities(match[1])
    const target = relTarget.get(match[2])
    if (target) sheetRefs.push({ name, path: target.startsWith('/') ? target.slice(1) : `xl/${target}` })
  }

  const sections = []
  for (const sheet of sheetRefs) {
    const xml = zip.readText(sheet.path)
    if (!xml) continue

    const rows = []
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = []
      for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
        const attrs = cellMatch[1] ?? cellMatch[3] ?? ''
        const inner = cellMatch[2] ?? ''
        const isShared = /t="s"/.test(attrs)
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/)
        if (vMatch) {
          const raw = vMatch[1]
          cells.push(isShared ? (shared[Number(raw)] ?? '') : raw)
        } else {
          const inlineMatch = inner.match(/<is>([\s\S]*?)<\/is>/)
          if (inlineMatch) cells.push(stripTags(inlineMatch[1]).trim())
        }
      }
      const line = cells.filter((c) => c !== '').join(' | ')
      if (line.trim()) rows.push(line)
    }

    if (rows.length) sections.push({ text: `【工作表：${sheet.name}】\n${rows.join('\n')}` })
  }

  if (sections.length === 0) throw new Error('XLSX 中没有可读取的单元格')
  return { sections, meta: { sheets: sheetRefs.length } }
}

/* ────────────────────────── PDF ────────────────────────── */

export async function extractPdf(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise

  const pageCount = doc.numPages
  const sections = []

  try {
    for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()

      // 按 y 坐标聚行，避免把整页拼成一行
      let lastY = null
      let line = []
      const lines = []
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue
        const y = Math.round(item.transform?.[5] ?? 0)
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          lines.push(line.join(''))
          line = []
        }
        line.push(item.str)
        lastY = y
      }
      if (line.length) lines.push(line.join(''))

      const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
      if (text) sections.push({ text, page: pageNo })
      page.cleanup()
    }
  } finally {
    // pdfjs 6.x 的清理入口是 cleanup()，没有 destroy()
    try {
      await doc.cleanup()
    } catch {
      // 清理失败不影响已抽取的内容
    }
  }

  // 一页文字都没有 → 判定为扫描件
  const printable = sections.reduce((sum, s) => sum + s.text.replace(/\s/g, '').length, 0)
  if (printable === 0) {
    return { sections: [], meta: { pages: pageCount }, scanned: true }
  }

  return { sections, meta: { pages: pageCount } }
}

/* ────────────────────────── 纯文本 / Markdown / HTML ────────────────────────── */

export function extractText(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  return { sections: [{ text }], meta: {} }
}

export function extractHtml(buffer) {
  const html = buffer.toString('utf8')
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html
  const cleaned = body
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
  const text = stripTags(cleaned).replace(/\n{3,}/g, '\n\n').trim()
  return { sections: [{ text }], meta: {} }
}

/* ────────────────────────── 统一入口 ────────────────────────── */

const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'text', 'log', 'csv'])
const HTML_EXTS = new Set(['html', 'htm', 'xhtml'])

/** 该扩展名是否被支持 */
export function isSupportedExtension(ext) {
  const lower = ext.toLowerCase()
  return ['pdf', 'docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls'].includes(lower)
    || TEXT_EXTS.has(lower)
    || HTML_EXTS.has(lower)
}

/** 旧版二进制 Office 格式（.doc/.xls/.ppt）提示 */
export function unsupportedReason(ext) {
  const lower = ext.toLowerCase()
  if (['doc', 'ppt', 'xls'].includes(lower)) {
    return `旧版二进制格式 .${lower} 暂不支持，请用 Office 另存为 .${lower}x 后再导入`
  }
  return `不支持的格式：.${lower}`
}

/**
 * 抽取文档内容。
 * @returns {{ sections: Array<{text: string, page?: number}>, meta: object, scanned?: boolean }}
 */
export async function extractDocument(buffer, extension) {
  const ext = extension.toLowerCase().replace(/^\./, '')

  if (TEXT_EXTS.has(ext)) return extractText(buffer)
  if (HTML_EXTS.has(ext)) return extractHtml(buffer)
  if (ext === 'pdf') return extractPdf(buffer)
  if (ext === 'docx') return extractDocx(buffer)
  if (ext === 'pptx') return extractPptx(buffer)
  if (ext === 'xlsx') return extractXlsx(buffer)

  throw new Error(unsupportedReason(ext))
}
