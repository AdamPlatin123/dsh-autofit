/**
 * Host half of the dsh-autofit bundle.
 *
 * Authenticated, Client-callable routes (exact Connection Fetch routes; owner Peer only):
 *   POST /api/autofit/check    { spec }                 L1/L2 trial of one spec
 *   POST /api/autofit/fix      { spec, allowBuilds? }   trial → repair → re-trial (lib/autofix)
 *   POST /api/autofit/catalog  { q?, offset?, limit?, sources?, category?, radar?, sort?, installed?, itemKeys? }
 *                                                       merged catalog of every enabled source + radar verdicts
 *   POST /api/autofit/status   { name? }                last background check of an installed bundle
 *   POST /api/autofit/sources/list     {}               configured catalog sources and their load state
 *   POST /api/autofit/sources/probe    { url }          preview an index URL before adding it
 *   POST /api/autofit/sources/set      { …change }      enable/disable, trust, priority, add or remove a source
 *   POST /api/autofit/sources/refresh  { id? }          reload one source (or all) now
 *   POST /api/autofit/job/start        { spec, allowBuilds?, key?, sourceId? }   "Install with autofix" job;
 *        a job naming a browse-only source is refused (409 autofit/untrusted-source)
 *
 * Every route is POST with a JSON body: the /api browser-trust fence rejects plain GETs (lab: 400, empty body).
 *
 * Background: every 60 s the current profile's dependencies are compared with the last snapshot; a newly
 * installed third-party bundle is trialled once (whatever installed it — Discover, another market, the CLI),
 * and the result is kept in `<DSH_HOME>/autofit/checks.json` for the detail page.
 *
 * Only one trial runs at a time (a trial starts real pnpm and a real web boot); background checks yield to
 * user-initiated ones.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { autofix, autofitPipeline } from '../lib/autofix/index.js'
import { randomUUID } from 'node:crypto'
import { probe } from '../lib/probe/index.js'
import { sweepStale } from '../lib/probe/cleanup.js'
import { catalogRequest, catalogUnavailable, chipPredicate, hostMarketList, isFresh, jobGate, legacyView, offersPlugins, sourceStatus, wireItem } from '../lib/sources/catalog.js'
import { buildIndex, mergeCatalog, queryCatalog } from '../lib/sources/merge.js'
import { applySourceChange, loadSource, loadSourceConfig, probeSource, saveSourceConfig } from '../lib/sources/store.js'

/** Connection must exist for a browser-callable route; otherwise this row stays inactive. */
export const inject = ['connection']

const ROUTES = { check: '/api/autofit/check', fix: '/api/autofit/fix', catalog: '/api/autofit/catalog', status: '/api/autofit/status',
  jobStart: '/api/autofit/job/start', jobPoll: '/api/autofit/job/poll', jobCancel: '/api/autofit/job/cancel', jobList: '/api/autofit/job/list', jobInstalled: '/api/autofit/job/installed',
  sourcesList: '/api/autofit/sources/list', sourcesProbe: '/api/autofit/sources/probe', sourcesSet: '/api/autofit/sources/set', sourcesRefresh: '/api/autofit/sources/refresh' }
const WATCH_INTERVAL_MS = 60 * 1000

/**
 * The launcher that started this Host process. `process.argv[1]` is DSH's `lib/bin.js`; probe runs it under
 * this process's executable (Electron-aware), so the trial uses the same runtime as the Host.
 */
function dshLauncher() {
  const configured = process.env.DSH_AUTOFIT_DSH_BIN
  if (configured && existsSync(configured)) return configured
  // 1. argv[1], symlinks resolved: a global `dsh` (npm, nvm) is a link to `@deepseek-ai/dsh/lib/bin.js`.
  try {
    const entry = process.argv[1] && realpathSync(process.argv[1])
    if (entry && /(?:^|[\\/])bin\.js$/i.test(entry)) return entry
  } catch { /* argv[1] is not a file */ }
  // 2. ProfileContext.installAnchor: DSH's own package.json for the CLI, or a file DSH resolves from (packaged apps).
  const fromAnchor = binFromAnchor(where.installAnchor)
  if (fromAnchor) return fromAnchor
  // 3. Desktop in Electron: the runtime ships in the app resources. Official DeepSeek Harness: `app.asar/dsh/`;
  //    community DSH Desktop: `app/` up to 2.0.18, `app.asar` from 2.0.22. Electron's fs reads asar paths.
  if (process.versions.electron && process.resourcesPath) {
    for (const root of [path.join('app.asar', 'dsh'), 'app', 'app.asar']) {
      const bin = path.join(process.resourcesPath, root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(bin)) return bin
    }
  }
  // 4. Last resort: `dsh` on PATH (often absent when DSH was started from a GUI launcher).
  return 'dsh'
}

