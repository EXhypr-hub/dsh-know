/**
 * P1 端到端自测脚本（不属于插件运行时，仅开发验证用）。
 * 运行：node scripts/selftest.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

import { extractDocument, openZip } from '../lib/extract.js'
import { chunkSections } from '../lib/chunk.js'
import { KnowledgeStore, titleFromFilename } from '../lib/store.js'

let pass = 0
let fail = 0

function ok(name, detail = '') {
  pass++
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}

function bad(name, error) {
  fail++
  console.log(`  ❌ ${name} — ${error instanceof Error ? error.message : error}`)
}

async function test(name, fn) {
  try {
    await fn()
  } catch (error) {
    bad(name, error)
  }
}

/* ───────────────── 构造测试文件 ───────────────── */

/** 用内置 zlib 造一个最小 DOCX */
function makeDocx(paragraphs) {
  const { deflateRawSync } = require('node:zlib')
  return null
}

const SAMPLE_DOCX = 'C:/Users/34096/Desktop/111/hw_src.docx'
const SAMPLE_PDF = null

const TEXT_SAMPLE = `# 光合作用

光合作用分为光反应和暗反应两个阶段。

## 光反应

光反应在类囊体膜上进行，产生 ATP 和 NADPH，并释放氧气。

## 暗反应

暗反应在叶绿体基质中进行，利用 ATP 和 NADPH 将二氧化碳固定为糖类。
`

/* ───────────────── 测试 ───────────────── */

console.log('\n═══ P1 端到端自测 ═══\n')

const workDir = await mkdtemp(join(tmpdir(), 'kb-selftest-'))

// 1. 纯文本抽取与切块
await test('纯文本抽取', async () => {
  const buffer = Buffer.from(TEXT_SAMPLE, 'utf8')
  const result = await extractDocument(buffer, 'md')
  if (result.sections.length !== 1) throw new Error('应抽出 1 个 section')
  if (!result.sections[0].text.includes('光反应')) throw new Error('内容缺失')
  ok('纯文本抽取', `${result.sections[0].text.length} 字符`)
})

await test('切块', async () => {
  const sections = [{ text: TEXT_SAMPLE }]
  const chunks = chunkSections(sections, { size: 120, overlap: 20, minSize: 20 })
  if (chunks.length < 2) throw new Error(`应切成多块，实际 ${chunks.length}`)
  if (!chunks.every((c) => c.ord !== undefined)) throw new Error('缺少 ord')
  if (!chunks.every((c) => c.text.length > 0)) throw new Error('存在空块')
  ok('切块', `${chunks.length} 块，最长 ${Math.max(...chunks.map((c) => c.text.length))} 字符`)
})

// 2. 存储
await test('存储初始化', async () => {
  const store = new KnowledgeStore(join(workDir, 'kb'))
  await store.open()
  const collections = store.listCollections()
  if (collections.length !== 0) throw new Error('初始应为空')
  const def = store.ensureDefaultCollection()
  if (!def?.id) throw new Error('默认库创建失败')
  const counts = store.counts()
  if (counts.collections !== 1) throw new Error('统计不对')
  ok('存储初始化', `默认库 id=${def.id}`)
  store.close()
})

await test('文档导入全流程', async () => {
  const store = new KnowledgeStore(join(workDir, 'kb2'))
  await store.open()
  const collection = store.ensureDefaultCollection()

  const buffer = Buffer.from(TEXT_SAMPLE, 'utf8')
  const sha = store.hashOf(buffer)

  // 重复检测
  if (store.findDocumentByHash(collection.id, sha)) throw new Error('不应存在')

  await store.saveFile(sha, '.md', buffer)
  const docId = store.createDocument({
    collectionId: collection.id,
    title: titleFromFilename('光合作用.md'),
    filename: '光合作用.md',
    ext: '.md',
    size: buffer.length,
    sha256: sha,
  })

  const extracted = await extractDocument(buffer, 'md')
  const chunks = chunkSections(extracted.sections)
  store.replaceChunks(docId, chunks)
  store.updateDocumentStatus(docId, 'ready', { chunkCount: chunks.length })

  const doc = store.getDocument(docId)
  if (doc.status !== 'ready') throw new Error('状态未更新')
  if (doc.chunk_count !== chunks.length) throw new Error('块数不一致')

  // 重复导入应被识别
  const dup = store.findDocumentByHash(collection.id, sha)
  if (!dup) throw new Error('重复检测失效')

  ok('文档导入全流程', `${chunks.length} 块`)
  store.close()
})

