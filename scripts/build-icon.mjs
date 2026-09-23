/**
 * 生成应用图标（build/icon.ico）。
 *
 * 为什么程序化生成：本项目没有设计资源流水线，而「默认 Electron 图标」是分发时的
 * 明显缺口（安装包、任务栏、窗口标题栏都是 Electron 的默认分子图标）。图标本身是
 * 纯几何图形（圆角方底 + 窗口 + 终端提示符），用解析几何 + 超采样抗锯齿即可稳定产出，
 * 版本可变、可复现、无需外部依赖。若要换成设计师稿，直接替换 build/icon.ico 即可，
 * 本脚本与 electron-builder.yml 的 `win.icon` 指向不变。
 *
 * 构图：切角方底（45° 倒角、角落透明，品牌蓝渐变）上一个白色窗口（含标题栏与三个窗口钮），
 * 窗口内是终端提示符 ">_"——对应产品三件事里的「项目首页 + 终端」，与界面强调色 #007aff 同源。
 *
 * 输出：
 *   build/icon.ico          多尺寸 ICO（256/48/32/16，256 为内嵌 PNG；RGBA，切角处透明）
 *   build/icon-256.png      预览用大图（便于肉眼检查）
 *
 * 用法：node scripts/build-icon.mjs [--out=build/icon.ico]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------- 配色（取自 src/renderer/src/styles/tokens.css 的强调色系） ---------- */

const TOP = [122, 178, 255] // 渐变起点：亮蓝
const BOTTOM = [10, 111, 224] // 渐变终点：品牌蓝
const PAPER = [255, 255, 255] // 窗口纸面
const BAR = [238, 243, 251] // 标题栏
const BAR_LINE = [219, 230, 245] // 标题栏分隔线
const INK = [10, 111, 224] // 提示符：与渐变终点同色，保证对比
const DOTS = [
  [255, 95, 86], // 红
  [255, 189, 46], // 黄
  [39, 201, 63] // 绿
]

/* ---------- 解析几何：距离场 + 覆盖采样 ---------- */

/** 圆角矩形 SDF：内部为负、外部为正（用于判断点是否在形内） */
function roundedRectDistance(px, py, x0, y0, x1, y1, radius) {
  const cx = Math.max(x0 + radius, Math.min(px, x1 - radius))
  const cy = Math.max(y0 + radius, Math.min(py, y1 - radius))
  const dx = px - cx
  const dy = py - cy
  return (
    Math.hypot(dx, dy) -
    radius +
    Math.max(0, Math.max(x0 + radius - px, px - (x1 - radius))) * 0 +
    Math.max(0, Math.max(y0 + radius - py, py - (y1 - radius))) * 0
  )
}

/** 45° 切角矩形判定：四角各截去一个直角边为 chamfer 的等腰直角三角形 */
function chamferRectContains(px, py, x0, y0, x1, y1, chamfer) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false
  if (px < x0 + chamfer && py < y0 + chamfer && px - x0 + py - y0 > chamfer) return false // 左上
  if (px > x1 - chamfer && py < y0 + chamfer && x1 - px + py - y0 > chamfer) return false // 右上
  if (px < x0 + chamfer && py > y1 - chamfer && px - x0 + y1 - py > chamfer) return false // 左下
  if (px > x1 - chamfer && py > y1 - chamfer && x1 - px + y1 - py > chamfer) return false // 右下
  return true
}

/** 点到线段的距离 */
function segmentDistance(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = px - x1
  const wy = py - y1
  const lengthSq = vx * vx + vy * vy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq))
  return Math.hypot(wx - t * vx, wy - t * vy)
}

const mix = (a, b, t) => a.map((channel, index) => channel + (b[index] - channel) * t)

/**
 * 单个采样点着色：按构图从底往顶依次判定，**后命中者覆盖先命中者**。
 * 坐标一律用「设计稿坐标 × scale」，因此 16/32/48 与 256 是同一张图。
 */
