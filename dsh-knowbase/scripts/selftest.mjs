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

// 7. P2：向量与融合
await test('向量基础运算', async () => {
  const { cosine, normalize, toBlob, fromBlob } = await import('../lib/embed.js')
  const a = normalize(Float32Array.from([1, 0, 0]))
  const b = normalize(Float32Array.from([0, 1, 0]))
  const c = normalize(Float32Array.from([1, 0, 0]))

  if (Math.abs(cosine(a, b)) > 1e-6) throw new Error('正交向量余弦应为 0')
  if (Math.abs(cosine(a, c) - 1) > 1e-6) throw new Error('相同向量余弦应为 1')

  const round = fromBlob(toBlob(a))
  if (Math.abs(cosine(a, round) - 1) > 1e-6) throw new Error('BLOB 往返失真')
  ok('向量基础运算', '余弦 / 归一化 / BLOB 往返')
})

await test('RRF 融合', async () => {
  const { fuseResults } = await import('../lib/embed.js')
  const kw = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }]
  const vec = [{ id: 2, text: 'b' }, { id: 3, text: 'c' }, { id: 1, text: 'a' }]
  const fused = fuseResults(kw, vec, { limit: 5 })

  // 两侧都命中的 id=2 应排第一
  if (fused[0].id !== 2) throw new Error('双路命中项未排首位')
  if (fused.length !== 3) throw new Error('去重后应有 3 条')
  const hasBoth = fused[0].sources.length === 2
  if (!hasBoth) throw new Error('来源标记不正确')
  ok('RRF 融合', `${fused.length} 条，双路命中排首位`)
})

await test('向量存储与语义排序', async () => {
  const { KnowledgeStore } = await import('../lib/store.js')
  const { cosine, normalize, toBlob, fromBlob, modelIdOf, hashText } = await import('../lib/embed.js')

  const dir = await mkdtemp(join(tmpdir(), 'kb-vec-'))
  const store = new KnowledgeStore(dir)
  await store.open()
  const col = store.ensureDefaultCollection()

  const chunks = [
    { text: '光合作用把光能转化为化学能', v: [0.9, 0.1, 0.0] },
    { text: '植物叶绿体进行光合作用产生氧气', v: [0.85, 0.15, 0.05] },
    { text: '马克思讨论商品拜物教与异化', v: [0.0, 0.1, 0.95] },
  ]
  const docId = store.createDocument({
    collectionId: col.id, title: 't', filename: 't.md', ext: 'md', size: 10, sha256: 'v1',
  })
  store.replaceChunks(docId, chunks.map((c, i) => ({ ord: i, text: c.text, tokens: 10 })))

  const model = modelIdOf('api', 'test', 3)
  store.saveEmbeddings(model, chunks.map((c, i) => ({
    chunkId: i + 1,
    dimension: 3,
    vec: toBlob(normalize(Float32Array.from(c.v))),
    textHash: hashText(c.text),
  })))

  if (store.countEmbeddings(model, col.id) !== 3) throw new Error('向量数不对')
  if (store.chunksNeedingEmbedding(model, col.id).length !== 0) throw new Error('不应再有待建项')

  const qv = normalize(Float32Array.from([0.88, 0.12, 0.02]))
  const rows = store.listVectors(col.id, model)
  const ranked = rows
    .map((r) => ({ text: r.text, sim: cosine(qv, fromBlob(r.vec)) }))
    .sort((a, b) => b.sim - a.sim)

  if (!ranked[0].text.includes('光合')) throw new Error('最相关项判错')
  if (ranked[0].sim < 0.9) throw new Error('相似度异常')
  if (ranked[2].sim > 0.2) throw new Error('无关项相似度过高')

  store.close()
  ok('向量存储与语义排序', `最相关 ${ranked[0].sim.toFixed(3)} / 最不相关 ${ranked[2].sim.toFixed(3)}`)
})

