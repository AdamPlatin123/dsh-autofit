/**
 * L0 plugin profile ("describe"): what a plugin is, where it runs, what it does to the profile it joins,
 * and what it needs — from its files alone. Never executes plugin code.
 *
 * Why this exists: large plugins are not "a feature added to web". dsh-tui replaces the web front end and
 * disables 23 core rows; DSH Desktop is an Electron shell carrying its own DSH runtime; ds-bot is a long-lived
 * service sharing state across hosts. A load trial alone reports all three as "pass" or "fail" without saying
 * whether the profile it was tried in was even the right one (lab, 2026-11-05).
 *
 * YAML is parsed with the `yaml` module of the local DSH installation, so this file adds no dependency.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** Rows whose reconfiguration changes what the agent may do or reach. */
const SECURITY_ROWS = new Set(['sandbox', 'sandbox-policy', 'bash-sandbox', 'pwsh-sandbox', 'approval', 'permission',
  'authorization', 'credentials', 'shell-env', 'fs-observation-policy', 'remote-access'])
const NATIVE_DEPS = /^(node-pty|koffi|better-sqlite3|sqlite3|sharp|canvas|@napi-rs\/.*|bufferutil|utf-8-validate|keytar|robotjs|nut-tree.*|uiohook-napi|ffi-napi|@serialport\/.*)$/
const SOURCE_EXT = /\.(m?js|cjs)$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'docs', 'screenshots', 'assets'])

/**
 * Directory of the `@deepseek-ai/dsh` package behind a launcher. Handles the global npm layout, shims and wrapper
 * scripts (npm .cmd shims, nvm, a Desktop-embedded runtime wrapped by a shell script) by reading the launcher for
 * the path of `@deepseek-ai/dsh/lib/bin.js`. `DSH_AUTOFIT_DSH_DIR` overrides discovery.
 */
