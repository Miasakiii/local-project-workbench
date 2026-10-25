# 本地项目工作台（Local Project Workbench）

> 让每个本地项目拥有一个可阅读、可操作、可继续工作的首页。

**Windows 10 / 11 · Electron 44.9.3 + React 19 + TypeScript · MIT 许可证**

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
- **同时打开上限 8 个项目**：已打开的项目保持挂载（终端会话、文件监听与界面状态都不中断）；达到上限时自动关闭**最久未活动且没有终端会话在运行**的项目——有会话在跑的项目不会被自动关闭，不静默中断用户工作。

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

- **node-pty 真交互式 shell**（N-API 模块，无需针对 Electron 重新构建）；**多标签独立会话**，切换标签、收起面板、切换项目或页面都不终止进程；侧边栏标记哪个项目有终端在运行。
- **会话状态明确**：`idle → starting → running → exited / failed`；标签显示启动目录与运行状态，关闭运行中的标签、结束会话或退出应用都会先确认，取消不会动会话。
- **终端内搜索**：Ctrl+Shift+F 呼出官方 xterm 搜索，显示当前/总数并支持上一个/下一个；Ctrl+滚轮缩放字号；界面无 range 滑动条。
- **不会自动启动或恢复进程**：终端只由用户动作创建；切换回来只揭示既有会话，不附带隐式命令执行。
- **可读性基线**：字体栈是「西文等宽 + 中文回退」两段式（Cascadia Mono／Consolas → 微软雅黑／Noto Sans SC），中文字形不会掉到宋体小字；xterm 的 `minimumContrastRatio: 7`（WCAG AAA）会把 CLI **自己输出的**暗灰（256 色灰阶／真彩色灰）自动提亮到可读——Claude Code 这类工具的次要文本实测低至 1.5:1，纯挑主题色覆盖不到；默认 14px／1.4 行距，**Ctrl+滚轮可缩放字号**（10–24px，偏好写入本地存储并同步到同窗口所有标签），滚动回看 10000 行。
- **终端声明 256 色 + 真彩色**（PTY 环境注入 `TERM=xterm-256color`、`COLORTERM=truecolor`）：缺省时 Electron 主进程没有这两项，CLI 会退化成 16 色并把次要文本压到 brightBlack，深色背景上几乎不可读；渲染优先使用官方 WebGL addon，在不放宽生产态 CSP 的前提下保留 ANSI 颜色与搜索高亮，无 WebGL 时回退 DOM。
- **终端主角化**：头部主按钮 + Ctrl+\` 一键呼出；有会话的项目切回来时面板自动展开（**只揭示既有会话，绝不自动创建**）；可全屏把终端当主视图用；可见性重启后恢复。
- **默认 Shell 可选** pwsh／PowerShell／cmd（白名单，缺省自动探测）；退出应用时若仍有活动会话，先询问再退出，不静默中断正在运行的命令。

### 文件管理（受控写操作）

- 新建空文件／文件夹、重命名、复制、剪切粘贴、删除；**冲突一律拒绝且不覆盖**，父子项同时选中时跳过子项，禁止把文件夹移动进自身。
- **逐项失败报告**：四类操作统一返回逐项结果（成功／失败／未执行 + 原因 + 说明），不给统一成功提示；**删除只走系统回收站，不可回收时整批停止并说明，绝不降级为永久删除**。
- 条目操作全部收在**右键菜单**里（预览、用默认程序打开、用指定编辑器打开、在所在目录新建终端、复制路径、在资源管理器中定位、复制、剪切、重命名、删除），焦点行可按 Shift+F10／Menu 键开出同一套菜单；工具栏只留视图级操作与「新建」。

### 设置与启动

- 侧边栏左下角**设置**页，收拢应用级偏好：编辑器路径（用于「用指定编辑器打开」）、终端设置（默认 Shell、启动目录、字体与字号、行高与字距、光标、对比度、回滚行数、复制与链接行为）、「恢复上次项目」开关、关于（Electron／Chromium／Node 版本）。终端设置统一持久化在应用数据目录，旧版默认 Shell 会自动迁移，非法值逐项回退。
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

产物为 `release/local-project-workbench-<版本>-setup.exe`（NSIS，实测约 100 MB；文件名保持 ASCII，产品名仍是「本地项目工作台」），支持无人值守安装与静默卸载：

```bash
# 静默安装：/S 静默，/D 指定绝对路径（路径不能带引号）
release/local-project-workbench-0.3.0-setup.exe /S /D=C:\Apps\local-project-workbench
```

发布由推送 `v<version>` 标签触发 [release.yml](.github/workflows/release.yml)：自动验证、打包、生成 `SHA256SUMS.txt` 并创建 Release。最新正式版为 [v0.3.0](https://github.com/Miasakiii/local-project-workbench/releases/tag/v0.3.0)。未配置签名证书时产物为未签名安装包，Windows SmartScreen 可能提示。

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
│  │                       pty-session / quit-coordinator / write-guard /
│  │                       file-op-errors / entry-name
│  ├─ preload/             白名单桥接层（不暴露原始 ipcRenderer）
│  ├─ renderer/            React 界面
│  │  ├─ pages/            项目库、项目首页、设置页
│  │  ├─ components/       项目侧边栏、文件树（FileTree + file-browser/ 纯函数）、
│  │  │                    右键菜单、预览、差异、终端、尺寸手柄等
│  │  ├─ hooks/            文件栏状态 hooks：预览／树数据／选择／写操作／键盘导航
│  │  └─ styles/           样式表按页面／组件拆分；styles.css 为 @import 入口
│  │                       （顺序即层叠顺序；menu.css 在末端，属覆盖型浮层）
│  └─ shared/              IPC 契约与数据对象类型
├─ scripts/                验证脚本、打包辅助、文件体积守卫与 TS 加载钩子（不参与打包）
├─ tests/unit/             Node 内置测试运行器的单元用例（纯函数与本地存储，不导入 Electron）
├─ docs/
│  └─ design/              产品设计讨论稿与界面终端重构稿（v0.1–v0.5）
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

版本 **0.3.0**。M0–M3 全部里程碑与 10 项验收场景已交付；**19 个集成验证套件 + 101 个单元用例 + 2 项性能实测、752 项集成断言全绿**，单元测试覆盖率实测 **91.60% 行 / 85.57% 分支 / 88.64% 函数**；P5 发布验收已完成：真实 ACL 拒绝删除 4/4、NVIDIA RTX 4060 硬件路径与 SwiftShader 软件路径各复验打包产物 12/12、隔离身份静默安装／卸载与 61 个用户数据文件哈希比对通过、解包 328.4 MB ≤ 340 MB、安装包 100.5 MB ≤ 110 MB；安装包、主程序与 `elevate.exe` 均为 `NotSigned`，未配置证书时 SmartScreen 会提示风险；界面重构三项（文件栏右键化 / 侧边栏设置入口 / 终端主角化）与 P4 终端专项改造（会话状态机、搜索、终端设置持久化、视图变化不终止会话）已落地，并有真实 Windows ConPTY 验收；0.3.0 在 P4/P5 基础上修复了 Git 重命名原路径越界、Windows 编辑器类型限制与终端早到事件回放；同时包含安全加固（信任独立特权通道、终端会话归属、写路径物理身份快照、CSP 按环境拆分）、工程治理（单元测试与覆盖率门槛、发布产物命名、Release workflow、体积门禁）与同时打开项目上限，详见 [CHANGELOG](CHANGELOG.md)。

已知限制（如实登记，不冒充已解决）：

- **写路径 TOCTOU** 已多重收窄：拒绝经过重解析点的写目标、四类写操作全程同步、解析后采集**物理身份快照**（`dev + ino`；「删除后建同名文件」这类 realpath 复核的盲区必然改变 ino）并在执行前复核、执行后复核源与目标身份（剪切落地的必须就是已验证的同一个文件对象）；守卫开销实测中位约 11 µs。残余段仅剩「执行前复核结束 → 系统调用」之间无法用路径 API 分解的微秒级窗口，无法归零（R9）。
- `dxcompiler.dll` / `dxil.dll` 与 SwiftShader/Vulkan 运行时约 32 MB 仍保留：P5 已在 RTX 4060（D3D11）与 SwiftShader 两条路径验证打包产物 12/12，但「硬件路径正常」不能证明这些 DLL 永远不会被加载；裁剪前仍需逐项静态核查加载清单。
- 终端渲染优先使用 WebGL；无 WebGL 的环境回退 DOM 渲染器，ANSI 颜色与搜索高亮会降级（输入输出不受影响）。硬件与软件渲染路径已在 P5 对照验证，终端画布均正常创建。
- **未签名分发**：当前安装包、主程序与 `elevate.exe` 均为 `NotSigned`；未配置 `CSC_LINK` / `CSC_KEY_PASSWORD` 时 Windows SmartScreen 会提示未知发布者。公开分发前需配置代码签名证书。
- **界面仅简体中文**，尚未接入 i18n；未接入自动更新（`publish: null`）与崩溃上报。公开分发前需另行决策，不冒充已支持。

---

## 安全边界

以下为不得因开发便利而放松的硬约束：

- 渲染进程禁用 Node 集成，启用上下文隔离与沙箱；预加载层只暴露白名单接口，主进程校验调用来源（origin 精确匹配 + senderFrame 非空，杜绝 userinfo 绕过）。
- 渲染进程只传「项目 ID + 相对路径」，主进程解析真实路径并复核归属；覆盖路径穿越、符号链接、目录联接、UNC、设备名、备用数据流等写法。
- 写操作**不经过符号链接与目录联接**；项目根与 `.git` 元数据不提供写操作（Windows 下 `.git` 大小写不敏感），且该判定在折叠 `..` 之后复核一次。
- **信任授予是独立特权通道**（`project:trust`），授予时主进程弹原生确认框由用户当面确认；普通元数据更新通道不再接受 `trusted` 字段。未信任项目一律拒绝**写操作与终端创建**——终端同样以登记表的 `trusted` 为准，渲染层声明的任何字段都不参与判定。
- **终端会话绑定创建它的 WebContents**：write/resize/dispose 校验调用方 sender 与创建会话的 sender 一致，防止多窗口场景下跨窗口越权操作终端。
- 删除一律进系统回收站；不可回收时停止并说明。
- 限制页面导航与窗口创建；外链仅允许 http/https 并交给系统浏览器。
- **CSP 按环境拆分**：开发态保留 `ws:/wss:`（Vite HMR），生产态移除并收紧 `style-src`。
- **平台边界**：路径形态检查中的备用数据流（ADS）、Windows 保留设备名、尾点尾空格三项拒绝规则仅 Windows 生效——它们是 Win32 路径语义的防护，不是通用规则。应用以 Windows 为一等平台（C01），POSIX 上的路径防护按该平台的合法字符语义退化，**不作为支持目标**（详见「已知限制」）。

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

设计讨论稿按版本递进，**v0.4 为产品需求基线，v0.5 为当前界面与终端实施基线**：

| 文档 | 内容 |
|---|---|
| [界面与终端重构设计 v0.5](docs/design/本地项目管理器-界面与终端重构设计-v0.5.md) | **当前实施基线。** P0–P5 的执行顺序、终端交互与设置、验证和发布门；各阶段均有验证证据 |
| [设计讨论稿 v0.4](docs/design/本地项目管理器-设计讨论稿-v0.4.md) | **产品需求基线。** 回写 M0–M2 的实施偏差：页面结构（侧边栏改为项目切换器）、新增交互与尺寸约定、视觉风格、D1 复核结论、验收场景状态 |
| [设计讨论稿 v0.3](docs/design/本地项目管理器-设计讨论稿-v0.3.md) | 关闭全部五项决策门；含实现约束表与 10 项验收场景 |
| [设计讨论稿 v0.2](docs/design/本地项目管理器-设计讨论稿-v0.2.md) | 关闭「普通目录可登记」决策（C08） |
| [设计讨论稿 v0.1](docs/design/本地项目管理器-设计讨论稿-v0.1.md) | 初稿 |

设计稿中未列入「已确认需求」的内容均为**设计建议，而非冻结需求**；已确认项的变更须出新版本并记录理由，不直接修改历史版本。

---

<details>
<summary>验证体系：19 个集成套件 + 单元测试层 + 2 项性能实测 / 752 项集成断言 + 101 个单元用例</summary>

```bash
npm run verify:all          # 静态检查 + 体积守卫 + 类型检查 + 构建 + 单元测试 + 全部集成套件 + 端到端（推荐）
npm run capture:ui          # 重建并复跑端到端，生成 docs/design/ui-baseline/ 真实 Electron 截图
```

仓库已在 `.github/workflows/ci.yml` 配置 GitHub Actions：push 或 PR 到 `main` 时，在 `windows-latest` 上安装依赖并显式准备 Electron 运行时，再依次执行 lint、体积守卫、类型检查、构建与 `verify:suites`——等价于完整 `npm run verify:all`，拆成独立步骤便于定位失败；Electron 44 不再通过 `postinstall` 下载运行时，所以必须在验证脚本直接调用 `dist/electron.exe` 前准备；终端套件依赖 Windows ConPTY，故不用 Linux runner。

各套件可单独运行：

| 命令 | 覆盖 | 项数 |
|---|---|---|
| `npm run test:unit` | Node 内置测试运行器：路径守卫、入口名称、Git porcelain 与差异解析、Markdown 净化结构性不变量、偏好判定、Windows 编辑器类型、Shell 白名单、错误分类、JSON 原子存储、写路径身份快照、终端外观与偏好（字号归一化与存储容错、字体栈含中文回退、主题对比度门槛、状态机与搜索文案、早到事件回放、偏好迁移与逐项回退） | 101 个用例 |
| `npm run test:coverage` | 单元测试 + 纯函数覆盖率门槛（行 70 / 分支 55 / 函数 70；实测 91.60 / 85.57 / 88.64） | — |
| `npm run verify:m0-4` | Markdown 隔离（脚本、外链、路径穿越、目录联接、链接可键盘聚焦） | 82 |
| `npm run verify:m0-5` | 删除语义与失败处理（注入回收站能力） | 37 |
| `npm run verify:m0-5:trash` | 真实系统回收站（Electron 主进程） | 8 |
| `npm run verify:acl-real` | 真实 Windows ACL 拒绝删除（生产删除路径报告 `permission-denied`、拒绝计入失败且不调用回收站、恢复 ACL 后可正常回收） | 4 |
| `npm run verify:m0-6` | Git 解析 + 真实仓库集成（含仓库根解析） | 9 + 9 |
| `npm run verify:m1` | 登记、去重、视图状态（含终端面板可见性持久化）、文件浏览与预览（目录联接按目录列举、超大文本前缀截断、UTF-16LE/BE BOM 识别）、网络图片授权的登记侧 | 69 |
| `npm run verify:m2-diff` | 差异解析与真实仓库（含只读性断言、hunk 内 `--- `/`+++ ` 内容行与文件头的区分、重命名原路径不得越过项目根） | 37 |
| `npm run verify:m2-degrade` | 失败降级与监听过滤规则 | 30 |
| `npm run verify:m3-1` | 同一父目录内单点重命名（文件／文件夹、冲突、信任、重解析点、归一化后的受保护项） | 22 |
| `npm run verify:m3-file-ops` | 新建、复制／剪切粘贴、删除、回收站降级、批量失败报告与 `.git` 归一化写法；**执行前竞态注入**（身份快照拒绝同名异文件替换、抢占目标、父目录换成联接、删除目标被换、5ms 宽窗口）与守卫开销实测 | 59 |
| `npm run verify:m3-lifecycle` | 重新定位与信任重确认、退出前活动会话提示；信任绑定目录物理身份（同名目录替换后自动降级、旧记录不继承信任、重新授予绑定新身份） | 45 |
| `npm run verify:m3-startup` | 应用级偏好与「恢复上次项目」：默认值、持久化、损坏容错、五种恢复分支、与登记表集成、终端偏好迁移/校验/局部更新与默认 Shell 白名单 | 54 |
| `npm run verify:remote-image` | 网络图片授权与主进程代理：授权门、地址形态、本机／内网、连接前解析复核、**固定连接 IP**、**手动逐跳重定向**、响应类型与体积、魔数嗅探、**真实传输契约**（本地服务器驱动生产实现：固定 IP lookup 全流程、请求已发送、状态/头/字节回传、超时可读说明） | 63 |
| `npm run smoke:m1` | 端到端（真实 Electron + 构建产物 + 界面交互，含右键菜单驱动文件操作与 Esc 还焦点、Shift+F10 等价键、设置页与终端偏好持久化、重新定位、退出确认、三阶段启动位置、网络图片开关、文件树键盘导航、提示条键盘关闭、模态聚焦、tabpanel 关联、终端主按钮／Ctrl+\`／全屏／自动展开、会话状态与关闭/结束确认、真实 ConPTY 输入与搜索导航、字号缩放、面板拖拽、页面/项目切换会话保持、最小窗口布局） | 157 + 8 + 5 |
| `npm run verify:g5-shell` | 终端 shell 白名单映射与回退（win32/$SHELL、缺省探测） | 9 |
| `npm run verify:g3b-editor` | 编辑器路径持久化、清空与缺省回退，Windows 拒绝无法直接启动的 `.bat/.cmd`（不破坏其它偏好） | 7 |
| `npm run verify:r9-native-guard` | 写路径原生守卫加载器契约（缺席即回退、可重复稳定、包名/契约就绪） | 4 |
| `npm run verify:terminal-trust` | 终端创建的主进程信任复核（纵深防御）：未信任一律拒绝且不建进程、非布尔按未信任、判定顺序、信任通过后原有复核与主路径不受影响；**会话归属**（write/dispose 校验 sender 与创建会话的 sender 一致） | 24 |
| `npm run verify:fuzz-security` | 安全敏感组件 fuzz／property-based 测试：路径守卫（28 个攻击向量 + 500 次随机 fuzz + `..foo` 不误判）、Markdown 净化层（43 个 XSS 向量 + 500 次随机 fuzz + 结构性不变量）与解析器资源边界（4 万未闭合方括号预算、深层引用限深、代码跨度不干扰链接配对） | 10 |
| `npm run measure:m0-7` | 冷启动、内存与体积实测 | — |
| `npm run measure:g9` | G9 性能造数实测（100 项目 / 1,000 项，主进程数据口径） | — |

**合计 752 项集成断言 + 101 个单元用例。** 端到端套件在真实 Electron 中加载 `out/` 构建产物，通过渲染进程实际调用 IPC 并驱动界面交互，并断言计算后的样式以防「样式表未生效」类回归。

**说明：**

- 单元测试与集成脚本共用 `scripts/ts-loader/register.mjs`；`tests/unit/` 不导入 Electron，可在纯 Node 下秒级运行。覆盖率门槛只覆盖有完整单元覆盖的纯函数模块；Markdown 净化的结构性不变量由 `verify:fuzz-security` 覆盖，不用低门槛冒充高覆盖。
- 主进程模块在纯 Node 下验证需使用 `--experimental-transform-types`（`--experimental-strip-types` 不支持 TypeScript 参数属性）；`scripts/ts-loader/register.mjs` 负责解析 `@shared/*` 别名与省略扩展名的相对导入，只服务验证脚本与单元测试，不参与打包。
- 需要真实 Electron 的脚本采用父/子进程模式：部分环境会注入 `ELECTRON_RUN_AS_NODE=1`，父进程显式清除该变量后再派生 Electron，子进程自检运行模式并明确失败。
- `smoke:m1` 在运行前断言 `out/` 产物不早于 `src/`：产物陈旧时直接失败，避免「验证通过」实际测到的是旧代码。`verify:all` 已内含构建步骤。
- 端到端脚本会关闭窗口的后台节流（`setBackgroundThrottling(false)`）：无显示会话的环境里窗口不会被判定为「可见」，Chromium 会据此节流动画与计时器。该设置只作用于验证期间，不改变应用自身的节流策略。
- 端到端脚本按**三个阶段各派生一次真实进程**验证启动位置（C09），阶段之间只通过应用数据目录里的 `settings.json` 传递状态——「重启后恢复」是真实重启，不是内存里模拟跳转。
- 若所在环境拒绝 npm 派生 `cmd.exe`（`EACCES`），`npm run verify:all` 会在第一行失败且**与项目无关**；此时逐条直接调用本地二进制（`./node_modules/.bin/biome lint`、`./node_modules/.bin/electron-vite build`、`node scripts/verify-*.mts`）即为等价的全链验证。
- 已知问题 I-1（已定位到根因，维持噪音级登记）：`AttachConsole failed` 堆栈来自 node-pty 在 kill ConPTY 会话时**派生的 `conpty_console_list_agent` 子进程**——该子进程对 `AttachConsole(shellPid)` 的失败单独打印堆栈，属 node-pty 内部行为，应用层无法消除（自行替换 kill 实现只会换来更差的事务性）。实测 Node 与打包产物中均会出现，但 GUI 分发态无 stderr 出口、用户不可见；不影响会话关闭与进程树清理（探针实测 dispose 后 shell 与 conhost 全部退出、启动目录可删）。
- 已知问题 I-2（已修复）：Windows 上 node-pty 会话被 kill 之后，ConPTY 可能仍短暂持有启动目录。根因是验证脚本用 `Atomics.wait` 做退避——它**阻塞主线程**，libuv 无法处理 conhost 退出通知，持有期在阻塞窗口内永远不会释放（套件打印「残留」后进程一退出目录立即可删，正是这个原因）；改用 `await setTimeout` 让事件循环转动后，300/600/1200/2400 ms 退避重试可在窗口内完成清理。清理语义不变：**尽力而为，清理失败不冒充验证失败**。

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

**实测结果：解包 328.4 MB、NSIS 安装包 100.5 MB**（未裁剪时的投影值为 398.9 MB；均为 0.3.0 于 2026-10-25 的最终验证实测，Electron 44.9.3）。

体积构成（实测）：

| 项 | 体积 | 占比 |
|---|---|---|
| `本地项目工作台.exe`（Chromium + Node） | 235.4 MB | 71.7% |
| `dxcompiler.dll` | 24.6 MB | 7.5% |
| `LICENSES.chromium.html` | 19.5 MB | 6.0% |
| `resources.pak` | 11.9 MB | 3.6% |
| `icudtl.dat` | 10.4 MB | 3.2% |
| `resources/`（app.asar 1.8 MB + 解包的 node-pty 5.3 MB） | 7.3 MB | 2.2% |
| `vk_swiftshader.dll` | 5.3 MB | 1.6% |
| 其余（d3dcompiler / ffmpeg / dxil / pak / locales 等） | 13.8 MB | 4.2% |

**明确保留、不裁剪的项：**

| 项 | 体积 | 保留原因 |
|---|---|---|
| `dxcompiler.dll` / `dxil.dll` | 26 MB | WebGPU(Dawn) 与 D3D12 着色器编译。本应用不用 WebGPU，但 GPU 进程初始化可能依赖。**2026-10-12 静态核查**：chrome.exe 无任何导入表项指向二者，仅两处按名引用——Dawn 的 "DXC instead of FXC" 回退日志串（crbug.com/dawn/402）与 `gpu::CollectGpuExtraInfo` 的诊断清单。**2026-10-25 硬件对照**：RTX 4060（D3D11）与 `--use-angle=swiftshader` 两条路径分别复验打包产物 12/12；两条路径均正常仍不足以证明二者永不被加载，故保留 |
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
npm run verify:release   # pack:dir + 解包体积门槛（≤ 340 MB）+ 打包产物验证；--output=<目录> 可输出到工作区外（规避宿主占用 app.asar）
npm run pack:win         # 生成 NSIS 安装包（≤ 110 MB 体积门槛，实测约 100 MB）
```

**打包产物的验证方式：** `verify:packaged` 用远程调试协议（CDP）从外部驱动打包后的应用，不依赖应用内部任何测试钩子，因此能覆盖只有打包才会暴露的问题。当前 **12 项**全部通过：启动并渲染、预加载白名单桥可用、沙箱完整（无 `require` / `process` / `ipcRenderer`）、渲染进程可创建 WebGL 上下文、样式表从 asar 加载、项目库与文件树可用、**裁剪后的 node-pty 确实可用**（实际拉起交互式 shell 并收到输出）、**终端在打包产物中挂载并运行**、**终端渲染后端与 WebGL 能力一致**（WebGL 可用时 xterm 创建画布）、中文文案正常、无致命错误输出。派生应用时会显式清除 `ELECTRON_RUN_AS_NODE`（该变量会让 Electron 退化为纯 Node 并拒绝 Chromium 参数）；设 `VERIFY_PACKAGED_GL_FLAGS="--use-angle=swiftshader"` 可显式指定软件渲染后端复测（默认不传，行为不变）。

**安装与卸载**（per-user 安装、`oneClick: false`、可改安装目录）：P5 以隔离身份（独立 appId 与快捷方式）静默安装到临时目录，退出码 0，安装目录产物齐全、快捷方式指向正确，安装后 `verify:packaged` **12/12**；`/S /currentuser` 静默卸载退出码 0，安装目录、测试快捷方式与测试注册表项全部清除，用户数据目录（`%APPDATA%\local-project-workbench`）保留。0.3.0 已覆盖安装本机 `F:\sud\local-project-workbench`：安装版本为 0.3.0，主程序 SHA-256 与发布构建一致，安装后产物验证 **12/12**；安装前后用户数据均为 61 个文件、8,286,887 字节，聚合 SHA-256 **0 差异**。

**发布与签名：** 推送 `v<version>` 标签触发 `.github/workflows/release.yml`：先运行 `verify:all`，再 `pack:win`，校验标签与 `package.json` 版本一致，生成 `release/SHA256SUMS.txt`，最后用 `gh release create` 创建 GitHub Release。代码签名通过 `CSC_LINK` / `CSC_KEY_PASSWORD` 仓库 secrets 启用；未配置时产物未签名。0.3.0 正式发布资产、主程序与 `elevate.exe` 均为 `NotSigned`（SHA-256：GitHub Release 安装包 `c45e4af78accc8a5ff2a4417e4764510dfe29d250fc62616a8571c0348e42c75`，安装后主程序 `e769725523133194982e86bf7bf3b637b52c57cddc10047848cb20327e0b7278`，`elevate.exe` `9B1FBF0C11C520AE714AF8AA9AF12CFD48503EEDECD7398D8992EE94D1B4DC37`），Windows SmartScreen 会提示未知发布者；对外分发前需配置证书。当前未接入 electron-updater，`publish: null` + `--publish never` 不生成也不上传 `latest.yml` / `app-update.yml`；接入自动更新时再改 GitHub provider，并保持 ASCII `artifactName`。

**应用图标**：安装包、任务栏、窗口标题栏与资源管理器图标由 `scripts/build-icon.mjs` 程序化生成（`build/icon.ico`，解析几何 + 4×4 超采样抗锯齿，256/48/32/16 四个尺寸，RGBA）。`pack:dir`／`pack:win` 会先跑 `node scripts/build-icon.mjs` 再交给 electron-builder（`win.icon: build/icon.ico`）；也可单独执行 `npm run build:icon` 预览。构图是 **45° 切角方底**（品牌蓝渐变，切角处透明）+ 白窗（标题栏三钮）+ 终端提示符 `>_`。**换设计师稿时直接替换 `build/icon.ico` 即可**，脚本与 `electron-builder.yml` 的指向不变。

</details>

---

## 环境基线

- Windows 10 / 11（目标平台）
- Node.js 22.x（已验证 22.22.2；单元测试使用 Node 内置 `node:test`，无第三方测试框架）
- Electron 44.9.3（Chromium 152.0.7977.167 / Node 24.22.0；`npm run smoke:m1` 的关于页实测）
- Git 2.55（已验证）

---

## 常用命令

```bash
npm run dev         # 开发模式（热更新）
npm run build       # 构建生产版本到 out/
npm run build:icon  # 生成应用图标 build/icon.ico（打包链已内置此步）
npm run preview     # 预览构建结果
npm run typecheck   # 主进程与渲染进程类型检查

npm run test:unit           # 单元测试（Node 内置运行器，纯 Node，秒级）
npm run test:coverage       # 单元测试 + 覆盖率门槛（行 70 / 分支 55 / 函数 70）

npm run check:file-size   # 文件体积守卫：src/ 单文件超过 800 行即失败（可 --limit 调整）

npm run verify:all            # 静态检查 + 体积守卫 + 类型检查 + 构建 + 单元测试 + 全部集成套件 + 端到端
npm run verify:suites         # 单元测试 + 全部集成套件（CI 使用，不含静态检查/构建）
npm run verify:m3             # M3 四套（重命名、文件操作、生命周期、启动位置）
npm run verify:m3-file-ops    # 文件操作与批量失败报告
npm run verify:m3-startup     # 应用级偏好与「恢复上次项目」
npm run verify:remote-image   # 网络图片授权与主进程代理
npm run verify:terminal-trust # 终端创建的主进程信任复核（纵深防御）
npm run smoke:m1              # 端到端（真实 Electron，需先构建）

npm run pack:win              # 生成 NSIS 安装包（≤ 110 MB 体积门槛，实测约 100 MB）
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
