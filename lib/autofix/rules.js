/**
 * Deterministic repair rules. Each rule reads the trial result (probe) and edits an unpacked package
 * directory in place, returning the changes it made. Every rule here comes from a break reproduced in the
 * lab (see .lab/RESULTS.md); anything that needs reading the code's intent is left to the agent tier.
 *
 * Tiers:  A mechanical (manifest only) · B rule (known code-level breaks) · C needs user approval.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KNOWN_SERVICE_RENAMES } from '../probe/signals.js'

const SKIP = new Set(['node_modules', '.git'])
const SOURCE = /\.(m?js|cjs)$/

function jsFiles(dir, out = [], depth = 0) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < 8) jsFiles(full, out, depth + 1) } else if (SOURCE.test(e.name) && statSync(full).size < 3e6) out.push(full)
  }
  return out
}

function readPkg(dir) { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) }
function writePkg(dir, pkg) { writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n') }

/** Collect every failure text a probe produced (install error, host and client failures). */
export function failureTexts(result) {
  const L1 = result?.layers?.L1 ?? {}
  const L2 = result?.layers?.L2 ?? {}
  return [L1.error, L1.logTail, ...(L2.host?.failures ?? []).map((f) => f.error), ...(L2.client?.failures ?? []).map((f) => f.error)]
    .filter(Boolean).map(String)
}

/** A · widen exactly the DSH requirements the host reported as unmet. */
export function widenRequirements(dir, result) {
  const req = result?.layers?.L1?.requirements
  const host = result?.host?.version
  if (!req || !host) return []
  const pkg = readPkg(dir)
  const changes = []
  for (const [key, range] of Object.entries(req)) {
    const widened = `${range} || ^${host}`
    if (key === 'engines.dsh' && pkg.engines?.dsh) {
      pkg.engines.dsh = widened
      changes.push({ tier: 'A', rule: 'widen-engines', file: 'package.json', detail: `engines.dsh: ${range} → ${widened}` })
      continue
    }
    for (const field of ['peerDependencies', 'dependencies', 'optionalDependencies']) {
      if (pkg[field]?.[key] !== undefined) {
        const before = pkg[field][key]
        pkg[field][key] = `${before} || ^${host}`
        changes.push({ tier: 'A', rule: 'widen-peer', file: 'package.json', detail: `${field}.${key}: ${before} → ${pkg[field][key]}` })
      }
    }
  }
  if (changes.length) writePkg(dir, pkg)
  return changes
}

/** A · a bundle patch written as a top-level mapping (`insert:`) instead of the required top-level list. */
export function fixPatchDialect(dir, result) {
  if (!result?.codes?.includes('legacy-patch-dialect')) return []
  const pkg = readPkg(dir)
  const changes = []
  for (const rel of [].concat(pkg.dsh?.bundle?.patch ?? [])) {
    const file = path.join(dir, rel)
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const first = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? ''
    if (!/^[a-z][\w-]*:/.test(first)) continue
    writeFileSync(file, text.split('\n').map((l) => (l === first ? `- ${l}` : l.trim() ? `  ${l}` : l)).join('\n'))
    changes.push({ tier: 'A', rule: 'patch-dialect', file: rel, detail: 'top-level mapping → top-level list' })
  }
  return changes
}

/**
 * B · JSON Schema objects must state `additionalProperties` (dsh-tools ≥0.2). The host error names the path
 * (`schema.properties.config.additionalProperties`); fix that key's inline `{ type: 'object' … }`, or the root
 * of a tool's `parameters`/`schema` object when the path is the root.
 */
export function fixSchemaAdditionalProperties(dir, result) {
  const paths = failureTexts(result).flatMap((t) => [...t.matchAll(/([\w.[\]]+)\.additionalProperties must be explicitly true or false/g)].map((m) => m[1]))
  if (!paths.length) return []
  const keys = new Set(paths.map((p) => p.split('.').filter((s) => s !== 'properties').pop()))
  const changes = []
  for (const file of jsFiles(dir)) {
    let src = readFileSync(file, 'utf8')
    let n = 0
    for (const key of keys) {
      const quoted = key === 'schema' ? '(?:parameters|schema)' : `['"]?${key.replace(/[^\w$]/g, '')}['"]?`
      const re = new RegExp(`(\\b${quoted}\\s*:\\s*\\{)(\\s*type\\s*:\\s*['"]object['"])(?![^{}]*additionalProperties)`, 'g')
      src = src.replace(re, (_m, open, type) => { n++; return `${open}${type}, additionalProperties: true` })
    }
    if (n) {
      writeFileSync(file, src)
      changes.push({ tier: 'B', rule: 'schema-additional-properties', file: path.relative(dir, file), detail: `${n} object schema(s) for ${[...keys].join(', ')} now state additionalProperties: true` })
    }
  }
  return changes
}