export function dshPackageDir(dshBin = 'dsh', env = process.env) {
  if (env.DSH_AUTOFIT_DSH_DIR && existsSync(path.join(env.DSH_AUTOFIT_DSH_DIR, 'package.json'))) return env.DSH_AUTOFIT_DSH_DIR
  let bin
  try {
    bin = path.isAbsolute(dshBin) ? dshBin : execFileSync(process.platform === 'win32' ? 'where' : 'which', [dshBin], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    bin = realpathSync(bin)
  } catch { return null }
  const fromLib = /^(.*[\\/]@deepseek-ai[\\/]dsh)[\\/]lib[\\/]bin\.js$/.exec(bin)
  if (fromLib) return fromLib[1]
  try {
    const text = readFileSync(bin, 'utf8').slice(0, 20000)
    const m = /([^\s"'`]*@deepseek-ai[\\/]dsh)[\\/]lib[\\/]bin\.js/.exec(text)
    if (m) {
      const dir = path.resolve(path.dirname(bin), m[1].replace(/^%~?dp0%?\\?/i, ''))
      if (existsSync(path.join(dir, 'package.json'))) return dir
    }
  } catch { /* binary launcher */ }
  return null
}

function dshRequire(dshBin = 'dsh') {
  const dir = dshPackageDir(dshBin)
  return dir ? createRequire(path.join(dir, 'package.json')) : null
}

/**
 * Minimal reader for Cordis patch lists, used when the host's `yaml` module cannot be found. It understands the
 * subset patch files use for row operations: a top-level list of maps with `insert:` (a nested list of rows with
 * `id`/`name`/`children`), or `id:` plus `disabled:` / `config:` / `name:`; `remove:` with ids. Values other than
 * `true`/`false` scalars are kept as strings; nested config is reduced to "present".
 */
export function parsePatchLite(text) {
  const out = []
  let cur = null
  let mode = null
  let rowIndent = -1
  let row = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const t = line.trim()
    if (indent === 0 && t.startsWith('- ')) {
      cur = {}; out.push(cur); mode = null; row = null
      const kv = /^-\s+([\w-]+):\s*(.*)$/.exec(t)
      if (kv) assign(cur, kv[1], kv[2])
      if (kv && (kv[1] === 'insert' || kv[1] === 'remove')) { mode = kv[1]; cur[mode] = [] }
      continue
    }
    if (!cur) continue
    const item = /^-\s+(?:([\w-]+):\s*(.*))?$/.exec(t)
    if (mode && item && (rowIndent < 0 || indent <= rowIndent)) {
      rowIndent = indent
      if (mode === 'remove' && !item[1]) { cur.remove.push(t.slice(2).trim()); continue }
      row = {}; cur[mode].push(row)
      if (item[1]) assign(row, item[1], item[2])
      continue
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(t)
    if (!kv) continue
    if (mode && row && indent > rowIndent) { if (indent <= rowIndent + 2) assign(row, kv[1], kv[2]); continue }
    if (indent <= 2) {
      if (kv[1] === 'insert' || kv[1] === 'remove') { mode = kv[1]; cur[mode] = []; rowIndent = -1; continue }
      mode = null
      assign(cur, kv[1], kv[2])
    }
  }
  return out
  function assign(obj, k, v) {
    const val = v.trim().replace(/^['"]|['"]$/g, '')
    if (k === 'config') { obj.config = true; return }
    obj[k] = val === 'true' ? true : val === 'false' ? false : val === '' ? true : val.startsWith('!!js') ? '<js>' : val
  }
}

function parseYaml(text, req) {
  let Y = null
  try { Y = req?.('yaml') } catch { /* host without a resolvable yaml module */ }
  if (!Y) return parsePatchLite(text)
  return Y.parse(text, { customTags: [{ tag: '!!js', resolve: () => '<js>' }], logLevel: 'silent' })
}

function patchFiles(dir, pkg) {
  const decl = pkg.dsh?.bundle?.patch
  return [].concat(decl ?? []).map((p) => path.join(dir, p)).filter((p) => existsSync(p))
}

/** Row operations of a patch list: inserted ids, and updates to rows the patch did not insert. */
function patchOps(entries, acc = { inserts: [], updates: [], removes: [] }) {
  for (const e of entries ?? []) {
    if (!e || typeof e !== 'object') continue
    if (e.insert) {
      for (const row of [].concat(e.insert)) {
        if (row?.id) acc.inserts.push({ id: row.id, name: row.name })
        if (Array.isArray(row?.children)) patchOps([{ insert: row.children }], acc)
      }
    } else if (e.remove) {
      acc.removes.push(...[].concat(e.remove).map((r) => (typeof r === 'string' ? r : r?.id)).filter(Boolean))
    } else if (e.id) {
      acc.updates.push({
        id: e.id,
        disabled: 'disabled' in e ? e.disabled : undefined,
        config: 'config' in e,
        renamed: typeof e.name === 'string' ? e.name : undefined,
      })
    }
  }
  return acc
}

/** Core row ids = rows inserted by the shipped base bundles of this DSH installation. */
export function coreRows(req = dshRequire()) {
  const ids = new Set()
  if (!req) return ids
  for (const bundle of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    try {
      const pj = req.resolve(`${bundle}/package.json`)
      const dir = path.dirname(pj)
      const pkg = JSON.parse(readFileSync(pj, 'utf8'))
      for (const f of patchFiles(dir, pkg)) for (const r of patchOps(parseYaml(readFileSync(f, 'utf8'), req)).inserts) ids.add(r.id)
    } catch { /* bundle absent in this version */ }
  }
  return ids
}

function walk(dir, visit, depth = 0, budget = { files: 0 }) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (budget.files > 20000) return
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && depth < 8) walk(full, visit, depth + 1, budget) } else if (e.isFile()) { budget.files++; visit(full) }
  }
}

/**
 * Describe the plugin package at `dir` (an unpacked or installed package directory).
 * @param {string} dir
 * @param {{ core?: Set<string>, dshBin?: string }} [opts]
 */
export function describe(dir, opts = {}) {
  const req = dshRequire(opts.dshBin)
  const core = opts.core ?? coreRows(req)
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  const peers = pkg.peerDependencies ?? {}

  // Scale + source signals (bounded read: first 6 MB of plugin-owned JavaScript).
  const scale = { files: 0, bytes: 0, jsFiles: 0, deps: deps.length, peers: Object.keys(peers).length, subBundles: [] }
  const env = new Set()
  const endpoints = new Set()
  const signals = { longLived: 0, sidecar: 0, terminal: 0, secrets: 0 }
  let read = 0
  walk(dir, (f) => {
    let st
    try { st = statSync(f) } catch { return }
    scale.files++
    scale.bytes += st.size
    if (path.basename(f) === 'package.json' && path.dirname(f) !== dir) {
      try { const sub = JSON.parse(readFileSync(f, 'utf8')); if (sub.dsh?.bundle || sub.dsh?.client) scale.subBundles.push(sub.name ?? path.relative(dir, path.dirname(f))) } catch { /* ignore */ }
    }
    if (!SOURCE_EXT.test(f)) return
    scale.jsFiles++
    if (read > 6e6 || st.size > 2e6) return
    read += st.size
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) env.add(m[1])
    for (const m of src.matchAll(/['"`](https?:\/\/[a-z0-9.-]+\.[a-z]{2,})[/'"`]/gi)) if (!/w3\.org|schemas\.|example\.|localhost|127\.0\.0\.1/.test(m[1])) endpoints.add(m[1])
    if (/setInterval\(|text\/event-stream|EventSource|\.lock['"]|WebSocketServer|cron/.test(src)) signals.longLived++
    if (/spawn\(['"](python3?|uv|pip|java|docker|go)\b|\.py['"]/.test(src)) signals.sidecar++
    if (/process\.stdout\.isTTY|ansi-escapes|\x1b\[|react-reconciler|setRawMode/.test(src)) signals.terminal++
    if (/(TOKEN|SECRET|API_KEY|PASSWORD)\b/.test(src)) signals.secrets++
  })

  // Profile impact from the bundle patch.
  const ops = { inserts: [], updates: [], removes: [] }
  for (const f of patchFiles(dir, pkg)) patchOps(parseYaml(readFileSync(f, 'utf8'), req), ops)
  const own = new Set(ops.inserts.map((r) => r.id))
  const foreign = ops.updates.filter((u) => !own.has(u.id))
  const impact = {
    inserts: ops.inserts.map((r) => r.id),
    disablesCore: foreign.filter((u) => u.disabled !== undefined && u.disabled !== false && core.has(u.id)).map((u) => u.id + (u.disabled === true ? '' : '?')),
    reconfiguresCore: foreign.filter((u) => (u.config || u.renamed) && core.has(u.id)).map((u) => u.id),
    replacesImplementation: foreign.filter((u) => u.renamed && core.has(u.id)).map((u) => `${u.id}→${u.renamed}`),
    removes: ops.removes,
    touchesOther: foreign.filter((u) => !core.has(u.id)).map((u) => u.id),
  }
  impact.security = [...new Set([...impact.reconfiguresCore, ...impact.disablesCore.map((s) => s.replace(/\?$/, ''))])].filter((id) => SECURITY_ROWS.has(id))
  impact.level = impact.disablesCore.length >= 5 || impact.security.length || impact.removes.length ? 'high'
    : impact.disablesCore.length || impact.reconfiguresCore.length ? 'medium' : 'low'

  // Requirements.
  const nativeModules = deps.filter((d) => NATIVE_DEPS.test(d))
  const embedded = (() => { try { return JSON.parse(readFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version } catch { return null } })()
  const electron = 'electron' in peers || deps.includes('electron')
  const bins = Object.keys(typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin ?? {})

  // Kind + surfaces + target profile.
  const surfaces = []
  if (impact.inserts.length) surfaces.push('host')
  if (pkg.dsh?.client) surfaces.push(`${pkg.dsh.client.platform ?? 'web'}-client`)
  if (signals.terminal && (bins.length || impact.disablesCore.length >= 5)) surfaces.push('terminal')
  if (electron) surfaces.push('desktop-shell')
  let kind = 'extension'
  if (electron || embedded) kind = 'shell'
  else if (impact.disablesCore.length >= 5 || (bins.length && impact.reconfiguresCore.some((id) => ['agent-loop', 'system-prompt'].includes(id)))) kind = 'frontend'
  else if (scale.subBundles.length >= 2) kind = 'pack'
  else if (signals.longLived && (endpoints.size || signals.secrets)) kind = 'service'
  let readmeProfile = null
  for (const r of ['README.md', 'README.zh.md', 'README.en.md']) {
    const p = path.join(dir, r)
    if (!existsSync(p)) continue
    const m = /dsh plugin --profile ([\w-]+) add/.exec(readFileSync(p, 'utf8'))
    if (m) { readmeProfile = m[1]; break }
  }
  const targetProfile = kind === 'shell' ? 'own-runtime' : kind === 'frontend' ? (readmeProfile && readmeProfile !== 'web' ? readmeProfile : 'dedicated') : 'web'

  const notes = []
  if (kind === 'frontend') notes.push(`replaces the default front end; installing into an existing web profile disables ${impact.disablesCore.length} core rows there`)
  if (kind === 'shell') notes.push(`host shell${embedded ? ` with embedded DSH ${embedded}` : ''}; its plugins run on that runtime, not on the global dsh`)
  if (impact.security.length) notes.push(`changes security-relevant rows: ${impact.security.join(', ')}`)
  if (kind === 'service') notes.push('long-lived service: background work, network endpoints and/or credentials; a load trial does not exercise them')
  if (signals.sidecar) notes.push('spawns an external runtime (sidecar); the trial environment must provide it')

  return {
    schema: 'dsh-autofit/describe/v1',
    name: pkg.name,
    version: pkg.version,
    kind,
    surfaces,
    targetProfile,
    scale,
    compat: {
      engines: pkg.engines?.dsh ?? null,
      dshPeers: Object.fromEntries(Object.entries(peers).filter(([k]) => k === '@deepseek-ai/dsh' || k.startsWith('@deepseek-ai/dsh-'))),
      verified: pkg.dsBot?.verifiedDsh ?? pkg.dsh?.verifiedDsh ?? null,
    },
    profileImpact: impact,
    requirements: {
      nativeModules,
      sidecar: signals.sidecar > 0,
      electron,
      embeddedRuntime: embedded,
      env: [...env].filter((e) => !/^(NODE_|npm_|DSH_HOME$|HOME$|PATH$|TERM$|CI$)/.test(e)).sort().slice(0, 40),
      endpoints: [...endpoints].sort().slice(0, 40),
      bins,
    },
    notes,
  }
}
