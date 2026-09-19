/**
 * 注册 TS 解析钩子。用法：
 *   node --experimental-strip-types --import ./scripts/ts-loader/register.mjs <脚本>
 */

import { register } from 'node:module'

register('./resolve-hook.mjs', import.meta.url)