function binFromAnchor(anchor) {
  if (!anchor) return null
  try {
    const own = JSON.parse(readFileSync(anchor, 'utf8'))
    if (own?.name === '@deepseek-ai/dsh') {
      const bin = path.join(path.dirname(anchor), 'lib', 'bin.js')
      if (existsSync(bin)) return bin
    }
  } catch { /* not a package.json */ }
  try {
    const pkg = createRequire(anchor).resolve('@deepseek-ai/dsh/package.json')
    const bin = path.join(path.dirname(pkg), 'lib', 'bin.js')
    if (existsSync(bin)) return bin
  } catch { /* not resolvable from the anchor */ }
  return null
}

/** The Host carries its own profile pointers; a trial must never inherit them (it would target the live profile). */
function trialEnv() {
  const env = { ...process.env }
  delete env.DSH_PROFILE
  delete env.DSH_PROFILE_DIR
  delete env.DSH_SESSION_ID
  return env
}

/** Filled from the ProfileContext service at apply(); env/home fallbacks keep the routes usable without it. */
const where = { profileDir: process.env.DSH_PROFILE_DIR || null, home: null, packageManager: null, installAnchor: null }
const dshHome = () => where.home || process.env.DSH_HOME || path.join(homedir(), '.dsh')
const dataDir = () => path.join(dshHome(), 'autofit')

function failure(code, message, details = {}) { return { ok: false, error: { code, message, details } } }
function text(value, limit = 2000) {
  if (value === undefined || value === null) return null
  const out = String(value)
  return out.length > limit ? `${out.slice(0, limit)}…` : out
}
function stringList(value, limit = 40) { return (Array.isArray(value) ? value : []).slice(0, limit).map((item) => text(item, 400)).filter(Boolean) }
function failures(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((item) => ({
    entry: text(item?.entry, 300), package: text(item?.package, 300), error: text(item?.error ?? item?.message, 1200),
    codes: stringList(item?.codes, 20), collateral: item?.collateral === true,
  }))
}
function describeSummary(d) {
  if (!d || typeof d !== 'object') return null
  const impact = d.profileImpact ?? {}
  const req = d.requirements ?? {}
  return {
    name: text(d.name, 300), version: text(d.version, 100), kind: text(d.kind, 40), targetProfile: text(d.targetProfile, 80),
    surfaces: stringList(d.surfaces, 10),
    profileImpact: {
      level: text(impact.level, 20), inserts: stringList(impact.inserts, 60), disablesCore: stringList(impact.disablesCore, 60),
      reconfiguresCore: stringList(impact.reconfiguresCore, 60), replacesImplementation: stringList(impact.replacesImplementation, 60),
      security: stringList(impact.security, 60), removes: stringList(impact.removes, 60), touchesOther: stringList(impact.touchesOther, 60),
    },
    notes: stringList(d.notes, 20), compat: d.compat ?? null,
    requirements: {
      nativeModules: stringList(req.nativeModules, 30), sidecar: req.sidecar === true, electron: req.electron === true,
      embeddedRuntime: text(req.embeddedRuntime, 100), bins: stringList(req.bins, 20), env: stringList(req.env, 30), endpoints: stringList(req.endpoints, 30),
    },
  }
}

/** Keep the wire payload small and stable; the UI never needs the raw probe object. */
function summarize(result) {
  const l1 = result?.layers?.L1 ?? {}
  const l2host = result?.layers?.L2?.host ?? null
  const l2client = result?.layers?.L2?.client ?? null
  return {
    spec: text(result?.spec, 2000),
    verdict: text(result?.verdict, 40),
    durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
    host: { version: text(result?.host?.version, 100), tier: text(result?.host?.tier, 40) },
    L1: {
      status: text(l1.status, 40), error: text(l1.error, 1200), requirements: l1.requirements ?? null,
      blockedBuilds: stringList(l1.blockedBuilds, 30), exempted: l1.exempted ?? null, codes: stringList(l1.codes, 40),
      logTail: text(l1.logTail, 4000), describe: describeSummary(l1.describe), describeError: text(l1.describeError, 1200),
    },
    L2: {
      host: { status: text(l2host?.status, 40), failures: failures(l2host?.failures), fatal: l2host?.fatal === true, logTail: text(l2host?.logTail, 4000), reason: text(l2host?.reason, 600) },
      client: { status: text(l2client?.status, 40), reason: text(l2client?.reason, 1200), failures: failures(l2client?.failures) },
    },
    codes: stringList(result?.codes, 80),
  }
}

