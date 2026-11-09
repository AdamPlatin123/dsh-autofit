/**
 * dsh-autofit/autofix — trial, repair, re-trial.
 *
 *   probe(spec) ── pass ──────────────────────────────▶ install the original
 *        │ fail / incompatible
 *        ▼
 *   unpack the package → apply deterministic rules (tier A/B) → repack as <version>+autofit.N
 *        → probe(artifact) … at most `maxRounds` rounds, stop when no rule applies
 *        ▼
 *   pass → install the repaired artifact (local tarball, provenance in package.json "autofit")
 *   else → report what needs the user's approval (tier C) and what is left for the agent tier
 *
 * The original package is never modified; repaired artifacts live under `<DSH_HOME>/autofit/patched/`. An agent
 * repair also carries its diff (`autofit.diff` in the package) and is returned with `review: true`: the caller shows
 * the diff and installs only after the user agrees.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { safeRemove } from '../probe/cleanup.js'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { probe } from '../probe/index.js'
import { fetchTarball } from './fetch.js'
import { DIFF_FILE, agentChanges, review, snapshot } from './guard.js'
import { RULES, residuals } from './rules.js'

export { RULES, residuals } from './rules.js'
export { fetchTarball, parseNpmSpec } from './fetch.js'

const UNFIXABLE = new Set(['infra-fail', 'not-published'])

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, ...opts })
}

/*
 * tar never sees a Windows absolute path: every call runs in the right directory with bare names. GNU tar (first on
 * PATH under Git Bash / MSYS) reads an archive `C:\…` as `host:path` ("Cannot connect to C: resolve failed") and
 * mangles backslashes in `-C C:\…` on extract; Windows' bsdtar has no --force-local to opt out with.
 */

/** Extract `archive` into `dest` (the archive is copied there first when it lives elsewhere). */
export function untar(archive, dest) {
  const local = path.join(dest, path.basename(archive))
  const copied = path.resolve(archive) !== path.resolve(local)
  if (copied) copyFileSync(archive, local)
  try {
    sh('tar', ['-xzf', path.basename(local)], { cwd: dest })
  } finally {
    if (copied) safeRemove(local)
  }
}

/** Pack directory `dir` (as its own top-level folder) into the gzipped tarball `file`. */
export function packDir(dir, file) {
  const parent = path.dirname(path.resolve(dir))
  const name = `.autofit-pack-${process.pid}-${Date.now()}.tgz`
  sh('tar', ['-czf', name, path.basename(dir)], { cwd: parent })
  try {
    copyFileSync(path.join(parent, name), file)
  } finally {
    safeRemove(path.join(parent, name))
  }
}

/** Unpack `spec` into `<work>/package`: a directory is copied, a tarball extracted, anything else fetched with npm pack. */
/** A spec that names a local file or directory rather than a registry package. */
export function localPath(spec) {
  const s = String(spec).replace(/^file:/, '')
  if (path.isAbsolute(s) || /^(\.{1,2}[\\/]|~[\\/])/.test(s) || /\.(tgz|tar\.gz)$/i.test(s) || /^[a-zA-Z]:[\\/]/.test(s)) return s
  return null
}

