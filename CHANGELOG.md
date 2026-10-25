# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定；
版本号与 `package.json` 一致。设计决策的演进另见 `docs/design/` 设计讨论稿的修订记录。

## [0.1.0] - 2026-09-24

首个可用版本，Windows 10 / 11 平台交付。

### 新增

- 项目库与登记：按真实路径身份去重（`realpathSync.native`）、卡片/搜索/置顶/最近打开、README 首段自动简介与自定义简介、重新定位（目录身份变化即撤销信任）。
- GitHub 式项目首页：README 自动识别与多语言变体、安全的 Markdown 渲染（净化层永不写出可加载 URL 的结构性不变量）、网络图片按项目授权后由主进程代取、只读预览（Markdown／纯文本／代码高亮／常见栅格图片）。
- 只读 Git 变化感知：四分组 + 逐行差异、失败与「无差异」严格区分、受控文件监听、外部保存后自动重载并保留滚动位置。
- 内置真实终端：node-pty 交互式 shell、多标签独立会话、终端主角化（Ctrl+\` 呼出／全屏／自动展开既有会话）、默认 Shell 白名单（pwsh／PowerShell／cmd）。
- 受控文件管理：新建／重命名／复制／剪切粘贴／删除（只走系统回收站，不可回收时整批停止）、逐项失败报告、右键菜单全套条目动作。
- 设置与启动：编辑器路径、终端默认 Shell、「恢复上次项目」开关（默认关闭）、关于页。

### 验证与分发

- M0–M3 全部里程碑与 10 项验收场景交付；验证套件覆盖 Markdown 隔离、删除语义、真实回收站、Git 解析与真实仓库、登记去重、差异解析、文件操作与竞态注入、生命周期与启动位置、网络图片授权、终端信任与 shell 白名单等。
- NSIS 安装包实测 99.9 MB（解包 326.8 MB）；无人值守安装／静默卸载／用户数据保留／安装目录产物验证 9/9 通过。

## [0.2.0] - 2026-10-23

安全加固与工程治理版本。产品范围仍为 C01–C10，不新增云同步、账号、代码编辑或 Git 写操作。

### 安全

- **依赖安全更新**：Electron 44.4.1 → 44.9.3、Vite 7.3.6 → 7.3.7、source-map-js 1.2.1 → 1.2.2、http-cache-semantics 4.2.0 → 4.3.0；`npm audit` 由 4 个漏洞（1 中 3 高）降为 0。Electron 升级后按既有约束复验 node-pty（N-API 模块，与 Electron ABI 无关）与打包产物。
- **信任改为独立特权通道**（`project:trust`）：授予信任必须经主进程弹原生确认框由用户当面确认，普通元数据更新通道不再接受 `trusted` 字段；撤销信任无需确认（只收紧权限）。
- **信任绑定目录物理身份**：授予信任时采集根目录 `dev + ino`；目录被同名替换、可移动磁盘更换盘符时真实路径不变而物理身份改变，信任自动降级为只读；旧版本记录缺少身份绑定时不继承信任。
- **写路径物理身份快照**：解析后采集 `dev + ino`（文件系统不提供稳定索引时退化为 `size + mtimeMs` 复合指纹），执行前复核、执行后复核源与目标身份，堵住「删除后建同名文件」这类 realpath 复核的盲区；实测守卫开销中位约 11 µs。
- **终端会话归属创建它的 WebContents**：write/resize/dispose 校验调用方 sender 与创建会话的 sender 一致，防多窗口场景跨窗口越权操作终端。
- **IPC 来源校验加固**：origin 精确匹配（`URL` 解析后比较，杜绝 `http://localhost:5173@evil.com` 类 userinfo 绕过）+ senderFrame 非空；页面导航限制同样改按 origin 比较。
- **CSP 按环境拆分**：生产态移除 `ws:/wss:` 并收紧 `style-src`（移除 `'unsafe-inline'`），开发态保留 HMR 所需配置。
- **内网地址判定修复**：IPv6 前缀（`fc`/`fd`/`fe80`）只对含冒号的 host 生效，`fcbarcelona.com`、`fdic.gov` 这类域名不再被误判为内网地址。
- **路径守卫边界修复**：项目根下名为 `..foo` 的合法文件不再被误判为「项目外」。

