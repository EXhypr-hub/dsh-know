#!/usr/bin/env node
/**
 * 下载 Release 文件，自动挑一个能用的加速器。
 *
 * 背景：国内访问 github.com 经常超时，但 GitHub 的 API、raw、
 * objects.githubusercontent.com 其实都是通的，只有 github.com 这个门打不开。
 * 加速器就是在中间转一手，把下载请求代理过去。
 *
 * 实测（2026-11-17 本机）：
 *   github.com                ❌ 完全不通
 *   gh-proxy.com              ✅ 1.95 MB/s
 *   ghfile.geekertao.top      ✅ 可用
 *
 * 用法：
 *   node scripts/download-release.mjs                    # 列可下载的文件
 *   node scripts/download-release.mjs dsh-knowbase.tgz   # 下载指定文件
 *   node scripts/download-release.mjs --all              # 全部下载
 *   node scripts/download-release.mjs --check            # 只测加速器连通性
 */

import { createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const OWNER = 'EXhypr-hub'
const REPO = 'dsh-know'

/**
 * 加速器列表，按实测速度排序。
 * 每个都是「前缀 + 原始 GitHub 地址」的拼法。
 */
const ACCELERATORS = [
  { name: 'gh-proxy', prefix: 'https://gh-proxy.com/' },
  { name: 'geekertao', prefix: 'https://ghfile.geekertao.top/' },
  { name: '直连', prefix: '' },
]

/** GitHub 上有哪些 Release 文件 */
async function listAssets(tag = 'latest') {
  const url = tag === 'latest'
    ? `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
    : `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`

  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-know-downloader',
    },
  })
  if (!res.ok) throw new Error(`查询 Release 失败：HTTP ${res.status}`)
  const data = await res.json()
  return {
    tag: data.tag_name,
    assets: (data.assets ?? []).map((a) => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
    })),
  }
}

/** 测一个加速器是否能拿到文件（只取头 1 字节） */
async function probe(prefix, targetUrl) {
  try {
    const res = await fetch(prefix + targetUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(8000),
    })
    return res.ok || res.status === 206
  } catch {
    return false
  }
}

/** 挑第一个可用的加速器 */
async function pickAccelerator(targetUrl) {
  for (const acc of ACCELERATORS) {
    process.stdout.write(`  测试 ${acc.name}… `)
    const ok = await probe(acc.prefix, targetUrl)
    console.log(ok ? '✅' : '❌')
    if (ok) return acc
  }
  return null
}

async function download(asset, dir = '.') {
  const target = `${dir}/${asset.name}`
  console.log(`\n下载 ${asset.name}（${(asset.size / 1024 / 1024).toFixed(1)}MB）`)

  const acc = await pickAccelerator(asset.url)
  if (!acc) {
    console.log('  ❌ 所有加速器都不可用。')
    console.log('     这通常不是你的问题——换个时间再试，或者用下面的原始地址手动下：')
    console.log(`     ${asset.url}`)
    return false
  }

  console.log(`  使用 ${acc.name} 下载…`)
  const res = await fetch(acc.prefix + asset.url, {
    signal: AbortSignal.timeout(600000),
  })
  if (!res.ok) {
    console.log(`  ❌ HTTP ${res.status}`)
    return false
  }

  const total = Number(res.headers.get('content-length')) || asset.size
  let received = 0
  let lastPrint = 0
  const started = Date.now()

  const source = Readable.fromWeb(res.body)
  source.on('data', (chunk) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastPrint > 300) {
      lastPrint = now
      const pct = total > 0 ? ((received / total) * 100).toFixed(0) : '?'
      const speed = received / ((now - started) / 1000) / 1024 / 1024
      process.stdout.write(`\r  ${pct}%  ${(received / 1024 / 1024).toFixed(1)}MB  ${speed.toFixed(2)}MB/s   `)
    }
  })

  try {
    await pipeline(source, createWriteStream(target))
  } catch (error) {
    console.log(`\n  ❌ 下载中断：${error.message}`)
    if (existsSync(target)) unlinkSync(target)
    return false
  }

  const actual = statSync(target).size
  console.log(`\r  ✅ 完成  ${(actual / 1024 / 1024).toFixed(1)}MB  用时 ${((Date.now() - started) / 1000).toFixed(0)}s   `)

  // 大小对不上说明拿到的是错误页，不是真文件
  if (asset.size > 0 && Math.abs(actual - asset.size) > 1024) {
    console.log(`  ⚠️  大小与预期不符（预期 ${asset.size} 字节，实际 ${actual}），可能下到了错误页`)
    return false
  }
  console.log(`  保存到：${target}`)
  return true
}

/* ────────────────────── 主流程 ────────────────────── */

const args = process.argv.slice(2)
const wantCheck = args.includes('--check')
const wantAll = args.includes('--all')
const wanted = args.filter((a) => !a.startsWith('--'))

console.log('查询 Release…')
const { tag, assets } = await listAssets()

console.log(`\n最新版本：${tag}`)
if (assets.length === 0) {
  console.log('这个 Release 还没有附件。')
  process.exit(0)
}

console.log('可下载：')
for (const a of assets) {
  console.log(`  ${a.name.padEnd(32)} ${(a.size / 1024 / 1024).toFixed(2)}MB`)
}

if (wantCheck) {
  console.log('\n测试加速器连通性（以 tgz 为样本）：')
  const sample = assets.find((a) => a.name.endsWith('.tgz')) ?? assets[0]
  for (const acc of ACCELERATORS) {
    process.stdout.write(`  ${acc.name.padEnd(14)} `)
    const ok = await probe(acc.prefix, sample.url)
    console.log(ok ? '✅ 可用' : '❌ 不可用')
  }
  process.exit(0)
}

const targets = wantAll
  ? assets
  : wanted.length > 0
    ? assets.filter((a) => wanted.some((w) => a.name.includes(w)))
    : []

if (targets.length === 0) {
  console.log('\n指定要下载哪个，例如：')
  console.log(`  node scripts/download-release.mjs ${assets[0]?.name ?? 'dsh-knowbase.tgz'}`)
  console.log('或者全部下载：')
  console.log('  node scripts/download-release.mjs --all')
  process.exit(0)
}

let failed = 0
for (const asset of targets) {
  if (!(await download(asset))) failed++
}

console.log(`\n${failed === 0 ? '✅ 全部下载成功' : `⚠️ ${failed} 个失败`}`)
process.exitCode = failed === 0 ? 0 : 1
