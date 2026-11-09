/**
 * Guardrails for the repair agent: what it changed, and whether that is still a repair.
 *
 * The agent works on a copy taken after the deterministic rules; `snapshot()` records that copy and `review()` compares
 * the copy against it before every trial. A trial is refused when the edits touch what makes the plugin itself (its
 * name, dependencies, scripts, bundle patch), drop a registration, narrow a DSH requirement, or exceed a size budget —
 * the agent is told why and can revert. The diff of a passing repair ships inside the repaired package (`autofit.diff`)
 * and is shown to the user before anything is installed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SKIP = new Set(['node_modules', '.git'])
/** Files autofit itself writes into the copy; not the agent's edits. */
export const DIFF_FILE = 'autofit.diff'
const OWN = new Set([DIFF_FILE])
const MAX_FILE = 2_000_000

/** Edit budget for one repair. The lab repairs changed 1–3 files and under 20 lines. */
export const LIMITS = { files: 8, lines: 200 }

/** package.json fields the agent may not change: they decide what the package is and what it runs or replaces. */
const PROTECTED_FIELDS = ['name', 'scripts', 'bin', 'dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies', 'dsh.bundle']

const posix = (p) => p.split(path.sep).join('/')

/** Text content of every file under `dir` (relative POSIX path → string). */
export function snapshot(dir) {
  const out = new Map()
  const walk = (d, depth) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) { if (depth < 12) walk(full, depth + 1); continue }
      const rel = posix(path.relative(dir, full))
      if (OWN.has(rel) || statSync(full).size > MAX_FILE) continue
      out.set(rel, readFileSync(full, 'utf8'))
    }
  }
  walk(dir, 0)
  return out
}

/** package.json without the fields autofit itself rewrites on every pack, in one canonical layout. */
function canonicalPkg(text) {
  const pkg = JSON.parse(text)
  delete pkg.version
  delete pkg.autofit
  return JSON.stringify(pkg, null, 2) + '\n'
}

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Line edit script between two texts: prefix/suffix trimmed, LCS on the rest (replaced wholesale when too large). */
function lineOps(a, b) {
  const x = a === '' ? [] : a.split('\n')
  const y = b === '' ? [] : b.split('\n')
  let pre = 0
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++
  let suf = 0
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++
  const xm = x.slice(pre, x.length - suf)
  const ym = y.slice(pre, y.length - suf)
  const mid = []
  if (xm.length * ym.length > 4_000_000) {
    for (const l of xm) mid.push(['-', l])
    for (const l of ym) mid.push(['+', l])
  } else {
    const n = xm.length
    const m = ym.length
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      // On a tie, removals come before additions, as in every unified diff.
      if (i < n && j < m && xm[i] === ym[j]) { mid.push([' ', xm[i]]); i++; j++ } else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) { mid.push(['-', xm[i]]); i++ } else { mid.push(['+', ym[j]]); j++ }
    }
  }
  return [...x.slice(0, pre).map((l) => [' ', l]), ...mid, ...x.slice(x.length - suf).map((l) => [' ', l])]
}

/** Unified diff of one file (3 lines of context), plus its added/removed line counts. */
export function unifiedDiff(file, a, b) {
  const ops = lineOps(a, b)
  const added = ops.filter((o) => o[0] === '+').length
  const removed = ops.filter((o) => o[0] === '-').length
  if (!added && !removed) return { added, removed, text: '' }
  // Distance from each line to the nearest change, either side; a line within 3 of a change is context.
  const dist = new Array(ops.length).fill(Infinity)
  for (let i = 0, last = -Infinity; i < ops.length; i++) { if (ops[i][0] !== ' ') last = i; dist[i] = i - last }
  for (let i = ops.length - 1, next = Infinity; i >= 0; i--) { if (ops[i][0] !== ' ') next = i; dist[i] = Math.min(dist[i], next - i) }
  const hunks = []
  let ai = 1
  let bi = 1
  let cur = null
  ops.forEach(([k, l], idx) => {
    if (dist[idx] <= 3) {
      if (!cur) { cur = { a: ai, b: bi, lines: [] }; hunks.push(cur) }
      cur.lines.push(k + l)
    } else cur = null
    if (k !== '+') ai++
    if (k !== '-') bi++
  })
  const header = (h) => {
    const an = h.lines.filter((l) => l[0] !== '+').length
    const bn = h.lines.filter((l) => l[0] !== '-').length
    return `@@ -${an ? h.a : h.a - 1},${an} +${bn ? h.b : h.b - 1},${bn} @@`
  }
  const text = [`--- a/${file}`, `+++ b/${file}`, ...hunks.flatMap((h) => [header(h), ...h.lines])].join('\n') + '\n'
  return { added, removed, text }
}

