#!/usr/bin/env node
/**
 * 上架前预检：对照 awesome-dsh-plugin 的收录要求逐条检查。
 *
 * 参考：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
 *
 * 用法：node scripts/publish-check.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(ROOT, '..')

let fail = 0
let warn = 0

const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => { console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); fail++ }
const WARN = (label, detail = '') => { console.log(`  ⚠️  ${label}${detail ? ` — ${detail}` : ''}`); warn++ }

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

console.log('\n=== 一、manifest 硬性要求 ===\n')

// 最常见的被拒原因：只声明 dsh.client
if (pkg.dsh?.bundle?.patch) {
  ok('声明了 dsh.bundle.patch', pkg.dsh.bundle.patch)
} else {
  bad('缺少 dsh.bundle.patch', '只声明 dsh.client 无法安装，是最常见的被拒原因')
}

if (existsSync(join(ROOT, pkg.dsh?.bundle?.patch ?? ''))) {
  ok('patch 文件真实存在')
} else {
  bad('patch 文件不存在')
}

// cordis.patch.yml 必须只 insert 自己
const patchPath = join(ROOT, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  const inserts = (patch.match(/- insert:/g) ?? []).length
  if (inserts === 1 && patch.includes(pkg.name)) {
    ok('cordis.patch.yml 只插入自己')
  } else {
    WARN('cordis.patch.yml 结构需要复核', `insert 出现 ${inserts} 次`)
  }
} else {
  bad('仓库根缺少 cordis.patch.yml')
}

if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pkg.name)) {
  ok('包名合规（全小写 + 连字符）', pkg.name)
} else {
  bad('包名不合规', pkg.name)
}

// semver 合法性
try {
  const semver = (await import('semver')).default
  if (semver.valid(pkg.version)) ok('版本号是合法 semver', pkg.version)
  else bad('版本号不是合法 semver', pkg.version)
} catch {
  WARN('无法校验 semver', 'semver 模块不可用')
}

if ((pkg.keywords ?? []).includes('dsh-plugin')) {
  ok('keywords 含 dsh-plugin')
} else {
  bad('keywords 缺少 dsh-plugin')
}

if (pkg.license) ok('声明了许可证', pkg.license)
else bad('缺少 license 字段')

if (pkg.repository?.url) ok('声明了 repository', pkg.repository.url)
else bad('缺少 repository 字段')

// engines 的预发布陷阱
try {
  const semver = (await import('semver')).default
  const range = pkg.engines?.dsh
  if (!range) {
    bad('缺少 engines.dsh')
  } else if (!range.includes('||')) {
    bad('engines.dsh 只有一段', '会静默排除所有更高的预发布版本')
  } else {
    const targets = ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.2-rc.1', '0.2.2-rc.3']
    const missed = targets.filter((v) => !semver.satisfies(v, range))
    if (missed.length) bad('engines.dsh 覆盖不全', `漏掉 ${missed.join(', ')}`)
    else ok('engines.dsh 覆盖所有目标预发布版')
  }
} catch {
  WARN('无法校验 engines.dsh')
}

console.log('\n=== 二、内容要求 ===\n')

// README 带安装说明
const readme = existsSync(join(REPO_ROOT, 'README.md'))
  ? readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
  : ''
if (/##\s*安装/.test(readme) && /github\.com\/|dsh plugin add/.test(readme)) {
  ok('README 有安装说明')
} else {
  bad('README 缺少安装说明')
}

if (/许可证|License|MIT/i.test(readme)) ok('README 提到许可证')
else WARN('README 未提许可证')

// 真实代码
const codeFiles = ['index.js', 'client.js', join('lib', 'store.js')]
  .filter((f) => existsSync(join(ROOT, f)))
if (codeFiles.length === 3) ok('包含真实代码', codeFiles.join(', '))
else bad('代码文件不全')

// 插件图标与详情
if (existsSync(join(ROOT, 'icon.svg'))) ok('有图标')
else WARN('缺图标')

const zhLocale = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
const enLocale = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
if (zhLocale.meta?.title && enLocale.meta?.title) ok('中英文 meta 齐全')
else bad('locale 缺少 meta')

// 描述不带营销词
const MARKETING = ['最好的', '最强', '颠覆', '革命性', '完美', '顶级', '第一', 'best ever', 'revolutionary', 'world-class']
const desc = `${enLocale.meta?.description ?? ''} ${zhLocale.meta?.description ?? ''}`
const found = MARKETING.filter((w) => desc.toLowerCase().includes(w.toLowerCase()))
if (found.length === 0) ok('描述无营销词')
else bad('描述含营销词', found.join(', '))

console.log('\n=== 三、GitHub 侧（需要你手动确认） ===\n')

let repoInfo = null
try {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  const m = out.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  if (m) repoInfo = { owner: m[1], repo: m[2] }
} catch {
  // 没有 remote
}

if (repoInfo) {
  console.log(`  仓库：${repoInfo.owner}/${repoInfo.repo}`)
  const yamlName = `${repoInfo.owner}__${repoInfo.repo}.yml`
  console.log(`  条目文件应为：data/plugins/${yamlName}`)
  console.log(`  条目 url 应为：https://github.com/${repoInfo.owner}/${repoInfo.repo}`)
} else {
  WARN('没能从 git remote 解析出 GitHub 仓库')
}

console.log('  ⚠️  仓库创建满 1 天（CI 自动检查，本地无法验证）')
console.log('  ⚠️  仓库需添加 dsh-plugin topic（GitHub 网页设置）')

console.log('\n=== 四、打包产物 ===\n')

try {
  /*
   * Windows 上直接 spawn npm.cmd 会 EINVAL（.cmd 不是可执行文件），
   * 必须经 cmd.exe 调；其它平台直接用 npm。
   */
  const isWin = process.platform === 'win32'
  const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : 'npm'
  const args = isWin
    ? ['/c', 'npm', 'pack', '--dry-run', '--json']
    : ['pack', '--dry-run', '--json']
  const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 90000 })
  // npm 有时会在 JSON 前打日志，取第一个 [ 开始的部分
  const start = out.indexOf('[')
  const info = JSON.parse(start >= 0 ? out.slice(start) : out)[0]
  const kb = Math.round((info.size ?? 0) / 1024)
  const files = info.entryCount ?? info.files?.length ?? 0
  ok('npm pack 可打包', `${kb} kB / ${files} 个文件`)
  const names = (info.files ?? []).map((f) => f.path)
  for (const need of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    if (!names.includes(need)) bad(`打包产物缺 ${need}`)
  }
} catch (error) {
  WARN('npm pack 检查失败', String(error.message).slice(0, 100))
}

console.log(`\n${'='.repeat(50)}`)
if (fail === 0) {
  console.log(`预检通过（${warn} 项需要你手动确认）`)
  console.log('\n下一步：')
  console.log('  1. 在 GitHub 仓库添加 dsh-plugin topic')
  console.log('  2. 确认仓库创建已满 1 天')
  console.log('  3. 往 awesome-dsh-plugin 提 PR，加一个 YAML 文件')
} else {
  console.log(`预检未通过：${fail} 项错误，${warn} 项待确认`)
}
process.exitCode = fail === 0 ? 0 : 1
