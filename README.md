# dsh-autofit

DSH 插件自动适配：装之前先实测，装不上自动修，有更新先试。

本仓包含：

- **DSH 组合包（插件页内）**：
  - 「添加插件」菜单 →「Install with Autofit…」：任意来源（npm、git、tarball、本地路径）输入后点「Install with autofix」即可。右下角弹出小窗，依次进行试装、规则修复、agent 修复、安装，直到装好为止；小窗可以最小化成角落里的胶囊，也可以关掉，任务在后台继续跑；
  - 「Autofit」标签页：awesome 索引 + 雷达判定的插件目录，每张卡片都有「Install with autofix」；
  - 插件详情页：「Autofit check」区块 + 标题旁标签；任何入口装进来的插件，约 1 分钟内在后台自动补测一次。
- **`dsh-autofit/probe`**：零依赖的 L1/L2 试装器（L1 真实安装 + L2 host/client 两端加载）；
- **`dsh-autofit/autofix`**：试装 → 套用修复规则 → 重新打包 → 再试装（最多 3 轮）；
- **`dsh-autofit/describe`**：L0 静态画像（类型、目标 profile、对 profile 的影响、运行要求）；
- **`scripts/build-index.mjs`**：把 DSH 插件雷达的运行级判定叠加到 format-1 市场索引上。

### 安装组合包

```sh
dsh plugin --profile web add dsh-autofit      # 或在 DSH 插件页「Add plugin」里输入 dsh-autofit
dsh --profile web                             # 插件页 → Add plugin 下拉 / Autofit 标签页
```

桌面版（官方 DeepSeek Harness，或社区的 DSH Desktop）：在应用的插件页「Add plugin」里输入 `dsh-autofit`（桌面版只允许通过自己的界面往 desktop profile 装插件）。

命令行单独使用：`npx dsh-autofit probe <插件>` / `npx dsh-autofit fix <插件>`。

### 跨版本实测（2026-11-06）

| DSH | 入口 | 检查接口 |
|---|---|---|
| 0.2.1-rc.2 · 0.2.1-rc.5 · 0.2.2-alpha.3 · 0.2.2-rc.1 | 插件页 Autofit 标签 + 添加菜单 + 详情区块 | ✅ |
| 0.1.7 · 0.2.0 | 插件页 → Autofit Installer（组合包页面）+ 详情区块 | ✅ |
| 0.1.5 | 设置 → 插件 → Autofit 标签 | ✅ |

| 官方 DeepSeek Harness（深度求索） | 内置运行时 | 运行时实测（2026-11-09） |
|---|---|---|
| 0.2.2-rc.1（Windows x64，更新源当前最新） | 0.2.2-rc.1（`app.asar/dsh`），自带 Node 24.21、pnpm 11.28.5 | ✅ 完整 L1/L2；PATH 上没有 pnpm 时用自带的 |

| 社区 DSH Desktop（anywhere-labs，非官方） | 内置运行时 | 运行时实测 |
|---|---|---|
| 2.0.22-next / 2.0.22-beta.1 | 0.2.2-rc.1（app.asar） | ✅ 完整 L1/L2 |
| 2.0.18 | 0.2.1-rc.2 | ✅ 完整 L1/L2 |
| 2.0.12 | 0.1.5-rc.2 | 有系统 Node 时 ✅；否则仅 L1 |

桌面版界面层（菜单与标签页）尚未完成自动化验证：首次运行引导和"只能从应用内安装插件"的限制挡住了无头测试。

## probe：L1/L2 试装

```sh
npx dsh-autofit probe <插件 spec>            # npm 名[@版本]、git spec、tarball 或目录
npx dsh-autofit probe dsh-foo@1.2.0 --json
npx dsh-autofit probe dsh-foo --exempt        # 原生版本拒装时，在临时 home 内豁免后继续测
npx dsh-autofit probe dsh-foo --allow-builds node-pty
npx dsh-autofit probe dsh-foo --bin /path/to/other/dsh   # 对另一个 DSH 版本试装
npx dsh-autofit host                          # 当前 DSH 的版本、参数与能力分档
```

```js
import { probe } from 'dsh-autofit/probe'
const r = await probe('dsh-foo@1.2.0')
r.verdict          // pass | fail | incompatible | infra-fail | inconclusive | not-published
r.layers.L1        // 安装结果、版本要求、被拦的构建脚本
r.layers.L2.host   // clean | failed | timeout，附出错的条目和诊断码
r.layers.L2.client // clean | failed | unverified | not-executed
r.codes            // 诊断码，供修复阶梯使用：schema-additional-properties、native-build、legacy-patch-dialect …
```

