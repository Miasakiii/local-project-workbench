/**
 * 大量标准输出生成器，用于 M0-3 背压验证。
 *
 * 用法：node scripts/gen-output.cjs [行数]
 * 默认 200000 行，每行约 60 字节，总量约 12 MB。
 */

const TOTAL = Number(process.argv[2] ?? 200000)
const PADDING = 'PADDINGPADDINGPADDINGPADDINGPADDINGPADDINGPADDINGPADDING'

let buffer = ''
for (let index = 0; index < TOTAL; index += 1) {
  buffer += `LINE_${index}_${PADDING}\n`
  if (buffer.length >= 65536) {
    process.stdout.write(buffer)
    buffer = ''
  }
}
if (buffer.length > 0) process.stdout.write(buffer)

console.log('__M0_3_DONE__')