function summarizeFix(report) {
  return {
    spec: text(report.spec, 2000),
    verdict: text(report.verdict, 40),
    rounds: (report.rounds ?? []).map((r) => ({ round: r.round, verdict: text(r.verdict, 40), codes: stringList(r.codes, 40), durationMs: r.durationMs ?? null })),
    changes: (report.changes ?? []).map((c) => ({ round: c.round, tier: text(c.tier, 4), rule: text(c.rule, 60), file: text(c.file, 300), detail: text(c.detail, 600) })),
    artifact: report.artifact ? { file: text(report.artifact.file, 1000), name: text(report.artifact.name, 300), version: text(report.artifact.version, 100), usable: report.artifact.usable === true } : null,
    needsApproval: (report.needsApproval ?? []).map((a) => ({ kind: text(a.kind, 40), packages: stringList(a.packages, 20), why: text(a.why, 400) })),
    unresolved: (report.unresolved ?? []).map((u) => ({ code: text(u.code, 60), hint: text(u.hint, 400) })),
    error: text(report.error, 1200),
    notRepairable: report.notRepairable === true, reason: text(report.reason, 600),
    final: report.final ? summarize(report.final) : null,
  }
}

/* ------------------------------------------------------------------ one trial at a time */

let running = null
async function exclusive(task) {
  if (running) return { busy: true }
  running = task()
  try { return { value: await running } } finally { running = null }
}

/* ------------------------------------------------------------------ catalog (many sources) */

// Every enabled source loads on its own through lib/sources/store.js (on-disk cache, stale serving): it is reused
// for 30 min after a good load and retried after 2 min when it failed (catalog.js isFresh), with at most one load per
// source in flight. A request waits only for sources that have never finished a load; a due reload of a source that
// has data runs in the background and the request is answered from the data at hand (stale-while-revalidate).
// The merged index is rebuilt only when some source's data (or trust) changed.
const catalog = { config: null, configLoading: null, configGen: 0, states: new Map(), merged: null, gen: 0 }
/** Index URLs the host's optional plugin-market service is configured with: [{ url, title, description, error }]. */
let hostMarkets = []
let hostVersionCache

/** The running DSH version (package.json next to the launcher), or null; sources choose versions for it. */
function hostVersion() {
  if (hostVersionCache !== undefined) return hostVersionCache
  hostVersionCache = null
  try {
    const bin = dshLauncher()
    if (bin !== 'dsh') {
      const pkg = JSON.parse(readFileSync(path.join(path.dirname(bin), '..', 'package.json'), 'utf8'))
      if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') hostVersionCache = pkg.version
    }
  } catch { /* unknown: sources fall back to the newest stable version */ }
  return hostVersionCache
}

function invalidateConfig() {
  catalog.config = null
  catalog.configLoading = null // a load started before the change must not be handed out after it
  catalog.configGen++
}

/** The effective source config, read from disk (the latest saved state) with the current host markets. */
function readSourceConfig() {
  return loadSourceConfig(dataDir(), { hostMarkets: hostMarkets.map((m) => m.url) })
}

async function sourceConfig() {
  if (catalog.config) return catalog.config
  if (catalog.configLoading) return catalog.configLoading
  const gen = catalog.configGen
  const loading = readSourceConfig()
    .then((list) => { if (gen === catalog.configGen) catalog.config = list; return list })
    .finally(() => { if (catalog.configLoading === loading) catalog.configLoading = null })
  catalog.configLoading = loading
  return loading
}

// `/sources/set` changes run one at a time, each on the config as last saved: concurrent changes would otherwise
// start from the same list (one answered ok but lost) and race their renames onto sources.json (EPERM on Windows).
let sourceChanges = Promise.resolve()
function serializedSourceChange(task) {
  const run = sourceChanges.then(task)
  sourceChanges = run.catch(() => {})
  return run
}