**隔离方式：** 每次试装都用一个临时 `DSH_HOME` 和全新的 `web` profile，不会动用户自己的 profile。
- 安装阶段沿用调用方的环境（npm 源、代理），pnpm 默认不运行依赖的构建脚本。
- 加载阶段用最小化环境：`HOME` 指向临时目录，不带代理，也不带凭据。
- **这不是安全沙箱**：L2 阶段插件代码会在本机执行，和正式安装后一样。有容器时，可以用 `--home <目录> --phase install|boot` 把两阶段拆开：安装阶段联网，加载阶段放进断网容器。

**client 端检查：** 不依赖 puppeteer，通过 Node 内置的 WebSocket 走 Chrome DevTools 协议，使用本机已有的 Chrome / Edge / Chromium（可用 `DSH_AUTOFIT_BROWSER` 指定）。找不到浏览器时，client 端标为 `unverified`。

### 支持的 DSH 版本（实测 0.0.1-rc.5 至 0.2.2-alpha.3）

| 档位 | 版本 | probe 的行为 |
|---|---|---|
| full | ≥ 0.2.1 | 能识别原生版本拒装和 `allow-version` 豁免；host 端失败时打警告并继续启动；client 端检查完整 |
| standard | 0.1.5 – 0.2.0 | 没有原生版本检查；0.1.5 上 host 端失败会让 DSH 起不来（`fatal`）；client 端检查完整 |
| basic | ≤ 0.1.2 | host 端失败会在打印 URL 后让启动崩溃；client 包是懒加载的，标为 `not-executed` |

各版本的失败信号格式不同，都由 `lib/probe/signals.js` 解析，测试用例全部来自真实日志（`test/probe-signals.test.mjs`）。

## autofix：修复阶梯

```sh
npx dsh-autofit fix <插件 spec> [--allow-builds node-pty] [--json]
```

| 层级 | 规则 | 来源（实测） |
|---|---|---|
| A 机械 | 只放宽宿主报出的不满足项（peer / `engines.dsh`），追加 `|| ^<宿主版本>`；`dependencies` 不动（放宽会换掉装进来的依赖版本） | 版本声明保守的插件 |
| A 机械 | 旧 patch 写法（顶层映射）→ 顶层列表 | insurance-actuary |
| B 规则 | 按宿主报错路径给 object schema 补 `additionalProperties: true`：只改 `properties: {…}` 里的那个键，或 `.register(…)` 里的根 schema | period-report |
| B 规则 | 工具补 `output { schema, render }` | insurance-actuary |
| B 规则 | 已知服务改名（`settingsScope → configForms`，卡片 DSH-0.1.7-J1-27）：只改 `inject` 声明和从插件上下文取服务的地方（`ctx.x`、`ctx.get('x')`），同名的存储键、日志文字、配置字段不动 | vision-router（实测不足以修好，见下） |
| C 需授权 | 被拦下的依赖构建脚本：提示并在用户批准后带 `allowBuilds` 重试 | vscode-workbench |
| D agent | 规则修不好时，用当前 DSH 的默认模型（`llm` 服务，不需要另配 key）开一个修复对话，见下 | lab-fx-agentfix |

修复版是 `<版本>+autofit.N` 的本地 tarball（文件名带内容哈希，后来的修复不会覆盖已安装的那个），`package.json` 的 `autofit` 字段记录来源（本地文件只记文件名）与每条改动；原包从不修改；仍未通过的修复版不提供安装。

实测（DSH 0.2.1-rc.2，隔离网络容器）：9 个真实插件中自动修好 5 个（period-report、insurance-actuary、voice-webspeech、dsh-web-access、dsh-tui 0.11.1）；vscode-workbench 在批准 `node-pty` 构建后修好；vision-router / codex-connect 改名后仍失败（新服务接口形状也变了），如实标为需 agent；harness-one 标为需 agent。

### 修复 agent

规则修不好时，组合包会用用户在 DSH 里设置的默认模型开一个修复对话（`lib/autofix/agent.js`）：

- agent 只拿到 6 个工具：`list_files` / `read_file` / `write_file` / `replace_in_file`（只能访问插件副本目录，拒绝绝对路径和 `..` 越界）、`run_trial`（打包 + 真实试装）、`finish`；没有 shell；
- 系统提示里附带实验室里发现的已知破坏性变更（peer 范围、patch 写法、schema、工具 output、服务改名……）；
- 只有最后一次 `run_trial` 通过才算修好，agent 自己说「修好了」不算数；
- 护栏（`lib/autofix/guard.js`）：每次 `run_trial` 前把副本和规则修复后的版本比对，下列改动会被拒绝试装，agent 得先改回去：改 `package.json` 的 `name` / `scripts` / `bin` / `dependencies` / `optionalDependencies` / `dsh.bundle`；改 bundle patch 文件；删掉 `.register(…)` 调用；清空文件；收窄或删除 peer / `engines` 范围；改动超过 8 个文件或 200 行；
- agent 的改动写进修复版：`autofit.changes` 按文件记录增删行数，完整 diff 在包内的 `autofit.diff`；
- agent 修好的版本不会自动安装：小窗显示 diff，你点「安装修复版」才装，点「放弃」则不装（刷新页面后也不会装）；规则修好的版本照旧直接安装；
- 下载源码不依赖 npm（直接请求 registry，依次尝试 npmjs、npmmirror），Desktop 等没有 npm 的环境也能用。

