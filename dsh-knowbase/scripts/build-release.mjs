#!/usr/bin/env node
/**
 * 构建发布产物。
 *
 * 两种产物，对应两种安装方式：
 *
 *   1. dsh-knowbase.tgz        约 130KB —— npm pack 产物，不含依赖。
 *                              用于 awesome-dsh-plugin 条目的 tarball 字段，
 *                              以及 `dsh plugin add` 从 tarball 安装。
 *                              用户装完由包管理器拉依赖。
 *
 *   2. dsh-knowbase-offline.zip 约 200MB —— 含完整 node_modules。
 *                              给完全离线的机器用：解压到磁盘，
 *                              在 DSH 里添加那个文件夹即可，不需要联网装依赖。
 *
 * ⚠️ 命名规则：tarball 文件名**不能带版本号**。
 *    awesome-dsh-plugin 的 tarball 字段通常写
 *    `releases/latest/download/<名字>.tgz`——`latest` 在请求时解析，
 *    但文件名是照字面取的。文件名一旦带版本号，下次发版链接就会 404。
 *
 * 用法：
 *   node scripts/build-release.mjs --tgz       只做 npm 包
 *   node scripts/build-release.mjs --offline   只做离线包（慢）
 *   node scripts/build-release.mjs --all       两个都做
 */

import { existsSync, mkdirSync, rmSync, statSync, renameSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(ROOT, '..')
const OUT = join(REPO_ROOT, 'release')

const args = process.argv.slice(2)
const buildTgz = args.includes('--tgz') || args.includes('--all')
const buildOffline = args.includes('--offline') || args.includes('--all')

if (!buildTgz && !buildOffline) {
  console.log('用法：node scripts/build-release.mjs [--tgz|--offline|--all]')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`

/** Windows 上 .cmd 需要经 cmd.exe 调用 */
function run(cmd, cmdArgs, options = {}) {
  const isWin = process.platform === 'win32'
  const exe = isWin ? (process.env.ComSpec || 'cmd.exe') : cmd
  const argv = isWin ? ['/c', cmd, ...cmdArgs] : cmdArgs
  return execFileSync(exe, argv, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...options })
}

/** 递归统计目录大小 */
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

mkdirSync(OUT, { recursive: true })

/* ────────────────────── 1. npm 包 ────────────────────── */

if (buildTgz) {
  console.log('构建 npm 包…')
  // 清掉旧的
  for (const name of readdirSync(OUT)) {
    if (name.endsWith('.tgz')) rmSync(join(OUT, name), { force: true })
  }

  const raw = run('npm', ['pack', '--pack-destination', OUT, '--json'])
  const start = raw.indexOf('[')
  const info = JSON.parse(start >= 0 ? raw.slice(start) : raw)[0]
  const produced = info.filename ?? `dsh-knowbase-${pkg.version}.tgz`

  /*
   * 重命名成不带版本号的名字——见文件头的说明，
   * 带版本号会让 releases/latest/download/ 链接在下次发版后 404。
   */
  const target = join(OUT, 'dsh-knowbase.tgz')
  if (existsSync(target)) rmSync(target, { force: true })
  renameSync(join(OUT, produced), target)

  const size = statSync(target).size
  console.log(`  ✅ release/dsh-knowbase.tgz  ${mb(size)}  ${info.entryCount ?? '?'} 个文件`)
  console.log('     用于：awesome-dsh-plugin 条目的 tarball 字段')
}

/* ────────────────────── 2. 离线包 ────────────────────── */

if (buildOffline) {
  console.log('\n构建离线包（含依赖，会比较慢）…')

  const stage = join(OUT, '.stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  // 把插件源码复制进暂存目录（排除发布物、备份、临时件）
  const SKIP = new Set(['node_modules', '.git', '.slim-backup', 'release'])
  const copyTree = (from, to) => {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      if (entry.name.endsWith('.bak-') || entry.name.startsWith('.stage')) continue
      const src = join(from, entry.name)
      const dst = join(to, entry.name)
      if (entry.isDirectory()) copyTree(src, dst)
      else if (entry.isFile()) {
        // 用 node 自己的 copy，避免 shell 差异
        execFileSync(process.execPath, ['-e',
          `require('node:fs').copyFileSync(${JSON.stringify(src)}, ${JSON.stringify(dst)})`,
        ])
      }
    }
  }

  const stagePkg = join(stage, 'dsh-knowbase')
  copyTree(ROOT, stagePkg)

  // 依赖：优先直接把现成的 node_modules 搬过去（本机已装好）
  const depsFrom = join(ROOT, 'node_modules')
  if (!existsSync(depsFrom)) {
    console.error('  ❌ 找不到 node_modules，先在本目录跑一次 npm install')
    process.exit(1)
  }

  console.log('  复制依赖（约 565MB，需要一点时间）…')
  const depsTo = join(stagePkg, 'node_modules')
  mkdirSync(depsTo, { recursive: true })
  // Windows 上 robocopy 比逐个 copyFile 快得多；其它平台用 cp -a
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', [
      '/c', 'robocopy', depsFrom, depsTo, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/nc', '/ns',
    ], { stdio: 'ignore' })
    // robocopy 用退出码 1 表示「成功复制了文件」，不是失败
  } else {
    execFileSync('cp', ['-a', `${depsFrom}/.`, depsTo])
  }

  // 顺手去掉体积巨大又肯定用不到的浏览器专用文件（可用 slim 脚本还原）
  const webDir = join(depsTo, 'onnxruntime-web')
  if (existsSync(webDir)) {
    rmSync(webDir, { recursive: true, force: true })
    console.log('  已从离线包剔除 onnxruntime-web（浏览器专用，Node 不加载）')
  }

  const totalSize = sizeOf(stagePkg)
  console.log(`  暂存目录：${mb(totalSize)}`)

  // 打包成 zip
  const zipPath = join(OUT, 'dsh-knowbase-offline.zip')
  if (existsSync(zipPath)) rmSync(zipPath, { force: true })

  console.log('  压缩中（这一步最慢）…')
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', [
      '/c', 'powershell', '-NoProfile', '-Command',
      `Compress-Archive -Path '${stagePkg}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
    ], { stdio: 'inherit' })
  } else {
    execFileSync('bash', ['-c',
      `cd ${JSON.stringify(stage)} && zip -qr ${JSON.stringify(zipPath)} dsh-knowbase`,
    ], { stdio: 'inherit' })
  }

  const zipSize = statSync(zipPath).size
  rmSync(stage, { recursive: true, force: true })

  console.log(`  ✅ release/dsh-knowbase-offline.zip  ${mb(zipSize)}`)
  console.log('     用于：完全离线的机器，解压后在 DSH 里添加文件夹')
}

/* ────────────────────── 汇总 ────────────────────── */

console.log('\n产物清单：')
for (const name of readdirSync(OUT).sort()) {
  const full = join(OUT, name)
  if (statSync(full).isFile()) console.log(`  ${name}  ${mb(statSync(full).size)}`)
}

console.log('\n下一步（需要你确认后执行）：')
if (buildTgz) {
  console.log('  gh release create v' + pkg.version + ' release/*.tgz release/*.zip --title "..."')
}