function shadePoint(sx, sy, scale) {
  const inRect = (x0, y0, x1, y1, radius) =>
    roundedRectDistance(sx, sy, x0 * scale, y0 * scale, x1 * scale, y1 * scale, radius * scale) <= 0
  const inChamfer = (x0, y0, x1, y1, chamfer) =>
    chamferRectContains(sx, sy, x0 * scale, y0 * scale, x1 * scale, y1 * scale, chamfer * scale)
  // 小尺寸（16/32）下按比例缩细的笔画会消失，因此给一个像素级下限
  const minHalf = scale <= 32 / 256 ? 1.7 : 0.6
  const onStroke = (x1, y1, x2, y2, width) =>
    segmentDistance(sx, sy, x1 * scale, y1 * scale, x2 * scale, y2 * scale) <= Math.max((width * scale) / 2, minHalf)
  const inDot = (cx, cy, radius) => Math.hypot(sx - cx * scale, sy - cy * scale) <= Math.max(radius * scale, minHalf)

  let color = null

  // 1) 切角方底：45° 倒角（角落透明），品牌蓝对角渐变（按设计稿坐标归一化，尺寸无关）
  if (inChamfer(8, 8, 248, 248, 30)) {
    color = mix(TOP, BOTTOM, (sx / scale + sy / scale) / (2 * 256))
  }
  // 2) 窗口纸面
  if (inRect(56, 60, 200, 194, 14)) color = PAPER
  // 3) 标题栏与分隔线
  if (inRect(56, 60, 200, 92, 0)) color = BAR
  if (Math.abs(sy - 92 * scale) <= Math.max(1, scale)) color = BAR_LINE
  // 4) 标题栏三个窗口钮
  if (inDot(74, 76, 5)) color = DOTS[0]
  if (inDot(92, 76, 5)) color = DOTS[1]
  if (inDot(110, 76, 5)) color = DOTS[2]
  // 5) 终端提示符 ">"（窗口视觉中心略偏下，与标题栏重量平衡）
  if (onStroke(98, 126, 118, 146, 16) || onStroke(118, 146, 98, 166, 16)) color = INK
  // 6) 光标 "_"
  if (onStroke(132, 164, 162, 164, 16)) color = INK

  return color
}

/**
 * 单像素着色：4×4 超采样求覆盖率，避免斜边与细线出现锯齿。
 * 返回 { color, alpha }；alpha < 1 表示该像素被图形部分覆盖。
 */
function shade(px, py, size) {
  const scale = size / 256
  let covered = 0
  let color = null
  const step = 1 / 4
  for (let iy = 0; iy < 4; iy += 1) {
    for (let ix = 0; ix < 4; ix += 1) {
      const hit = shadePoint(px + (ix + 0.5) * step, py + (iy + 0.5) * step, scale)
      if (hit !== null) {
        covered += 1
        color = hit
      }
    }
  }
  if (color === null || covered === 0) return null
  return { color, alpha: covered / 16 }
}

/* ---------- PNG / ICO 编码 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 32 位 RGBA PNG，filter 0，便于任何解码器读取（ICO 内嵌也用同一格式） */
function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 位深
  header[9] = 6 // 颜色类型：真彩色 + alpha
  header[10] = 0 // 压缩
  header[11] = 0 // 过滤
  header[12] = 0 // 无隔行

  const raw = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[y * width + x]
      raw[offset] = pixel[0]
      raw[offset + 1] = pixel[1]
      raw[offset + 2] = pixel[2]
      raw[offset + 3] = pixel[3]
      offset += 4
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 多尺寸 ICO：每个条目内嵌一张 PNG（Vista 起支持，256×256 必须用 PNG） */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // 保留
  header.writeUInt16LE(1, 2) // 类型：图标
  header.writeUInt16LE(images.length, 4)

  let entriesSize = 0
  const directories = images.map((image) => {
    const entry = Buffer.alloc(16)
    entry[0] = image.width >= 256 ? 0 : image.width
    entry[1] = image.height >= 256 ? 0 : image.height
    entry[2] = 0 // 调色板
    entry[3] = 0 // 保留
    entry.writeUInt16LE(1, 4) // 色彩平面
    entry.writeUInt16LE(32, 6) // 位深
    entry.writeUInt32LE(image.data.length, 8)
    entry.writeUInt32LE(6 + images.length * 16 + entriesSize, 12)
    entriesSize += image.data.length
    return entry
  })

  return Buffer.concat([header, ...directories, ...images.map((image) => image.data)])
}

/* ---------- 主流程 ---------- */

/** 光栅化：切角之外透明（RGBA 第 4 通道），边缘像素按覆盖率给部分 alpha 抗锯齿 */
function rasterize(size) {
  const pixels = new Array(size * size)
  const flatten = (color) => color.map((channel) => Math.max(0, Math.min(255, Math.round(channel))))
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const hit = shade(x + 0.5, y + 0.5, size)
      pixels[y * size + x] = hit === null ? [0, 0, 0, 0] : [...flatten(hit.color), Math.round(hit.alpha * 255)]
    }
  }
  return pixels
}

export { BOTTOM, DOTS, encodeIco, encodePng, INK, PAPER, rasterize, shade, TOP }

function main() {
  const sizes = [256, 48, 32, 16]
  const images = sizes.map((size) => ({ width: size, height: size, data: encodePng(size, size, rasterize(size)) }))
  const ico = encodeIco(images)

  const outArg = process.argv.find((item) => item.startsWith('--out='))
  const outPath = outArg === undefined ? join(ROOT, 'build', 'icon.ico') : join(ROOT, outArg.slice(6))
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, ico)
  writeFileSync(join(ROOT, 'build', 'icon-256.png'), images[0].data)

  console.log(`图标已生成：${outPath}`)
  for (const image of images) {
    console.log(`  ${image.width}x${image.height}　${image.data.length} 字节`)
  }
  console.log(`ICO 合计：${ico.length} 字节`)
}

// 直接运行（node scripts/build-icon.mjs）才生成文件；被 import 时只提供函数。
if (process.argv[1]?.endsWith('build-icon.mjs')) {
  main()
}
