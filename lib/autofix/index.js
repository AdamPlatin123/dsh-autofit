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
 * The original package is never modified; repaired artifacts live under `<DSH_HOME>/autofit/patched/`.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { probe } from '../probe/index.js'
import { RULES, residuals } from './rules.js'

export { RULES, residuals } from './rules.js'

const UNFIXABLE = new Set(['infra-fail', 'not-published'])

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, ...opts })
}

/** Unpack `spec` into `<work>/package`: a directory is copied, a tarball extracted, anything else fetched with npm pack. */
async function unpack(spec, work, env) {
  const dest = path.join(work, 'package')
  if (existsSync(spec) && !spec.endsWith('.tgz') && !spec.endsWith('.tar.gz')) {
    cpSync(spec, dest, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(spec.length)) })
    return dest
  }
  let tarball = existsSync(spec) ? spec : null
  if (!tarball) {
    if (/^(git\+|github:|https?:\/\/.*\.git(#|$)|git@)/.test(spec)) throw new Error('autofix currently repairs npm packages, tarballs and directories; git specs are trialled but not repaired')
    const name = sh('npm', ['pack', spec, '--ignore-scripts', '--silent', '--pack-destination', work], { env, cwd: work }).trim().split('\n').pop()
    tarball = path.join(work, name)
  }
  sh('tar', ['-xzf', tarball, '-C', work])
  if (!existsSync(dest)) {
    const top = readdirSync(work, { withFileTypes: true }).find((e) => e.isDirectory())
    if (!top) throw new Error('unpacked tarball has no top-level directory')
    cpSync(path.join(work, top.name), dest, { recursive: true })
  }
  return dest
}

function pack(dir, outDir, round, spec, changes) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const base = String(pkg.version ?? '0.0.0').replace(/\+autofit\.\d+$/, '')
  pkg.version = `${base}+autofit.${round}`
  pkg.autofit = { from: spec, round, changes: changes.map(({ tier, rule, file, detail }) => ({ tier, rule, file, detail })) }
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  mkdirSync(outDir, { recursive: true })
  const safe = String(pkg.name ?? 'plugin').replace(/^@/, '').replace(/\//g, '-')
  const file = path.join(outDir, `${safe}-${base}+autofit.${round}.tgz`)
  sh('tar', ['-czf', file, '-C', path.dirname(dir), path.basename(dir)])
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
    rmSync(work, { recursive: true, force: true })
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