### 新增

- 同时打开项目数上限 8：达到上限自动关闭最久未活动且没有终端会话在运行的项目；全部有会话在运行时允许临时超限，不静默中断用户工作。
- fuzz / property-based 安全测试套件（`npm run verify:fuzz-security`）：路径守卫 28 个攻击向量 + 500 次随机 fuzz、Markdown 净化层 43 个 XSS 向量 + 500 次随机 fuzz、解析器资源边界（4 万未闭合方括号预算、深层引用限深）。
- GitHub Actions CI：push／PR 到 `main` 时在 `windows-latest` 自动运行完整 `npm run verify:all`。

### 变更

- 版本号升至 **0.2.0**；[未发布] 区段整体归档到本版本，不再让安全变更停留在「未发布」状态。
- 发布产物名改为 ASCII `local-project-workbench-<version>-setup.exe`，产品名仍为「本地项目工作台」。中文产物名会在发布元数据中被改写，导致 `latest.yml` 指向不存在的文件。
- 显式设置 `publish: null`：当前未接入 electron-updater，不再生成 `latest.yml` / `app-update.yml`；接入自动更新时再改为 GitHub provider。
- CI 拆分 `verify:suites`（单元测试 + 集成套件），与 `verify:all`（静态检查 + 类型检查 + 构建 + 套件）分工；CI 不再重复执行 lint/typecheck/build。
- `package.json` 补齐 `repository` / `homepage` / `bugs` / `engines` 元数据。
- 文件写操作按类型拆分为独立模块（`create-entry` / `delete-entries` / `rename-entry` / `transfer-entries` / `file-op-common`），`file-access.ts` 收为薄出口；行为不变。
- 大文件预览改为只读取阈值内前缀并标记截断，前缀读取按请求字节数分配。
- Markdown 行内匹配统一改 sticky 正则并复用，消除每个 `<` 处复制剩余字符串的 O(n²) 行为。

### 修复

- 项目内目录联接（junction）在文件列表中按目录列举并可进入，不再被当作普通文件。
- UTF-16LE／UTF-16BE BOM 文本按文本预览而非二进制。
- 差异解析：hunk 计数未耗尽时，行首的 `--- `/`+++ ` 是内容行（删除 `--…`、新增 `++…`），不再被误判为文件头。
- 快速切换文件时，晚到的旧预览响应不再覆盖当前预览（请求代次隔离）。
- 文件树漫游 tabindex：焦点光标不在当前行内（切换项目后树已刷新）或尚未进入树时，回退到首个可见行，保证始终有且仅有一行可被 Tab 进入。
- `release/latest.yml` 引用 `local-project-workbench-setup-0.1.0.exe`，实际产物却是中文名安装包：改为 ASCII `artifactName` 并显式 `publish: null`，不再生成会 404 的更新元数据。
- README 的版本号、安装包路径、验证套件计数与 CHANGELOG 同步；ACL 未补测口径明确为「观测前提缺失」，不冒充已通过。

### 测试

- 新增 Node 内置测试运行器单元层：`tests/unit/` 10 个文件 / **67 个用例**，覆盖路径守卫、入口名称、Git porcelain 与差异解析、Markdown 净化结构性不变量、偏好判定、Shell 白名单、文件操作错误分类、JSON 原子存储与写路径身份快照。
- `npm run test:coverage` 对纯函数模块设 70% 行 / 55% 分支 / 70% 函数门槛（实测 91.85% 行 / 85.05% 分支 / 88.10% 函数）；Markdown 净化的结构性不变量仍由 `verify:fuzz-security` 覆盖，不用低门槛冒充高覆盖。
- `verify:all` 改为静态检查 + 构建 + `verify:suites`；CI 与 release workflow 共用同一套验证链。
- 文件操作套件新增执行前竞态注入：身份快照拒绝同名异文件替换、抢占目标、父目录换成联接、删除目标被换、5 ms 宽窗口。
- 生命周期套件新增信任身份绑定断言：同名目录替换降级、旧记录不继承信任、重新授予绑定新身份。
- 端到端套件「方向键移动焦点」改确定性重试：原固定 sleep 赌 React 提交落盘，负载下偶发「焦点不动」；现在每个回合重新聚焦再按键，提交后的回合必然移动焦点。
- 验证脚本改用异步派生外部进程（`execFile`／`spawn`）：本类环境对同步派生返回 EBUSY。
- 打包产物验证支持 `VERIFY_PACKAGED_GL_FLAGS` 显式指定软件渲染后端复测。
- 安装包体积门槛：解包 ≤ 340 MB、安装包 ≤ 110 MB，分别接入 `verify:release` 与 `pack:win`。

