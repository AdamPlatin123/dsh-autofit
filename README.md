# dsh-autofit

DSH 插件自动适配：装之前先实测，装不上自动修，有更新先试。

本仓当前包含两部分：

- **`dsh-autofit/probe`**：轻量的 L1/L2 试装器（L1 真实安装 + L2 host/client 两端加载），零依赖，约 30KB；
- **`scripts/build-index.mjs`**：把 DSH 插件雷达的运行级判定叠加到 format-1 市场索引上。

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

## 开发

```sh
npm test                        # 单元测试（含官方 format-1 校验器，需要本机装有 dsh）
node scripts/build-index.mjs    # 生成雷达叠加索引
```