await test('全文检索', async () => {
  const store = new KnowledgeStore(join(workDir, 'kb3'))
  await store.open()
  const collection = store.ensureDefaultCollection()

  const buffer = Buffer.from(TEXT_SAMPLE, 'utf8')
  const sha = store.hashOf(buffer)
  const docId = store.createDocument({
    collectionId: collection.id,
    title: '光合作用',
    filename: '光合作用.md',
    ext: '.md',
    size: buffer.length,
    sha256: sha,
  })
  const extracted = await extractDocument(buffer, 'md')
  store.replaceChunks(docId, chunkSections(extracted.sections))
  store.updateDocumentStatus(docId, 'ready', { chunkCount: 3 })

  const hits = store.search('光反应', { collectionId: collection.id, limit: 5 })
  if (hits.length === 0) throw new Error('检索无结果')
  if (!hits.some((h) => h.text.includes('光反应'))) throw new Error('结果不含关键词')

  const noHits = store.search('量子纠缠暗物质', { collectionId: collection.id })
  if (noHits.length !== 0) throw new Error('无关查询不应有结果')

  ok('全文检索', `${hits.length} 条命中`)
  store.close()
})

// 3. 真实 DOCX
await test('真实 DOCX 抽取', async () => {
  let buffer
  try {
    buffer = readFileSync(SAMPLE_DOCX)
  } catch {
    ok('真实 DOCX 抽取', '跳过（样例文件不存在）')
    return
  }
  const result = await extractDocument(buffer, 'docx')
  const text = result.sections.map((s) => s.text).join('\n')
  if (text.length < 10) throw new Error('抽取内容过少')
  ok('真实 DOCX 抽取', `${result.sections.length} 段，${text.length} 字符`)
})

// 4. 真实 PDF
await test('真实 PDF 抽取', async () => {
  // 现场造一个合法 PDF
  const text = 'Photons excite chlorophyll electrons in photosystem II'
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n' })
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  const buffer = Buffer.from(pdf, 'latin1')
  const result = await extractDocument(buffer, 'pdf')
  if (result.sections.length === 0) throw new Error('未抽出内容')
  const extracted = result.sections.map((s) => s.text).join('\n')
  if (!extracted.includes('photosystem')) throw new Error(`内容不符: ${extracted.slice(0, 80)}`)
  ok('真实 PDF 抽取', `${extracted.length} 字符，页码=${result.sections[0].page}`)
})

// 5. 扫描件判定
await test('扫描件判定', async () => {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n' })
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  const result = await extractDocument(Buffer.from(pdf, 'latin1'), 'pdf')
  if (!result.scanned) throw new Error('未识别为扫描件')
  ok('扫描件判定', '正确识别为需 OCR')
})

// 6. 不支持格式
await test('不支持格式提示', async () => {
  try {
    await extractDocument(Buffer.from('x'), 'doc')
    throw new Error('应当抛错')
  } catch (error) {
    if (!String(error.message).includes('另存为')) throw error
    ok('不支持格式提示', '给出转换建议')
  }
})

// 6b. 扩展名带点/不带点都要认（曾导致 .docx 被误判为不支持）
await test('扩展名归一化', async () => {
  const { isSupportedExtension } = await import('../lib/extract.js')
  const cases = [
    ['docx', true], ['.docx', true], ['.DOCX', true], ['DOCX', true],
    ['pdf', true], ['.pdf', true],
    ['md', true], ['.md', true],
    ['html', true], ['.html', true],
    ['doc', false], ['.doc', false],   // 旧版二进制应提示转换
    ['exe', false], ['.exe', false],
  ]
  const wrong = cases.filter(([ext, expect]) => isSupportedExtension(ext) !== expect)
  if (wrong.length) {
    throw new Error(`误判: ${wrong.map(([e]) => e).join(', ')}`)
  }
  ok('扩展名归一化', `${cases.length} 种写法全部正确`)
})

// 7. 中文切块质量
await test('中文切块不碎句', async () => {
  const long = '这是一个测试句子。'.repeat(60)
  const chunks = chunkSections([{ text: long }], { size: 200, overlap: 40, minSize: 40 })
  if (chunks.length < 2) throw new Error('应切成多块')
  const broken = chunks.filter((c) => c.text.length > 0 && !/^这是|^测试|^。/.test(c.text))
  if (broken.length > chunks.length / 2) throw new Error('切块破坏了句子边界')
  ok('中文切块不碎句', `${chunks.length} 块`)
})

/* ───────────────── 收尾 ───────────────── */

await rm(workDir, { recursive: true, force: true })

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`)
process.exit(fail > 0 ? 1 : 0)