实测（DSH 0.2.1-rc.2 web，默认模型 deepseek-v4.1-flash）：一个 host 端调用了不存在的 API 的插件，在小窗里一键走完「原版失败 → agent 读代码并修改一处 → 试装通过 → 自动安装」，约 70 秒。加上护栏后重跑（2026-11-09）：agent 改了 `index.js` 6 行，任务停在「待你确认」，修复版带着 `autofit.diff`，profile 里没有装上；点放弃后任务变为已取消。

## 桌面版

桌面版内置自己的 DSH 运行时，版本可能和全局 CLI 不同。有两种桌面版：

- **官方 DeepSeek Harness**（深度求索发布，签名为 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.，从 deepseek.com 下载）：运行时在 `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh`，0.2.2-rc.1 与应用版本号一致。运行时打在 asar 里，只有 Electron 读得到，所以 probe 用应用本身的 Electron-as-Node 运行它；0.2.1+ 在这种模式下能加载 profile 插件，L1/L2 完整。pnpm 在 asar 外的 `resources/runtime/primary-runtime/dependencies/pnpm`，PATH 上没有 pnpm 时自动用它。
- **社区 DSH Desktop**（anywhere-labs/deepseek-harness-desktop，版本号 2.0.x，非官方）：运行时在 `resources/app`（≤2.0.18）或 `resources/app.asar`（≥2.0.22）。未打包进 asar 的运行时优先用系统里能运行该版本 DSH 的 Node（≥22；DSH 0.2.1+ 的 `bin.js` 依赖 `import.meta.main`，需 ≥22.18 或 ≥24.2）；没有 Node 且运行时低于 0.2.1（2.0.12 内置 0.1.5-rc.2）时，只做 L1（安装与版本检查），L2 标为 `unverified`，因为这些版本在 Electron-as-Node 下解析不到 profile 里的包。

## 开发

```sh
npm test                        # 单元测试（含官方 format-1 校验器，需要本机装有 dsh）
node scripts/build-index.mjs    # 生成雷达叠加索引
npm run check:release           # 检查 npm pack 会发出去的内容
```

### 发布

只由 CI 发布：`npm version` 改版本、提交并打 tag，推送 tag 后 `release.yml` 先在该 commit 上跑完整 CI，再经 npm trusted publishing（OIDC，无 token，自动附 provenance）发包，并创建 GitHub Release。

```sh
npm version patch               # 或 minor / prerelease --preid rc；生成 commit 和 vX.Y.Z tag
git push --follow-tags
```

- 带 `-` 的版本（`0.4.0-rc.1`）发到 `next`，其余发到 `latest`。
- tag 必须在 main 上；`prepublishOnly` 运行 `scripts/check-release.mjs --publish`：CI 里要求本次运行来自 `v<version>` tag，本地要求工作区干净且 HEAD 有这个 tag。它还检查 `bin`/`exports` 的目标都在包里、没有 `files` 以外的文件、没有 CRLF。
- 仓库的 `.gitattributes` 固定 LF：Windows 上 `core.autocrlf=true` 的检出会把 bin 的 shebang 写成 `node\r`，打出来的包在 macOS / Linux 上无法运行。

一次性设置（维护者在网页上完成）：

1. npmjs.com → dsh-autofit → Settings → Trusted publishing：GitHub Actions，仓库 `AdamPlatin123/dsh-autofit`，workflow `release.yml`，environment `npm`。
2. GitHub 仓库 → Settings → Environments → `npm`：添加 required reviewer，每次发布需批准。
3. 第一次经 CI 发布成功后，npmjs.com 包设置 → Publishing access 选 “Require two-factor authentication and disallow tokens”，此后只有 CI 能发。

### Windows 说明

- 命令行直接用 `dsh` 即可：会按 npm 的 `dsh.cmd` 找到它实际运行的 `bin.js`，并和 shim 一样优先用它旁边的 `node.exe`。当前 Node 太旧（缺 `import.meta.main`）时，自动换用 PATH 上能运行的 Node，找不到就明确报出所需版本，不再是一句「dsh not found」。
- 试装时设置 `npm_config_ignore_workspace_root_check=true`：pnpm 9 在 profile 工作区里不带 `-w` 会拒绝 `add`（`ERR_PNPM_ADDING_TO_ROOT`）。仍然出现时归为 `infra-fail`（诊断码 `package-manager`），不会进入修复和 agent。
- 打包和解包时，tar 只会收到相对路径，因此 Git Bash 里排在前面的 GNU tar 也能正常工作。
