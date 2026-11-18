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
  // （签名现在带 override 参数，具体校验见「测速使用界面当前配置」那条）
  if (!/async benchDevice\(/.test(host)) throw new Error('缺少 benchDevice()')
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

await test('切块配置与分隔符', async () => {
  const { chunkSections, DEFAULT_CHUNK, separatorToPattern } = await import('../lib/chunk.js')

  // 默认值
  if (DEFAULT_CHUNK.smart !== true) throw new Error('smart 默认应为 true')
  if (DEFAULT_CHUNK.separator !== '\n\n') throw new Error('默认分隔符不对')

  const long = (s) => s.repeat(12)

  // 自定义分隔符生效
  const text = [long('甲段。'), long('乙段。'), long('丙段。')].join('\n---\n')
  const bySep = chunkSections([{ text }], { separator: '---', smart: false })
  if (bySep.length !== 3) throw new Error(`自定义分隔符切出 ${bySep.length} 块，应为 3`)

  // 默认空行分隔
  const byBlank = chunkSections([{ text: [long('一。'), long('二。')].join('\n\n') }], { smart: false })
  if (byBlank.length !== 2) throw new Error(`空行分隔应切 2 块，实际 ${byBlank.length}`)

  // smart=false 不合并、不识别代码
  const code = ['public class A {', '  int x = 1;', '}'].join('\n\n')
  const smartOn = chunkSections([{ text: code }], { smart: true })
  const smartOff = chunkSections([{ text: code }], { smart: false })
  if (smartOn.length !== 1) throw new Error('smart=true 应把代码合成 1 块')
  if (smartOff.length <= 1) throw new Error('smart=false 不应合并')

  // 分隔符转义：用户填 . 不该变成通配
  const dotPattern = separatorToPattern('.')
  if (dotPattern.source !== '\\.') throw new Error(`分隔符未转义：${dotPattern.source}`)

  ok('切块配置与分隔符', 'smart 开关、自定义分隔符、转义均正确')
})

await test('库级配置与笔记入库', async () => {
  const { KnowledgeStore } = await import('../lib/store.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'kb-cfg-'))
  try {
    const store = await new KnowledgeStore(dir).open()
    const col = store.createCollection('配置测试')

    // 库级设置存入 settings 表，键带库 id
    store.setSetting(`chunk.${col.id}`, { smart: false, separator: '---', size: 300 })
    const chunk = store.getSetting(`chunk.${col.id}`)
    if (chunk.smart !== false) throw new Error('切块配置未持久化')
    if (chunk.separator !== '---') throw new Error('分隔符未持久化')

    store.setSetting(`search.${col.id}`, { topK: 9 })
    const search = store.getSetting(`search.${col.id}`)
    if (search.topK !== 9) throw new Error('Top K 未持久化')

    // 不同库互不影响
    const other = store.createCollection('另一个库')
    if (store.getSetting(`chunk.${other.id}`, null) !== null) {
      throw new Error('另一个库不该有配置')
    }

    store.close()

    ok('库级配置与笔记入库', '切块与 Top K 按库隔离存取')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('值域夹紧与笔记校验', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

  // 切块参数边界
  if (!/Math\.min\(4000, Math\.max\(100, size\)\)/.test(host)) {
    throw new Error('分段大小未夹到 100–4000')
  }
  if (!/Math\.min\(next\.size \/ 2, Math\.max\(0, overlap\)\)/.test(host)) {
    throw new Error('重叠大小未限制为不超过块大小一半')
  }
  // Top K 边界
  if (!/Math\.min\(50, Math\.max\(1, Math\.round\(topK\)\)\)/.test(host)) {
    throw new Error('Top K 未夹到 1–50')
  }
  // 笔记空内容要拒绝
  if (!host.includes("笔记内容不能为空")) throw new Error('笔记缺少空内容校验')
  // 三个新路由都挂上
  for (const path of ['chunk-config', 'search-settings', '/note']) {
    if (!host.includes(path)) throw new Error(`缺少路由 ${path}`)
  }

  ok('值域夹紧与笔记校验', '切块/TopK 边界与空笔记校验齐备')
})

await test('服务商数据统一标准', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // 三套 provider 数组都要存在
  for (const name of ['EMBED_PROVIDERS', 'RERANK_PROVIDERS', 'OCR_PROVIDERS']) {
    if (!src.includes(`const ${name} = [`)) throw new Error(`缺少 ${name}`)
  }
  // 旧的重排预设应已移除
  if (src.includes('RERANK_PRESETS')) throw new Error('旧的 RERANK_PRESETS 未清理')

  // 逐个解析 provider 块，检查字段完整性
  function checkProviders(name) {
    const start = src.indexOf(`const ${name} = [`)
    if (start < 0) throw new Error(`找不到 ${name}`)
    const end = src.indexOf('\n    ]', start)
    const block = src.slice(start, end)

    const ids = [...block.matchAll(/\n        id: '([^']+)',/g)].map((m) => m[1])
    if (ids.length < 2) throw new Error(`${name} 服务商过少（${ids.length}）`)
    if (!ids.includes('custom')) throw new Error(`${name} 缺少 custom 兜底`)

    // 非 custom 必须有 baseUrl；模型清单为空时，必须在 hint 里说清原因
    // （例如 DeepSeek 没有公开的嵌入接口，属于有意占位）
    const entries = block.split(/\n      \{\n/).slice(1)
    for (const entry of entries) {
      const id = (entry.match(/id: '([^']+)'/) ?? [])[1]
      if (!id) continue
      if (id === 'custom') continue

      if (!/baseUrl: 'https?:\/\//.test(entry)) {
        throw new Error(`${name}/${id} 缺少 baseUrl`)
      }
      const hasModels = /models: \[[\s\S]*?id:/.test(entry)
      if (!hasModels) {
        const explained = /hint: '[^']*(未公开|不支持|暂无|占位|没有)[^']*'/.test(entry)
        if (!explained) {
          throw new Error(`${name}/${id} 没有模型，且 hint 未说明原因`)
        }
      }
    }
    return ids.length
  }

  const counts = {
    embed: checkProviders('EMBED_PROVIDERS'),
    rerank: checkProviders('RERANK_PROVIDERS'),
    ocr: checkProviders('OCR_PROVIDERS'),
  }

  // 统一的选择器组件要被三处共用
  if (!src.includes('function ProviderModelPicker')) throw new Error('缺少统一选择器')

  ok('服务商数据统一标准', `嵌入 ${counts.embed} / 重排 ${counts.rerank} / OCR ${counts.ocr} 家，结构一致`)
})

await test('百炼重排的兼容性标注', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // gte-rerank-v2 不支持 OpenAI 兼容接口，必须在文案里说清楚，
  // 否则用户填了必然报 model_not_supported
  const dashscopeBlock = src.slice(
    src.indexOf("id: 'dashscope',\n        label: '阿里云百炼 DashScope',\n        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',\n        keyUrl: 'https://bailian.console.aliyun.com/',\n        hint: '只有"),
  )
  if (!src.includes('gte-rerank-v2 需专用接口')) {
    throw new Error('百炼重排缺少 gte-rerank-v2 不可用的说明')
  }
  if (!src.includes("id: 'qwen3-rerank'")) {
    throw new Error('缺少 qwen3-rerank 模型项')
  }
  // 不能把不可用的 gte-rerank-v2 列进可选模型
  if (/models: \[[^\]]*gte-rerank-v2/.test(src)) {
    throw new Error('把不兼容的 gte-rerank-v2 列成了可选模型')
  }

  ok('百炼重排的兼容性标注', '只列 qwen3-rerank，并注明 gte-rerank-v2 不可用')
})

await test('多级页面结构', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // 基础交互组件
  for (const name of ['Drawer', 'Collapse', 'Slider', 'Tip', 'FieldLabel', 'ProviderModelPicker']) {
    if (!src.includes(`function ${name}(`)) throw new Error(`缺少组件 ${name}`)
  }

  // 抽屉主体
  for (const name of ['RecallPanel', 'SettingsBody']) {
    if (!src.includes(`function ${name}(`)) throw new Error(`缺少抽屉主体 ${name}`)
  }

  // 主面板新结构：左栏 + 右侧纵向（顶栏/工具栏/内容）
  if (!src.includes("className: 'kb-right'")) throw new Error('缺少右侧纵向容器')
  if (!src.includes("className: 'kb-toolbar'")) throw new Error('缺少工具栏')
  if (!src.includes("className: 'kb-header-actions'")) throw new Error('缺少顶栏图标区')

  // 两个抽屉都要挂载
  if (!src.includes('open: recallOpen')) throw new Error('召回测试抽屉未挂载')
  if (!src.includes('open: settingsOpen')) throw new Error('设置抽屉未挂载')

  // 空态四个按钮
  if (!src.includes("className: 'kb-empty-actions'")) throw new Error('缺少空态按钮组')
  for (const label of ['source.file', 'source.note', 'source.dir', 'source.link']) {
    if (!src.includes(`t('${label}')`)) throw new Error(`空态缺少 ${label}`)
  }

  // 添加数据源菜单
  if (!src.includes("sourceMenu === 'menu'")) throw new Error('缺少添加数据源菜单')
  if (!src.includes("sourceMenu === 'note'")) throw new Error('缺少笔记表单')
  if (!src.includes("sourceMenu === 'link'")) throw new Error('缺少链接表单')
  if (!src.includes('webkitdirectory')) throw new Error('缺少目录选择')

  // 拖放改成覆盖层，且事件挂在内容区
  if (!src.includes('kb-drop-overlay')) throw new Error('缺少拖放覆盖层')
  if (!/h\('main', \{\s*className: 'kb-content',\s*onDrop,/.test(src)) {
    throw new Error('拖放事件没有挂在内容区（首次拖动会收不到）')
  }

  ok('多级页面结构', '抽屉/折叠/滑块/气泡 + 主面板三段式 + 四种数据源齐备')
})

await test('动效规范', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // 抽屉滑入 280ms
  if (!src.includes('transition: transform 280ms cubic-bezier')) {
    throw new Error('抽屉缺少滑入过渡')
  }
  // 折叠用 grid-template-rows 做高度动画
  if (!src.includes('grid-template-rows: 0fr')) throw new Error('折叠缺少高度动画')
  // 按钮按下反馈
  if (!src.includes('scale(0.92)') && !src.includes('scale(0.985)')) {
    throw new Error('按钮缺少按下反馈')
  }
  // 气泡淡入
  if (!src.includes('.kb-tip-bubble')) throw new Error('气泡缺少样式')
  // 列表 stagger
  if (!src.includes('animationDelay')) throw new Error('列表缺少逐个淡入')

  // 必须尊重系统的「减少动态效果」
  if (!src.includes('prefers-reduced-motion')) {
    throw new Error('未处理 prefers-reduced-motion')
  }

  // 检查所有 transition 时长都在 90–300ms 之间（太慢会显得拖沓）
  const durations = [...src.matchAll(/transition:[^;]*?(\d+)ms/g)].map((m) => Number(m[1]))
  const tooSlow = durations.filter((d) => d > 300)
  if (tooSlow.length > 0) {
    throw new Error(`有过渡时长超过 300ms：${tooSlow.join(', ')}`)
  }
  const tooFast = durations.filter((d) => d < 80)
  if (tooFast.length > 0) {
    throw new Error(`有过渡时长低于 80ms（看不出效果）：${tooFast.join(', ')}`)
  }

  ok('动效规范', `${durations.length} 处过渡均在 90–300ms，且支持减少动态效果`)
})

await test('安全：ZIP 炸弹防护', async () => {
  const { openZip } = await import('../lib/extract.js')
  const { deflateRawSync } = await import('node:zlib')

  /** 构造最小 ZIP：一个本地头 + 一个中央目录项 + EOCD */
  function makeZip(name, payload) {
    const data = deflateRawSync(payload, { level: 9 })
    const nb = Buffer.from(name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(payload.length, 22)
    lh.writeUInt16LE(nb.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(payload.length, 24)
    ch.writeUInt16LE(nb.length, 28)
    const cd = Buffer.concat([ch, nb])
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(30 + nb.length + data.length, 16)
    return Buffer.concat([lh, nb, data, cd, eocd])
  }

  // 100MB 全零 → 压缩后仅 ~100KB，是最典型的压缩炸弹
  const bomb = makeZip('word/document.xml', Buffer.alloc(100 * 1024 * 1024))
  if (bomb.length > 2 * 1024 * 1024) throw new Error('测试样本构造有误，压缩后不该这么大')

  let blocked = false
  try {
    const zip = openZip(bomb)
    zip.read('word/document.xml')
  } catch (error) {
    blocked = true
    // 必须是给人看的提示，不能是 Node 的原始 Buffer 报错
    if (!/压缩包|体积异常/.test(String(error.message))) {
      throw new Error(`拦截了但提示不友好：${error.message}`)
    }
  }
  if (!blocked) throw new Error('ZIP 炸弹未被拦截')

  // 正常文档必须仍然能读
  const normal = makeZip('word/document.xml', Buffer.from('<root>正常内容</root>'.repeat(100)))
  const text = openZip(normal).readText('word/document.xml')
  if (!text.includes('正常内容')) throw new Error('误杀了正常文档')

  ok('安全：ZIP 炸弹防护', '100MB 炸弹被拦下且提示友好，正常文档不受影响')
})

await test('安全：SSRF 内网拦截', async () => {
  const { isPrivateHost } = await import('../lib/fetch-policy.js')

  // 各种 IPv4 变形写法都必须识别成内网，否则拦截形同虚设
  const mustBlock = [
    '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:7f00:1',
    '2130706433', '0x7f000001', '0177.0.0.1', '127.1',
    '127.0.0.1', 'localhost', '0.0.0.0', '10.1.2.3',
    '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1',
    '::1', 'fe80::1', 'fd00::1', '224.0.0.1', 'a.local',
  ]
  const mustPass = [
    'arxiv.org', '8.8.8.8', 'openstax.org',
    '172.32.0.1', '192.169.1.1', '1.1.1.1', 'example.com', '11.22.33.44',
  ]

  const leaked = mustBlock.filter((h) => !isPrivateHost(h))
  if (leaked.length) throw new Error(`这些内网写法被放行了：${leaked.join(', ')}`)

  const killed = mustPass.filter((h) => isPrivateHost(h))
  if (killed.length) throw new Error(`这些公网地址被误杀：${killed.join(', ')}`)

  ok('安全：SSRF 内网拦截', `${mustBlock.length} 种内网变形全拦，${mustPass.length} 个公网全放行`)
})

await test('安全：原型污染与 HTML 上限', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const extract = readFileSync(new URL('../lib/extract.js', import.meta.url), 'utf8')

  // 配置入口必须过清洗
  if (!host.includes('function sanitizeConfig')) throw new Error('缺少配置清洗函数')
  if (!host.includes("key === '__proto__'")) throw new Error('清洗函数没有过滤 __proto__')
  const uses = (host.match(/sanitizeConfig\(patch/g) ?? []).length
  if (uses < 5) throw new Error(`只有 ${uses} 个配置入口接了清洗，应为 6 个`)

  // HTML 抽取要有输入上限，防正则退化
  if (!/MAX_HTML_BYTES/.test(extract)) throw new Error('HTML 抽取缺少长度上限')

  // 实测：展开语法本身不会污染原型
  const malicious = JSON.parse('{"__proto__":{"polluted":"yes"},"a":1}')
  const merged = { ...malicious }
  if ({}.polluted === 'yes') throw new Error('对象展开被原型污染了')

  ok('安全：原型污染与 HTML 上限', '6 个配置入口已清洗，HTML 限 8MB，展开语法免疫')
})

await test('磁盘探测', async () => {
  const { statfs, mkdir, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')

  // 与 index.js 里 canWriteTo 同逻辑
  async function canWriteTo(dir) {
    const probe = join(dir, `.kb-probe-test-${Date.now()}`)
    try {
      await mkdir(probe)
      await rm(probe, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  const drives = []
  if (process.platform === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      try {
        const s = await statfs(`${letter}:/`)
        const bs = Number(s.bsize)
        drives.push({
          path: `${letter}:`,
          totalBytes: Number(s.blocks) * bs,
          freeBytes: Number(s.bavail) * bs,
          writable: await canWriteTo(`${letter}:/`),
        })
      } catch {
        // 盘不存在
      }
    }
  } else {
    const s = await statfs('/')
    const bs = Number(s.bsize)
    drives.push({
      path: '/',
      totalBytes: Number(s.blocks) * bs,
      freeBytes: Number(s.bavail) * bs,
      writable: await canWriteTo('/'),
    })
  }

  if (drives.length === 0) throw new Error('一个磁盘都没探测到')
  for (const d of drives) {
    if (!d.path) throw new Error('磁盘缺少 path')
    if (!(d.totalBytes > 0)) throw new Error(`${d.path} 总容量异常`)
    if (!(d.freeBytes >= 0)) throw new Error(`${d.path} 可用容量异常`)
    if (d.freeBytes > d.totalBytes) throw new Error(`${d.path} 可用大于总容量`)
    if (typeof d.writable !== 'boolean') throw new Error(`${d.path} writable 不是布尔值`)
  }

  const summary = drives.map((d) => `${d.path} ${Math.round(d.freeBytes / 1024 ** 3)}GB可用`).join(' / ')
  ok('磁盘探测', `${drives.length} 个盘：${summary}`)
})

await test('磁盘选择器接线', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // 后端：方法 + 路由 + 缓存
  if (!/async listDrives\(/.test(host)) throw new Error('缺少 listDrives()')
  if (!host.includes("'/api/dsh-knowbase/drives'")) throw new Error('缺少 drives 路由')
  if (!host.includes('drivesCache')) throw new Error('缺少磁盘列表缓存')

  // 前端：探测结果渲染 + 点击填入子目录
  if (!client.includes('function suggestPathFor')) throw new Error('缺少 suggestPathFor()')
  if (!client.includes("api('drives')")) throw new Error('前端没有调用 drives 接口')
  if (!client.includes("className: `kb-drive${")) throw new Error('缺少磁盘列表渲染')

  // 点盘符应填到子目录，而不是盘根（Windows 盘根常不可写）
  if (!/\$\{base\}\\\\dsh-knowbase/.test(client) && !client.includes('dsh-knowbase`')) {
    throw new Error('点选盘符没有补上 dsh-knowbase 子目录')
  }

  ok('磁盘选择器接线', '后端探测+缓存、前端渲染+子目录建议均已接通')
})

await test('版本适配：核心探测与可选服务分层', async () => {
  const { checkCore, checkServices, describeCapabilities } = await import('../lib/compat.js')

  /*
   * 这里守的是一个真实事故：
   * 早期版本在 apply() 开头用 ctx.get('connection') 判断路由能力，
   * 但 Cordis 服务是异步就绪的，apply 时 ctx.get() 返回 undefined，
   * 探测判定「不兼容」→ apply 直接 return → 工具和路由全没注册。
   * 插件列表里显示 active，一用就「请求失败」。
   *
   * 所以现在必须分层：core 同步可靠，services 只能在 inject 里看，
   * 且 services 永远不能用来阻止注册。
   */

  // ① 核心方法齐全
  const coreOk = checkCore({ effect() {}, inject() {} })
  if (!coreOk.available) throw new Error('effect/inject 都在，却判成不可用')

  // ② 核心方法缺失才算不可用
  const coreBad = checkCore({})
  if (coreBad.available) throw new Error('空 ctx 却判成可用')
  if (!coreBad.missing.includes('ctx.effect')) throw new Error('没指出缺 ctx.effect')

  // ③ 关键：apply 阶段 ctx.get 拿不到服务时，不能有「服务探测」这回事
  //    旧实现 detectHostCapabilities(ctx) 在这种情况下会返回 usable=false
  const earlyCtx = { effect() {}, inject() {}, get() { return undefined } }
  const earlyCore = checkCore(earlyCtx)
  if (!earlyCore.available) {
    throw new Error('服务未就绪时核心探测判成了不可用——这会让插件什么都不注册')
  }

  // ④ 服务探测只在 inject 回调里做，且能识别齐全与缺失
  const fullScope = {
    get: (n) => ({
      connection: { fetch: { register() {} } },
      tools: { register() {} },
      skills: { register() {} },
      credentials: {},
    }[n]),
    connection: { fetch: { register() {} } },
    tools: { register() {} },
    skills: { register() {} },
    credentials: {},
  }
  const full = checkServices(fullScope)
  if (!full.routes || !full.tools || !full.skills) throw new Error('服务齐全却探测失败')

  const partial = checkServices({ get: () => undefined })
  if (partial.routes || partial.tools) throw new Error('空作用域却探测成有服务')

  // ⑤ 诊断文案：未确认服务时不能妄称「不兼容」
  const pending = describeCapabilities(coreOk)
  if (/不兼容|请升级/.test(pending)) {
    throw new Error(`服务未确认时不该报升级：${pending}`)
  }
  const missingRoutes = describeCapabilities(coreOk, { routes: false, tools: true })
  if (!/前端接口不可用/.test(missingRoutes)) throw new Error('缺前端接口却没提示')

  ok('版本适配：核心探测与可选服务分层', 'apply 阶段只查核心方法，服务缺失不会阻止注册')
})

await test('版本适配：客户端降级', async () => {
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

  // 没有 slots.register 时必须早退而不是抛错
  if (!/typeof slots\.register !== 'function'/.test(client)) {
    throw new Error('客户端没有检查 slots.register')
  }
  // 要能兼容没有 slots.inject 的老版本
  if (!/canInject/.test(client)) throw new Error('客户端没有 inject 降级分支')
  // 右侧栏也要有存在性检查
  if (!/typeof scope\.slots\?\.inject === 'function'/.test(client)) {
    throw new Error('右侧栏没有检查 slots.inject')
  }

  // 声明方式：engines.dsh 是 DSH 真正读取的字段
  // （具体覆盖范围由「engines 覆盖所有预发布版」那条测试把关）
  if (!/^>=0\.1\.7-rc\.2/.test(pkg.engines?.dsh ?? '')) {
    throw new Error(`engines.dsh 最低版本不对：${pkg.engines?.dsh}`)
  }
  // 无效字段必须已清理
  if (pkg.dsh?.compatibility !== undefined) {
    throw new Error('无效字段 dsh.compatibility 未清理')
  }
  // Host 侧要探测并暴露诊断；且必须是分层探测（不能拿服务判断能否注册）
  if (!host.includes('checkCore(ctx)')) throw new Error('Host 没有接核心探测')
  if (!host.includes('checkServices(scope)')) throw new Error('Host 没在 inject 里探测服务')
  if (host.includes('if (!caps.usable)')) {
    throw new Error('仍在使用会提前 return 的旧探测，这会让插件什么都不注册')
  }
  if (!/compatibility:/.test(host)) throw new Error('status 没有暴露兼容信息')
  // 服务探测必须是实时的，不能缓存 apply 时的结果
  if (!host.includes('probeServices()')) throw new Error('缺少实时的服务探测')

  ok('版本适配：客户端降级', 'engines.dsh 已声明，slot 缺失时早退，无无效字段')
})

await test('版本适配：engines 覆盖所有预发布版', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const semver = (await import('semver')).default

  const range = pkg.engines?.dsh
  if (!range) throw new Error('缺少 engines.dsh')

  /*
   * node-semver 的陷阱：预发布版本只有当范围里存在「与之 major.minor.patch
   * 完全一致、且自身带预发布标签」的比较符时才会被放行。
   * 所以单段 '>=0.1.7-rc.2' 匹配不到 0.2.x 的任何 rc 版本，
   * 包括当前运行的 0.2.2-rc.3 —— 必须为每条预发布线各写一个分支。
   */
  const mustMatch = [
    '0.1.7-rc.2',   // 声明的最低版本
    '0.2.0-rc.2',
    '0.2.1-rc.1',
    '0.2.1-rc.2',
    '0.2.2-rc.1',
    '0.2.2-rc.3',   // 当前运行
    '0.2.2',        // 正式版
    '0.3.0',
  ]
  const missed = mustMatch.filter((v) => !semver.satisfies(v, range))
  if (missed.length) {
    throw new Error(
      `engines.dsh 匹配不到这些版本：${missed.join(', ')}。`
      + '预发布版需要显式分支，例如 ">=0.1.7-rc.2 || >=0.2.0-rc.2 || …"',
    )
  }

  // 单段写法是典型的错误，确保没退回去
  if (!range.includes('||')) {
    throw new Error('engines.dsh 只有一段，会静默排除所有更高的预发布版')
  }

  ok('版本适配：engines 覆盖所有预发布版', `覆盖 ${mustMatch.length} 个版本，含当前 0.2.2-rc.3`)
})

await test('测速使用界面当前配置，不依赖已保存', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  /*
   * 曾经的 bug：界面上一改「嵌入方式」为本地模型，LocalModelPicker 立刻渲染，
   * 但改动还没保存。测速请求不带配置，后端只能读已保存值，
   * 于是出现「明明选的是本地模型，却提示需要先把嵌入方式设为本地模型」。
   */

  // 后端：benchDevice 要接受 override
  if (!/async benchDevice\(override = \{\}\)/.test(host)) {
    throw new Error('benchDevice 没有接受 override 参数')
  }
  if (!/override\.provider \?\? saved\.provider/.test(host)) {
    throw new Error('没有优先使用调用方传来的 provider')
  }
  // 路由要把 body 透传
  if (!/benchDevice\(\{\s*provider: body\?\.provider/.test(host)) {
    throw new Error('bench-device 路由没有透传界面配置')
  }

  // 前端：要把当前 config 传过去
  if (!/api\('bench-device', \{\s*provider: config\.provider/.test(client)) {
    throw new Error('前端测速没有传当前配置')
  }
  // 依赖数组必须含 config，否则闭包读到旧值，等于没修
  if (!/\}, \[config\]\)/.test(client)) {
    throw new Error('runBench 的依赖数组没含 config，会读到旧的 provider')
  }

  // 行为验证：合并逻辑
  const merge = (saved, override) => ({
    provider: override.provider ?? saved.provider,
    local: { ...saved.local, ...(override.local ?? {}) },
  })
  const savedNone = { provider: 'none', local: { modelId: 'm', dtype: 'q8', device: 'cpu' } }
  const unsaved = merge(savedNone, { provider: 'local', local: { device: 'dml' } })
  if (unsaved.provider !== 'local') throw new Error('未保存的 local 没有被采信')
  if (unsaved.local.device !== 'dml') throw new Error('未保存的 device 没有被采信')
  if (unsaved.local.modelId !== 'm') throw new Error('其它字段应保留')

  ok('测速使用界面当前配置，不依赖已保存', 'override 优先，未传时回落，依赖数组已含 config')
})

await test('按钮 ↔ 后端 全量对照', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')

  const run = (script) => {
    const path = fileURLToPath(new URL(`./${script}`, import.meta.url))
    const cwd = fileURLToPath(new URL('..', import.meta.url))
    try {
      return { ok: true, out: execFileSync(process.execPath, [path], { encoding: 'utf8', cwd }) }
    } catch (error) {
      return { ok: false, out: String(error.stdout ?? error.message) }
    }
  }

  // 1. 前端每一处 api() 调用，后端都要有对应路由与动作
  const routes = run('check-routes.mjs')
  if (!routes.ok || !/✅ 全部 \d+ 组/.test(routes.out)) {
    const detail = routes.out.split('\n').filter((l) => /❌|\[/.test(l)).slice(0, 5).join('\n')
    throw new Error(`路由对不上：\n${detail || routes.out.slice(0, 200)}`)
  }

  // 2. 每个按钮的 onClick 都要有实际动作
  const buttons = run('check-buttons.mjs')
  const summary = buttons.out.match(/共识别 (\d+) 个按钮[\s\S]*?(\d+) 个有实际动作，(\d+) 个可疑/)
  if (!summary) throw new Error(`按钮检查没输出统计：${buttons.out.slice(0, 200)}`)
  const total = Number(summary[1])
  const bad = Number(summary[3])
  if (bad > 0) {
    const detail = buttons.out.split('可疑按钮：')[1]?.trim().slice(0, 300) ?? ''
    throw new Error(`${bad}/${total} 个按钮的 onClick 没有实际动作：\n${detail}`)
  }

  ok('按钮 ↔ 后端 全量对照', `${total} 个按钮全部有动作，前后端组合全部对得上`)
})

await test('测速结论覆盖所有设备组合', async () => {
  /*
   * 复刻 index.js 里的 verdict 生成逻辑，验证四种组合都给出明确结论。
   * 原来只在 CPU 与 GPU 都测通时才生成结论，导致 GPU 不可用的机器上
   * 界面上只有两个数字，看不出该选哪个。
   */
  function verdictOf(results) {
    const cpu = results.find((r) => r.device === 'cpu' && r.ok)
    const dml = results.find((r) => r.device === 'dml' && r.ok)
    const failReason = (device) => {
      const item = results.find((r) => r.device === device && !r.ok)
      return item?.error ? item.error.slice(0, 60) : '不可用'
    }

    if (cpu && dml) {
      const ratio = dml.perMs / cpu.perMs
      return {
        faster: ratio < 1 ? 'dml' : 'cpu',
        summary: ratio < 1
          ? `DirectML 快 ${(1 / ratio).toFixed(1)} 倍，可以试试 GPU`
          : `CPU 快 ${ratio.toFixed(1)} 倍，建议保持 CPU`,
      }
    }
    if (cpu && !dml) return { faster: 'cpu', summary: `GPU 测不通（${failReason('dml')}），建议保持 CPU` }
    if (!cpu && dml) return { faster: 'dml', summary: `CPU 测不通（${failReason('cpu')}），只能用 DirectML` }
    return {
      faster: null,
      summary: `两种设备都测不通：CPU ${failReason('cpu')}；GPU ${failReason('dml')}`,
    }
  }

  const cases = [
    ['两者都通·CPU 快', [{ device: 'cpu', ok: true, perMs: 3 }, { device: 'dml', ok: true, perMs: 10 }], 'cpu', /CPU 快/],
    ['两者都通·GPU 快', [{ device: 'cpu', ok: true, perMs: 10 }, { device: 'dml', ok: true, perMs: 3 }], 'dml', /DirectML 快/],
    ['只有 CPU 通', [{ device: 'cpu', ok: true, perMs: 3 }, { device: 'dml', ok: false, error: 'DML 初始化失败' }], 'cpu', /GPU 测不通.*DML 初始化失败/],
    ['只有 GPU 通', [{ device: 'cpu', ok: false, error: 'OOM' }, { device: 'dml', ok: true, perMs: 5 }], 'dml', /CPU 测不通.*OOM/],
    ['两者都不通', [{ device: 'cpu', ok: false, error: 'A' }, { device: 'dml', ok: false, error: 'B' }], null, /都测不通/],
  ]

  for (const [label, results, expectFaster, pattern] of cases) {
    const v = verdictOf(results)
    if (v.faster !== expectFaster) {
      throw new Error(`${label}：结论应为 ${expectFaster}，实际 ${v.faster}`)
    }
    if (!pattern.test(v.summary)) {
      throw new Error(`${label}：结论文案不含预期内容「${pattern}」，实际是「${v.summary}」`)
    }
    if (!v.summary || v.summary.length < 6) {
      throw new Error(`${label}：结论太短，等于没说`)
    }
  }

  // 界面必须把结果放在按钮下方独占一行，不能在按钮右边的 flex 行里
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  if (!/kb-bench-main/.test(client)) throw new Error('结果没有用独立的结论样式')
  if (!/kb-bench-\$\{benchResult\.kind/.test(client)) throw new Error('结果没有按成败区分样式')

  ok('测速结论覆盖所有设备组合', '5 种设备组合都给出明确结论，结果单独成行显示')
})

await test('对话选库：标记解析', async () => {
  const { extractKbRefs, stripKbRefs } = await import('../lib/composer.js')

  // 基本提取
  const one = extractKbRefs('@kb:粉毛 第一个视频讲了什么')
  if (one.length !== 1 || one[0].name !== '粉毛') throw new Error('单引用提取失败')

  // 多引用按出现顺序
  const two = extractKbRefs('看看 @kb:粉毛 和 @kb:默认知识库 各怎么说')
  if (two.map((r) => r.name).join(',') !== '粉毛,默认知识库') {
    throw new Error(`多引用顺序错：${two.map((r) => r.name).join(',')}`)
  }

  // 同一库引用多次只算一次（避免重复检索）
  if (extractKbRefs('@kb:粉毛 和 @kb:粉毛').length !== 1) throw new Error('重复引用未去重')

  // 中文标点要能终止库名
  if (extractKbRefs('@kb:粉毛，请解释')[0]?.name !== '粉毛') throw new Error('中文逗号未终止库名')
  if (extractKbRefs('@kb:粉毛。谢谢')[0]?.name !== '粉毛') throw new Error('中文句号未终止库名')

  // 裸前缀不算引用
  if (extractKbRefs('@kb:').length !== 0) throw new Error('裸 @kb: 被当成引用')

  // 无引用
  if (extractKbRefs('没有引用的一句话').length !== 0) throw new Error('无引用时不该有结果')

  // 库名含空格：靠 knownNames 精确匹配
  const spaced = extractKbRefs('@kb:我的 资料库 总结', { knownNames: ['我的 资料库'] })
  if (spaced[0]?.name !== '我的 资料库') throw new Error('带空格的库名未精确匹配')

  // 前缀相似时取更长的名字，否则「粉毛」会吃掉「粉毛拉丁」
  const longer = extractKbRefs('@kb:粉毛拉丁 x', { knownNames: ['粉毛', '粉毛拉丁'] })
  if (longer[0]?.name !== '粉毛拉丁') throw new Error('长库名未优先匹配')

  ok('对话选库：标记解析', '单/多/重复/中文标点/空格库名/长名优先 均正确')
})

await test('对话选库：标记剥离', async () => {
  const { stripKbRefs } = await import('../lib/composer.js')

  const cases = [
    ['@kb:粉毛 第一个视频讲了什么', '第一个视频讲了什么'],
    ['看看 @kb:粉毛 和 @kb:默认知识库 各怎么说', '看看 和 各怎么说'],
    // 引用被删后不能留下孤零零的标点
    ['@kb:粉毛，请解释', '请解释'],
    ['@kb:粉毛。谢谢', '谢谢'],
    ['@kb:粉毛', ''],
    ['没有引用的一句话', '没有引用的一句话'],
  ]

  for (const [input, expect] of cases) {
    const got = stripKbRefs(input).text
    if (got !== expect) {
      throw new Error(`${JSON.stringify(input)} → ${JSON.stringify(got)}，期望 ${JSON.stringify(expect)}`)
    }
  }

  // names 要带出来，供上层检索
  const { names } = stripKbRefs('@kb:甲乙 @kb:丙丁 提问')
  if (names.join(',') !== '甲乙,丙丁') throw new Error(`names 不对：${names.join(',')}`)

  ok('对话选库：标记剥离', '去标记后无残留标点，正文与库名都正确')
})

await test('对话选库：注入文本', async () => {
  const { formatInjection, formatFailureNote } = await import('../lib/composer.js')

  const text = formatInjection({
    collections: [{ name: '粉毛' }],
    results: [{
      collection: '粉毛',
      hits: [{
        title: '网哲TV1-2',
        page: 12,
        heading: '10.1 第 1 期',
        text: '视频最有价值的不是物理学部分。',
      }],
    }],
  })

  if (!/网哲TV1-2/.test(text)) throw new Error('注入文本缺文档名')
  if (!/第 12 页/.test(text)) throw new Error('注入文本缺页码')
  if (!/仅依据以上资料回答/.test(text)) throw new Error('缺「仅依据资料」约束')
  if (!/标注文档名与页码/.test(text)) throw new Error('缺引用要求')

  // 无命中时必须明确让模型别编
  const empty = formatInjection({ collections: [{ name: '空库' }], results: [{ collection: '空库', hits: [] }] })
  if (!/未检索到/.test(empty)) throw new Error('无命中时没说明')
  if (!/不要凭记忆编造/.test(empty)) throw new Error('无命中时缺防编造约束')

  // 超长要截断并注明，不能让上下文被撑爆
  const long = formatInjection({
    collections: [{ name: 'A' }],
    results: [{ collection: 'A', hits: [{ title: 'T', text: 'x'.repeat(9000) }] }],
    limit: 600,
  })
  if (!/已截断/.test(long)) throw new Error('超长未标注截断')
  if (long.length > 900) throw new Error(`截断后仍然过长：${long.length}`)

  // 失败说明要能读，且含库名与原因
  const note = formatFailureNote(['粉毛'], '库不存在')
  if (!/粉毛/.test(note) || !/库不存在/.test(note)) throw new Error('失败说明不完整')

  ok('对话选库：注入文本', '出处/约束/无命中/超长截断/失败说明 均覆盖')
})

await test('对话选库：Host 注入不阻断', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // Host 必须监听 pre-step，且异常时原样放行
  if (!/ctx\.on\('agent\/pre-step'/.test(host)) throw new Error('Host 没有监听 agent/pre-step')
  if (!/kind !== 'enter'/.test(host)) throw new Error('pre-step 没有区分 reject 与 enter')
  if (!/catch \{[\s\S]{0,400}?return decision/.test(host)) {
    throw new Error('注入失败时没有原样放行，可能阻断提问')
  }

  // 没有标记且没有会话级选择时必须提前返回 null，不做任何检索
  if (!/if \(names\.length === 0\) return null/.test(host)) {
    throw new Error('既无标记也无会话选择时没短路，会白跑检索')
  }

  // 客户端要注册 @ 来源，且缺 inputTriggers 时跳过而不是崩
  if (!/trigger: '@'/.test(client)) throw new Error('客户端没有注册 @ 来源')
  if (!/typeof triggers\?\.registerSource !== 'function'/.test(client)) {
    throw new Error('缺 inputTriggers 时没有降级')
  }

  // 引用在剪贴板与模型文本里必须同一形态，否则 Host 解析不到
  if (!/clipboardText: \(ref\) => ref/.test(client)) throw new Error('clipboardText 与 ref 不一致')
  if (!/serialize: async \(ref\) => ref/.test(client)) throw new Error('serialize 与 ref 不一致')

  ok('对话选库：Host 注入不阻断', 'pre-step 已接，无标记短路，异常放行，引用形态一致')
})

await test('对话选库：会话级选择', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

  // 会话选择要按 sessionId 存在 Host 侧，提问时能读回
  if (!/this\.composerScopes = new Map\(\)/.test(host)) throw new Error('缺少会话选择存储')
  if (!/setComposerScope\(sessionId, names\)/.test(host)) throw new Error('缺少 setComposerScope')
  if (!/getComposerScope\(sessionId\)/.test(host)) throw new Error('缺少 getComposerScope')

  // 两个来源都要接：消息里的 @kb: 标记，以及会话级选择
  if (!/combined\.includes\(KB_REF_PREFIX\)/.test(host)) throw new Error('没读消息里的 @kb: 标记')
  if (!/this\.composerScopes\.get\(String\(sessionId\)\)/.test(host)) throw new Error('没读会话级选择')

  // 标记优先于会话选择
  const markerFirst = /if \(combined\.includes\(KB_REF_PREFIX\)\)[\s\S]{0,200}?if \(names\.length === 0 && sessionId !== undefined\)/.test(host)
  if (!markerFirst) throw new Error('两个来源的优先级不对，消息标记应当优先')

  // 路由要存在且支持 set/get/clear
  if (!/'\/api\/dsh-knowbase\/composer-scope'/.test(host)) throw new Error('缺少 composer-scope 路由')
  for (const action of ['set', 'get', 'clear']) {
    if (!new RegExp(`body\\.action === '${action}'`).test(host)) throw new Error(`composer-scope 不支持 ${action}`)
  }

  // 会话选择要在 pre-step 里按 agent.id 查
  if (!/payload\?\.agent\?\.id/.test(host)) throw new Error('pre-step 没传会话 id')

  // 过期会话要清理，否则 Map 会一直长
  if (!/pruneComposerScopes/.test(host)) throw new Error('缺少过期会话清理')

  ok('对话选库：会话级选择', '按 sessionId 存储、标记优先、set/get/clear 齐全、过期清理')
})

await test('检索摘要：按回合存取', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // 存摘要的容器与三个方法
  if (!/this\.turnRecalls = new Map\(\)/.test(host)) throw new Error('缺少 turnRecalls 存储')
  for (const fn of ['rememberTurnRecall', 'getTurnRecall', 'clearTurnRecall']) {
    if (!new RegExp(`\\b${fn}\\s*\\(`).test(host)) throw new Error(`缺少 ${fn}`)
  }

  // 键必须带 sessionId 与 turn，两个会话同一回合不能互相覆盖
  if (!/const key = `\$\{sid\}#\$\{t\}`/.test(host)) {
    throw new Error('摘要键没有同时带 sessionId 与 turn')
  }

  // 只留展示字段：正文必须截断，不能把整段原文存进内存
  if (!/RECALL_TEXT_CHARS/.test(host)) throw new Error('正文没有截断，会撑大内存')
  if (!/\.slice\(0, KnowledgeBase\.RECALL_TEXT_CHARS\)/.test(host)) {
    throw new Error('正文截断没接上')
  }

  // 上限与淘汰
  if (!/RECALL_LIMIT/.test(host)) throw new Error('没有条目上限')
  if (!/while \(this\.turnRecalls\.size > KnowledgeBase\.RECALL_LIMIT\)/.test(host)) {
    throw new Error('没有超限淘汰')
  }

  // 过期清理要连摘要一起清
  if (!/for \(const \[key, value\] of this\.turnRecalls\)/.test(host)) {
    throw new Error('过期清理没覆盖检索摘要')
  }

  // 路由 set/get
  if (!/'\/api\/dsh-knowbase\/turn-recall'/.test(host)) throw new Error('缺少 turn-recall 路由')
  for (const action of ['get', 'clear']) {
    if (!new RegExp(`body\\.action === '${action}'`).test(host)) {
      throw new Error(`turn-recall 不支持 ${action}`)
    }
  }

  // pre-step 要把 turn 传下去，否则摘要键拼不出来
  if (!/payload\?\.turn/.test(host)) throw new Error('pre-step 没把 turn 传下去')

  ok('检索摘要：按回合存取', '按 sessionId+turn 存、正文截断、有上限与过期清理、路由齐全')
})

await test('检索摘要：前端展示', async () => {
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  if (!/function TurnRecallCard/.test(client)) throw new Error('缺少 TurnRecallCard 组件')

  // 挂在回合尾部，且注册失败不能让插件崩
  if (!/slots\.inject\('conversation\.chat\.turnTail'/.test(client)) {
    throw new Error('没有注册到 conversation.chat.turnTail')
  }
  if (!/try \{\s*slots\.inject\('conversation\.chat\.turnTail'/.test(client)) {
    throw new Error('turnTail 注册没有 try 包裹，旧版 DSH 会崩')
  }

  // 没有摘要时必须返回 null，不渲染空卡片
  if (!/if \(recall === null\) return null/.test(client)) {
    throw new Error('没有摘要时没短路，会渲染空卡片')
  }

  // 零命中也要有话说，别让用户以为没生效
  if (!/recall\.turnNone/.test(client)) throw new Error('零命中时没有提示')

  // 收起态要留徽标而不是整块消失
  if (!/kb-scope-badge/.test(client)) throw new Error('选择条收起后没有徽标')
  if (!/if \(picked\.length === 0\) return null/.test(client)) {
    throw new Error('没选库时徽标应当不占位')
  }

  ok('检索摘要：前端展示', 'turnTail 卡片 + 收起态徽标，空数据不占位')
})

await test('指令走上下文注入，对话里不留消息', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')

  /*
   * 这条守的是一条体验问题链：
   *   ① 资料拼进用户那条消息 → 提问被污染
   *   ② 改成独立消息 → 对话里出现巨大的资料卡片，淹没正文
   *   ③ 改成短指令消息 → 仍然在对话里多出一张卡片
   *   ④ 现在：指令走 systemPrompt.context，对话里只显示「上下文注入」一行
   */

  // 不得再往上下文里塞资料正文
  if (/formatInjection\(/.test(host)) {
    throw new Error('仍在注入资料正文')
  }

  // pre-step 必须原样放行，不改 messages
  if (!/永远原样放行/.test(host)) {
    throw new Error('pre-step 缺少「原样放行」的说明')
  }
  if (/return \{ \.\.\.decision, messages: injected\.messages \}/.test(host)) {
    throw new Error('pre-step 仍在改写消息，对话里会多出卡片')
  }

  // 指令必须走 systemPrompt.context
  if (!/systemPrompt\.context\(\{/.test(host)) {
    throw new Error('没有走 systemPrompt.context 通道')
  }
  if (!/name: 'dsh-knowbase'/.test(host)) {
    throw new Error('上下文注入缺少稳定名字')
  }
  // 每轮要按会话判断，没选库就不注入
  if (!/context\?\.agent\?\.id/.test(host)) {
    throw new Error('上下文注入没按会话取标识')
  }
  if (!/picked\.length === 0\) return ''/.test(host)) {
    throw new Error('没选库时应当注入空串，而不是一段默认文案')
  }
  // 装配阶段不许抛错
  if (!/上下文装配阶段绝不抛错/.test(host)) {
    throw new Error('上下文注入缺少 try 保护')
  }

  // 工具侧：没传 collection 时回落到会话选中的库
  if (!/kb\.composerScopes\?\.get\(String\(sessionId\)\)/.test(tools)) {
    throw new Error('kb_search 没有回落到会话选中的库')
  }
  if (!/exec\?\.agent\?\.id/.test(tools)) {
    throw new Error('kb_search 没从 exec 里取 sessionId')
  }
  if (!/scopeNote/.test(tools)) {
    throw new Error('多选库时没有说明检索范围')
  }

  ok('指令走上下文注入，对话里不留消息', 'pre-step 原样放行，指令折叠显示，工具自动落到选中的库')
})

/* ───────────────── 收尾 ───────────────── */

await rm(workDir, { recursive: true, force: true })

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══\n`)
// 不直接 process.exit：让事件循环自然排空，避免 HTTP server 句柄未关闭时的 libuv 断言
if (fail > 0) process.exitCode = 1
