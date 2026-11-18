/**
 * 对话里的知识库引用（`@kb:名称`）的解析与注入文本拼装。
 *
 * 这里全是纯函数，不碰网络与数据库，方便单独测试。
 * 写入方是客户端 composer 的 `@` 来源，读出方是 Host 的 agent/pre-step。
 *
 * 标记为什么长这样：
 *   带上 `kb:` 前缀是为了不和 DSH 自己的 `@file` / `@session` 撞车；
 *   clipboardText 与 serialize 返回同一个形态，复制粘贴能还原。
 */

/** 引用前缀 */
export const KB_REF_PREFIX = '@kb:'

/**
 * 名称的终止字符。
 * 中文场景下库名后面常常直接跟标点，所以中英文标点都要算边界。
 */
const NAME_STOP = new Set([
  ' ', '\t', '\n', '\r',
  '@', '#', '/', '\\',
  ',', '.', ';', ':', '!', '?',
  '，', '。', '；', '：', '！', '？', '、', '（', '）', '「', '」', '《', '》',
])

/**
 * 从文本里找出所有 `@kb:名称`。
 *
 * @param {string} text
 * @param {{ knownNames?: readonly string[] }} [options]
 *   传入库名清单时按清单精确匹配（优先匹配更长的名字），
 *   这样带空格的库名也能正确识别。
 * @returns {{ name: string, index: number, raw: string }[]} 去重并按出现顺序
 */
export function extractKbRefs(text, options = {}) {
  const source = typeof text === 'string' ? text : ''
  if (source === '' || !source.includes(KB_REF_PREFIX)) return []

  const known = Array.isArray(options.knownNames)
    ? [...options.knownNames].filter((n) => typeof n === 'string' && n !== '').sort((a, b) => b.length - a.length)
    : null

  const found = []
  let cursor = 0

  while (cursor < source.length) {
    const at = source.indexOf(KB_REF_PREFIX, cursor)
    if (at < 0) break

    const nameStart = at + KB_REF_PREFIX.length
    let name = ''

    if (known !== null) {
      // 已知库名：取最长匹配，避免「粉毛」把「粉毛拉丁」吃掉
      const hit = known.find((n) => source.startsWith(n, nameStart))
      if (hit !== undefined) name = hit
    }

    if (name === '') {
      // 未知库名：吃到边界为止
      let end = nameStart
      while (end < source.length && !NAME_STOP.has(source[end])) end++
      name = source.slice(nameStart, end)
    }

    if (name === '') {
      // 形如裸的 `@kb:`，跳过这个前缀继续找
      cursor = nameStart
      continue
    }

    found.push({ name, index: at, raw: source.slice(at, nameStart + name.length) })
    cursor = nameStart + name.length
  }

  // 去重保序：同一个库引用多次只需检索一次
  const seen = new Set()
  return found.filter((ref) => {
    if (seen.has(ref.name)) return false
    seen.add(ref.name)
    return true
  })
}

/**
 * 把 `@kb:名称` 从正文里去掉，同时不留下双空格。
 *
 * @param {string} text
 * @param {{ knownNames?: readonly string[] }} [options]
 * @returns {{ text: string, names: string[] }}
 */
export function stripKbRefs(text, options = {}) {
  const source = typeof text === 'string' ? text : ''
  const refs = extractKbRefs(source, options)
  if (refs.length === 0) return { text: source, names: [] }

  let out = source
  // 从后往前删，位置才不会被前面的删除影响
  for (const ref of [...refs].reverse()) {
    out = out.slice(0, ref.index) + out.slice(ref.index + ref.raw.length)
  }

  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    // 引用被删掉后，开头常常留下一个孤零零的逗号或句号
    .replace(/^[\s，。；：、,.!?！？;:]+/, '')
    .trim()

  return { text: out, names: refs.map((r) => r.name) }
}

/** 注入资料的字符上限，避免把上下文挤爆 */
export const INJECTION_LIMIT = 6000

/**
 * 拼装要追加到本轮上下文里的资料块。
 *
 * @param {object} input
 * @param {{ name: string, note?: string }[]} input.collections 本次引用的库
 * @param {{ collection: string, hits: object[], note?: string }[]} input.results 每库的检索结果
 * @param {number} [input.limit] 字符上限
 * @returns {string}
 */
export function formatInjection({ collections = [], results = [], limit = INJECTION_LIMIT } = {}) {
  const names = collections.map((c) => c?.name).filter(Boolean)
  if (names.length === 0) return ''

  const lines = []
  lines.push(`【知识库资料】本轮已加载：${names.map((n) => `「${n}」`).join('、')}`)
  lines.push('')

  let hasAnyHit = false
  let truncated = 0

  for (const result of results) {
    const hits = Array.isArray(result?.hits) ? result.hits : []
    if (hits.length === 0) {
      lines.push(`「${result?.collection ?? '?'}」未检索到相关内容${result?.note ? `（${result.note}）` : ''}。`)
      lines.push('')
      continue
    }

    hasAnyHit = true
    lines.push(`「${result.collection}」命中 ${hits.length} 条：`)
    for (const [i, hit] of hits.entries()) {
      const where = []
      if (hit?.title) where.push(`《${hit.title}》`)
      if (hit?.page !== undefined && hit?.page !== null) where.push(`第 ${hit.page} 页`)
      if (hit?.heading) where.push(hit.heading)
      const locator = where.length > 0 ? where.join(' · ') : '未标注出处'

      const body = String(hit?.text ?? '').replace(/\s+\n/g, '\n').trim()
      lines.push(`[${i + 1}] ${locator}`)
      lines.push(body)
      lines.push('')
    }
    if (result.note) lines.push(`（${result.note}）`)
  }

  lines.push(
    hasAnyHit
      ? '请仅依据以上资料回答；每处结论后标注文档名与页码，例如「（《书名》第 3 页）」。资料不足以回答时，请明确说明「资料中未提及」。'
      : '以上知识库未检索到可用于回答本问题的资料。请如实告知用户没有找到相关内容，不要凭记忆编造。',
  )

  let text = lines.join('\n').trim()

  // 超长就截断，并明确标注，避免模型以为资料到这里就没了
  if (text.length > limit) {
    truncated = text.length - limit
    text = text.slice(0, limit).trimEnd()
      + `\n\n（资料过长已截断，省略约 ${truncated} 字符）`
  }

  return text
}

/**
 * 库不存在、检索报错这类情况，也给出可读的说明而不阻断发送。
 *
 * @param {string[]} names
 * @param {string} reason
 * @returns {string}
 */
export function formatFailureNote(names, reason) {
  const list = names.map((n) => `「${n}」`).join('、')
  return `【知识库资料】本轮本想加载 ${list}，但未成功：${reason}。`
    + '\n请如实告知用户这次没有取到知识库资料，不要凭记忆编造。'
}
