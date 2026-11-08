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

DSH Desktop：在 Desktop 的插件页「Add plugin」里输入 `dsh-autofit`（Desktop 只允许通过自己的界面往 desktop profile 装插件）。

命令行单独使用：`npx dsh-autofit probe <插件>` / `npx dsh-autofit fix <插件>`。

### 跨版本实测（2026-11-06）

| DSH | 入口 | 检查接口 |
|---|---|---|
| 0.2.1-rc.2 · 0.2.1-rc.5 · 0.2.2-alpha.3 · 0.2.2-rc.1 | 插件页 Autofit 标签 + 添加菜单 + 详情区块 | ✅ |
| 0.1.7 · 0.2.0 | 插件页 → Autofit Installer（组合包页面）+ 详情区块 | ✅ |
| 0.1.5 | 设置 → 插件 → Autofit 标签 | ✅ |

| DSH Desktop | 内置运行时 | 运行时实测 |
|---|---|---|
| 2.0.22-next / 2.0.22-beta.1 | 0.2.2-rc.1（app.asar） | ✅ 完整 L1/L2 |
| 2.0.18 | 0.2.1-rc.2 | ✅ 完整 L1/L2 |
| 2.0.12 | 0.1.5-rc.2 | 有系统 Node 时 ✅；否则仅 L1 |

Desktop 界面层（菜单与标签页）尚未完成自动化验证：首次运行引导和"只能从应用内安装插件"的限制挡住了无头测试。

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
| A 机械 | 只放宽宿主报出的不满足项（peer / `engines.dsh`），追加 `|| ^<宿主版本>` | 版本声明保守的插件 |
| A 机械 | 旧 patch 写法（顶层映射）→ 顶层列表 | insurance-actuary |
| B 规则 | 按宿主报错路径给 object schema 补 `additionalProperties: true` | period-report |
| B 规则 | 工具补 `output { schema, render }` | insurance-actuary |
| B 规则 | 已知服务改名（`settingsScope → configForms`，卡片 DSH-0.1.7-J1-27） | vision-router（实测不足以修好，见下） |
| C 需授权 | 被拦下的依赖构建脚本：提示并在用户批准后带 `allowBuilds` 重试 | vscode-workbench |
| D agent | 规则修不好时，用当前 DSH 的默认模型（`llm` 服务，不需要另配 key）开一个修复对话，见下 | lab-fx-agentfix |

修复版是 `<版本>+autofit.N` 的本地 tarball，`package.json` 的 `autofit` 字段记录来源与每条改动；原包从不修改；仍未通过的修复版不提供安装。

实测（DSH 0.2.1-rc.2，隔离网络容器）：9 个真实插件中自动修好 5 个（period-report、insurance-actuary、voice-webspeech、dsh-web-access、dsh-tui 0.11.1）；vscode-workbench 在批准 `node-pty` 构建后修好；vision-router / codex-connect 改名后仍失败（新服务接口形状也变了），如实标为需 agent；harness-one 标为需 agent。

### 修复 agent

规则修不好时，组合包会用用户在 DSH 里设置的默认模型开一个修复对话（`lib/autofix/agent.js`）：

- agent 只拿到 6 个工具：`list_files` / `read_file` / `write_file` / `replace_in_file`（只能访问插件副本目录，拒绝绝对路径和 `..` 越界）、`run_trial`（打包 + 真实试装）、`finish`；没有 shell；
- 系统提示里附带实验室里发现的已知破坏性变更（peer 范围、patch 写法、schema、工具 output、服务改名……）；
- 只有最后一次 `run_trial` 通过才算修好，agent 自己说「修好了」不算数；修好后由插件管理器原生安装修复版；
- 下载源码不依赖 npm（直接请求 registry，依次尝试 npmjs、npmmirror），Desktop 等没有 npm 的环境也能用。

实测（DSH 0.2.1-rc.2 web，默认模型 deepseek-v4.1-flash）：一个 host 端调用了不存在的 API 的插件，在小窗里一键走完「原版失败 → agent 读代码并修改一处 → 试装通过 → 自动安装」，约 70 秒。

## DSH Desktop

Desktop 内置自己的 DSH 运行时（实测 0.1.5-rc.2，与全局 CLI 不同）。在 Desktop（Electron）里运行时，probe 优先用系统里能运行该版本 DSH 的 Node（≥22；DSH 0.2.1+ 的 `bin.js` 依赖 `import.meta.main`，需 ≥22.18 或 ≥24.2）运行 Desktop 内置的 `bin.js`；没有 Node 时退回 Electron 的 Node 模式，只做 L1（安装与版本检查），L2 标为 `unverified`，因为 Electron-as-Node 下插件加载器解析不到 profile 里的包。PATH 上没有 pnpm 时，自动用宿主自带的 pnpm。

## 开发

```sh
npm test                        # 单元测试（含官方 format-1 校验器，需要本机装有 dsh）
node scripts/build-index.mjs    # 生成雷达叠加索引
```

### Windows 说明

- 命令行直接用 `dsh` 即可：会按 npm 的 `dsh.cmd` 找到它实际运行的 `bin.js`，并和 shim 一样优先用它旁边的 `node.exe`。当前 Node 太旧（缺 `import.meta.main`）时，自动换用 PATH 上能运行的 Node，找不到就明确报出所需版本，不再是一句「dsh not found」。
- 试装时设置 `npm_config_ignore_workspace_root_check=true`：pnpm 9 在 profile 工作区里不带 `-w` 会拒绝 `add`（`ERR_PNPM_ADDING_TO_ROOT`）。仍然出现时归为 `infra-fail`（诊断码 `package-manager`），不会进入修复和 agent。
- 打包和解包时，tar 只会收到相对路径，因此 Git Bash 里排在前面的 GNU tar 也能正常工作。