/** Load one source unless its last load is still fresh. Never rejects: loadSource answers failures as data. */
function loadOne(source, { force = false, log } = {}) {
  const prev = catalog.states.get(source.id)
  if (prev?.loading) return prev.loading
  if (!force && isFresh(prev, Date.now())) return Promise.resolve(prev)
  const loading = loadSource(source, { dataDir: dataDir(), hostVersion: hostVersion() ?? undefined })
    .then((r) => ({ at: Date.now(), meta: r.meta, offerings: r.offerings ?? null, radar: r.radar ?? null, gen: ++catalog.gen }))
    .catch((err) => {
      log?.warn?.(`dsh-autofit: source ${source.id} failed to load: ${err?.message ?? err}`)
      return { at: Date.now(), meta: { ...(prev?.meta ?? {}), state: prev?.offerings?.length || prev?.radar?.size ? 'stale' : 'failed', error: { code: 'internal', message: text(err?.message ?? err, 600) } },
        offerings: prev?.offerings ?? [], radar: prev?.radar ?? new Map(), gen: ++catalog.gen }
    })
    .then((next) => { catalog.states.set(source.id, next); return next })
  catalog.states.set(source.id, { ...(prev ?? {}), loading })
  return loading
}

/**
 * Load every enabled source (`force` reloads them, or only source `id`), merge and index.
 * @returns `{ index, rows, source, radarAt }`: rows = per-source status, source = URL of the top source with data.
 */
async function loadCatalog({ force = false, id = null, log } = {}) {
  const config = await sourceConfig()
  const enabled = config.filter((s) => s.enabled !== false && (offersPlugins(s) || s.kind === 'radar-overlay'))
  const waits = []
  for (const s of enabled) {
    const forced = force && (!id || s.id === id)
    const load = loadOne(s, { force: forced, log })
    // Wait for a forced reload and for a source that has never finished loading; a source with data is served as
    // is while its due reload runs on (loadOne never rejects; the catch is a guard for this background path).
    if (forced || !Number.isFinite(catalog.states.get(s.id)?.at)) waits.push(load)
    else load.catch(() => {})
  }
  await Promise.all(waits)
  // Drop the data of sources that are gone or disabled (a disabled 20k-entry index would otherwise stay in memory).
  for (const key of catalog.states.keys()) if (!enabled.some((s) => s.id === key)) catalog.states.delete(key)
  const plugin = enabled.filter(offersPlugins)
  const radarSource = enabled.find((s) => s.kind === 'radar-overlay')
  const radar = radarSource ? catalog.states.get(radarSource.id) : null
  const sig = [...plugin.map((s) => `${s.id}:${s.trust}:${catalog.states.get(s.id)?.gen ?? 0}`), `radar:${radar?.gen ?? 0}`].join('|')
  if (!catalog.merged || catalog.merged.sig !== sig) {
    const merged = mergeCatalog(plugin.map((s) => ({ id: s.id, trust: s.trust, offerings: catalog.states.get(s.id)?.offerings ?? [] })), { radar: radar?.radar ?? null })
    catalog.merged = { sig, index: buildIndex(merged.items) }
  }
  const top = plugin.map((s) => catalog.states.get(s.id)?.meta).find((m) => m?.url && m.count > 0)
  return { index: catalog.merged.index, merged: catalog.merged, config, rows: sourceStatus(config, catalog.states), source: top?.url ?? null, radarAt: radar?.meta?.generatedAt ?? null }
}

/** The 0.4.0 view of the current merge (legacyView), computed once per merge. */
function legacyItems(c) {
  if (!c.merged.legacy) {
    const rank = new Map(c.config.map((s, i) => [s.id, i]))
    c.merged.legacy = legacyView(c.index.items, (id) => rank.get(id) ?? Infinity)
  }
  return c.merged.legacy
}

/** Names of every dependency of the current profile (for the `installed` chip), or null without a profile. */
function installedNames() {
  if (!where.profileDir) return null
  try { return Object.keys(JSON.parse(readFileSync(path.join(where.profileDir, 'package.json'), 'utf8')).dependencies ?? {}) } catch { return null }
}

/* ------------------------------------------------------------------ background checks */

function checksFile() { return path.join(dataDir(), 'checks.json') }
function readChecks() { try { return JSON.parse(readFileSync(checksFile(), 'utf8')) } catch { return {} } }
function writeChecks(checks) {
  mkdirSync(dataDir(), { recursive: true })
  const tmp = `${checksFile()}.tmp`
  writeFileSync(tmp, JSON.stringify(checks, null, 2))
  renameSync(tmp, checksFile())
}

