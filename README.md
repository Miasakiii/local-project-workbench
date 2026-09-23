# 本地项目工作台（Local Project Workbench）

> 让每个本地项目拥有一个可阅读、可操作、可继续工作的首页。

**Windows 10 / 11 · Electron 44.4.1 + React 19 + TypeScript · MIT 许可证**

一个跑在 Windows 上的本地项目工作台：把**资源管理器式的文件操作**、**GitHub 式仓库首页**和**项目专属终端**合进同一个入口，用于登记、浏览和继续本地项目。

三条不可协商的产品前提：

1. **项目留在原位置**——不复制、不上传源码，不扫描整台电脑。
2. **用户主动登记**——应用只记录目录位置，重启后可找回。
3. **Git 是可选增强**——普通目录同样可以登记；Git 不可用不影响浏览、文件管理、README 与终端。

---

## 功能特性

### 项目库与登记

- **登记与真实去重**：按 `realpathSync.native` 的真实路径身份去重——同一目录的不同写法、大小写差异、经目录联接的别名都归一到同一记录；移除登记只删记录，不动磁盘文件。
- **项目库首页**：卡片、搜索、置顶、最近打开；简介默认取 README 首段（回退到路径），也可在卡片上「编辑简介」填写自定义文案，清空即恢复自动。
- **重新定位**：目录被移动或重命名后可指向新位置；**目录身份一旦变化就撤销信任**，必须重新确认后才允许写操作与终端。

### GitHub 式首页与 README 阅读

- **README 自动识别**：按固定顺序查找（兼容大小写，含 `docs`／`.github`），支持多语言变体切换与指定介绍文件；没有 README 时给出空状态与选择入口，不擅自创建文件。
- **安全的 Markdown 渲染**：脚本与事件属性被阻止，外链交给系统浏览器，项目内链接可跳转；净化层**永不写出可加载的 URL 属性**，「输出中不存在 `src`」是可断言的结构性不变量，而非逐条黑名单。
- **网络图片默认不加载**；需要时**按项目**授权，授权后由**主进程代取**并复核协议、类型、体积、超时与每一跳重定向后的地址，转成 data URL 才交给界面——渲染层 CSP 未因此放宽，界面从不直连远程地址。
- **只读预览**：Markdown、纯文本、代码（行号 + 轻量语法高亮）、常见栅格图片；二进制、编码不支持、无权限分别说明。

### 只读 Git 变化感知

- **四分组 + 逐行差异**：未暂存／已暂存／未跟踪／冲突；项目头显示分支与变更数。
- **失败与「无差异」严格区分**，绝不把查询失败显示成「没有变化」；「不是仓库」与「Git 不可用」也分别表述，不把环境问题误报为项目属性。
- **受控文件监听**：只监听活动项目、忽略依赖与构建目录，事件合并与限流；**监听只是刷新信号**，事实以重新读取与 Git 查询为准。
- **外部保存后自动重载**：预览更新并保留滚动位置；文件被删除时保留提示页并提供返回目录。

### 内置真实终端

