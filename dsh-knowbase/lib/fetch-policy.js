/**
 * 抓取策略：计划书 5.3 的那套防护。
 *
 * 用户明确要求「做成开关，不要白名单硬约束」，所以：
 *   - 总开关默认**关闭**，关着就完全不联网
 *   - 打开后默认放行任意 http/https 站点
 *   - 但保留几条通用底线：禁内网、读 robots、同站点限速、体积上限、留痕
 *   - 想要的更严的话，可以额外填白名单（可选）
 */

/** 同站点两次请求的最小间隔（毫秒） */
export const MIN_INTERVAL_MS = 2000

/** robots.txt 缓存有效期 */
const ROBOTS_TTL_MS = 60 * 60 * 1000

/** 记录每个站点的上次请求时间，实现限速 */
const lastRequestAt = new Map()

/** robots 规则缓存 */
const robotsCache = new Map()

/** 内网 / 回环 / 保留地址判断 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::') return true

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }

  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
  return false
}

/** 同站点限速：等到距上次请求满 MIN_INTERVAL_MS */
export async function waitForSlot(host) {
  const key = String(host ?? '').toLowerCase()
  const last = lastRequestAt.get(key) ?? 0
  const elapsed = Date.now() - last
  if (elapsed < MIN_INTERVAL_MS) {
    const delay = MIN_INTERVAL_MS - elapsed
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  lastRequestAt.set(key, Date.now())
}

/**
 * 简易 robots.txt 解析：只看 User-agent: * 分组下的 Disallow。
 * 命中时返回 { allowed: false, reason }。
 */
export function parseRobots(text) {
  const rules = []
  let inGroup = false

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue

    const [rawKey, ...rest] = line.split(':')
    const key = rawKey.trim().toLowerCase()
    const value = rest.join(':').trim()

    if (key === 'user-agent') {
      inGroup = value === '*'
      continue
    }
    if (!inGroup) continue

    if (key === 'disallow' && value !== '') rules.push(value)
  }
  return rules
}

/** 判断路径是否被 robots 禁止 */
export function isBlockedByRules(pathname, rules) {
  const path = String(pathname ?? '/')
  return rules.some((rule) => {
    // 简单前缀匹配；支持通配符 * 与结尾 $
    if (rule.includes('*') || rule.endsWith('$')) {
      const pattern = rule
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$/, '$')
      try {
        return new RegExp(`^${pattern}`).test(path)
      } catch {
        return false
      }
    }
    return path.startsWith(rule)
  })
}

/**
 * 检查 robots.txt 是否允许抓取该路径。
 * 读不到 robots（404 / 网络失败）时按「允许」处理，这是通行做法。
 */
export async function checkRobots(targetUrl, { timeoutMs = 8000 } = {}) {
  let parsed
  try {
    parsed = new URL(targetUrl)
  } catch {
    return { allowed: false, reason: '网址格式不正确' }
  }

  const origin = parsed.origin
  const now = Date.now()
  const cached = robotsCache.get(origin)
  if (cached && now - cached.at < ROBOTS_TTL_MS) {
    return {
      allowed: !isBlockedByRules(parsed.pathname, cached.rules),
      reason: cached.rules.length > 0 ? `robots.txt 有 ${cached.rules.length} 条 Disallow` : undefined,
    }
  }

  try {
    const res = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dsh-knowbase/0.3 (+local knowledge base)' },
    })
    if (!res.ok) {
      robotsCache.set(origin, { at: now, rules: [] })
      return { allowed: true }
    }
    const rules = parseRobots(await res.text())
    robotsCache.set(origin, { at: now, rules })
    if (isBlockedByRules(parsed.pathname, rules)) {
      return { allowed: false, reason: `robots.txt 禁止抓取该路径（${parsed.pathname}）` }
    }
    return { allowed: true }
  } catch {
    // 拿不到 robots.txt 时按允许处理
    robotsCache.set(origin, { at: now, rules: [] })
    return { allowed: true }
  }
}

/** 清空缓存（测试用） */
export function resetFetchState() {
  lastRequestAt.clear()
  robotsCache.clear()
}