### 分发与发布

- 新增 `.github/workflows/release.yml`：推送 `v*` 标签时校验标签与 `package.json` 版本一致，运行 `verify:all` 与 `pack:win`，生成 `SHA256SUMS.txt` 并创建 GitHub Release。
- 代码签名通过 `CSC_LINK` / `CSC_KEY_PASSWORD` 仓库 secrets 启用；未配置时产物为未签名安装包，Windows SmartScreen 可能提示。
- README 同步更新安装包路径、发布流程、验证套件表与已知限制口径。

## [0.3.0] - 2026-10-25

### 安全

- **新披露依赖漏洞收口**：`fast-uri` 3.1.8 → 3.1.9、`undici` 7.29.1 → 7.30.1，以及 `node-gyp` 依赖链中的 `undici` 6.28.1 → 6.29.1；仅更新 lockfile 中的补丁版本，完整 `npm audit` 为 0。
- **真实 ACL 拒绝删除可正确归类**：目标文件被 `DENY(DELETE)` 时，`realpathSync.native` 返回 `EPERM` 而文件实际存在，原实现会误报 `not-found`。路径守卫现按错误码区分 `permission-denied`、不存在与 I/O 失败；创建路径中若祖先真实路径无法解析则失败关闭，不再按字符串拼接继续。删除仍保持「不覆盖、不降级为永久删除」。
- **Git 差异重命名原路径越界**：`originalPath` 原先未经项目归属复核就作为 Git pathspec 传入；项目登记为仓库子目录时，构造 `../` 原路径可读取父级仓库中项目外文件的差异。现在与 `relativePath` 走同一真实路径守卫，越界即失败关闭，并新增子目录仓库回归用例。

### 改进

- **界面信息层级**：项目头部按身份、页面切换、状态与操作重新组织；设置页按通用、编辑器、终端、快捷键与关于分组，补充真实生效的快捷键说明。
- 统一语义设计令牌、控件高度、按钮层级、文本对比度与键盘焦点；补充 `prefers-reduced-motion` 支持，空状态与状态标签沿用低饱和中性视觉。
- 新增 `npm run capture:ui`：在真实 Electron 中生成 1280×840 与 960×600 视觉基线，覆盖项目库、项目工作区、设置页和终端聚焦态；最小窗口新增无横向溢出与操作可达断言。
- **终端可读性**（用户反馈「终端可读性很差」）：
  - 字体栈改为「西文等宽 + 中文回退」两段式（`Cascadia Mono`／`Consolas` → `Microsoft YaHei UI`／`Noto Sans SC`）。原栈只有西文字体，中文一路回退到宋体，13px 下笔画细弱发虚。
  - xterm 开启 `minimumContrastRatio: 7`（WCAG AAA），自动提亮**前景色**。Claude Code 这类 CLI 的次要文本用 256 色灰阶（如 240）或真彩色灰，在深色背景上实测低至 1.5:1；这类颜色由 CLI 自己输出，挑主题色覆盖不到。
  - 默认字号 13 → 14px、行高 1.25 → 1.4，字间距 0.2px；补全 16 色 ANSI 主题（亮色系整体提亮，`dim` 文本常用 brightBlack）；滚动回看 2000 → 10000 行。
  - 终端面板底色与终端主题 background 统一为 `#181a1d`（消除内边距处的色差带），深色滚动条改为浅灰可见。
