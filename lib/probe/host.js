/**
 * Host detection: DSH version, CLI flags, and capability tier.
 * Thresholds come from the 2026-11-03 cross-version lab matrix (0.0.1-rc.5 … 0.2.2-alpha.3),
 * not from documentation; flags are feature-detected from `--help` rather than assumed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dshPackageDir } from '../describe.js'

/** Minimal SemVer compare (major.minor.patch + prerelease identifiers); enough for DSH tags. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map(Number), pre: pre ? pre.split('.') : [] }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && +p !== +q) return +p - +q
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

const atLeast = (v, floor) => compareVersions(v, floor) >= 0

/**
 * Capabilities by version, as measured in the lab:
 * - nativeCompatGate / versionExemption: install rejects unmet engines.dsh / DSH peers; `allow-version` exists (≥0.2.1).
 * - pluginManager / creatorMode: plugin manager service, plugins.detail.section, agent-preset skills (≥0.1.7).
 * - officialMarket: pluginMarket + format-1 index + plugins.tab (≥0.2.1).
 * - clientImmediate: `dsh.client.immediately` bundles execute at boot; older hosts load client bundles lazily (≥0.1.5).
 * - hostFailure: how a throwing host entry surfaces — 'warn' (boot continues), 'crash-after-url', 'fatal' (no URL).
 */
export function capabilitiesFor(version) {
  const v = version
  let hostFailure = 'warn'
  if (compareVersions(v, '0.1.5-0') >= 0 && compareVersions(v, '0.1.6-0') < 0) hostFailure = 'fatal'
  else if (compareVersions(v, '0.1.3-0') < 0) hostFailure = 'crash-after-url'
  const caps = {
    nativeCompatGate: atLeast(v, '0.2.1-0'),
    versionExemption: atLeast(v, '0.2.1-0'),
    officialMarket: atLeast(v, '0.2.1-0'),
    pluginManager: atLeast(v, '0.1.7-0'),
    creatorMode: atLeast(v, '0.1.7-0'),
    clientImmediate: atLeast(v, '0.1.5-0'),
    hostFailure,
  }
  caps.tier = caps.officialMarket ? 'full' : caps.clientImmediate ? 'standard' : 'basic'
  return caps
}

/**
 * How to start DSH. A plain launcher (`dsh`, a shim, an absolute path) runs as is. A JavaScript entry
 * (`.../@deepseek-ai/dsh/lib/bin.js`, which is what a running Host sees in `process.argv[1]`) runs under this
 * process's own executable, so no `node` on PATH is needed; inside Electron (DSH Desktop) that executable is
 * the app binary, which needs ELECTRON_RUN_AS_NODE=1 to act as Node.
 * @returns {{ command: string, prefix: string[], env: Record<string,string>, script: string|null }}
 */
export function resolveLauncher(bin = 'dsh', env = process.env) {
  if (typeof bin === 'object' && bin?.command) return { prefix: [], env: {}, script: null, limitedL2: false, ...bin }
  if (/\.(m?js|cjs)$/i.test(bin)) {
    if (!process.versions.electron) return { command: process.execPath, prefix: [bin], env: {}, script: bin, limitedL2: false }
    // Inside Electron (DSH Desktop): prefer a real Node. Electron-as-Node runs DSH but its plugin loader cannot
    // resolve profile packages there (lab 2026-11-05: Desktop 0.1.5-rc.2, ERR_MODULE_NOT_FOUND for every plugin,
    // while plain Node passes), so without Node only L1 can be trusted.
    const node = findNode(env)
    if (node) return { command: node, prefix: [bin], env: {}, script: bin, limitedL2: false }
    return { command: process.execPath, prefix: [bin], env: { ELECTRON_RUN_AS_NODE: '1' }, script: bin, limitedL2: true }
  }
  return { command: bin, prefix: [], env: {}, script: null, limitedL2: false }
}

/** A Node ≥22 on PATH, or null. */
function findNode(env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    for (const name of process.platform === 'win32' ? ['node.exe'] : ['node']) {
      const full = dir && path.join(dir, name)
      if (!full || !existsSync(full)) continue
      try {
        const v = execFileSync(full, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10000, env: { PATH: env.PATH } }).trim()
        if (Number(v.split('.')[0]) >= 22) return full
      } catch { /* not runnable */ }
    }
  }
  return null
}

function run(launcher, args, env) {
  try {
    return execFileSync(launcher.command, [...launcher.prefix, ...args], { encoding: 'utf8', env: { ...env, ...launcher.env }, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

function onPath(cmd, env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) if (existsSync(path.join(dir, cmd + ext))) return true
  }
  return false
}

/** pnpm bundled with this DSH installation (DSH Desktop ships one without putting it on PATH). */
function bundledPnpm(dshDir) {
  if (!dshDir) return null
  for (const dir of [path.join(dshDir, 'node_modules', 'pnpm'), path.join(dshDir, '..', 'pnpm'), path.join(dshDir, '..', '..', 'pnpm')]) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pnpm
      if (entry && existsSync(path.join(dir, entry))) return { version: pkg.version, entry: path.join(dir, entry) }
    } catch { /* not here */ }
  }
  return null
}

/**
 * Detect the host behind `bin` (default: `dsh` on PATH). Detection runs against an empty throwaway DSH_HOME:
 * `dsh web --help` composes a profile, and composing the user's real `web` profile with a different runtime
 * (e.g. Desktop's embedded 0.1.5 reading a 0.2.1 profile) fails and would hide the flags.
 */
export function detectHost({ bin = 'dsh', env = process.env } = {}) {
  const launcher = resolveLauncher(bin, env)
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-autofit-detect-'))
  try {
    const denv = { ...env, DSH_HOME: scratch }
    delete denv.DSH_PROFILE
    delete denv.DSH_PROFILE_DIR
    const version = (run(launcher, ['--version'], denv).trim().split('\n').pop() ?? '').trim()
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`dsh not found or unreadable version: ${JSON.stringify(version)}`)
    const webHelp = run(launcher, ['web', '--help'], denv)
    const flags = { noOpen: webHelp.includes('--no-open'), port: webHelp.includes('--port') }
    const dshDir = dshPackageDir(launcher.script ?? (typeof bin === 'string' ? bin : launcher.command), env)
    const pnpm = onPath('pnpm', env) ? { onPath: true } : { onPath: false, bundled: bundledPnpm(dshDir) }
    return { bin: launcher.script ?? launcher.command, launcher, version, flags, pnpm, dshDir, capabilities: capabilitiesFor(version) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