await test('API 嵌入错误处理', async () => {
  const { ApiEmbedder } = await import('../lib/embed.js')

  // 未填地址应立即报错，而不是发出请求
  const empty = new ApiEmbedder({ baseUrl: '', model: 'x' })
  let threw = false
  try { await empty.embedBatch(['a']) } catch { threw = true }
  if (!threw) throw new Error('空地址应报错')

  // 指向不存在的地址应给出可读错误
  const bad = new ApiEmbedder({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x', timeoutMs: 1500 })
  threw = false
  let message = ''
  try { await bad.embedBatch(['a']) } catch (error) { threw = true; message = error.message }
  if (!threw) throw new Error('不可达地址应报错')
  if (!message) throw new Error('错误信息为空')

  ok('API 嵌入错误处理', '空配置与不可达地址均有明确报错')
})

await test('维度一致性与语义检索（假服务端）', async () => {
  const { createServer } = await import('node:http')
  const { KnowledgeStore } = await import('../lib/store.js')
  const { ApiEmbedder, cosine, fromBlob, normalize, toBlob } = await import('../lib/embed.js')

  // 用关键词映射成向量的小型假服务，无需联网
  const DIM = 8
  const KEYMAP = { 光合: 0, 光能: 0, 植物: 0, 马克思: 3, 商品: 3, 异化: 3, 电路: 6, 十进制: 6 }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const { input, model } = JSON.parse(body)
      const data = input.map((text, index) => {
        const v = new Array(DIM).fill(0)
        for (const [kw, idx] of Object.entries(KEYMAP)) {
          if (text.includes(kw)) { v[idx] += 1; v[(idx + 1) % DIM] += 0.3 }
        }
        if (v.every((x) => x === 0)) v[7] = 1
        return { index, embedding: v, object: 'embedding' }
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', model, data }))
    })
  })

  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

    const dir = await mkdtemp(join(tmpdir(), 'kb-dim-'))
    const store = new KnowledgeStore(dir)
    await store.open()
    const col = store.ensureDefaultCollection()
    const docId = store.createDocument({
      collectionId: col.id, title: 'x', filename: 'x.md', ext: 'md', size: 1, sha256: 'dim1',
    })
    store.replaceChunks(docId, [
      '光合作用把光能转化',
      '马克思讨论异化',
      '数字电路十进制',
    ].map((t, i) => ({ ord: i, text: t, tokens: 5 })))

    const cfg = { baseUrl, model: 'test-embed', dimension: 0, batchSize: 2 }

    // 模拟修复后的流程：先探测维度，再写向量
    const probe = new ApiEmbedder(cfg)
    const tested = await probe.test()
    cfg.dimension = tested.dimension

    const stable = new ApiEmbedder(cfg)
    // modelId 必须只由配置决定，不依赖运行时探测
    if (probe.id !== stable.id) throw new Error('modelId 前后不一致')

    for (;;) {
      const pending = store.chunksNeedingEmbedding(stable.id, col.id, 64)
      if (pending.length === 0) break
      const vectors = await stable.embed(pending.map((p) => p.text))
      store.saveEmbeddings(stable.id, pending.map((p, i) => ({
        chunkId: p.chunk_id,
        dimension: vectors[i].length,
        vec: toBlob(normalize(Float32Array.from(vectors[i]))),
        textHash: 'h',
      })))
    }

    // 模拟重启：重新构造实例
    const fresh = new ApiEmbedder(cfg)
    if (fresh.id !== stable.id) throw new Error('重启后 modelId 变化')
    const rows = store.listVectors(col.id, fresh.id)
    if (rows.length !== 3) throw new Error(`重启后索引丢失，只剩 ${rows.length} 条`)

    // 语义命中：问「光能转化」应命中光合那句，而非电路那句
    const [qv] = await fresh.embed(['光能转化'])
    const qn = normalize(Float32Array.from(qv))
    const ranked = rows
      .map((r) => ({ text: r.text, sim: cosine(qn, fromBlob(r.vec)) }))
      .sort((a, b) => b.sim - a.sim)
    if (!ranked[0].text.includes('光合')) throw new Error('语义检索未命中正确文档')

    store.close()
    ok('维度一致性与语义检索', `重启后索引完好，命中「${ranked[0].text}」`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await test('切库清空检索状态（前端逻辑）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // switchCollection 必须清空这几项，否则会显示上一个库的内容
  const fn = src.match(/const switchCollection = useCallback\([\s\S]*?\}, \[activeId\]\)/)
  if (!fn) throw new Error('找不到 switchCollection')

  const body = fn[0]
  const required = [
    ['setHits(null)', '命中结果'],
    ["setQuery('')", '查询词'],
    ['setSearchMode(null)', '检索模式标记'],
    ['setExpanded(new Set())', '展开状态'],
    ['searchSeq.current++', '在途请求作废'],
  ]
  const missing = required.filter(([token]) => !body.includes(token))
  if (missing.length) {
    throw new Error(`switchCollection 缺少: ${missing.map(([, name]) => name).join('、')}`)
  }

  // 侧栏切库同样要清干净
  const paneSelect = src.match(/onChange: \(e\) => \{[\s\S]*?setActiveId\(Number\(e\.target\.value\)\)[\s\S]*?\},/)
  if (!paneSelect) throw new Error('找不到侧栏切库处理')
  if (!paneSelect[0].includes('setHits(null)')) throw new Error('侧栏切库未清空命中')

  // 删除文档后也应清空，避免悬空引用
  const del = src.match(/const removeDocument = useCallback\([\s\S]*?\}, \[activeId/)
  if (!del) throw new Error('找不到 removeDocument')
  if (!del[0].includes('setHits(null)')) throw new Error('删文档后未清空命中')

  ok('切库清空检索状态', `${required.length} 项状态均重置，含在途请求作废`)
})

// 8. P3：重排与本地模型
await test('重排配置归一化', async () => {
  const { resolveRerankConfig } = await import('../lib/rerank.js')

  // 非法输入要落到安全默认值
  const bad = resolveRerankConfig(null)
  if (bad.provider !== 'none') throw new Error('空配置应为 none')
  if (bad.api.topN !== 8) throw new Error('topN 默认值不对')

  const clamped = resolveRerankConfig({ provider: 'api', api: { topN: 999 } })
  if (clamped.api.topN > 50) throw new Error('topN 未做上限收敛')

  const styled = resolveRerankConfig({ provider: 'api', api: { style: 'cohere' } })
  if (styled.api.style !== 'cohere') throw new Error('style 未保留')

  const fallback = resolveRerankConfig({ provider: 'api', api: { style: '乱写' } })
  if (fallback.api.style !== 'openai') throw new Error('非法 style 应回落 openai')

  ok('重排配置归一化', '默认值 / 上限 / 风格回落均正确')
})

await test('重排结果应用', async () => {
  const { applyRerank } = await import('../lib/rerank.js')

  const candidates = [
    { id: 1, text: 'A' },
    { id: 2, text: 'B' },
    { id: 3, text: 'C' },
  ]

  // 重排把 C 排到最前，只取 2 条
  const out = applyRerank(candidates, [
    { index: 2, score: 0.9 },
    { index: 0, score: 0.5 },
    { index: 1, score: 0.1 },
  ], 2)

  if (out.length !== 2) throw new Error(`应返回 2 条，实际 ${out.length}`)
  if (out[0].id !== 3) throw new Error('排序未生效')
  if (out[0].rerankScore !== 0.9) throw new Error('分数未带上')

  // 重排返回空时应原样回落
  const fallback = applyRerank(candidates, [], 2)
  if (fallback.length !== 2) throw new Error('空重排应回落到原顺序')
  if (fallback[0].rerankScore !== null) throw new Error('回落时不应带分数')

  // 越界索引要忽略，不能崩
  const oob = applyRerank(candidates, [{ index: 99, score: 1 }], 2)
  if (oob.length === 0) throw new Error('越界索引导致结果为空')

  ok('重排结果应用', '排序 / 截断 / 空结果回落 / 越界防护均正确')
})

await test('本地模型目录管理', async () => {
  const { MODEL_CATALOG, inspectLocalModel, listLocalModels, downloadModel } =
    await import('../lib/models.js')

  // 目录清单完整性
  const ids = Object.keys(MODEL_CATALOG)
  if (ids.length < 3) throw new Error('模型清单过少')
  for (const id of ids) {
    const spec = MODEL_CATALOG[id]
    if (!spec.repo) throw new Error(`${id} 缺 repo`)
    if (!Array.isArray(spec.files) || spec.files.length === 0) throw new Error(`${id} 缺文件清单`)
    if (!spec.dim) throw new Error(`${id} 缺维度`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'kb-models-'))

  // 不存在的模型
  const none = await inspectLocalModel(dir, ids[0])
  if (none.complete) throw new Error('空目录不该判为完整')
  if (none.missing.length !== MODEL_CATALOG[ids[0]].files.length) throw new Error('缺失项统计不对')

  // 空目录列表
  const empty = await listLocalModels(join(dir, 'nope'))
  if (!Array.isArray(empty) || empty.length !== 0) throw new Error('不存在的目录应返回空数组')

  // 未知模型要报错
  let threw = false
  try {
    await downloadModel({ modelId: '不存在', modelsDir: dir })
  } catch { threw = true }
  if (!threw) throw new Error('未知模型应报错')

  ok('本地模型目录管理', `${ids.length} 个模型，缺失统计与错误处理正确`)
})

await test('依赖安装链路', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // 后端：三条必备环节
  const checks = [
    ['findNpm', 'npm 定位'],
    ['/api/dsh-knowbase/models/install-lib', '安装路由'],
    ['/api/dsh-knowbase/models/install-progress', '进度路由'],
    ['spawn(', '子进程调用'],
    ["'/c', npm", 'Windows cmd 包装'],
  ]
  const missing = checks.filter(([token]) => !host.includes(token))
  if (missing.length) throw new Error(`后端缺少: ${missing.map(([, n]) => n).join('、')}`)

  // 不能用 shell:true（会触发参数拼接告警）
  if (/spawn\([^)]*shell:\s*true/.test(host)) throw new Error('不应使用 shell:true')

  // 前端：一键按钮 + 轮询
  if (!client.includes('一键安装依赖')) throw new Error('前端缺一键安装按钮')
  if (!client.includes('models/install-progress')) throw new Error('前端缺进度轮询')

  ok('依赖安装链路', '5 个环节齐备，未使用 shell:true')
})

await test('本地模型缓存位置', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/embed-local.js', import.meta.url), 'utf8')

  /*
   * transformers 默认把模型缓存在 node_modules 里，
   * 重装依赖会丢模型。必须显式改到数据目录。
   */
  if (!src.includes('env.cacheDir')) {
    throw new Error('未设置 env.cacheDir，模型会下到 node_modules 里')
  }
  if (!src.includes('hf-cache')) {
    throw new Error('cacheDir 未指向数据目录')
  }

  // 镜像必须走 env.remoteHost（环境变量方式实测无效）
  if (!src.includes('env.remoteHost')) {
    throw new Error('未设置 env.remoteHost，镜像不会生效')
  }
  if (/process\.env\.HF_ENDPOINT\s*=/.test(src)) {
    throw new Error('不应依赖 HF_ENDPOINT 环境变量（实测 import 后无效）')
  }

  // 下载器与推理器的路径衔接：下载过的模型要能被直接加载，而不是重下
  if (!src.includes('resolveSource')) {
    throw new Error('缺少 resolveSource，下载过的模型不会被复用')
  }
  if (!src.includes('MODEL_CATALOG')) {
    throw new Error('未引用 MODEL_CATALOG，无法把 modelId 映射到仓库名')
  }

  ok('本地模型缓存位置', 'cacheDir 指向数据目录，镜像走 env.remoteHost，下载与推理路径已衔接')
})

