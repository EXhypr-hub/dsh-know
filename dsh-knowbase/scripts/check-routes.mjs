#!/usr/bin/env node
/**
 * 路由对照检查：前端每一处 api() 调用，后端是否都真的处理。
 *
 * 做法：把 index.js 按 `route('/api/dsh-knowbase/xxx'` 切块，
 * 每块视为该路由的处理体，从中抽出它认得的 action；
 * 再扫 client.js 里每一处 api('<路由>', {...action...})，
 * 逐条确认后端确实处理。
 *
 * 对不上就是死按钮：点了会 404 或返回「未知操作」。
 */

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
const host = readFileSync(join(ROOT, 'index.js'), 'utf8')

/* ── 1. 后端：按 route(...) 切块 ── */

const MARK = "route('/api/dsh-knowbase/"
const parts = host.split(MARK)
const routeBlocks = new Map()

for (let i = 1; i < parts.length; i++) {
  const chunk = parts[i]
  const nameMatch = chunk.match(/^([a-z-]+)'/)
  if (!nameMatch) continue
  const name = nameMatch[1]
  const body = chunk.slice(0, 4000)

  const actions = new Set()
  for (const a of body.matchAll(/action === '([a-zA-Z-]+)'/g)) actions.add(a[1])
  for (const a of body.matchAll(/\bcase '([a-zA-Z-]+)'/g)) actions.add(a[1])

  routeBlocks.set(name, { actions, hasActions: actions.size > 0 })
}

/* ── 2. 前端：每一处 api 调用及 action ── */

const calls = []
const callRe = /api\(['"]([a-z-]+)['"]\s*,\s*\{([\s\S]{0,400}?)\}\s*\)/g
let m
while ((m = callRe.exec(client)) !== null) {
  const [, route, obj] = m
  const actionMatch = obj.match(/action:\s*['"]([a-zA-Z-]+)['"]/)
  const line = client.slice(0, m.index).split('\n').length
  calls.push({ route, action: actionMatch ? actionMatch[1] : null, line })
}

const bareRe = /api\(['"]([a-z-]+)['"]\s*\)/g
while ((m = bareRe.exec(client)) !== null) {
  const line = client.slice(0, m.index).split('\n').length
  calls.push({ route: m[1], action: null, line })
}

/* ── 3. 对照 ── */

const problems = []
const okList = []
const seen = new Set()

for (const call of calls) {
  const key = `${call.route}|${call.action ?? ''}`
  if (seen.has(key)) continue
  seen.add(key)

  const block = routeBlocks.get(call.route)
  if (!block) {
    problems.push({
      kind: '路由不存在',
      line: call.line,
      detail: `前端调 api('${call.route}')，后端没有 /api/dsh-knowbase/${call.route} 路由`,
    })
    continue
  }
  if (call.action && block.hasActions && !block.actions.has(call.action)) {
    problems.push({
      kind: '动作未处理',
      line: call.line,
      detail: `后端 ${call.route} 不处理 action='${call.action}'（支持：${[...block.actions].join(', ')}）`,
    })
    continue
  }
  okList.push(call)
}

/* ── 4. 输出 ── */

console.log(`后端路由 ${routeBlocks.size} 个，前端调用 ${calls.length} 处（去重 ${seen.size} 组）`)

if (problems.length > 0) {
  console.log(`\n❌ ${problems.length} 处对不上：`)
  for (const p of problems) {
    console.log(`  [${p.kind}] client.js:${p.line} — ${p.detail}`)
  }
} else {
  console.log(`✅ 全部 ${seen.size} 组前后端组合都能对上`)
  console.log(`   支持的组合：${okList.map((c) => `${c.route}${c.action ? '→' + c.action : ''}`).sort().join(', ')}`)
}

process.exitCode = problems.length === 0 ? 0 : 1