- **node-pty 真交互式 shell**（N-API 模块，无需针对 Electron 重新构建）；**多标签独立会话**，切换标签或收起面板都不终止进程；侧边栏标记哪个项目有终端在运行。
- **终端主角化**：头部主按钮 + Ctrl+\` 一键呼出；有会话的项目切回来时面板自动展开（**只揭示既有会话，绝不自动创建**）；可全屏把终端当主视图用；可见性重启后恢复。
- **默认 Shell 可选** pwsh／PowerShell／cmd（白名单，缺省自动探测）；退出应用时若仍有活动会话，先询问再退出，不静默中断正在运行的命令。

### 文件管理（受控写操作）

- 新建空文件／文件夹、重命名、复制、剪切粘贴、删除；**冲突一律拒绝且不覆盖**，父子项同时选中时跳过子项，禁止把文件夹移动进自身。
- **逐项失败报告**：四类操作统一返回逐项结果（成功／失败／未执行 + 原因 + 说明），不给统一成功提示；**删除只走系统回收站，不可回收时整批停止并说明，绝不降级为永久删除**。
- 条目操作全部收在**右键菜单**里（预览、用默认程序打开、用指定编辑器打开、在所在目录新建终端、复制路径、在资源管理器中定位、复制、剪切、重命名、删除），焦点行可按 Shift+F10／Menu 键开出同一套菜单；工具栏只留视图级操作与「新建」。

### 设置与启动

- 侧边栏左下角**设置**页，收拢应用级偏好：编辑器路径（用于「用指定编辑器打开」）、终端默认 Shell、「恢复上次项目」开关、关于（Electron／Chromium／Node 版本）。
- 默认启动停在项目库；开启「恢复上次项目」后重启直接进入上次活跃项目，恢复不了时说明原因、不静默换页——**只恢复浏览位置，不附带写权限，也不恢复进程**（未信任项目仍以只读浏览打开）。

---

## 快速开始

### 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11 |
| Node.js | 22.x（开发验证基于 22.22.2） |
| Git | 可选——被管理项目使用 Git 能力时才需要（验证基于 2.55） |

### 方式一：从源码运行

```bash
git clone https://github.com/Miasakiii/local-project-workbench.git
cd local-project-workbench
npm install      # node-pty 是 N-API 预编译模块，无需 electron-rebuild
npm run dev
```

### 方式二：打包成安装包

```bash
npm run pack:win
```

产物为 `release/本地项目工作台-<版本>-setup.exe`（NSIS，实测约 100 MB），支持无人值守安装与静默卸载：

```bash
# 静默安装：/S 静默，/D 指定绝对路径（路径不能带引号）
release/本地项目工作台-0.1.0-setup.exe /S /D=C:\Apps\local-project-workbench
```

仓库目前**未在 GitHub Releases 发布安装包**，需要的话请自行打包，或先用方式一运行。

### 首次使用

1. 启动后默认停在**项目库**，点「登记新项目」选择一个本地目录——**普通文件夹即可登记，无需是 Git 仓库**。
2. 进入项目页后是**只读浏览**：README、文件树、Git 变化（若是仓库）都能看。
3. 首次执行**写操作**或**新建终端**时会弹出信任确认（“信任后：可在项目内创建终端、删除文件（发送到系统回收站）”）；确认后该目录才允许写操作与终端。目录被移动或重命名后信任自动撤销，需重新确认。

---

## 架构

```
渲染进程（React，无 Node 能力）
   │  只传「项目 ID + 相对路径」            ← 安全边界在此收窄
   ▼
预加载层（白名单桥接，不暴露原始 ipcRenderer）
   ▼
主进程 IPC（按域拆分：guard / app / projects / files / git / system / terminal）
   ▼
模块层（project-registry / file-access / git-query / pty-session / …）
   ▼
