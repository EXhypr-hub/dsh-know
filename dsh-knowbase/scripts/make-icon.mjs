// 把 icon.svg 渲染成市场用的 180x180 PNG 位图
import sharp from 'sharp'
import { readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(root, 'icon.svg')
const outPath = join(root, 'icon-180.png')

const svg = readFileSync(svgPath)
console.log('源文件:', svgPath, svg.length, '字节')

const info = await sharp(svg, { density: 900 })
  .resize(180, 180, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png({ compressionLevel: 9 })
  .toFile(outPath)

console.log('✅ 生成:', outPath)
console.log('   尺寸:', info.width + 'x' + info.height, '| 大小:', statSync(outPath).size, '字节')
