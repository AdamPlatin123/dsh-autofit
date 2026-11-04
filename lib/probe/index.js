/**
 * dsh-autofit/probe — lightweight L1 (real install) + L2 (host and client load) trial for one plugin.
 *
 * Isolation (temp-home mode): a throwaway DSH_HOME holds a fresh `web` profile, so the user's
 * profiles are never touched. Install runs with the caller's environment (registry, proxy) and
 * pnpm's default of NOT running dependency build scripts, so no plugin code executes in L1.
 * Boot runs with a minimal environment: HOME inside the temp dir, no proxy, no credentials
 * (a dummy DeepSeek key satisfies the boot check). This is NOT a security sandbox — plugin code
 * runs on this machine during L2 exactly as it would after a real install. Use a container
 * when one is available for that.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findBrowser, inspectPage } from './cdp.js'
import { detectHost } from './host.js'
import { parseBoot, parseClient, parseInstall } from './signals.js'

export { detectHost, capabilitiesFor, compareVersions } from './host.js'
export { diagnose, parseBoot, parseClient, parseInstall, waitingServices, KNOWN_SERVICE_RENAMES } from './signals.js'
export { findBrowser } from './cdp.js'

const PROFILE = 'web'
const redact = (s) => String(s).replace(/token=[\w-]+/g, 'token=…')

function exec(bin, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 124 : 1), out }) })
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 127, out: String(err) }) })
  })
}

function bootEnv(home, base) {
  const env = { PATH: base.PATH, DSH_HOME: home, HOME: path.join(home, 'user'), USERPROFILE: path.join(home, 'user'),
    TMPDIR: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'),
    LANG: base.LANG ?? 'C.UTF-8', BROWSER: 'none', DEEPSEEK_API_KEY: 'sk-dsh-autofit-probe' }
  for (const k of ['SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'NVM_DIR']) if (base[k]) env[k] = base[k]
  mkdirSync(env.HOME, { recursive: true })
  mkdirSync(env.TMPDIR, { recursive: true })
  return env
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    else process.kill(-child.pid, 'SIGKILL')
  } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
}

/** Boot `dsh web`, wait for the URL (or exit / timeout), optionally inspect the page, return logs. */
async function boot(host, env, { bootTimeoutMs, browser, settleMs }) {
  const args = [PROFILE, ...(host.flags.noOpen ? ['--no-open'] : []), ...(host.flags.port ? ['--port', '0'] : [])]
  const child = spawn(host.bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let log = ''
  let exited = null
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const exitP = new Promise((r) => child.on('close', (code) => { exited = code ?? 1; r() }))
  const started = Date.now()
  while (exited === null && !/dsh web: https?:\/\/\S+/.test(log) && Date.now() - started < bootTimeoutMs) {
    await new Promise((r) => setTimeout(r, 250))
  }
  const url = /dsh web: (https?:\/\/\S+)/.exec(log)?.[1] ?? null
  let page = null
  if (url && exited === null) {
    // ≤0.1.2 hosts print the URL and then crash on a failing entry: give them a moment to do so.
    if (host.capabilities.hostFailure === 'crash-after-url') await new Promise((r) => setTimeout(r, 3000))
    if (browser && exited === null) {
      page = await inspectPage(url, { browser, settleMs }).catch((err) => ({ error: String(err.message ?? err), messages: [] }))
    } else {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  const timedOut = exited === null && !url
  if (exited === null) killTree(child)
  await Promise.race([exitP, new Promise((r) => setTimeout(r, 5000))])
  return { log, url, exitedEarly: exited !== null && !page, timedOut, page }
}

/**
 * Trial one plugin spec (npm name[@version], git spec, tarball path or directory).
 * @param {string} spec
 * @param {object} [opts]
 * @param {string} [opts.bin='dsh'] DSH launcher to trial against (lets one machine test several DSH versions).
 * @param {string[]} [opts.allowBuilds] dependency build scripts to approve (e.g. ['node-pty']).
 * @param {boolean} [opts.exempt] on a native version rejection, grant the exact-version exemption inside the
 *   throwaway home and continue — measures "would it run if forced" without touching the user's profiles.
 * @param {string|false} [opts.browser] browser path, or false to skip the client half; default auto-discover.
 * @param {boolean} [opts.keep] keep the temp home for inspection.
 * @param {string} [opts.home] use this DSH_HOME instead of a fresh temp dir (implies keep).
 * @param {'all'|'install'|'boot'} [opts.phase='all'] split L1 and L2 across runs sharing `home` — e.g. install
 *   with network, then boot in an offline container. The install phase records L1 in `<home>/.autofit-l1.json`.
 */
export async function probe(spec, opts = {}) {
  const t0 = Date.now()
  // DSH resolves relative paths against the profile directory, not the caller's cwd.
  if (!path.isAbsolute(spec) && /^\.{0,2}[\\/]|^[\w.-]+[\\/]/.test(spec) && existsSync(spec)) spec = path.resolve(spec)
  const baseEnv = opts.env ?? process.env
  const host = detectHost({ bin: opts.bin ?? 'dsh', env: baseEnv })
  const phase = opts.phase ?? 'all'
  const home = opts.home ?? mkdtempSync(path.join(opts.tmpRoot ?? tmpdir(), 'dsh-autofit-probe-'))
  if (opts.home) mkdirSync(home, { recursive: true })
  const keep = opts.keep || Boolean(opts.home)
  const l1File = path.join(home, '.autofit-l1.json')
  const installEnv = { ...baseEnv, DSH_HOME: home }
  const installTimeout = opts.installTimeoutMs ?? 600000
  const result = {
    schema: 'dsh-autofit/probe/v1',
    spec,
    host: { version: host.version, tier: host.capabilities.tier, capabilities: host.capabilities },
    isolation: 'temp-home',
    layers: { L1: null, L2: { host: null, client: null } },
    verdict: null,
    codes: [],
  }
  try {
    if (phase === 'boot') {
      if (!existsSync(l1File)) throw new Error(`no install phase recorded in ${home}`)
      result.layers.L1 = JSON.parse(readFileSync(l1File, 'utf8'))
      result.codes.push(...(result.layers.L1.codes ?? []))
      if (result.layers.L1.status !== 'installed') {
        result.verdict = { incompatible: 'incompatible', 'not-published': 'not-published', 'infra-fail': 'infra-fail' }[result.layers.L1.status] ?? 'fail'
        return result
      }
    } else {
    // L1 — real install into the throwaway profile.
    if (opts.allowBuilds?.length) {
      await exec(host.bin, ['plugin', '--profile', PROFILE, 'install'], installEnv, installTimeout)
      appendFileSync(path.join(home, 'profiles', PROFILE, 'pnpm-workspace.yaml'),
        `\nallowBuilds:\n${opts.allowBuilds.map((b) => `  ${b}: true`).join('\n')}\n`)
    }
    let inst = await exec(host.bin, ['plugin', '--profile', PROFILE, 'add', spec], installEnv, installTimeout)
    let L1 = parseInstall(inst.out, inst.code)
    if (L1.status === 'incompatible' && opts.exempt && host.capabilities.versionExemption) {
      const cmd = /allow-version (\S+) --dsh-version (\S+)/.exec(inst.out)
      if (cmd) {
        await exec(host.bin, ['plugin', '--profile', PROFILE, 'allow-version', cmd[1], '--dsh-version', cmd[2], '--accept-risk'], installEnv, 60000)
        inst = await exec(host.bin, ['plugin', '--profile', PROFILE, 'add', spec], installEnv, installTimeout)
        L1 = { ...parseInstall(inst.out, inst.code), exempted: { target: cmd[1], runtime: cmd[2], requirements: L1.requirements } }
      }
    }
    result.layers.L1 = { ...L1, logTail: redact(inst.out.split('\n').slice(-12).join('\n')) }
    result.codes.push(...L1.codes)
    writeFileSync(l1File, JSON.stringify(result.layers.L1))
    if (L1.status !== 'installed') {
      result.verdict = { incompatible: 'incompatible', 'not-published': 'not-published', 'infra-fail': 'infra-fail' }[L1.status] ?? 'fail'
      return result
    }
    if (phase === 'install') { result.verdict = 'installed'; return result }
    }

    // L2 — boot with a minimal environment and inspect host + client halves.
    const browser = opts.browser === false ? null : (opts.browser ?? findBrowser(baseEnv))
    const b = await boot(host, bootEnv(home, baseEnv), { bootTimeoutMs: opts.bootTimeoutMs ?? 90000, browser, settleMs: opts.settleMs ?? 8000 })
    const hb = parseBoot(b.log)
    const hostStatus = hb.hostFailures.length || hb.fatal || hb.unattributed ? 'failed'
      : b.timedOut ? 'timeout' : !hb.url ? (hb.missingCredential ? 'infra-fail' : 'failed') : 'clean'
    result.layers.L2.host = { status: hostStatus, failures: hb.hostFailures, fatal: hb.fatal, logTail: redact(b.log.split('\n').slice(-20).join('\n')) }
    for (const f of hb.hostFailures) result.codes.push(...f.codes)

    let client
    if (!host.capabilities.clientImmediate) client = { status: 'not-executed', reason: `DSH ${host.version} loads client bundles lazily` }
    else if (!browser) client = { status: 'unverified', reason: 'no Chrome/Edge/Chromium found' }
    else if (!b.page) client = { status: 'unverified', reason: 'host did not stay up' }
    else if (b.page.error) client = { status: 'unverified', reason: b.page.error }
    else {
      const c = parseClient(b.page.messages)
      client = { status: c.clientFailures.length ? 'failed' : 'clean', failures: c.clientFailures, netWarnings: c.netWarnings.slice(0, 5).map(redact) }
      for (const f of c.clientFailures) result.codes.push(...f.codes)
    }
    result.layers.L2.client = client

    result.verdict = hostStatus === 'failed' || client.status === 'failed' ? 'fail'
      : hostStatus === 'timeout' ? 'inconclusive'
      : hostStatus === 'infra-fail' ? 'infra-fail' : 'pass'
    return result
  } finally {
    result.codes = [...new Set(result.codes)]
    result.durationMs = Date.now() - t0
    if (keep) result.home = home
    else rmSync(home, { recursive: true, force: true })
  }
}

/** Read a package's own manifest from a directory spec (helper for callers that want name/version). */
export function readManifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
}