- 终端 **Ctrl+滚轮缩放字号**（10–24px，一步一档）：偏好写入本地存储，跨会话保留；同窗口其它标签通过自定义事件同步，切标签不出现字号忽大忽小。
- PTY 环境注入 `TERM=xterm-256color` 与 `COLORTERM=truecolor`：node-pty 的 `name` 在 Windows/ConPTY 上不写 `TERM`，Electron 主进程也没有这两项，缺省时 CLI 会退化为 16 色。
- **终端专项改造（P4）**：
  - 会话状态机 `idle → starting → running → exited / failed`；标签显示启动目录与运行状态，关闭运行中的标签、结束会话和退出应用都会先确认。
  - 终端内搜索复用官方 `@xterm/addon-search`：Ctrl+Shift+F 呼出，显示当前/总数，支持上一个/下一个；仅为高亮装饰开启 `allowProposedApi`。
  - 终端偏好统一持久化到 `settings.json` 的 `terminal` 对象（默认 Shell、启动目录、字体与字号、行高与字距、光标、最小对比度、回滚行数、复制与链接行为），旧版扁平 `defaultShell` 自动迁移，非法值逐项回退；设置页不提供 range 滑动条。
  - 切换标签、收起/全屏面板、切换项目或页面均不终止会话；仍不自动启动终端、不恢复上次进程，也不执行隐式命令。
  - 新增官方 `@xterm/addon-webgl` 渲染器：生产态 CSP 禁止内联样式，DOM 渲染器会丢失 ANSI 颜色与搜索高亮；WebGL 把颜色绘入画布且**不放宽 CSP**，不可用时回退 DOM 渲染器。

### 修复

- **Windows 编辑器类型限制**：选择器不再提供 `.bat/.cmd`，主进程也只接受可直接由 `spawn()` 启动的 `.exe`；旧设置中的不支持类型按未设置迁移，避免选择 `code.cmd` 后在启动时抛 `EINVAL`。设置页文案同步说明该限制。
- **终端早到事件回放**：会话输出或退出事件可能早于 `terminal:create` 响应抵达渲染层，原实现因 `sessionId` 尚为空而丢弃。现按事件自带 ID 暂存，绑定后顺序回放；早退会直接进入 `exited`，不再误显示为运行中。一次绑定后丢弃其它并发会话的缓存。

### 测试

- 单元用例 67 → 78：新增 `tests/unit/terminal-appearance.test.mts`，覆盖字号归一化与存储容错（不可用、非法、超界）、字体栈必须含中文回退、主题 16 色合法性与对比度门槛；覆盖率实测升至 92.36% 行 / 85.75% 分支 / 88.64% 函数。
- 端到端 `smoke:m1` 复跑 152/152 通过（终端创建、主按钮、全屏、自动展开、退出确认与最小窗口布局均无回归）。
- 单元用例 78 → 98：补齐会话状态机、搜索计数文案、终端偏好默认值/迁移/逐项回退/局部更新；覆盖率实测 92.29% 行 / 85.75% 分支 / 88.37% 函数。
- 端到端 `smoke:m1` 扩展至 170/170：真实 ConPTY 输入经搜索命中、匹配前后导航、Ctrl+Shift+F、Ctrl+滚轮缩放持久化、面板拖拽下限、标签关闭与结束会话确认、收起/全屏/项目切换/页面切换会话保持、退出前活动会话确认。
- `npm run capture:ui` 视觉基线增至 7 张，新增终端搜索态，复核深色搜索框、匹配填充与 ANSI 彩色输出。
- 单元用例 98 → 99：新增 realpath 错误码到拒绝原因的映射断言，并补 `permission-denied` 的错误原因与用户文案；覆盖率实测 91.49% 行 / 85.42% 分支 / 88.51% 函数。
- 单元用例 99 → 101：新增 Windows 编辑器类型限制、终端早到事件按会话回放断言；覆盖率实测 91.60% 行 / 85.57% 分支 / 88.64% 函数。
- `verify:m2-diff` 36 → 37：新增「登记目录为 Git 仓库子目录时，重命名原路径不得读取父级仓库文件」回归；`verify:g3b-editor` 6 → 7：新增 Windows `.cmd` 被拒绝并迁移为未设置。
- 新增真实 ACL 验证 `verify:acl-real` 4/4：生产删除路径报告 `permission-denied`、拒绝计入失败且不调用回收站、恢复 ACL 后同一文件可正常删除。
- CI 与 Release workflow 在 `npm ci` 后显式执行 `node node_modules/electron/install.js`，修复 Electron 44 移除 `postinstall` 后 Windows runner 缺少 `dist/electron.exe` 导致的验证失败；M0-6 仓库根断言改用 `realpathSync.native`，不再因 Windows 8.3 短临时路径与 Git 长路径的写法差异误报；文件树拖拽断言改为验证有效增长且不超过拖动距离，兼容小视口下的预览区最小宽度夹取。
- 打包产物验证 9 → 12 项：新增 WebGL 上下文、终端挂载运行、终端渲染后端与 WebGL 能力一致；NVIDIA RTX 4060（D3D11）与 `--use-angle=swiftshader` 两条路径均 12/12。
- 最终 `verify:all` 共 752 项集成断言全绿。

