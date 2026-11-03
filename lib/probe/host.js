/**
 * Host detection: DSH version, CLI flags, and capability tier.
 * Thresholds come from the 2026-11-03 cross-version lab matrix (0.0.1-rc.5 … 0.2.2-alpha.3),
 * not from documentation; flags are feature-detected from `--help` rather than assumed.
 */
import { execFileSync } from 'node:child_process'

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

function run(bin, args, env) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', env, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

/** Detect the host behind `bin` (default: `dsh` on PATH). */
export function detectHost({ bin = 'dsh', env = process.env } = {}) {
  const version = (run(bin, ['--version'], env).trim().split('\n').pop() ?? '').trim()
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`dsh not found or unreadable version: ${JSON.stringify(version)}`)
  const webHelp = run(bin, ['web', '--help'], env)
  const flags = {
    noOpen: webHelp.includes('--no-open'),
    port: webHelp.includes('--port'),
  }
  return { bin, version, flags, capabilities: capabilitiesFor(version) }
}
