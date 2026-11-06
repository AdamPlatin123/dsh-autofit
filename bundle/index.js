/**
 * Host half of the dsh-autofit bundle.
 *
 * Authenticated, Client-callable routes (exact Connection Fetch routes; owner Peer only):
 *   POST /api/autofit/check    { spec }                 L1/L2 trial of one spec
 *   POST /api/autofit/fix      { spec, allowBuilds? }   trial → repair → re-trial (lib/autofix)
 *   POST /api/autofit/catalog  { q?, offset?, limit? }   market catalog (awesome index + radar verdicts)
 *   POST /api/autofit/status   { name? }                last background check of an installed bundle
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
import { loadJson, radarMap, RADAR_SOURCES, repoKey } from '../lib/radar.js'

/** Connection must exist for a browser-callable route; otherwise this row stays inactive. */
export const inject = ['connection']

const ROUTES = { check: '/api/autofit/check', fix: '/api/autofit/fix', catalog: '/api/autofit/catalog', status: '/api/autofit/status',
  jobStart: '/api/autofit/job/start', jobPoll: '/api/autofit/job/poll', jobCancel: '/api/autofit/job/cancel', jobList: '/api/autofit/job/list', jobInstalled: '/api/autofit/job/installed' }
const CATALOG_SOURCES = ['https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json', 'https://awesome-dsh-plugin.com/index.json']
const CATALOG_TTL_MS = 30 * 60 * 1000
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
  // 3. DSH Desktop in Electron: the runtime ships in the app resources (`app/` up to 2.0.18, `app.asar` from 2.0.22;
  //    Electron's fs reads asar paths).
  if (process.versions.electron && process.resourcesPath) {
    for (const root of ['app', 'app.asar']) {
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

/* ------------------------------------------------------------------ catalog */

let catalog = { at: 0, items: null, source: null, radarAt: null, loading: null }

async function loadCatalog() {
  if (catalog.items && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog
  if (catalog.loading) return catalog.loading
  catalog.loading = (async () => {
    const base = await loadJson(CATALOG_SOURCES, { timeoutMs: 20000 })
    let radar = new Map()
    let radarAt = null
    try {
      const r = await loadJson(RADAR_SOURCES, { timeoutMs: 20000 })
      radar = radarMap(r.value)
      radarAt = r.value.generated_at ?? null
    } catch { /* catalog still works without radar labels */ }
    const items = (base.value?.plugins ?? []).map((p) => {
      const v = Array.isArray(p.versions) ? p.versions[0] : null
      const hit = radar.get(repoKey(p.repository?.url))
      const title = typeof p.title === 'string' ? p.title : p.title?.zh ?? p.title?.en ?? p.name
      const desc = typeof p.description === 'string' ? p.description : p.description ?? null
      return {
        name: p.name, title, description: desc, category: p.metadata?.category ?? null,
        version: v?.version ?? null, engines: v?.engines?.dsh ?? null, repository: p.repository?.url ?? null, homepage: p.homepage ?? null,
        spec: v?.version ? `${p.name}@${v.version}` : p.name,
        radar: hit ? hit.verdict : null, stars: hit?.stars ?? null,
      }
    })
    catalog = { at: Date.now(), items, source: base.url, radarAt, loading: null }
    return catalog
  })().catch((err) => { catalog.loading = null; throw err })
  return catalog.loading
}

function searchCatalog(items, q, offset, limit) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const hay = (it) => `${it.name} ${it.title ?? ''} ${typeof it.description === 'string' ? it.description : Object.values(it.description ?? {}).join(' ')} ${it.category ?? ''}`.toLowerCase()
  const matched = words.length ? items.filter((it) => words.every((w) => hay(it).includes(w))) : items
  const ranked = [...matched].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
  return { total: ranked.length, items: ranked.slice(offset, offset + limit) }
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

async function drainQueue(log) {
  while (queue.length && !running) {
    const { name, spec } = queue.shift()
    const out = await exclusive(async () => probe(spec, { bin: dshLauncher(), env: trialEnv(), pnpm: where.packageManager }))
    if (out.busy) { queue.unshift({ name, spec }); return }
    const checks = readChecks()
    checks[name] = { at: new Date().toISOString(), trigger: 'installed', ...summarize(out.value) }
    writeChecks(checks)
    log?.info?.(`dsh-autofit: background check of ${spec}: ${out.value.verdict}`)
  }
}

function watchInstalls(log) {
  const tick = () => {
    const deps = profileDeps()
    if (!deps) return
    if (lastDeps) {
      for (const [name, declared] of Object.entries(deps)) {
        if (lastDeps[name] === declared || queue.some((q) => q.name === name)) continue
        queue.push({ name, spec: specFor(name, declared) })
      }
    }
    lastDeps = deps
    void drainQueue(log)
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
    id: job.id, spec: job.spec, status: job.status, createdAt: job.createdAt,
    events: job.events.slice(since), next: job.events.length,
    result: job.result ? { outcome: job.result.outcome, by: job.result.by ?? null, install: job.result.install ?? null,
      reason: text(job.result.reason, 1200), changes: (job.result.changes ?? []).slice(0, 40),
      needsApproval: job.result.needsApproval ?? [], unresolved: job.result.unresolved ?? [],
      artifactVersion: job.result.artifact?.version ?? null, final: job.result.final ? summarize(job.result.final) : null } : null,
    installed: job.installed ?? null,
  }
}

function startJob(ctx, spec, allowBuilds) {
  const job = { id: randomUUID(), spec, status: 'queued', createdAt: new Date().toISOString(), events: [], result: null, controller: new AbortController() }
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
      job.status = job.controller.signal.aborted ? 'cancelled' : ['pass', 'fixed'].includes(job.result.outcome) ? 'ready' : 'failed'
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
  return { spec, allowBuilds }
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
  const reg = (route) => ctx.effect(() => ctx.connection.fetch.register(route), `dsh-autofit: ${route.path}`)

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
      const b = await body(request)
      const offset = Math.max(0, Number.parseInt(b?.offset ?? 0, 10) || 0)
      const limit = Math.min(60, Math.max(1, Number.parseInt(b?.limit ?? 30, 10) || 30))
      try {
        const c = await loadCatalog()
        return json({ ok: true, value: { ...searchCatalog(c.items, typeof b?.q === 'string' ? b.q.slice(0, 200) : '', offset, limit), offset, limit, source: c.source, radarAt: c.radarAt } })
      } catch (error) {
        return json(failure('autofit/catalog-unavailable', text(error?.message ?? error, 800)), 502)
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
      const live = [...jobs.values()].find((j) => j.spec === input.spec && (j.status === 'queued' || j.status === 'running'))
      return json({ ok: true, value: jobView(live ?? startJob(ctx, input.spec, input.allowBuilds)) })
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
      if (job.status === 'queued') job.status = 'cancelled'
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