### 发布验收

- 隔离身份（独立 appId / 快捷方式）静默安装退出码 0，安装目录产物齐全、快捷方式指向正确，安装后打包产物验证 12/12；`/S /currentuser` 静默卸载退出码 0，安装目录、测试快捷方式与测试注册表项全部清除。
- 用户数据保留：卸载前后 61 个文件、8,286,887 字节逐一 SHA-256 比对 0 差异，标记文件保留。
- 0.3.0 本机同步：从 [GitHub Release v0.3.0](https://github.com/Miasakiii/local-project-workbench/releases/tag/v0.3.0) 下载正式安装包并覆盖安装到 `F:\sud\local-project-workbench`；安装版本 0.3.0、安装目录验证 12/12，发布安装包 SHA-256 为 `c45e4af78accc8a5ff2a4417e4764510dfe29d250fc62616a8571c0348e42c75`。安装前后用户数据 61 个文件、8,286,887 字节的聚合 SHA-256 完全一致。
- 体积门禁：解包 328.4 MB ≤ 340 MB，安装包 100.5 MB ≤ 110 MB，语言包 2 个共 1.1 MB。
- 签名：0.3.0 安装包、主程序与 `elevate.exe` 均为 `NotSigned`（SHA-256 已记入 README），SmartScreen 风险明确；未配置证书时不对外宣称为已签名分发。
- `verify:release` 新增 `--output=<目录>`，可在工作区外完成打包与验证（宿主占用 `app.asar` 时仍可执行）。

## [未发布]

### 变更

- **侧栏开合偏好迁出 localStorage**：侧栏开合从渲染层 `localStorage` 键 `workbench.sidebarOpen` 迁入应用设置存储（`settings.json` 的 `sidebarOpen` 字段，与终端偏好同一 `settings.update` 通道）；旧值一次性迁移——经设置通道写入成功后才清除原键，失败保留键、下次启动重试，不阻断启动；非法落盘值回落默认展开。渲染层不再有散落的 localStorage 键；新增 `tests/unit/sidebar-settings.test.mts` 并扩展 `app-settings` 单元用例（单元用例 101 → 108，覆盖率实测 91.64% 行 / 85.61% 分支 / 88.64% 函数）。

### 文档

- 新增 `docs/ROADMAP.md`：按 P0／P1／P2 汇总剩余待办（公开分发前的代码签名与分发策略决策、决策通过后的自动更新／i18n／崩溃上报接入、已登记限制的跟进与远期项），每条含目标、验收标准、依赖或前置、预估规模、是否需要用户决策与来源；与 README「项目状态」、本文件保持同步，完成一项更新一项状态。
- README「项目状态」段末补充指向 `docs/ROADMAP.md` 的链接。
- 修正 README 对设计稿 v0.4 § 8.2.3 的引用：体积上限是否构成硬性约束在设计稿中落档为「尚待用户确认」，原「2026-09-19 已确认体积无硬性上限、该触发条件关闭」与所引出处不符，已按设计稿口径更正（维持 Electron 的 D1 复核结论不变）。
- `electron-builder.yml` 头部注释的保留项体积数字与 README「分发与打包」实测表同步（27/7/2/20/30 MB 更正为 26/6.2/1.2/19.5/32 MB），并更正所引节名「分发体积」→「分发与打包」；仅注释，配置行为不变。