系统（文件系统 / Git / PTY / 回收站）
```

关键设计取舍：

- **写目标只有一个出口**：所有会改动磁盘的路径都经 `file-access.ts` 的 `resolveForWrite()` 取得绝对路径；判定顺序含「归一化**后**再查受保护项」——`sub/../.git` 与字面量 `.git` 同等拒绝；执行后复核源与目标状态，无法确认时不报告成功。
- **唯一 Git 调用点**：集中在 `git-query.ts`，以参数数组启动（禁止拼接 Shell 命令），并通过 `--no-ext-diff`／`--no-textconv`／`diff.external=` 等中和仓库配置里可能执行外部程序的部分；差异查询全程只读。
- **唯一对外请求出口**：只有 `modules/remote-image.ts` 会访问网络，且必须先通过项目授权（读登记记录，不接受界面声明）；连接前复核域名解析出的每个 IP，固定用已校验的公网 IP 建连并手动逐跳重定向，闭合 DNS 重绑定。
- **Markdown 隔离靠输出形态**：净化层永不写出 `src`／`href`（图片 `data-asset`、已授权远程图片 `data-remote`、外链 `data-external-url`、项目内链接 `data-project-path`），因此「输出无可加载 URL」是结构性不变量。
- **元数据只写应用数据目录**：不向用户项目写配置、不改 `.gitignore`、不初始化 Git。

<details>
<summary>仓库结构</summary>

```
.
├─ README.md
├─ LICENSE                 MIT 许可证
├─ package.json            工程、依赖与验证入口
├─ biome.json              静态检查与格式化配置（Biome）
├─ electron.vite.config.ts 构建配置
├─ electron-builder.yml    分发与打包配置
├─ tsconfig*.json          类型检查配置（主进程 / 渲染进程分离）
├─ src/
│  ├─ main/                Electron 主进程（特权服务）
│  │  ├─ index.ts          应用生命周期、窗口、退出协调、进程级服务装配
│  │  ├─ ipc/              按域拆分的 IPC 通道（guard / app / projects / files /
│  │  │                    git / system / terminal）；来源校验在 guard.ts
│  │  ├─ security/         路径解析与归属复核（path-guard）、原生守卫加载器
│  │  ├─ storage/          元数据原子写入与损坏容错（json-store）
│  │  └─ modules/          app-settings / project-registry / file-access /
│  │                       file-browser / markdown-* / code-highlight / git-* /
│  │                       diff-service / file-watcher / remote-image /
│  │                       pty-session / quit-coordinator
│  ├─ preload/             白名单桥接层（不暴露原始 ipcRenderer）
│  ├─ renderer/            React 界面
│  │  ├─ pages/            项目库、项目首页、设置页
│  │  ├─ components/       项目侧边栏、文件树、右键菜单、预览、差异、终端、尺寸手柄等
│  │  └─ styles/           样式表按页面／组件拆分；styles.css 为 @import 入口
│  │                       （顺序即层叠顺序；menu.css 在末端，属覆盖型浮层）
│  └─ shared/              IPC 契约与数据对象类型
├─ scripts/                验证脚本、打包辅助与 TS 加载钩子（不参与打包）
├─ docs/
│  └─ design/              产品设计讨论稿（Markdown 基线，v0.1–v0.4）
├─ build/                  Electron 裁剪运行时（由 prepare-electron-dist 生成）
├─ out/                    构建产物（已被 .gitignore 忽略）
└─ release/                打包产物（已被 .gitignore 忽略）
```

</details>

<details>
<summary>技术选型：为什么是 Electron（含 D1 复核实测）</summary>

权重最高的技术难点是真实终端（PTY），node-pty 在该项上具备成熟方案；Electron 的隔离短板属「已知且可配置」范畴，有官方安全指南可循。

D1 复核（2026-09-18，依据 M0-7 实测）维持 Electron：

| 复核维度 | 实测值 |
|---|---|
| 冷启动（到窗口可显示） | 中位 243 ms |
| 内存（工作集合计） | 273 MB（4 进程） |
| 安装包体积（投影） | 约 169 MB；裁剪 locales 与图形相关 DLL 后约 130 MB |
| 真实终端 | 已通过，且原生模块无需针对 Electron 重新构建 |

体积是选择 Electron 的主要代价（与 Tauri 的 10 MB 量级相差约一个数量级），不构成结构性障碍。**触发重新评估的条件**：若安装包体积成为硬性约束（例如要求低于 50 MB，或需要绿色免安装包分发），应重新评估 Tauri。2026-09-19 已确认体积无硬性上限，维持 Electron，该触发条件关闭（设计稿 v0.4 § 8.2.3）。

</details>

---

## 项目状态

版本 **0.1.0**。M0–M3 全部里程碑与 10 项验收场景已交付；**19 个验证套件、675 项断言全绿**；真实桌面人工验收与 Windows 分发实测（99.9 MB 安装包，无人值守安装／静默卸载／用户数据保留／安装目录产物验证 9/9）均已完成；界面重构三项（文件栏右键化 / 侧边栏设置入口 / 终端主角化）已落地。

已知限制（如实登记，不冒充已解决）：

- **真实 ACL 拒绝删除**的场景 7 权限分支未在可配置 ACL 的环境补测；失败分类与「不静默覆盖、不降级为永久删除」已有自动化覆盖。
- **写路径 TOCTOU** 竞态窗口已收窄（拒绝一切经过重解析点的写目标、create/rename/copy/move 全程同步、执行后复核源/目标）但无法用纯路径 API 归零。
- 安装包含 GPU／DirectX 相关 DLL 约 32 MB 未裁剪（无真实 GPU 环境可验证其必要性）；若能接受，需在真实 GPU 机器上另行确认后再裁。

---

## 安全边界

以下为不得因开发便利而放松的硬约束：

- 渲染进程禁用 Node 集成，启用上下文隔离与沙箱；预加载层只暴露白名单接口，主进程校验调用来源。
- 渲染进程只传「项目 ID + 相对路径」，主进程解析真实路径并复核归属；覆盖路径穿越、符号链接、目录联接、UNC、设备名、备用数据流等写法。
- 写操作**不经过符号链接与目录联接**；项目根与 `.git` 元数据不提供写操作（Windows 下 `.git` 大小写不敏感），且该判定在折叠 `..` 之后复核一次。
- 未信任项目一律拒绝**写操作与终端创建**——终端同样以登记表的 `trusted` 为准，渲染层声明的任何字段都不参与判定。
- 删除一律进系统回收站；不可回收时停止并说明。
- 限制页面导航与窗口创建；外链仅允许 http/https 并交给系统浏览器。

---

## 设计边界

### 已确认需求

| 编号 | 内容 |
|---|---|
| C01 | Windows 优先 |
| C02 | 用户主动打开并登记项目目录，重启后可找回 |
| C03 | GitHub 式首页与 README 阅读 |
| C04 | 只读预览 + 外部编辑器打开 + 基础文件管理 |
| C05 | 内置真实交互式终端 |
| C06 | 读取 Git 并反映文件与代码变化（**只读**：分支、状态、差异，无写按钮） |
| C07 | GitHub 仅作为页面体验参考，不引入账号与托管功能 |
| C08 | 普通目录亦可登记为项目，Git 为可选增强能力 |
| C09 | 默认启动页为项目库首页；「恢复上次项目」为可选开关，默认关闭 |
| C10 | 文件操作限于项目内基础管理；跨项目、跨卷移动交给系统资源管理器 |

**C08 的含义：**「项目」定义为已登记的本地目录，而非 Git 仓库。目录不是仓库、或 Git 程序不可用时，浏览、文件管理、README 阅读与终端四项能力全部保留。

### 第一版明确不做

云同步、GitHub 登录、Issues／PR、团队权限、完整代码编辑与调试、插件市场、自动运行项目脚本、整盘项目发现。

---

## 设计文档

设计讨论稿按版本递进，**v0.4 为当前基线**（M0–M2 的实施偏差已回写其中）：

| 文档 | 内容 |
|---|---|
| [设计讨论稿 v0.4](docs/design/本地项目管理器-设计讨论稿-v0.4.md) | **当前基线。** 回写 M0–M2 的实施偏差：页面结构（侧边栏改为项目切换器）、新增交互与尺寸约定、视觉风格、D1 复核结论、验收场景状态 |
| [设计讨论稿 v0.3](docs/design/本地项目管理器-设计讨论稿-v0.3.md) | 关闭全部五项决策门；含实现约束表与 10 项验收场景 |
| [设计讨论稿 v0.2](docs/design/本地项目管理器-设计讨论稿-v0.2.md) | 关闭「普通目录可登记」决策（C08） |
| [设计讨论稿 v0.1](docs/design/本地项目管理器-设计讨论稿-v0.1.md) | 初稿 |

设计稿中未列入「已确认需求」的内容均为**设计建议，而非冻结需求**；已确认项的变更须出新版本并记录理由，不直接修改历史版本。

---

<details>
<summary>验证体系：19 个套件 / 675 项断言</summary>

```bash
npm run verify:all          # 静态检查 + 类型检查 + 构建 + 全部验证套件 + 端到端（推荐）
```

各套件可单独运行：

| 命令 | 覆盖 | 项数 |
|---|---|---|
| `npm run verify:m0-4` | Markdown 隔离（脚本、外链、路径穿越、目录联接、链接可键盘聚焦） | 82 |
| `npm run verify:m0-5` | 删除语义与失败处理（注入回收站能力） | 37 |
| `npm run verify:m0-5:trash` | 真实系统回收站（Electron 主进程） | 8 |
| `npm run verify:m0-6` | Git 解析 + 真实仓库集成（含仓库根解析） | 9 + 9 |
| `npm run verify:m1` | 登记、去重、视图状态（含终端面板可见性持久化）、文件浏览与预览、网络图片授权的登记侧 | 64 |
| `npm run verify:m2-diff` | 差异解析与真实仓库（含只读性断言） | 34 |
| `npm run verify:m2-degrade` | 失败降级与监听过滤规则 | 30 |
| `npm run verify:m3-1` | 同一父目录内单点重命名（文件／文件夹、冲突、信任、重解析点、归一化后的受保护项） | 22 |
| `npm run verify:m3-file-ops` | 新建、复制／剪切粘贴、删除、回收站降级、批量失败报告与 `.git` 归一化写法 | 43 |
| `npm run verify:m3-lifecycle` | 重新定位与信任重确认、退出前活动会话提示 | 36 |
| `npm run verify:m3-startup` | 应用级偏好与「恢复上次项目」：默认值、持久化、损坏容错、五种恢复分支、与登记表集成、终端默认 Shell 白名单与非法值回落 | 48 |
| `npm run verify:remote-image` | 网络图片授权与主进程代理：授权门、地址形态、本机／内网、连接前解析复核、**固定连接 IP**、**手动逐跳重定向**、响应类型与体积、魔数嗅探、**真实传输契约**（本地服务器驱动生产实现：固定 IP lookup 全流程、请求已发送、状态/头/字节回传、超时可读说明） | 63 |
| `npm run smoke:m1` | 端到端（真实 Electron + 构建产物 + 界面交互，含右键菜单驱动文件操作与 Esc 还焦点、Shift+F10 等价键、设置页与默认 Shell 持久化、重新定位、退出确认、三阶段启动位置、网络图片开关、文件树键盘导航、提示条键盘关闭、模态聚焦、tabpanel 关联、终端主按钮／Ctrl+\`／全屏／自动展开） | 135 + 8 + 5 |
| `npm run verify:g5-shell` | 终端 shell 白名单映射与回退（win32/$SHELL、缺省探测） | 9 |
| `npm run verify:g3b-editor` | 编辑器路径持久化、清空与缺省回退（不破坏其它偏好） | 6 |
| `npm run verify:r9-native-guard` | 写路径原生守卫加载器契约（缺席即回退、可重复稳定、包名/契约就绪） | 4 |
| `npm run verify:terminal-trust` | 终端创建的主进程信任复核（纵深防御）：未信任一律拒绝且不建进程、非布尔按未信任、判定顺序、信任通过后原有复核与主路径不受影响 | 21 |
| `npm run measure:m0-7` | 冷启动、内存与体积实测 | — |
| `npm run measure:g9` | G9 性能造数实测（100 项目 / 1,000 项，主进程数据口径） | — |

**合计 675 项断言。** 端到端套件在真实 Electron 中加载 `out/` 构建产物，通过渲染进程实际调用 IPC 并驱动界面交互，并断言计算后的样式以防「样式表未生效」类回归。

**说明：**

- 主进程模块在纯 Node 下验证需使用 `--experimental-transform-types`（`--experimental-strip-types` 不支持 TypeScript 参数属性）；`scripts/ts-loader/register.mjs` 负责解析 `@shared/*` 别名与省略扩展名的相对导入，只服务验证脚本，不参与打包。
- 需要真实 Electron 的脚本采用父/子进程模式：部分环境会注入 `ELECTRON_RUN_AS_NODE=1`，父进程显式清除该变量后再派生 Electron，子进程自检运行模式并明确失败。
- `smoke:m1` 在运行前断言 `out/` 产物不早于 `src/`：产物陈旧时直接失败，避免「验证通过」实际测到的是旧代码。`verify:all` 已内含构建步骤。
- 端到端脚本会关闭窗口的后台节流（`setBackgroundThrottling(false)`）：无显示会话的环境里窗口不会被判定为「可见」，Chromium 会据此节流动画与计时器。该设置只作用于验证期间，不改变应用自身的节流策略。
- 端到端脚本按**三个阶段各派生一次真实进程**验证启动位置（C09），阶段之间只通过应用数据目录里的 `settings.json` 传递状态——「重启后恢复」是真实重启，不是内存里模拟跳转。
- 若所在环境拒绝 npm 派生 `cmd.exe`（`EACCES`），`npm run verify:all` 会在第一行失败且**与项目无关**；此时逐条直接调用本地二进制（`./node_modules/.bin/biome lint`、`./node_modules/.bin/electron-vite build`、`node scripts/verify-*.mts`）即为等价的全链验证。
- 已知问题 I-1：node-pty 在会话退出清理阶段输出 `AttachConsole failed` 堆栈，已定位为噪音级，不影响会话关闭与进程树清理。
- 已知问题 I-2：Windows 上 node-pty 会话被 kill 之后，ConPTY 可能仍短暂持有启动目录；相关套件把清理做成「尽力而为」——**清理失败不冒充验证失败**。

### 静态检查与格式化

```bash
npm run lint         # 静态检查（未使用变量、Hook 依赖、无障碍规则等）
npm run lint:fix     # 自动修复可修复项
npm run format       # 按统一风格重排源码
npm run check        # 静态检查 + 格式化 + 导入顺序（最严格口径）
```

**选型说明：** TypeScript 7 的 Go 重写不再暴露编译器 API（`ts.createSourceFile`、`ts.SyntaxKind` 等已移除），typescript-eslint 因此无法在本项目工作（[typescript-eslint#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518)）。Biome 自带解析器、不依赖 `typescript` 包，可一并承担静态检查、格式化与导入顺序，故取代 ESLint + Prettier。风格参数与既有代码保持一致：2 空格缩进、单引号、不加分号、不加尾逗号、行宽 120。

少数规则与项目既有决策冲突，已在 `biome.json` 或就地抑制注释中写明理由：

| 规则 | 处理 | 理由 |
|---|---|---|
| `complexity/useLiteralKeys` | 关闭 | 对不可信 JSON 与环境变量使用 `obj['key']` 是刻意的可读性标记 |
| `complexity/noImportantStyles` | 关闭 | 拖拽态需要覆盖任意后代的 `cursor` / `user-select` |
| `a11y/useSemanticElements` | 关闭（仅 ResizeHandle） | 尺寸手柄不是水平分隔线，`<hr>` 会丢失拖拽语义 |
| `useExhaustiveDependencies` | 就地抑制 4 处 | 均为刻意的「触发依赖」：效果体只读 ref，但必须在输入变化后重跑 |
| `security/noDangerouslySetInnerHtml` | 就地抑制 2 处 | 内容由主进程净化层产出并自审，净化层永不写出原始 `src` / `href` |
| `suspicious/noArrayIndexKey` | 就地抑制 4 处 | 条目无稳定标识且文案可重复，索引参与复合键是唯一可靠选择 |

</details>

<details>
<summary>分发与打包</summary>

打包配置见 `electron-builder.yml`。裁剪原则是**只删除在 Windows x64 上不可能被加载的文件**，不为体积牺牲任何功能路径。

| 裁剪项 | 裁剪前 | 裁剪后 | 依据 |
|---|---|---|---|
| node-pty 调试符号（`.pdb`） | 54 MB | 0 | 运行时永不加载 |
| node-pty 非目标平台预编译产物 | 32 MB | 0 | 只发 Windows x64（含 arm64 的 ConPTY 运行时） |
| Electron 语言包 | 49 MB（55 个） | 1.1 MB（2 个） | 界面为简体中文，保留 zh-CN / en-US |
| 已被 Vite 打包的前端依赖 | 17 MB | 0 | react / react-dom / xterm 已进 `out/renderer`，故移至 devDependencies |

**实测结果：解包 326.8 MB、NSIS 安装包 99.9 MB**（未裁剪时的投影值为 398.9 MB；数据为 2026-09-23 `pack:win` 实测）。

体积构成（实测）：

| 项 | 体积 | 占比 |
|---|---|---|
| `本地项目工作台.exe`（Chromium + Node） | 234.9 MB | 71.6% |
| `dxcompiler.dll` | 24.6 MB | 7.5% |
| `LICENSES.chromium.html` | 19.5 MB | 6.0% |
| `resources.pak` | 11.9 MB | 3.6% |
| `icudtl.dat` | 10.4 MB | 3.2% |
| `resources/`（app.asar 1.8 MB + 解包的 node-pty 5.6 MB） | 7.5 MB | 2.3% |
| `vk_swiftshader.dll` | 5.3 MB | 1.6% |
| 其余（d3dcompiler / ffmpeg / dxil / pak / locales） | 11.8 MB | 3.6% |

**明确保留、不裁剪的项：**

| 项 | 体积 | 保留原因 |
|---|---|---|
| `dxcompiler.dll` / `dxil.dll` | 26 MB | WebGPU(Dawn) 与 D3D12 着色器编译。本应用不用 WebGPU，但 GPU 进程初始化可能依赖；软件渲染环境无法验证硬件 GPU 路径 |
| `vk_swiftshader.dll` / `vulkan-1.dll` | 6.2 MB | 无可用 GPU 时的软件渲染兜底 |
| `ffmpeg.dll` | 3 MB | 媒体解码 |
| `chrome_200_percent.pak` | 1.2 MB | HiDPI 缩放 |
| `LICENSES.chromium.html` | 19.5 MB | Chromium 第三方许可证，属分发合规要求 |

**语言包的裁剪方式：** 不用 electron-builder 的 `electronLanguages`（它先把 55 个语言包全量复制进产物、再逐个删掉 53 个），而是由 `scripts/prepare-electron-dist.cjs` 预先生成一份只含所需语言包的运行时目录，打包时直接使用（`electronDist`）。少一轮 49 MB 的写入与删除，结果也更确定；该脚本用硬链接共享大文件，准备过程几乎不占额外磁盘。

**node-pty 无需 electron-rebuild**（M0-1 已验证：它是 N-API 模块，产物与 Electron ABI 无关），因此配置中显式设 `npmRebuild: false`。保留默认行为会在缺少 Spectre 缓解库的机器上直接构建失败，而重建本身毫无必要。

**Electron 发行包走国内镜像**（`electronDownload.mirror`）：直连 GitHub Releases 在部分网络下会长时间无响应，表现为打包静默卡住。

```bash
npm run pack:dir         # 打出未压缩安装目录到 release/win-unpacked
npm run measure:pack     # 测量真实产物体积与构成
npm run verify:packaged  # 在打包产物上做端到端验证（CDP 驱动）
npm run verify:release   # 上面三步串起来
npm run pack:win         # 生成 NSIS 安装包（实测产物约 100 MB）
```

**打包产物的验证方式：** `verify:packaged` 用远程调试协议（CDP）从外部驱动打包后的应用，不依赖应用内部任何测试钩子，因此能覆盖只有打包才会暴露的问题。当前 9 项全部通过：启动并渲染、预加载白名单桥可用、沙箱完整（无 `require` / `process` / `ipcRenderer`）、样式表从 asar 加载、项目库与文件树可用、**裁剪后的 node-pty 确实可用**（实际拉起交互式 shell 并收到输出）、中文文案正常、无致命错误输出。

**安装与卸载**（per-user 安装、`oneClick: false`、可改安装目录）也已实测：无人值守安装约 1–2 分钟，完成后顶层条目齐全（`app.asar`／node-pty 原生产物／locales 都在）；静默卸载退出码 0 且安装目录被完整删除，用户数据目录（`%APPDATA%\local-project-workbench`）**保留**（`deleteAppDataOnUninstall: false` 生效）；在真实安装目录上跑 `verify:packaged` 9/9 通过。

**应用图标**：安装包、任务栏、窗口标题栏与资源管理器图标由 `scripts/build-icon.mjs` 程序化生成（`build/icon.ico`，解析几何 + 4×4 超采样抗锯齿，256/48/32/16 四个尺寸，RGBA）。`pack:dir`／`pack:win` 会先跑 `node scripts/build-icon.mjs` 再交给 electron-builder（`win.icon: build/icon.ico`）；也可单独执行 `npm run build:icon` 预览。构图是 **45° 切角方底**（品牌蓝渐变，切角处透明）+ 白窗（标题栏三钮）+ 终端提示符 `>_`。**换设计师稿时直接替换 `build/icon.ico` 即可**，脚本与 `electron-builder.yml` 的指向不变。

</details>

---

## 环境基线

- Windows 10 / 11（目标平台）
- Node.js 22.x（已验证 22.22.2）
- Electron 44.4.1（Chromium 152 / Node 24.21.0）
- Git 2.55（已验证）

---

## 常用命令

```bash
npm run dev         # 开发模式（热更新）
npm run build       # 构建生产版本到 out/
npm run build:icon  # 生成应用图标 build/icon.ico（打包链已内置此步）
npm run preview     # 预览构建结果
npm run typecheck   # 主进程与渲染进程类型检查

npm run verify:all            # 静态检查 + 类型检查 + 构建 + 全部验证套件 + 端到端
npm run verify:m3             # M3 四套（重命名、文件操作、生命周期、启动位置）
npm run verify:m3-file-ops    # 文件操作与批量失败报告
npm run verify:m3-startup     # 应用级偏好与「恢复上次项目」
npm run verify:remote-image   # 网络图片授权与主进程代理
npm run verify:terminal-trust # 终端创建的主进程信任复核（纵深防御）
npm run smoke:m1              # 端到端（真实 Electron，需先构建）

npm run pack:win              # 生成 NSIS 安装包（约 100 MB）
```

---

## 说明

- 设计讨论稿中未列入「已确认需求」的内容均为**设计建议，而非冻结需求**。
- 已确认项的变更须出新版本并记录理由，不直接修改历史版本。
- 设计讨论稿以 **Markdown 为唯一基线**留存于仓库；对外交付用的 DOCX 稿不进入仓库，按需另行生成。
- 仓库行尾统一为 LF（见 `.gitattributes`）。

---

## 许可证

本项目以 [MIT License](LICENSE) 开源。