/** Index of the brace closing the `{` at `open`, skipping strings, templates and comments. */
function matchBrace(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** B · every registered tool must declare `output { schema, render }` (dsh-tools ≥0.2). */
export function fixToolOutput(dir, result) {
  if (!result?.codes?.includes('tool-output-required')) return []
  const changes = []
  for (const file of jsFiles(dir)) {
    let src = readFileSync(file, 'utf8')
    let n = 0
    let from = 0
    for (;;) {
      const at = src.indexOf('.register(', from)
      if (at < 0) break
      const open = src.indexOf('{', at)
      if (open < 0 || open - at > 20) { from = at + 10; continue }
      const close = matchBrace(src, open)
      if (close < 0) break
      const body = src.slice(open, close)
      if (/\bexecute\s*[:(]/.test(body) && /\b(parameters|description)\s*:/.test(body) && !/\boutput\s*:/.test(body)) {
        const insert = `\n  output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] },`
        src = src.slice(0, open + 1) + insert + src.slice(open + 1)
        n++
        from = close + insert.length
      } else from = close
    }
    if (n) {
      writeFileSync(file, src)
      changes.push({ tier: 'B', rule: 'tool-output', file: path.relative(dir, file), detail: `${n} tool(s) given a generic output { schema, render }` })
    }
  }
  return changes
}

/** B · a service the host renamed (plugin older than host): rename the plugin's references. */
export function fixServiceRenames(dir, result) {
  const waiting = new Set(failureTexts(result).flatMap((t) => [...t.matchAll(/waiting for service: ([\w.-]+)/g)].map((m) => m[1])))
  const renames = [...waiting].filter((s) => KNOWN_SERVICE_RENAMES[s])
  if (!renames.length) return []
  const changes = []
  for (const file of [...jsFiles(dir), path.join(dir, 'package.json')]) {
    let src = readFileSync(file, 'utf8')
    let n = 0
    for (const from of renames) {
      const to = KNOWN_SERVICE_RENAMES[from].to
      src = src.replace(new RegExp(`\\b${from}\\b`, 'g'), () => { n++; return to })
    }
    if (n) {
      writeFileSync(file, src)
      changes.push({ tier: 'B', rule: 'service-rename', file: path.relative(dir, file), detail: renames.map((s) => `${s} → ${KNOWN_SERVICE_RENAMES[s].to} (${KNOWN_SERVICE_RENAMES[s].card})`).join(', ') + ` · ${n} reference(s)` })
    }
  }
  return changes
}

export const RULES = [widenRequirements, fixPatchDialect, fixSchemaAdditionalProperties, fixToolOutput, fixServiceRenames]

/** What needs the user rather than a rule (tier C), and what is left for the agent tier. */
export function residuals(result) {
  const codes = new Set(result?.codes ?? [])
  const needsApproval = []
  const blocked = result?.layers?.L1?.blockedBuilds ?? []
  // Blocked build scripts only matter when something still fails (or a native module is reported missing).
  if (blocked.length && (codes.has('native-build') || (result?.verdict !== 'pass' && codes.has('build-scripts-blocked')))) {
    needsApproval.push({ kind: 'allow-builds', packages: blocked.map((b) => b.replace(/@[^@]+$/, '')), why: 'dependency build scripts were blocked; a native module may be missing' })
  }
  const unresolved = []
  if (codes.has('native-build') && !blocked.length) unresolved.push({ code: 'native-build', hint: 'needs a native build toolchain (make, a C++ compiler, python3)' })
  if (codes.has('sidecar')) unresolved.push({ code: 'sidecar', hint: 'the plugin starts an external runtime (e.g. Python); install it first' })
  if (codes.has('client-asset-404')) unresolved.push({ code: 'client-asset-404', hint: 'client asset URLs depend on the old script location; needs a code change (Creator mode agent)' })
  if (codes.has('missing-dependency') && !codes.has('native-build')) unresolved.push({ code: 'missing-dependency', hint: 'a dependency is not declared or not published' })
  if (codes.has('inject-contract')) unresolved.push({ code: 'inject-contract', hint: 'the plugin reads a service it did not declare in inject; needs a code change' })
  if (codes.has('collateral-damage')) unresolved.push({ code: 'collateral-damage', hint: 'installing it breaks other parts of this profile; install it into a dedicated profile instead' })
  const newer = (result?.codes ?? []).includes('missing-service') && failureTexts(result).some((t) => Object.values(KNOWN_SERVICE_RENAMES).some((r) => t.includes(`waiting for service: ${r.to}`)))
  if (newer) unresolved.push({ code: 'plugin-newer-than-host', hint: 'the plugin needs a newer DSH than this one; upgrade DSH or use an older plugin version' })
  const failedEntries = [...(result?.layers?.L2?.host?.failures ?? []), ...(result?.layers?.L2?.client?.failures ?? [])]
  if (result?.verdict === 'fail' && !unresolved.length && !needsApproval.length && failedEntries.every((f) => !(f.codes ?? []).length)) {
    unresolved.push({ code: 'unknown-failure', hint: 'the plugin fails without a known signature; needs reading its code (Creator mode agent)' })
  }
  return { needsApproval, unresolved }
}
