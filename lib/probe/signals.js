/**
 * Parse install logs, boot logs and browser console output into structured L1/L2 signals.
 * Patterns are taken from real output across DSH 0.0.1-rc.5 … 0.2.2-alpha.3 (see test/signals.test.mjs).
 */

/** Diagnosis codes: why something failed, in terms the repair ladder can act on. */
const DIAGNOSES = [
  ['incompatible-version', /is incompatible with dsh|incompatible-version/i],
  ['legacy-patch-dialect', /must be a top-level YAML array of loader patch entries/i],
  ['native-build', /Failed to load native module|\.node['"]?\b.*(not found|Cannot find)|gyp ERR/i],
  ['build-scripts-blocked', /Ignored build scripts:/i],
  ['missing-dependency', /ERR_MODULE_NOT_FOUND|Cannot find (package|module) '/i],
  ['schema-additional-properties', /additionalProperties must be explicitly true or false/i],
  ['tool-output-required', /must declare output \{ ?schema, render/i],
  ['inject-contract', /cannot get property "[^"]+" without inject/i],
  ['sidecar', /SidecarError|sidecar exited/i],
  ['missing-service', /pending \(waiting for service: [\w.-]+\)/i],
  ['client-asset-404', /Failed to fetch dynamically imported module/i],
  ['network', /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ERR_PNPM_FETCH|socket hang up|ERR_SOCKET|early EOF|unexpected disconnect while reading|fetch-pack|Could not resolve host|Failed to connect to/i],
  ['not-published', /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_FETCH_404|E404|No matching version/i],
]

export function diagnose(text) {
  return DIAGNOSES.filter(([, re]) => re.test(text)).map(([code]) => code)
}

/** L1: classify `dsh plugin add` output. */
export function parseInstall(log, exitCode) {
  const builds = /Ignored build scripts: ([^\n│]+?)\.?\s*(?:│|\n|$)/.exec(log)
  const blockedBuilds = builds ? builds[1].split(',').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean) : []
  const codes = diagnose(log)
  let requirements
  const req = /is incompatible with dsh [^:]+: requirements (\{[^\n]*?\})\./.exec(log)
  if (req) try { requirements = JSON.parse(req[1]) } catch { /* keep undefined */ }
  let status
  if (exitCode === 0) status = 'installed'
  else if (codes.includes('incompatible-version')) status = 'incompatible'
  else if (codes.includes('not-published')) status = 'not-published'
  else if (codes.includes('network')) status = 'infra-fail'
  else status = 'error'
  const errorLine = log.split('\n').find((l) => /installation rejected|ERR_PNPM|^\s*E[A-Z]+\b|error/i.test(l) && !/^\s+at /.test(l))
  // Transient network retries during a successful install are not a finding.
  const kept = codes.filter((c) => (c !== 'build-scripts-blocked' || blockedBuilds.length) && (c !== 'network' || status === 'infra-fail'))
  return { status, exitCode, requirements, blockedBuilds, codes: kept, error: status === 'installed' ? undefined : errorLine?.trim().slice(0, 400) }
}

/** L2 host half: classify `dsh web` output. */
export function parseBoot(log) {
  const url = /dsh web: (https?:\/\/\S+)/.exec(log)?.[1] ?? null
  const failures = []
  const seen = new Set()
  const push = (entry, pkg, error) => {
    const key = `${entry}|${error}`
    if (seen.has(key)) return
    seen.add(key)
    failures.push({ entry, package: pkg, error: error.slice(0, 600), codes: diagnose(error) })
  }
  // 0.1.7+: "dsh: warning: N entry did not activate" then "<id> (<package>): <Error…>"
  for (const m of log.matchAll(/^([\w@./-]+) \(([\w@./-]+)\): (.+)$/gm)) push(m[1], m[2], m[3])
  // ≤0.1.5 fatal form: "Error: dsh: plugin tree failed to load: …" then "<package>: <Error…>"
  for (const m of log.matchAll(/^(@?[\w.-]+(?:\/[\w.-]+)?): ((?:\w*Error|TypeError|SidecarError)\b.*)$/gm)) push(m[1], m[1], m[2])
  // 0.1.5 fatal form: "…failed to apply loader entry <id> (<package>): <message>" nested inside one line
  for (const m of log.matchAll(/failed to apply loader entry (?!include\b)([\w@./-]+) \(([\w@./-]+)\): ([^\n]+)/g)) push(m[1], m[2], m[3])
  const warned = /did not activate/.test(log)
  const fatal = /plugin tree failed to load|StartupError/.test(log)
  return {
    url,
    fatal,
    hostFailures: failures,
    unattributed: warned && failures.length === 0,
    missingCredential: /MISSING_CREDENTIAL/.test(log),
  }
}

/** L2 client half: classify browser console errors/exceptions collected over CDP. */
export function parseClient(messages) {
  const failures = []
  const netWarnings = []
  for (const text of messages) {
    if (/Failed to load resource/i.test(text)) { netWarnings.push(text); continue }
    const boot = /web boot: (\d+) entr(?:y|ies) did not activate/i.exec(text)
    const named = /^(\S+) failed to load\b(.*)$/is.exec(text)
    // 0.1.5 form: "Error: failed to import loader entry <id> (<package>): <message>"
    const entry = /failed to (?:import|apply) loader entry \S+ \(([^)]+)\)/i.exec(text)
    // 0.1.7+ boot form carries the package on the following line: "<package>: import failed: …"
    const bootPkg = boot ? /\n(@?[\w.-]+(?:\/[\w.-]+)?): (?:import failed|pending \(waiting for service|failed\b)/.exec(text) : null
    if (boot || named || entry || /Failed to fetch dynamically imported module/i.test(text)) {
      failures.push({ entry: named?.[1] ?? entry?.[1] ?? bootPkg?.[1] ?? null, error: text.slice(0, 600), codes: diagnose(text) })
    }
  }
  return { clientFailures: failures, netWarnings }
}

/**
 * Services renamed or removed by DSH, with the upgrade card that documents each change.
 * A plugin stuck "waiting for service: <old>" maps to a rule-tier fix.
 */
export const KNOWN_SERVICE_RENAMES = {
  settingsScope: { to: 'configForms', since: '0.1.7-rc.1', card: 'DSH-0.1.7-J1-27' },
}

/** Services a failure text says an entry is waiting for, with any known rename. */
export function waitingServices(text) {
  return [...String(text).matchAll(/waiting for service: ([\w.-]+)/g)].map((m) => {
    const svc = m[1]
    // Plugin older than host: it waits for a name the host retired.
    if (KNOWN_SERVICE_RENAMES[svc]) return { service: svc, ...KNOWN_SERVICE_RENAMES[svc], direction: 'plugin-older-than-host' }
    // Plugin newer than host: it waits for the new name on a host that still serves the old one.
    const old = Object.entries(KNOWN_SERVICE_RENAMES).find(([, r]) => r.to === svc)
    if (old) return { service: svc, from: old[0], since: old[1].since, card: old[1].card, direction: 'plugin-newer-than-host' }
    return { service: svc }
  })
}
