#!/usr/bin/env node
/**
 * 按钮级检查：逐个看 h('button', {...}) 的 onClick 到底做了什么。
 *
 * 用括号配平提取完整的属性对象——不能用非贪婪正则，
 * 按钮属性里常有 style: {...} 和模板字符串 ${}，正则会提前截断造成误报。
 *
 * 检查项：
 *   - 有没有 onClick
 *   - onClick 是否为空函数
 *   - onClick 引用的具名函数在本文件里是否真的定义过
 *   - onClick 是否有实际副作用
 */

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'client.js'), 'utf8')

/** 从 openIndex 处的 '{' 开始，返回配对的 '}' 的下标 */
function matchBrace(text, openIndex) {
  let depth = 0
  let quote = null
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    const prev = text[i - 1]

    if (quote) {
      if (ch === quote && prev !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/* ── 收集所有 button ── */

const buttons = []
const needle = "h('button'"
let cursor = 0

while (true) {
  const at = src.indexOf(needle, cursor)
  if (at < 0) break
  cursor = at + needle.length

  // 找到属性对象的起始花括号
  let braceStart = -1
  for (let i = at + needle.length; i < Math.min(at + 200, src.length); i++) {
    if (src[i] === '{') { braceStart = i; break }
    if (src[i] === ',' ) { /* 可能是 h('button', null, ...) */ }
  }

  let props = ''
  let afterProps = at + needle.length
  if (braceStart >= 0) {
    const braceEnd = matchBrace(src, braceStart)
    if (braceEnd > 0) {
      props = src.slice(braceStart + 1, braceEnd)
      afterProps = braceEnd + 1
    }
  }

  const line = src.slice(0, at).split('\n').length
  const after = src.slice(afterProps, afterProps + 500)
  const labelMatch = after.match(/t\('([a-zA-Z0-9_.]+)'\)/)
  const rawLabel = after.match(/'([\u4e00-\u9fa5][^']{0,20})'/)

  // onClick 可能是显式赋值，也可能是 ES6 属性简写（onClick 单独作为一项）
  const shorthand = /(?:^|[{,]\s*)onClick\s*(?:,\s*|\s*$)/m.test(props)

  buttons.push({
    line,
    props,
    hasOnClick: /onClick\s*:/.test(props) || shorthand,
    shorthand,
    onClick: props.match(/onClick\s*:\s*([\s\S]+?)(?:,\s*\n?\s*(?:disabled|style|title|className|key|type|aria-|onMouse|children)\s*:|$)/)?.[1]?.trim() ?? null,
    disabled: props.match(/disabled\s*:\s*([^\n,]+)/)?.[1]?.trim() ?? null,
    label: labelMatch?.[1] ?? rawLabel?.[1]?.trim() ?? '(无文字)',
  })
}

/* ── 判断每个 onClick 是否做事 ── */

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .trim()
}

/**
 * 判断 onClick 是否有实际动作。
 *
 * 三种写法都要认：
 *   onClick: submitCreate            ← 裸标识符，引用本文件里定义的函数
 *   onClick: () => api(...)          ← 内联箭头
 *   onClick: toggle                  ← 裸标识符（hook 里的函数）
 */
function hasEffect(code) {
  const bare = code.replace(/,$/, '').trim()

  // 裸标识符：必须能在本文件里找到定义，否则按钮点了会 ReferenceError
  if (/^[A-Za-z_$][\w$]*$/.test(bare)) {
    return { ok: new RegExp(`(?:function|const|let|var)\\s+${bare}\\b`).test(src), name: bare }
  }
  // 属性访问形式的引用，如 config.onSave
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(bare)) {
    return { ok: true, name: bare }
  }

  if (/api\s*\(/.test(code)) return { ok: true }
  if (/[A-Za-z_$][\w$]*\s*\??\.?\s*\??\(/.test(code)) return { ok: true }
  if (/[A-Za-z_$][\w$]*\s*\?\.\s*\w+\s*\(/.test(code)) return { ok: true }
  return { ok: false }
}

const suspicious = []
const fine = []

for (const b of buttons) {
  if (!b.hasOnClick) {
    suspicious.push({ ...b, reason: '没有 onClick' })
    continue
  }
  // 属性简写：onClick 由父组件传入，这里只确认它确实被透传了
  if (b.shorthand && !b.onClick) {
    fine.push({ ...b, viaProps: true })
    continue
  }
  const code = stripComments(b.onClick ?? '')
  if (code === '' || code === '()' || /^\(\s*\)\s*=>\s*$/.test(code)) {
    suspicious.push({ ...b, reason: 'onClick 是空函数' })
    continue
  }
  const effect = hasEffect(code)
  if (!effect.ok && effect.name) {
    suspicious.push({ ...b, reason: `onClick 引用的 ${effect.name}() 在本文件里找不到定义` })
    continue
  }
  if (!effect.ok) {
    suspicious.push({ ...b, reason: `onClick 没有副作用：${code.slice(0, 50)}` })
    continue
  }
  fine.push(b)
}

/* ── 输出 ── */

console.log(`共识别 ${buttons.length} 个按钮（括号配平提取，属性完整）`)
console.log(`  ${fine.length} 个有实际动作，${suspicious.length} 个可疑\n`)

if (suspicious.length === 0) {
  console.log('✅ 所有按钮的 onClick 都有实际动作')
} else {
  console.log('可疑按钮：\n')
  for (const b of suspicious) {
    console.log(`  client.js:${b.line}  「${b.label}」`)
    console.log(`    ${b.reason}`)
    if (b.disabled) console.log(`    disabled: ${b.disabled}`)
    if (b.onClick) console.log(`    onClick: ${b.onClick.slice(0, 80)}`)
    console.log()
  }
}

process.exitCode = suspicious.length === 0 ? 0 : 1