function profileDeps() {
  const dir = where.profileDir
  if (!dir) return null
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const deps = pkg.dependencies ?? {}
    return Object.fromEntries(Object.entries(deps).filter(([name]) => !name.startsWith('@deepseek-ai/') && name !== 'dsh-autofit'))
  } catch { return null }
}

/** Spec for re-trialling an installed dependency: its manifest spec, or name@installed-version. */
function specFor(name, declared) {
  if (/^(file|link):/.test(declared)) return declared.replace(/^(file|link):/, '')
  try {
    const v = JSON.parse(readFileSync(path.join(where.profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version
    if (v) return `${name}@${v}`
  } catch { /* fall back to the declared range */ }
  return `${name}@${declared}`
}

const queue = []
let lastDeps = null

// Background checks run unasked, next to the user's live DSH. They stop at L1 (a real install into a throwaway
// profile + static profile): booting the plugin there would also start its long-lived side (ports, tunnels, helper
// windows) beside the live copy — seen live: dsh-pocket "port 3081 busy, proxy on 3082". A user-started check does the
// full L1+L2 trial. And nothing here may ever reject: 0.3.5 let an EPERM from temp cleanup escape and kill the host.
async function drainQueue(log) {
  while (queue.length && !running) {
    const { name, spec } = queue.shift()
    let entry
    try {
      const out = await exclusive(async () => probe(spec, { bin: dshLauncher(), env: trialEnv(), pnpm: where.packageManager, phase: 'install', browser: false }))
      if (out.busy) { queue.unshift({ name, spec }); return }
      entry = { at: new Date().toISOString(), trigger: 'installed', scope: 'install', ...summarize(out.value) }
    } catch (err) {
      entry = { at: new Date().toISOString(), trigger: 'installed', scope: 'install', spec, verdict: 'infra-fail', error: text(String(err?.message ?? err), 600) }
    }
    try {
      const checks = readChecks()
      checks[name] = entry
      writeChecks(checks)
    } catch (err) { log?.warn?.(`dsh-autofit: could not record the check of ${spec}: ${err?.message ?? err}`) }
    log?.info?.(`dsh-autofit: background check of ${spec}: ${entry.verdict}`)
  }
}

function watchInstalls(log) {
  try { sweepStale() } catch { /* best effort */ }
  const tick = () => { try { tickOnce() } catch (err) { log?.warn?.(`dsh-autofit: install watcher: ${err?.message ?? err}`) } }
  const tickOnce = () => {
    const deps = profileDeps()
    if (!deps) return
    if (lastDeps) {
      for (const [name, declared] of Object.entries(deps)) {
        if (lastDeps[name] === declared || queue.some((q) => q.name === name)) continue
        queue.push({ name, spec: specFor(name, declared) })
      }
    }
    lastDeps = deps
    drainQueue(log).catch((err) => log?.warn?.(`dsh-autofit: background check failed: ${err?.message ?? err}`))
  }
  tick()
  const timer = setInterval(tick, WATCH_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}


/* ------------------------------------------------------------------ "Install with autofix" jobs */

/** id → job. Jobs run one after another (each starts real installs); the UI polls their event log. */
const jobs = new Map()
let jobChain = Promise.resolve()

function jobView(job, since = 0) {
  return {
    id: job.id, spec: job.spec, key: job.key ?? null, sourceId: job.sourceId ?? null, status: job.status, createdAt: job.createdAt,
    events: job.events.slice(since), next: job.events.length,
    result: job.result ? { outcome: job.result.outcome, by: job.result.by ?? null, install: job.result.install ?? null,
      reason: text(job.result.reason, 1200), changes: (job.result.changes ?? []).slice(0, 40),
      needsApproval: job.result.needsApproval ?? [], unresolved: job.result.unresolved ?? [],
      artifactVersion: job.result.artifact?.version ?? null, final: job.result.final ? summarize(job.result.final) : null,
      review: job.result.review ?? false, diff: text(job.result.diff, 40000), lines: job.result.lines ?? null } : null,
    installed: job.installed ?? null,
  }
}

function startJob(ctx, spec, allowBuilds, origin = {}) {
  const job = { id: randomUUID(), spec, key: origin.key ?? null, sourceId: origin.sourceId ?? null, status: 'queued', createdAt: new Date().toISOString(), events: [], result: null, controller: new AbortController() }
  const push = (e) => { job.events.push({ at: Date.now(), ...e }); if (job.events.length > 600) job.events.splice(0, job.events.length - 600) }
  jobs.set(job.id, job)
  for (const [id, j] of jobs) if (jobs.size > 20 && j.status !== 'running' && j.status !== 'queued') jobs.delete(id)
  jobChain = jobChain.then(async () => {
    if (job.controller.signal.aborted) { job.status = 'cancelled'; return }
    job.status = 'running'
    let llm = null
    let model = null
    try { llm = ctx.get('llm') } catch { /* no llm service */ }
    try { model = ctx.get('agentDefaultModel')?.currentSelection() ?? null } catch { /* no default model */ }
    try {
      let out
      do {
        while (running) await new Promise((r) => setTimeout(r, 1000)) // a user check or background check holds the slot
        out = await exclusive(() => autofitPipeline(spec, {
          probe: { bin: dshLauncher(), env: trialEnv(), pnpm: where.packageManager, allowBuilds },
          llm, model, outDir: path.join(dataDir(), 'patched'), onEvent: push, signal: job.controller.signal,
        }))
      } while (out.busy && !job.controller.signal.aborted)
      job.result = out.value ?? { outcome: 'error', reason: 'busy' }
      // `ready` installs right away (the user asked for it; rules record every change). An agent repair waits in
      // `review` until the user has seen its diff and said yes.
      job.status = job.controller.signal.aborted ? 'cancelled'
        : ['pass', 'fixed'].includes(job.result.outcome) ? (job.result.review ? 'review' : 'ready') : 'failed'
    } catch (err) {
      job.result = { outcome: 'error', reason: String(err?.message ?? err) }
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
      push({ type: 'done', outcome: 'error', reason: job.result.reason })
    }
  })
  return job
}

/* ------------------------------------------------------------------ routes */

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

async function readSpec(request) {
  let payload
  try { payload = await request.json() } catch { return { error: json(failure('autofit/invalid-json', 'The request body must be JSON.', { field: 'body' }), 400) } }
  const spec = typeof payload?.spec === 'string' ? payload.spec.trim() : ''
  if (!spec || spec.length > 2000 || spec.startsWith('-')) return { error: json(failure('autofit/invalid-spec', 'A plugin spec (not an option) of at most 2000 characters is required.', { field: 'spec' }), 400) }
  const allowBuilds = Array.isArray(payload?.allowBuilds) ? payload.allowBuilds.filter((b) => typeof b === 'string' && /^(@[\w.-]+\/)?[\w.-]+$/.test(b)).slice(0, 20) : []
  // A job started from a catalog card names the item key and the offer's source (for the trust gate, jobGate).
  const key = payload?.key ?? null
  const sourceId = payload?.sourceId ?? null
  return { spec, allowBuilds, key, sourceId }
}

export function apply(ctx) {
  // The Host process does not carry DSH_PROFILE_DIR (that is set for agent shell calls); ProfileContext does.
  try {
    const profile = ctx.get('profileContext')
    if (profile?.dir) where.profileDir = profile.dir
    if (profile?.home) where.home = profile.home
    if (profile?.installAnchor) where.installAnchor = profile.installAnchor
    if (profile?.packageManager?.command) where.packageManager = profile.packageManager
  } catch { /* no profile (e.g. SDK boot): background checks stay off */ }
  const log = ctx.logger
  const reg = (route) => ctx.effect(() => ctx.connection.fetch.register(route), `dsh-autofit: ${route.path}`)

  // Host markets: the pluginMarket service exists only with @deepseek-ai/dsh-experimental-plugin-market-bundle.
  // A nested inject runs the callback when (and while) the service is there; without it nothing happens.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['pluginMarket'], (scope) => {
        const sync = () => {
          let next = []
          // listIndexes() is synchronous on Host and never fetches; wrapped anyway (background path).
          try { next = hostMarketList(scope.pluginMarket?.listIndexes?.()) } catch (err) { log?.warn?.(`dsh-autofit: host markets: ${err?.message ?? err}`) }
          const changed = next.map((m) => m.url).join('\n') !== hostMarkets.map((m) => m.url).join('\n')
          hostMarkets = next
          if (changed) invalidateConfig()
        }
        sync()
        scope.on?.('plugin-market/changed', () => { try { sync() } catch { /* never throw from an event */ } })
        scope.effect?.(() => () => { if (hostMarkets.length) { hostMarkets = []; invalidateConfig() } }, 'dsh-autofit: host markets')
      })
    }
  } catch (err) { log?.warn?.(`dsh-autofit: plugin-market service not usable: ${err?.message ?? err}`) }

  reg({
    path: ROUTES.check, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const input = await readSpec(request)
      if (input.error) return input.error
      try {
        const out = await exclusive(() => probe(input.spec, { bin: dshLauncher(), env: trialEnv(), pnpm: where.packageManager, allowBuilds: input.allowBuilds }))
        if (out.busy) return json(failure('autofit/busy', 'Another Autofit check is already running.', { retryable: true }), 409)
        return json({ ok: true, value: { ...summarize(out.value), requestedSpec: input.spec } })
      } catch (error) {
        return json(failure('autofit/check-failed', text(error?.message ?? error, 1200) ?? 'The trial failed to start.', { launcher: dshLauncher() }), 500)
      }
    },
  })

  reg({
    path: ROUTES.fix, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const input = await readSpec(request)
      if (input.error) return input.error
      try {
        const out = await exclusive(() => autofix(input.spec, { probe: { bin: dshLauncher(), env: trialEnv(), pnpm: where.packageManager, allowBuilds: input.allowBuilds }, outDir: path.join(dataDir(), 'patched') }))
        if (out.busy) return json(failure('autofit/busy', 'Another Autofit check is already running.', { retryable: true }), 409)
        return json({ ok: true, value: { ...summarizeFix(out.value), requestedSpec: input.spec } })
      } catch (error) {
        return json(failure('autofit/fix-failed', text(error?.message ?? error, 1200) ?? 'Autofix failed to start.'), 500)
      }
    },
  })

  const body = async (request) => { try { return await request.json() } catch { return {} } }

  reg({
    path: ROUTES.catalog, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      // Without the new fields this is the 0.4.0 request: every enabled source, sorted by stars. Without `itemKeys`
      // the client may be 0.4.0 (cards keyed by name, jobs started without a source id): it gets one item per name
      // and no browse-only offers (catalog.js legacyView).
      const req = catalogRequest(await body(request))
      try {
        const c = await loadCatalog({ log })
        const down = catalogUnavailable(c.rows)
        if (down) return json(failure('autofit/catalog-unavailable', down, { sourceStatus: c.rows }), 502)
        const chip = chipPredicate(req, installedNames())
        const legacy = req.itemKeys ? null : legacyItems(c)
        const predicate = legacy ? (chip ? (it) => legacy.has(it) && chip(it) : (it) => legacy.has(it)) : chip
        const r = queryCatalog(c.index, {
          q: req.q, sources: req.sources, category: req.category, radar: req.radar, sort: req.sort,
          offset: req.offset, limit: req.limit, predicate,
        })
        return json({ ok: true, value: {
          total: r.total, items: r.items.map(wireItem), offset: req.offset, limit: req.limit, source: c.source, radarAt: c.radarAt,
          facets: r.facets, sourceStatus: c.rows,
        } })
      } catch (error) {
        log?.warn?.(`dsh-autofit: catalog: ${error?.message ?? error}`)
        return json(failure('autofit/catalog-unavailable', text(error?.message ?? error, 800)), 502)
      }
    },
  })

  const sourcesValue = async () => ({ sources: sourceStatus(await sourceConfig(), catalog.states), hostMarkets })

  reg({
    path: ROUTES.sourcesList, methods: ['POST'], requestBody: 'buffered',
    fetch: async () => {
      try {
        return json({ ok: true, value: await sourcesValue() })
      } catch (error) {
        return json(failure('autofit/sources-unavailable', text(error?.message ?? error, 800)), 500)
      }
    },
  })

  reg({
    path: ROUTES.sourcesProbe, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const b = await body(request)
      if (typeof b?.url !== 'string' || !b.url.trim()) return json(failure('autofit/invalid-source-url', 'An index URL is required.', { field: 'url' }), 400)
      try {
        return json({ ok: true, value: await probeSource(b.url, { hostVersion: hostVersion() ?? undefined, existing: catalog.merged?.index.items ?? [] }) })
      } catch (error) {
        const code = error?.code ?? 'internal'
        if (code === 'scheme' || code === 'invalid') return json(failure('autofit/invalid-source-url', text(error?.message ?? error, 800), { code }), 400)
        return json(failure('autofit/source-probe-failed', text(error?.message ?? error, 800), { code, status: error?.status ?? null }), 502)
      }
    },
  })

  reg({
    path: ROUTES.sourcesSet, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const change = await body(request)
      return serializedSourceChange(async () => {
        let next
        try {
          next = applySourceChange(await readSourceConfig(), change).sources
        } catch (error) {
          const code = error?.code ?? 'invalid'
          const status = code === 'duplicate' ? 409 : code === 'not-found' ? 404 : 400
          return json(failure(`autofit/source-${code}`, text(error?.message ?? error, 800)), status)
        }
        try {
          await saveSourceConfig(dataDir(), next)
          invalidateConfig()
          for (const s of next) if (s.enabled === false) catalog.states.delete(s.id) // free a disabled source now
          return json({ ok: true, value: await sourcesValue() })
        } catch (error) {
          return json(failure('autofit/sources-save-failed', text(error?.message ?? error, 800)), 500)
        }
      })
    },
  })

  reg({
    path: ROUTES.sourcesRefresh, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const b = await body(request)
      const id = typeof b?.id === 'string' ? b.id : null
      try {
        if (id && !(await sourceConfig()).some((s) => s.id === id)) return json(failure('autofit/source-not-found', `No source ${text(id, 100)}.`), 404)
        const c = await loadCatalog({ force: true, id, log })
        return json({ ok: true, value: { sources: c.rows, hostMarkets } })
      } catch (error) {
        log?.warn?.(`dsh-autofit: source refresh: ${error?.message ?? error}`)
        return json(failure('autofit/sources-unavailable', text(error?.message ?? error, 800)), 502)
      }
    },
  })

  reg({
    path: ROUTES.status, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const b = await body(request)
      const name = typeof b?.name === 'string' ? b.name : null
      const checks = readChecks()
      return json({ ok: true, value: name ? checks[name] ?? null : Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { at: v.at, verdict: v.verdict, spec: v.spec }])) })
    },
  })


  reg({
    path: ROUTES.jobStart, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const input = await readSpec(request)
      if (input.error) return input.error
      if (input.sourceId !== null || input.key !== null) {
        let config = []
        try { config = await sourceConfig() } catch (err) { log?.warn?.(`dsh-autofit: source config: ${err?.message ?? err}`) }
        const gate = jobGate({ sourceId: input.sourceId, key: input.key }, config)
        if (!gate.ok) return json(failure(gate.code, gate.message, { sourceId: text(input.sourceId, 100) }), gate.status)
      }
      const live = [...jobs.values()].find((j) => j.spec === input.spec && (j.status === 'queued' || j.status === 'running'))
      return json({ ok: true, value: jobView(live ?? startJob(ctx, input.spec, input.allowBuilds, { key: text(input.key, 600), sourceId: input.sourceId })) })
    },
  })
  reg({
    path: ROUTES.jobPoll, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const b = await body(request)
      const job = jobs.get(String(b?.id ?? ''))
      return job ? json({ ok: true, value: jobView(job, Math.max(0, Number(b?.since) || 0)) }) : json(failure('autofit/no-job', 'Unknown job.'), 404)
    },
  })
  reg({
    path: ROUTES.jobCancel, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const b = await body(request)
      const job = jobs.get(String(b?.id ?? ''))
      if (!job) return json(failure('autofit/no-job', 'Unknown job.'), 404)
      job.controller.abort()
      // Cancelling a repair under review is declining it: it is never installed, not even after a reload.
      if (job.status === 'queued' || job.status === 'review') job.status = 'cancelled'
      return json({ ok: true, value: jobView(job, job.events.length) })
    },
  })
  reg({
    path: ROUTES.jobList, methods: ['POST'], requestBody: 'buffered',
    fetch: async () => json({ ok: true, value: [...jobs.values()].slice(-10).map((j) => jobView(j, j.events.length)) }),
  })
  reg({
    path: ROUTES.jobInstalled, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const b = await body(request)
      const job = jobs.get(String(b?.id ?? ''))
      if (!job) return json(failure('autofit/no-job', 'Unknown job.'), 404)
      job.installed = { at: new Date().toISOString(), application: text(b?.application, 40), error: text(b?.error, 600) }
      job.status = b?.error ? 'failed' : 'installed'
      job.events.push({ at: Date.now(), type: 'installed', application: job.installed.application, error: job.installed.error })
      return json({ ok: true, value: jobView(job, job.events.length - 1) })
    },
  })

  ctx.effect(() => watchInstalls(ctx.logger), 'dsh-autofit: install watcher')
}
