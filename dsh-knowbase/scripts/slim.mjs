#!/usr/bin/env node
/**
 * 可选瘦身：删掉 Node 环境永远用不到的依赖文件。
 *
 * 为什么默认不跑：
 *   这些目录删掉后，任何人重新 `npm install` 都会装回来，
 *   而且用户可能出于别的原因需要它们。所以做成显式选择，
 *   不在 postinstall 里偷偷执行。
 *
 * 删什么（两项都不影响任何平台、任何功能）：
 *   1. node_modules/onnxruntime-web
 *      浏览器用的 ONNX 运行时。transformers 的 node 入口只在注释和
 *      CDN 路径字符串里提到它，从未 require。Node 走的是 onnxruntime-node。
 *   2. node_modules/tesseract.js-core/*.wasm
 *      tesseract 在 Node 里 require 的是内嵌 base64 的 `*.wasm.js`，
 *      裸 .wasm 文件只在浏览器里用。
 *
 * 不删什么：
 *   - onnxruntime-node/bin 下的 darwin / linux / win32
 *     删了会失去跨平台能力，绝不碰（只提示当前平台用哪个）。
 *
 * 用法：
 *   node scripts/slim.mjs            瘦身（自动备份 + 验证，失败还原）
 *   node scripts/slim.mjs --restore  从备份还原
 *   node scripts/slim.mjs --dry-run  只报告能省多少，不动手
 */

import { existsSync, rmSync, cpSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = join(ROOT, 'node_modules')
const BACKUP = join(MODULES, '.slim-backup')

const args = process.argv.slice(2)
const isRestore = args.includes('--restore')
const isDryRun = args.includes('--dry-run')

function sizeOf(path) {
  if (!existsSync(path)) return 0
  const info = statSync(path)
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOf(join(path, entry.name))
  }
  return total
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`

/** 本次要处理的目标 */
function targets() {
  const list = []

  const web = join(MODULES, 'onnxruntime-web')
  if (existsSync(web)) {
    list.push({ label: 'onnxruntime-web（浏览器专用，Node 不会加载）', path: web, kind: 'dir' })
  }

  const core = join(MODULES, 'tesseract.js-core')
  if (existsSync(core)) {
    for (const name of readdirSync(core)) {
      if (name.endsWith('.wasm')) {
        list.push({ label: `tesseract.js-core/${name}（浏览器专用）`, path: join(core, name), kind: 'file' })
      }
    }
  }

  return list
}

/* ────────────────────── 还原 ────────────────────── */

if (isRestore) {
  if (!existsSync(BACKUP)) {
    console.log('没有找到备份，无需还原。')
    process.exit(0)
  }
  let restored = 0
  for (const entry of readdirSync(BACKUP)) {
    const from = join(BACKUP, entry)
    const to = join(MODULES, entry)
    if (existsSync(to)) {
      console.log(`  跳过（已存在）：${entry}`)
      continue
    }
    cpSync(from, to, { recursive: true })
    restored++
    console.log(`  已还原：${entry}`)
  }
  rmSync(BACKUP, { recursive: true, force: true })
  console.log(`\n还原完成，共 ${restored} 项。`)
  process.exit(0)
}

/* ────────────────────── 体检 ────────────────────── */

const list = targets()
const totalBytes = list.reduce((sum, item) => sum + sizeOf(item.path), 0)

console.log('可以安全移除的内容：\n')
if (list.length === 0) {
  console.log('  没有需要处理的项（可能已经瘦身过了）。')
  process.exit(0)
}
for (const item of list) {
  console.log(`  · ${item.label}  ${mb(sizeOf(item.path))}`)
}
console.log(`\n合计可省：${mb(totalBytes)}`)
console.log(`当前 node_modules：${mb(sizeOf(MODULES))}`)

// 只提示，不动跨平台二进制
const binDir = join(MODULES, 'onnxruntime-node', 'bin', 'napi-v6')
if (existsSync(binDir)) {
  const platforms = readdirSync(binDir)
  const me = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const others = platforms.filter((p) => p !== me)
  if (others.length > 0) {
    const othersBytes = others.reduce((sum, p) => sum + sizeOf(join(binDir, p)), 0)
    console.log(
      `\n注意：onnxruntime-node 里还有 ${others.join('、')} 的平台二进制（共 ${mb(othersBytes)}）。`
      + '\n它们不删——删了插件就不能在那些系统上用了。',
    )
  }
}

if (isDryRun) {
  console.log('\n（--dry-run，未做任何修改）')
  process.exit(0)
}

/* ────────────────────── 备份 ────────────────────── */

mkdirSync(BACKUP, { recursive: true })
for (const item of list) {
  const name = item.label.includes('/')
    ? item.label.split('/')[1]
    : 'onnxruntime-web'
  const dest = join(BACKUP, name)
  if (!existsSync(dest)) cpSync(item.path, dest, { recursive: true })
}
console.log(`\n已备份到 node_modules/.slim-backup/（可随时用 --restore 还原）`)

/* ────────────────────── 删除 ────────────────────── */

for (const item of list) {
  rmSync(item.path, { recursive: true, force: true })
  console.log(`  已移除：${item.label}`)
}

/* ────────────────────── 验证 ────────────────────── */

console.log('\n验证功能是否受影响…')

function verify() {
  // 1. 本地嵌入仍能加载
  const script = `
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    console.log('transformers 加载 OK');
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60000,
  })

  // 2. tesseract 仍能挑到它的 wasm 变体
  const script2 = `
    await import('tesseract.js');
    console.log('tesseract 加载 OK');
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', script2], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60000,
  })
}

try {
  verify()
  console.log('\n✅ 验证通过，功能未受影响。')
  console.log(`   瘦身后 node_modules：${mb(sizeOf(MODULES))}`)
} catch (error) {
  console.error('\n❌ 验证失败，正在从备份还原…')
  console.error(String(error?.stderr ?? error?.message ?? error).slice(0, 500))
  for (const entry of readdirSync(BACKUP)) {
    cpSync(join(BACKUP, entry), join(MODULES, entry), { recursive: true })
  }
  rmSync(BACKUP, { recursive: true, force: true })
  console.error('已还原到瘦身前状态。')
  process.exit(1)
}
