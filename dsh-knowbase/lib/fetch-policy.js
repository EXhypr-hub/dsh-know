/**
 * 抓取策略：计划书 5.3 的那套防护。
 *
 * 用户明确要求「做成开关，不要白名单硬约束」，所以：
 *   - 总开关默认**关闭**，关着就完全不联网
 *   - 打开后默认放行任意 http/https 站点
 *   - 但保留几条通用底线：禁内网、读 robots、同站点限速、体积上限、留痕
 *   - 想要的更严的话，可以额外填白名单（可选）
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** 同站点两次请求的最小间隔（毫秒） */
export const MIN_INTERVAL_MS = 2000

/** robots.txt 缓存有效期 */
const ROBOTS_TTL_MS = 60 * 60 * 1000

/** 记录每个站点的上次请求时间，实现限速 */
const lastRequestAt = new Map()

/** robots 规则缓存 */
const robotsCache = new Map()

/**
 * 把各种 IPv4 写法解析成四个 0–255 的数，解析不了返回 null。
 *
 * 必须覆盖这些变形，否则内网拦截形同虚设：
 *   2130706433      → 127.0.0.1（十进制整数）
 *   0x7f000001      → 127.0.0.1（十六进制）
 *   0177.0.0.1      → 127.0.0.1（八进制）
 *   127.1           → 127.0.0.1（省略段）
 */
function parseIpv4(host) {
  const parts = String(host).split('.')
  if (parts.length === 0 || parts.length > 4) return null

  const nums = []
  for (const part of parts) {
    if (part === '') return null
    let value
    if (/^0x[0-9a-f]+$/i.test(part)) value = parseInt(part.slice(2), 16)
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part.slice(1), 8)
    else if (/^\d+$/.test(part)) value = parseInt(part, 10)
    else return null
    if (!Number.isFinite(value) || value < 0) return null
    nums.push(value)
  }

  /*
   * 按 inet_aton 的规则展开：
   * 最后一段承载剩余的所有字节（127.1 → 127.0.0.1）。
   */
  const last = nums.pop()
  const maxLast = 256 ** (4 - nums.length)
  if (last >= maxLast) return null
  for (let i = nums.length - 1; i >= 0; i--) {
    if (nums[i] > 255) return null
  }
  const expanded = [...nums]
  for (let i = 4 - nums.length - 1; i >= 0; i--) {
    expanded.push(Math.floor(last / (256 ** i)) % 256)
  }
  return expanded.length === 4 ? expanded : null
}

/** 内网 / 回环 / 保留地址判断 */
export function isPrivateHost(hostname) {
  let host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true

  // IPv6 映射到 IPv4 的写法：::ffff:127.0.0.1
  const mapped = host.match(/^::ffff:(.+)$/)
  if (mapped) host = mapped[1]
  // 十六进制形式的尾部：::ffff:7f00:1
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    host = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') return true

  // 先按各种 IPv4 写法尝试解析，能解析就以解析结果为准
  const ipv4 = parseIpv4(host)
  if (ipv4) {
    const [a, b] = ipv4
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true            // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true   // 私有
    if (a === 192 && b === 168) return true            // 私有
    if (a === 100 && b >= 64 && b <= 127) return true  // 运营商级 NAT
    if (a >= 224) return true                          // 组播与保留
    return false
  }

  // IPv6 唯一本地 / 链路本地 / 组播
  if (/^f[cd]/.test(host) || host.startsWith('fe80') || host.startsWith('ff')) return true

  /*
   * 兜底：解析不出结构、但看起来全是数字与点和 x 的主机名，
   * 一律当作可疑地址拒绝——宁可误伤也不能放行内网。
   */
  if (/^[0-9a-fx.:]+$/.test(host) && /\d/.test(host)) return true

  return false
}

/**
 * DNS 层面的内网校验。
 *
 * 只看主机名字符串不够：攻击者可以注册一个公网域名，
 * 把 A/AAAA 记录指向 127.0.0.1（DNS rebinding）。
 * 发起请求前先把域名解析出来，所有 IP 都必须通过 isPrivateHost。
 *
 * @param {string} hostname
 * @returns {Promise<{ ok: true, addresses: string[] } | { ok: false, reason: string }>}
 */
export async function resolvePublicHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  // 已经是 IP 字面量：无需解析，直接复用字符串规则
  if (isIP(host) !== 0) {
    return isPrivateHost(host)
      ? { ok: false, reason: `内网地址：${host}` }
      : { ok: true, addresses: [host] }
  }
  if (isPrivateHost(host)) return { ok: false, reason: `内网地址：${host}` }

  let addresses
  try {
    const records = await lookup(host, { all: true, verbatim: true })
    addresses = records.map((r) => r.address)
  } catch (error) {
    return {
      ok: false,
      reason: `域名解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (addresses.length === 0) return { ok: false, reason: '域名没有解析到任何地址' }
  const blocked = addresses.filter((ip) => isPrivateHost(ip))
  if (blocked.length > 0) {
    return { ok: false, reason: `域名解析到了内网地址（${blocked.join(', ')}），已拒绝` }
  }
  return { ok: true, addresses }
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
      /*
       * 不跟随重定向：robots.txt 的抓取发生在内网校验之后，
       * 若站点把 robots 重定向到别处（含内网地址），跟随就会形成 SSRF。
       * 遇到 3xx 按「没有规则」处理，不追。
       */
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      robotsCache.set(origin, { at: now, rules: [] })
      return { allowed: true }
    }
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