await test('智能体工具与技能', async () => {
  const { readFileSync } = await import('node:fs')
  const toolsSrc = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  const skillSrc = readFileSync(new URL('../lib/skill.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

  // 计划书 12.3 要求的五个工具
  const required = ['kb_list', 'kb_search', 'kb_ingest', 'kb_source_fetch', 'kb_job']
  const missing = required.filter((name) => !toolsSrc.includes(`name: '${name}'`))
  if (missing.length) throw new Error(`缺少工具: ${missing.join('、')}`)

  // 每个工具都要有输出声明与执行体，否则注册会失败
  const registered = (toolsSrc.match(/register\(\{/g) ?? []).length
  if (registered < required.length) throw new Error(`注册数量不足: ${registered}`)

  // 关键：工具结果必须是无损 JSON，undefined 会导致校验失败
  if (!toolsSrc.includes('function clean(')) {
    throw new Error('缺少 clean()，undefined 字段会让工具结果校验失败')
  }

  // 不依赖 DSH 内部包（插件不在其模块解析上下文里）
  if (/from '@deepseek-ai\//.test(toolsSrc)) {
    throw new Error('不应 import @deepseek-ai 内部包（会 ERR_MODULE_NOT_FOUND）')
  }

  // 技能
  if (!skillSrc.includes("SKILL_NAME = 'knowledge-base'")) throw new Error('技能名不对')
  if (!skillSrc.includes('kb_search')) throw new Error('技能未指导模型使用 kb_search')

  // 注册点
  if (!host.includes("ctx.inject(['tools']")) throw new Error('未注册工具')
  if (!host.includes("ctx.inject(['skills']")) throw new Error('未注册技能')

  ok('智能体工具与技能', `${required.length} 个工具 + knowledge-base 技能，结果已做 JSON 清洗`)
})

await test('代码文档切块不再碎成单行', async () => {
  const { chunkSections, looksLikeCode, looksLikeHeading } = await import('../lib/chunk.js')

  // 判定函数
  if (!looksLikeCode('int sum = 0;')) throw new Error('未识别代码行')
  if (!looksLikeCode('    return result;')) throw new Error('未识别缩进代码')
  if (looksLikeCode('这是一段普通说明文字。')) throw new Error('把普通文字误判成代码')

  if (!looksLikeHeading('光反应')) throw new Error('未识别短标题')
  if (!looksLikeHeading('1. 研究背景')) throw new Error('未识别编号标题')
  if (looksLikeHeading('int x = 1;')) throw new Error('把代码行误判成标题')
  if (looksLikeHeading('这是一个完整的句子。')) throw new Error('把句子误判成标题')

  // 一整段代码应该合成少数几块，而不是每行一块
  const code = [
    'public class Main {',
    '  public static void main(String[] args) {',
    '    int sum = 0;',
    '    for (int i = 1; i <= 100; i++) {',
    '      sum += i;',
    '    }',
    '    System.out.println(sum);',
    '  }',
    '}',
  ].join('\n\n')   // 每行之间放空行，模拟 docx 每段一段

  const chunks = chunkSections([{ text: code }])
  if (chunks.length > 3) {
    throw new Error(`代码被切成 ${chunks.length} 块，应合并为少数几块`)
  }
  const total = chunks.reduce((sum, c) => sum + c.text.length, 0)
  if (total < 100) throw new Error('代码内容丢失')

  // 不应再有极短块
  const tiny = chunks.filter((c) => c.text.length < 20)
  if (tiny.length > 0) throw new Error(`仍有 ${tiny.length} 个碎片块`)

  ok('代码文档切块', `9 行代码 → ${chunks.length} 块，共 ${total} 字符`)
})

await test('抓取防护', async () => {
  const { isPrivateHost, parseRobots, isBlockedByRules, waitForSlot, resetFetchState } =
    await import('../lib/fetch-policy.js')

  // 内网必须拒绝，公网必须放行
  const mustBlock = ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', 'localhost', 'x.local', '169.254.1.1']
  const mustPass = ['arxiv.org', '8.8.8.8', '172.32.0.1', 'openstax.org']
  const wrongBlock = mustBlock.filter((h) => !isPrivateHost(h))
  const wrongPass = mustPass.filter((h) => isPrivateHost(h))
  if (wrongBlock.length) throw new Error(`应拒绝但放行: ${wrongBlock.join(', ')}`)
  if (wrongPass.length) throw new Error(`应放行但拒绝: ${wrongPass.join(', ')}`)

  // robots 解析：通配符与结尾锚点
  const rules = parseRobots([
    'User-agent: *',
    'Disallow: /admin/',
    'Disallow: /private/*',
    'Disallow: /*.pdf$',
    '',
    'User-agent: Googlebot',
    'Disallow: /',
  ].join('\n'))

  if (rules.length !== 3) throw new Error(`robots 规则数不对: ${rules.length}`)
  if (isBlockedByRules('/admin/x', rules) !== true) throw new Error('/admin/ 应被禁止')
  if (isBlockedByRules('/public/x', rules) !== false) throw new Error('/public/ 应允许')
  if (isBlockedByRules('/private/a/b', rules) !== true) throw new Error('通配符规则失效')
  if (isBlockedByRules('/doc.pdf', rules) !== true) throw new Error('结尾锚点规则失效')
  if (isBlockedByRules('/doc.html', rules) !== false) throw new Error('.html 不该被 *.pdf 规则拦')

  // 限速：连续两次请求同一站点应至少间隔 MIN_INTERVAL_MS
  resetFetchState()
  const t0 = Date.now()
  await waitForSlot('example.com')
  await waitForSlot('example.com')
  const elapsed = Date.now() - t0
  if (elapsed < 1800) throw new Error(`限速未生效，两次仅间隔 ${elapsed}ms`)

  ok('抓取防护', `内网拦截 / robots 通配符 / 限速 ${elapsed}ms 均生效`)
})

await test('权威来源清单', async () => {
  const { SOURCES, sourcesByTopic, sourceForHost } = await import('../lib/sources.js')

  if (SOURCES.length < 10) throw new Error('来源数量过少')

  // 每条都必须有许可说明——不能给用户来路不明的资料
  const noLicense = SOURCES.filter((s) => !s.license || s.license.trim() === '')
  if (noLicense.length) throw new Error(`缺少许可说明: ${noLicense.map((s) => s.id).join(', ')}`)

  // 必备字段
  const incomplete = SOURCES.filter((s) => !s.id || !s.name || !s.host || !s.entry)
  if (incomplete.length) throw new Error(`字段不全: ${incomplete.map((s) => s.id).join(', ')}`)

  // 主题分组：计划书要求至少覆盖自然科学与马列
  const groups = sourcesByTopic()
  const topics = groups.map((g) => g.topic)
  if (!topics.includes('science')) throw new Error('缺自然科学来源')
  if (!topics.includes('humanities')) throw new Error('缺人文社科学来源')

  // 域名反查
  if (sourceForHost('arxiv.org')?.id !== 'arxiv') throw new Error('归属反查失败')
  if (sourceForHost('export.arxiv.org')?.id !== 'arxiv') throw new Error('子域名反查失败')
  if (sourceForHost('unknown.example') !== null) throw new Error('未知域名应返回 null')

  ok('权威来源清单', `${SOURCES.length} 条，${groups.length} 个主题，许可信息齐全`)
})

await test('本地重排', async () => {
  const { resolveRerankConfig, createReranker } = await import('../lib/rerank.js')
  const { RERANK_MODELS } = await import('../lib/rerank-local.js')

  // 配置归一化要认 local
  const localCfg = resolveRerankConfig({ provider: 'local', local: { modelKey: 'bge-reranker-v2-m3' } })
  if (localCfg.provider !== 'local') throw new Error('provider=local 未被接受')
  if (!localCfg.local?.modelKey) throw new Error('缺少 local 配置')

  // 非法 provider 回落 none
  const bad = resolveRerankConfig({ provider: '乱写' })
  if (bad.provider !== 'none') throw new Error('非法 provider 未回落')

  // 模型清单完整性
  const keys = Object.keys(RERANK_MODELS)
  if (keys.length < 2) throw new Error('重排模型清单过少')
  for (const k of keys) {
    const spec = RERANK_MODELS[k]
    if (!spec.repo) throw new Error(`${k} 缺 repo`)
    if (!spec.sizeMB) throw new Error(`${k} 缺体积说明`)
  }

  // 工厂：local 应返回本地实现，none 应返回 null
  const factoryLocal = await createReranker({ provider: 'local', local: {} }, { modelsDir: '/tmp' })
  if (!factoryLocal) throw new Error('工厂未创建本地重排器')
  if (!factoryLocal.configured) throw new Error('本地重排器应默认可用')
  if (!String(factoryLocal.label).includes('本地')) throw new Error('本地重排 label 不对')

  const factoryNone = await createReranker({ provider: 'none' })
  if (factoryNone !== null) throw new Error('provider=none 应返回 null')

  ok('本地重排', `${keys.length} 个模型，配置与工厂正确`)
})

await test('i18n 字典完整性', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  const dictStart = src.indexOf('const DICT = {')
  const dictEnd = src.indexOf("const LOCALE_NS = 'dsh-knowbase'")
  if (dictStart < 0 || dictEnd < 0) throw new Error('找不到内联字典')

  const dict = src.slice(dictStart, dictEnd)
  const body = src.slice(dictEnd)

  // 中文、英文条数应一致
  const zhKeys = [...dict.matchAll(/'([a-z]+\.[a-zA-Z]+)':/g)].map((m) => m[1])
  const uniqueZh = new Set(zhKeys)
  if (uniqueZh.size < 50) throw new Error(`字典条目过少: ${uniqueZh.size}`)

  // 用到的 key 必须都存在，否则界面会显示原始 key
  const used = [...new Set([...body.matchAll(/t\('([a-z]+\.[a-zA-Z]+)'\)/g)].map((m) => m[1]))]
  const missing = used.filter((k) => !uniqueZh.has(k))
  if (missing.length) throw new Error(`字典缺 key: ${missing.join(', ')}`)

  // t() 只能在组件内部调用（组件外没有 t，会运行时崩溃）
  // 作用域自动发现：所有缩进 4 空格的具名函数都可能有闭包内的 t
  const lines = src.split('\n')
  const scopes = []
  for (let i = 0; i < lines.length; i++) {
    if (/^    (?:async )?function [A-Za-z_$][\w$]*\s*\(/.test(lines[i])) {
      // 从函数声明行开始，找缩进同为 4 空格的收尾 }
      let end = lines.length - 1
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === '    }') { end = j; break }
      }
      scopes.push([i, end])
    }
  }
  if (scopes.length < 8) throw new Error(`作用域发现异常，只找到 ${scopes.length} 个函数`)

  const outside = []
  for (let i = 0; i < lines.length; i++) {
    if (!/\bt\('/.test(lines[i])) continue
    if (/useT|setTranslator|function translate|const t = useT/.test(lines[i])) continue
    if (!scopes.some(([a, b]) => i >= a && i <= b)) outside.push(i + 1)
  }
  if (outside.length) throw new Error(`t() 在组件外调用，行: ${outside.join(', ')}`)

  ok('i18n 字典完整性', `${uniqueZh.size} 条，${used.length} 个使用中，${scopes.length} 个作用域`)
})

await test('数据库迁移与备份', async () => {
  const { KnowledgeStore } = await import('../lib/store.js')
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-'))
  try {
    // 全新库：不迁移
    const fresh = await new KnowledgeStore(dir).open()
    if (fresh.migratedFrom !== null) throw new Error('全新库不该触发迁移')
    fresh.createCollection('迁移测试')
    const before = fresh.listCollections().length
    fresh.close()

    // 重开同版本：不迁移
    const again = await new KnowledgeStore(dir).open()
    if (again.migratedFrom !== null) throw new Error('同版本不该触发迁移')
    if (again.listCollections().length !== before) throw new Error('数据丢了')
    again.close()

    // 把版本调低，模拟旧库升级
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(join(dir, 'kb.sqlite'))
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('0', 'schema_version')
    raw.close()

    const upgraded = await new KnowledgeStore(dir).open()
    if (!upgraded.migratedFrom) throw new Error('旧库未触发迁移')
    if (!upgraded.migratedFrom.backup) throw new Error('迁移前没有备份')
    if (upgraded.listCollections().length !== before) throw new Error('迁移后数据丢失')
    upgraded.close()

    const backups = readdirSync(dir).filter((f) => f.includes('.bak-'))
    if (backups.length === 0) throw new Error('没有生成备份文件')

    ok('数据库迁移与备份', `旧库升级自动备份 ${backups[0]}，数据完好`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('任务中断与导入上限', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

  // 任务管理四件套
  for (const name of ['createTask(', 'cancelTask(', 'listTasks(', 'throwIfAborted(']) {
    if (!host.includes(name)) throw new Error(`缺少 ${name}`)
  }

  // 上限常量
  if (!/MAX_INGEST_FILES = 200/.test(host)) throw new Error('缺少 200 文件上限')

  // 抓取必须能接收外部 signal，而不是只有超时
  if (!/fetchSource\(\{[^}]*signal/.test(host)) {
    throw new Error('fetchSource 未接收 signal，无法中断')
  }
  if (!host.includes('AbortSignal.any')) {
    // 允许用其他组合方式，但必须同时具备用户取消与超时
    if (!(host.includes('signal: signal') || host.includes('signal ?? '))) {
      throw new Error('抓取未把用户 signal 接到 fetch')
    }
  }

  // 存储统计与清空
  if (!/async usage\(\)/.test(host)) throw new Error('缺少 usage()')
  if (!/async wipe\(/.test(host)) throw new Error('缺少 wipe()')
  if (!host.includes('删除全部')) throw new Error('清空缺少二次确认短语')

  ok('任务中断与导入上限', '任务可取消 / 200 文件上限 / 存储统计与二次确认齐备')
})

await test('下载完整性校验', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/models.js', import.meta.url), 'utf8')

  // 必须真的比对哈希，而不是只定义函数
  if (!src.includes('sha256Of(buffer)')) {
    throw new Error('下载后没有调用 sha256Of 校验')
  }
  if (!/x-linked-etag|etag/.test(src)) {
    throw new Error('没有读取服务器声明的哈希')
  }
  if (!src.includes('哈希不匹配')) {
    throw new Error('哈希不符时没有拒绝该文件')
  }
  // 校验结果要回传，让界面能显示"已验证/仅大小"
  if (!src.includes('integrity')) throw new Error('未回传完整性状态')

  ok('下载完整性校验', '读取 etag 比对 sha256，不符则换镜像重试')
})

await test('OCR 配置与扫描件判定', async () => {
  const { resolveOcrConfig, looksScanned, MAX_OCR_PAGES } = await import('../lib/ocr.js')

  // 配置归一化
  const cfg = resolveOcrConfig({ provider: 'vision', baseUrl: 'https://x/v1/', model: 'm' })
  if (cfg.provider !== 'vision') throw new Error('provider 未接受')
  if (cfg.baseUrl !== 'https://x/v1') throw new Error('尾部斜杠未去掉')

  const bad = resolveOcrConfig({ provider: '乱写' })
  if (bad.provider !== 'none') throw new Error('非法 provider 未回落')

  // 上限必须被夹住，否则用户填 999 会烧光额度
  const clamped = resolveOcrConfig({ provider: 'vision', maxPages: 999 })
  if (clamped.maxPages !== MAX_OCR_PAGES) throw new Error(`maxPages 未夹到上限：${clamped.maxPages}`)
  const low = resolveOcrConfig({ provider: 'vision', maxPages: 0 })
  if (low.maxPages !== 1) throw new Error('maxPages 下界未生效')

  // 扫描件判定
  if (!looksScanned({ textLength: 10, pageCount: 30 })) throw new Error('扫描件未识别')
  if (looksScanned({ textLength: 20000, pageCount: 30 })) throw new Error('正常 PDF 被误判成扫描件')
  if (looksScanned({ textLength: 0, pageCount: 1 })) throw new Error('单页图片不该当扫描件')

  ok('OCR 配置与扫描件判定', `上限 ${MAX_OCR_PAGES} 页，判定阈值正确`)
})

await test('PDF 页面渲染', async () => {
  const { renderPdfPages } = await import('../lib/ocr.js')
  const { readFileSync, existsSync } = await import('node:fs')

  const candidate = 'C:/Users/34096/Desktop/111/生涯发展报告-游戏开发工程师.pdf'
  if (!existsSync(candidate)) {
    ok('PDF 页面渲染', '（跳过：测试 PDF 不存在）')
    return
  }

  const started = Date.now()
  const pages = await renderPdfPages(readFileSync(candidate), { maxPages: 1, scale: 1.5 })
  const ms = Date.now() - started

  if (pages.length !== 1) throw new Error(`应渲染 1 页，实际 ${pages.length}`)
  if (!pages[0].png || pages[0].png.length < 5000) {
    throw new Error(`PNG 太小，可能渲染失败（${pages[0].png?.length ?? 0} bytes）`)
  }
  // PNG 魔数校验
  const magic = pages[0].png.subarray(0, 8).toString('hex')
  if (magic !== '89504e470d0a1a0a') throw new Error('输出不是合法 PNG')

  ok('PDF 页面渲染', `1 页 ${ms}ms，PNG ${Math.round(pages[0].png.length / 1024)}KB`)
})

await test('推理设备默认 CPU', async () => {
  const { readFileSync } = await import('node:fs')
  const embedLocal = readFileSync(new URL('../lib/embed-local.js', import.meta.url), 'utf8')

  // 默认必须是 cpu——实测 DirectML 更慢，不能默认开
  if (!/this\.device = config\?\.device === 'dml' \? 'dml' : 'cpu'/.test(embedLocal)) {
    throw new Error('device 默认值不是 cpu')
  }
  // 实测结论必须写进代码，避免以后有人"优化"成默认 GPU
  if (!embedLocal.includes('10.1ms') || !embedLocal.includes('3.0ms')) {
    throw new Error('缺少实测数据注释，后人会误以为 GPU 更快')
  }

  ok('推理设备默认 CPU', 'DirectML 实测更慢的结论已写入代码注释')
})

await test('本地 OCR', async () => {
  const { LocalOcr, tidyText, OCR_LANGS, listLangs } = await import('../lib/ocr-local.js')

  // 文本清理：中文之间的空格要去掉，英文单词间的要留
  const zh = tidyText('光合 作用 把 光能 转化')
  if (zh.includes(' ')) throw new Error(`中文空格未清理：${JSON.stringify(zh)}`)
  const en = tidyText('OCR TEST 123')
  if (en !== 'OCR TEST 123') throw new Error(`英文空格被误删：${JSON.stringify(en)}`)

  // 语言清单
  if (!OCR_LANGS.chi_sim || !OCR_LANGS.eng) throw new Error('缺少中英文语言包定义')

  // 真实识别：画一张含中英文的图
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(520, 120)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 520, 120)
  ctx.fillStyle = '#000'
  ctx.font = '34px sans-serif'
  ctx.fillText('本地识别 TEST 2026', 18, 72)

  const modelsDir = 'C:/Users/34096/.dsh/knowbase/models'
  const status = await listLangs(modelsDir)
  if (!status.find((l) => l.lang === 'chi_sim')?.downloaded) {
    ok('本地 OCR', '（跳过识别：中文语言包未下载）')
    return
  }

  const ocr = new LocalOcr({ modelsDir, langs: ['chi_sim', 'eng'] })
  try {
    const started = Date.now()
    const text = await ocr.recognizeImage(canvas.toBuffer('image/png'))
    const ms = Date.now() - started
    if (!/TEST/i.test(text) || !/2026/.test(text)) {
      throw new Error(`识别结果不含预期内容：${JSON.stringify(text.slice(0, 80))}`)
    }
    ok('本地 OCR', `识别正确 ${ms}ms：${JSON.stringify(text.trim().slice(0, 40))}`)
  } finally {
    await ocr.dispose()
  }
})

await test('设备测速接口', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // 后端要有测速方法，且两种设备都测
  if (!/async benchDevice\(\)/.test(host)) throw new Error('缺少 benchDevice()')
  if (!host.includes("for (const device of ['cpu', 'dml'])")) {
    throw new Error('测速没有覆盖 cpu 和 dml 两种设备')
  }
  // 结论要交给数据算，不能写死
  if (!host.includes('verdict')) throw new Error('缺少结论计算')
  // 路由要挂上
  if (!host.includes("'/api/dsh-knowbase/bench-device'")) throw new Error('缺少测速路由')

  // 前端要有按钮与结果展示
  if (!client.includes('runBench')) throw new Error('前端缺少测速入口')

  ok('设备测速接口', 'CPU/DML 各测一次，结论由实测数据算')
})

/* ───────────────── 收尾 ───────────────── */

await rm(workDir, { recursive: true, force: true })

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`)
// 不直接 process.exit：让事件循环自然排空，避免 HTTP server 句柄未关闭时的 libuv 断言
if (fail > 0) process.exitCode = 1