async function unpack(spec, work, env) {
  const dest = path.join(work, 'package')
  const local = localPath(spec)
  if (local) {
    if (!existsSync(local)) throw new Error(`local plugin file not found: ${local}`)
    spec = local
  }
  if (existsSync(spec) && !spec.endsWith('.tgz') && !spec.endsWith('.tar.gz')) {
    cpSync(spec, dest, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(spec.length)) })
    return dest
  }
  let tarball = existsSync(spec) ? spec : null
  if (!tarball) {
    if (/^(git\+|github:|https?:\/\/.*\.git(#|$)|git@)/.test(spec)) throw new Error('autofix currently repairs npm packages, tarballs and directories; git specs are trialled but not repaired')
    tarball = (await fetchTarball(spec, work, env)).file
  }
  untar(tarball, work)
  if (!existsSync(dest)) {
    const top = readdirSync(work, { withFileTypes: true }).find((e) => e.isDirectory())
    if (!top) throw new Error('unpacked tarball has no top-level directory')
    cpSync(path.join(work, top.name), dest, { recursive: true })
  }
  return dest
}

/** What a repaired package records as its source: a registry spec as is, a local file by name only (no home paths). */
export function provenance(spec) {
  const local = localPath(spec)
  return local ? `file:${path.basename(local)}` : spec
}

function pack(dir, outDir, round, spec, changes, diff = null) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const base = String(pkg.version ?? '0.0.0').replace(/\+autofit\.[\w.]+$/, '')
  pkg.version = `${base}+autofit.${round}`
  pkg.autofit = { from: provenance(spec), round, changes: changes.map(({ tier, rule, file, detail }) => ({ tier, rule, file: file.split(path.sep).join('/'), detail })) }
  if (diff) {
    writeFileSync(path.join(dir, DIFF_FILE), diff)
    pkg.autofit.diff = DIFF_FILE
  } else safeRemove(path.join(dir, DIFF_FILE))
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  mkdirSync(outDir, { recursive: true })
  const safe = String(pkg.name ?? 'plugin').replace(/^@/, '').replace(/\//g, '-')
  const file = path.join(outDir, `${safe}-${base}+autofit.${round}.tgz`)
  packDir(dir, file)
  return { file, name: pkg.name, version: pkg.version }
}

/** The fields of a probe result the caller needs for decisions and UI. */
function brief(r) {
  return { spec: r.spec, verdict: r.verdict, codes: r.codes, host: r.host?.version, L1: r.layers?.L1?.status, L2host: r.layers?.L2?.host?.status, L2client: r.layers?.L2?.client?.status, durationMs: r.durationMs }
}

/**
 * Trial `spec`; if it does not pass, repair and re-trial.
 * @param {string} spec
 * @param {object} [opts]
 * @param {object} [opts.probe] options passed to every probe() call (bin, browser, env, allowBuilds, …)
 * @param {number} [opts.maxRounds=3]
 * @param {string} [opts.outDir] where repaired tarballs go (default `<DSH_HOME or ~/.dsh>/autofit/patched`)
 * @param {(event: object) => void} [opts.onProgress]
 */
export async function autofix(spec, opts = {}) {
  const probeOpts = opts.probe ?? {}
  const env = probeOpts.env ?? process.env
  const outDir = opts.outDir ?? path.join(env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'autofit', 'patched')
  const maxRounds = opts.maxRounds ?? 3
  const progress = opts.onProgress ?? (() => {})
  const report = { schema: 'dsh-autofit/autofix/v1', spec, rounds: [], changes: [], artifact: null, verdict: null, needsApproval: [], unresolved: [] }

  progress({ stage: 'trial', round: 0, spec })
  let current = await probe(spec, probeOpts)
  report.rounds.push({ round: 0, ...brief(current) })
  report.initial = current
  if (current.verdict === 'pass' || UNFIXABLE.has(current.verdict)) {
    report.verdict = current.verdict
    report.final = current
    Object.assign(report, residuals(current))
    return report
  }

  const work = mkdtempSync(path.join(opts.tmpRoot ?? tmpdir(), 'dsh-autofit-fix-'))
  try {
    progress({ stage: 'unpack', spec })
    const dir = await unpack(spec, work, env)
    for (let round = 1; round <= maxRounds; round++) {
      const applied = RULES.flatMap((rule) => rule(dir, current))
      if (!applied.length) break
      report.changes.push(...applied.map((c) => ({ ...c, round })))
      const art = pack(dir, outDir, round, spec, report.changes)
      progress({ stage: 'retrial', round, artifact: art.file, changes: applied })
      current = await probe(art.file, probeOpts)
      report.rounds.push({ round, artifact: art.file, applied, ...brief(current) })
      report.artifact = art
      if (current.verdict === 'pass') break
    }
  } catch (err) {
    report.error = String(err.message ?? err)
  } finally {
    safeRemove(work)
  }
  report.final = current
  report.verdict = current.verdict === 'pass' && report.artifact ? 'fixed' : current.verdict
  Object.assign(report, residuals(current))
  if (report.verdict !== 'fixed' && report.artifact) {
    // A repaired artifact that still fails is kept for inspection but never offered for install.
    report.artifact = { ...report.artifact, usable: false }
  } else if (report.artifact) report.artifact.usable = true
  return report
}

/**
 * One-click pipeline behind "Install with autofix": trial → rules → repair agent, until something passes.
 * Emits progress events for the UI; resolves to what to install (the original spec or a repaired tarball).
 * @param {string} spec
 * @param {object} o
 * @param {object} [o.probe]   probe() options for every trial
 * @param {{ stream: Function }} [o.llm]   host llm service; without it the agent stage is skipped
 * @param {{ provider: string, model: string, reasoningEffort?: string }} [o.model]
 * @param {string} [o.outDir]
 * @param {(e: object) => void} [o.onEvent]
 * @param {AbortSignal} [o.signal]
 * @param {{ files: number, lines: number }} [o.limits]  edit budget for the agent (default guard.js LIMITS)
 */
export async function autofitPipeline(spec, o = {}) {
  const emit = o.onEvent ?? (() => {})
  const probeOpts = o.probe ?? {}
  const env = probeOpts.env ?? process.env
  const outDir = o.outDir ?? path.join(env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'autofit', 'patched')
  const done = (r) => { emit({ type: 'done', ...r }); return r }

  emit({ type: 'stage', stage: 'trial' })
  const initial = await probe(spec, probeOpts)
  emit({ type: 'trial', stage: 'original', verdict: initial.verdict, codes: initial.codes, host: initial.host?.version })
  if (initial.verdict === 'pass') return done({ outcome: 'pass', install: spec, describe: initial.layers?.L1?.describe ?? null })
  if (UNFIXABLE.has(initial.verdict)) {
    const reason = initial.verdict === 'not-published' ? 'the plugin is not published (check the name and version)'
      // Retrying does not help a missing or refusing pnpm; say what it said.
      : initial.codes?.includes('package-manager') ? `the trial machine's package manager failed: ${initial.layers?.L1?.error ?? 'see the install log'}`
      : `the trial environment failed (${initial.codes?.join(', ') || 'network or registry'}); try again`
    return done({ outcome: 'unfixable', reason, final: initial })
  }

  const work = mkdtempSync(path.join(tmpdir(), 'dsh-autofit-fix-'))
  try {
    emit({ type: 'stage', stage: 'unpack' })
    const dir = await unpack(spec, work, env)
    const changes = []
    let current = initial
    for (let round = 1; round <= 3; round++) {
      const applied = RULES.flatMap((rule) => rule(dir, current))
      if (!applied.length) break
      changes.push(...applied.map((c) => ({ ...c, round })))
      emit({ type: 'stage', stage: 'rules', round, changes: applied.map(({ tier, rule, file, detail }) => ({ tier, rule, file, detail })) })
      const art = pack(dir, outDir, round, spec, changes)
      current = await probe(art.file, probeOpts)
      emit({ type: 'trial', stage: `rules-${round}`, verdict: current.verdict, codes: current.codes })
      if (current.verdict === 'pass') return done({ outcome: 'fixed', by: 'rules', install: art.file, artifact: art, changes })
    }
    const res = residuals(current)
    if (res.needsApproval.length) return done({ outcome: 'needs-approval', needsApproval: res.needsApproval, changes, final: current })
    if (!o.llm || !o.model?.provider) return done({ outcome: 'unfixed', reason: 'no model available for the repair agent', unresolved: res.unresolved, changes, final: current })

    emit({ type: 'stage', stage: 'agent', model: `${o.model.provider}/${o.model.model}` })
    let agentRound = 0
    let lastArtifact = null
    let lastEdits = null
    // The agent's edits are measured against the copy as the rules left it.
    const before = snapshot(dir)
    const { repairWithAgent } = await import('./agent.js')
    const result = await repairWithAgent({
      dir, spec, initial: current, llm: o.llm, model: o.model, signal: o.signal,
      onEvent: (e) => emit({ ...e, stage: 'agent' }),
      guard: (d) => review(before, d, o.limits).violations,
      trial: async (d) => {
        agentRound++
        lastEdits = review(before, d, o.limits)
        lastArtifact = pack(d, outDir, `a${agentRound}`, spec, [...changes, ...agentChanges(lastEdits.files)], lastEdits.diff)
        return probe(lastArtifact.file, probeOpts)
      },
    })
    if (result.passed && lastArtifact) {
      return done({ outcome: 'fixed', by: 'agent', review: true, install: lastArtifact.file, artifact: lastArtifact,
        changes: [...changes, ...agentChanges(lastEdits.files)], diff: lastEdits.diff, lines: lastEdits.lines, summary: result.summary })
    }
    return done({ outcome: 'unfixed', reason: result.summary, unresolved: residuals(result.lastTrial ?? current).unresolved, changes, final: result.lastTrial ?? current })
  } catch (err) {
    return done({ outcome: 'error', reason: String(err.message ?? err) })
  } finally {
    safeRemove(work)
  }
}