const registrations = (src) => (src.match(/\.register\s*\(/g) ?? []).length

/**
 * Compare the copy at `dir` with `before` (a snapshot). Returns the per-file changes, the unified diff, and the
 * reasons the edits are not acceptable as a repair (empty when they are).
 */
export function review(before, dir, limits = LIMITS) {
  const after = snapshot(dir)
  const files = []
  const patches = []
  const violations = []
  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const file of names) {
    let a = before.get(file) ?? null
    let b = after.get(file) ?? null
    if (a === b) continue
    if (file === 'package.json' && a !== null && b !== null) {
      let pb
      try { pb = JSON.parse(b) } catch { violations.push('package.json is no longer valid JSON'); continue }
      const pa = JSON.parse(a)
      for (const field of PROTECTED_FIELDS) if (!same(get(pa, field), get(pb, field))) violations.push(`package.json "${field}" may not be changed by a repair`)
      for (const [field, keys] of [['engines', Object.keys(pa.engines ?? {})], ['peerDependencies', Object.keys(pa.peerDependencies ?? {})]]) {
        for (const k of keys) {
          const was = pa[field][k]
          const now = pb[field]?.[k]
          // Widening appends ` || <range>`; the original range must still be there.
          if (now === undefined) violations.push(`package.json ${field}.${k} was removed; widen it with " || ^<host version>" instead`)
          else if (!String(now).includes(String(was))) violations.push(`package.json ${field}.${k} changed from "${was}" to "${now}"; keep the original range and append " || ^<host version>"`)
        }
      }
      a = canonicalPkg(a)
      b = canonicalPkg(b)
      if (a === b) continue
    }
    const d = unifiedDiff(file, a ?? '', b ?? '')
    if (!d.text) continue
    const status = a === null ? 'added' : b === null ? 'deleted' : 'modified'
    files.push({ file, status, added: d.added, removed: d.removed })
    patches.push(d.text)
    if (a !== null && b !== null && /\.(m?js|cjs|ts)$/.test(file) && registrations(b) < registrations(a)) {
      violations.push(`${file}: ${registrations(a) - registrations(b)} .register(...) call(s) removed; a repair may not drop features`)
    }
    if (a !== null && a.trim() && !(b ?? '').trim()) violations.push(`${file} was emptied; a repair may not remove files`)
  }
  const pkg = (() => { try { return JSON.parse(before.get('package.json') ?? '{}') } catch { return {} } })()
  for (const rel of [].concat(pkg.dsh?.bundle?.patch ?? [])) {
    const file = posix(path.normalize(String(rel))).replace(/^\.\//, '')
    if (files.some((f) => f.file === file)) violations.push(`${file} is the bundle patch (it decides what else the profile loads); a repair may not change it`)
  }
  const lines = files.reduce((n, f) => n + f.added + f.removed, 0)
  if (files.length > limits.files) violations.push(`${files.length} files changed; a repair may change at most ${limits.files}`)
  if (lines > limits.lines) violations.push(`${lines} lines changed; a repair may change at most ${limits.lines} — make a smaller change`)
  return { files, lines, diff: patches.join(''), violations }
}

/** Change records (the shape rules use) for the agent's edits. */
export function agentChanges(files) {
  return files.map((f) => ({ tier: 'agent', rule: 'agent-edit', file: f.file, detail: `${f.status}: +${f.added} −${f.removed} lines (see ${DIFF_FILE})` }))
}
