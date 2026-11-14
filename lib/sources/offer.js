/**
 * The Offering: one plugin as one catalog source offers it, plus the normalizers every source reader shares
 * (text and locale maps, keywords, GitHub repo + directory, icons, homepages, install specs, version choice).
 *
 * Install specs mirror DSH's own `marketInstallTarget` (dsh-plugin-market-index) and never invent a target:
 * npm → `name@version` (public registry only, see npmInstall), git → `git+<url>.git#<commit>[&path:/<dir>]`.
 * Readers call these helpers and get either a value or a short reason string, so a bad entry is skipped and counted
 * instead of failing a source.
 */

import { repoKey } from '../radar.js'
import { RANGE_MAX, compare, parse, satisfies } from './semver.js'

export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 600
export const KEYWORDS_MAX = 12
export const SPEC_MAX = 2000
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

const NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const NAME_CI = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i
const NAME_MAX = 214
const LOCALE = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i
const COMMIT = /^[0-9a-f]{40}$/
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/
const BAD_SPEC_CHARS = /[\s\u0000-\u001f\u007f]/

/** Skip reasons readers count in `skippedBy`. */
export const SKIP = {
  entry: 'invalid-entry',
  name: 'invalid-name',
  duplicate: 'duplicate',
  version: 'no-valid-version',
  source: 'invalid-source',
  spec: 'invalid-spec',
  verdict: 'unknown-verdict',
  registry: 'unsupported-registry',
}

/** Whether `name` is an npm package name; `caseInsensitive` accepts upper case (git-sourced entries keep it as is). */
export function isPackageName(name, { caseInsensitive = false } = {}) {
  return typeof name === 'string' && name.length <= NAME_MAX && (caseInsensitive ? NAME_CI : NAME).test(name)
}

/** A spec `dsh plugin add` can take verbatim: ≤ 2000 chars, no leading `-`, no whitespace or control chars. */
export function isSafeSpec(spec) {
  return typeof spec === 'string' && spec.length > 0 && spec.length <= SPEC_MAX && !spec.startsWith('-') &&
    !BAD_SPEC_CHARS.test(spec)
}

function capString(value, max) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/**
 * A display text as a source states it: a trimmed string, or a `{ locale: text }` map with empty or malformed
 * members dropped; each text capped at `max` chars. Null when nothing usable is left.
 */
export function cleanText(value, max) {
  if (typeof value === 'string') return capString(value, max)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const out = {}
  let any = false
  for (const [locale, text] of Object.entries(value)) {
    if (!LOCALE.test(locale)) continue
    const capped = capString(text, max)
    if (capped === null) continue
    Object.defineProperty(out, locale.toLowerCase(), { value: capped, enumerable: true, writable: true, configurable: true })
    any = true
  }
  return any ? out : null
}

/** Up to 12 distinct lowercase keywords (each ≤ 50 chars), in source order. */
export function cleanKeywords(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const k of list) {
    if (typeof k !== 'string') continue
    const word = k.trim().toLowerCase()
    if (!word || word.length > 50 || out.includes(word)) continue
    out.push(word)
    if (out.length >= KEYWORDS_MAX) break
  }
  return out
}

/** A relative package directory without leading/trailing slashes, or null (empty, `.`/`..` segments, odd chars). */
export function cleanDirectory(dir) {
  if (typeof dir !== 'string') return null
  const text = dir.trim().replace(/^\/+|\/+$/g, '')
  if (!text) return null
  const segments = text.split('/')
  if (segments.some((s) => s === '.' || s === '..' || !PATH_SEGMENT.test(s))) return null
  return text
}

/**
 * `{ repo, directory }` from a repository URL: repo is the lowercase GitHub `owner/repo` (or null for other hosts);
 * directory comes from a `/tree/<ref>/<dir>` web path when present.
 */
export function repoFromUrl(url) {
  const repo = repoKey(url) ?? null
  let directory = null
  if (repo && typeof url === 'string') {
    const m = /github\.com\/[^/\s]+\/[^/\s#?]+\/tree\/[^/\s#?]+\/([^\s#?]+)/i.exec(url)
    if (m) directory = cleanDirectory(m[1])
  }
  return { repo, directory }
}

/** An absolute http(s) URL (as `URL.href`), or null. */
export function httpUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > SPEC_MAX) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/** An icon as an absolute http(s) URL: relative references resolve against `baseUrl`; `data:` and others → null. */
export function cleanIcon(icon, baseUrl) {
  if (typeof icon !== 'string' || !icon.trim() || icon.startsWith('data:') || icon.length > SPEC_MAX) return null
  try {
    const url = baseUrl ? new URL(icon.trim(), baseUrl) : new URL(icon.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/** Unix seconds from a number (seconds, [0, 1e11)) or an ISO date; years before `minYear` → null. */
export function toUnixSeconds(value, { minYear = 0 } = {}) {
  let ms
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value >= 1e11) return null
    ms = value * 1000
  } else if (typeof value === 'string' && value.trim()) {
    ms = Date.parse(value)
    if (!Number.isFinite(ms)) return null
  } else {
    return null
  }
  if (new Date(ms).getUTCFullYear() < minYear) return null
  return Math.floor(ms / 1000)
}

/** A finite non-negative number, or null. */
export function cleanCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * An `engines.dsh` range as a reader stores it: a string as is, or null when absent. A range longer than RANGE_MAX
 * is cut and marked with `…`, which keeps it invalid (semver.js rejects ranges over RANGE_MAX), so it never admits
 * a host, as DSH would not either, while a hostile index cannot make the catalog store or parse megabyte ranges.
 */
export function cleanEngines(value) {
  if (typeof value !== 'string') return null
  return value.length > RANGE_MAX ? `${value.slice(0, RANGE_MAX)}…` : value
}

/**
 * The registry to name in an npm install, or null for the public registry. Like DSH, the value is `URL.href`;
 * the default is recognized with or without its trailing slash. Returns undefined for an unusable value.
 */
export function cleanRegistry(registry) {
  if (registry === undefined || registry === null) return null
  const href = httpUrl(registry)
  if (!href) return undefined
  if (href.includes('?') || href.includes('#')) return undefined
  const slashed = href.endsWith('/') ? href : `${href}/`
  return slashed === DEFAULT_REGISTRY ? null : href
}

function install(kind, spec, registry = null) {
  if (!isSafeSpec(spec)) return { error: SKIP.spec }
  return {
    install: {
      kind,
      spec,
      registry,
      pinned: kind !== 'github-head',
      repairable: kind === 'npm' && registry === null,
    },
  }
}

/**
 * npm install target `name@version` (DSH marketInstallTarget). Returns `{ install }` or `{ error }`.
 * A non-default registry is refused (`SKIP.registry`): the trial, the repair and the install all resolve the spec
 * against the user's npm registry, which may hold a different package of the same name, so such an offering could
 * install something other than what the source lists. `install.registry` is therefore always null for now.
 */
export function npmInstall(name, version, registry) {
  const reg = cleanRegistry(registry)
  if (reg === undefined) return { error: SKIP.source }
  if (reg !== null) return { error: SKIP.registry }
  return install('npm', `${name}@${version}`, reg)
}

/**
 * Git install target pinned to a commit (DSH marketInstallTarget): `git+<url>[.git]#<commit>[&path:/<dir>]`.
 * The URL must be https with at least owner/repo path segments, no credentials/query/fragment, and not a tarball;
 * the commit must be 40 lowercase hex digits. Returns `{ install }` or `{ error }`.
 */
export function gitInstall(url, commit, path) {
  if (typeof url !== 'string' || typeof commit !== 'string' || !COMMIT.test(commit)) return { error: SKIP.source }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { error: SKIP.source }
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.href !== url || !/^(?:\/[^/]+){2,}$/.test(parsed.pathname) || /\.(?:tgz|tar\.gz)$/i.test(parsed.pathname)) {
    return { error: SKIP.source }
  }
  let dir = null
  if (path !== undefined && path !== null) {
    dir = cleanDirectory(path)
    if (dir === null || dir !== path) return { error: SKIP.source }
  }
  const base = url.endsWith('.git') ? url : `${url}.git`
  return install('git', `git+${base}#${commit}${dir === null ? '' : `&path:/${dir}`}`)
}

/** Unpinned GitHub default-branch install `github:owner/repo` (radar repos). */
export function githubHeadInstall(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || /^\.+$/.test(repo.split('/')[1])) {
    return { error: SKIP.source }
  }
  return install('github-head', `github:${repo}`)
}

/**
 * The lowercase `owner/repo` a GitHub-hosted tarball URL is served from (`https://github.com/<owner>/<repo>/…`, e.g.
 * release assets and archives, or `https://codeload.github.com/<owner>/<repo>/…`), or null for any other URL.
 */
export function tarballRepo(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'codeload.github.com')) return null
  const m = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/./.exec(u.pathname)
  if (!m || /^\.+$/.test(m[2])) return null
  return `${m[1]}/${m[2]}`.toLowerCase()
}

/** Remote tarball install: an https URL, passed as is. */
export function tarballInstall(url) {
  const href = httpUrl(url)
  if (!href || !href.startsWith('https:') || href !== url) return { error: SKIP.source }
  return install('tarball', href)
}

/**
 * Whether a host version meets an `engines.dsh` range the way DSH evaluates it (dsh-app-boot
 * evaluatePluginCompatibility): absent → yes; empty or invalid → no; otherwise semver.satisfies with
 * includePrerelease=true, so a prerelease host such as 0.2.1-rc.2 satisfies `^0.2.0` and `>=0.2.0-0`.
 */
export function enginesAdmit(range, hostVersion) {
  if (range === undefined || range === null) return true
  if (typeof range !== 'string' || !range.trim()) return false
  return satisfies(hostVersion, range, { includePrerelease: true })
}

/**
 * Pick the version to offer from `candidates` (`[{ version, engines }]`, any order; invalid versions ignored).
 * With `hostVersion`: the newest stable version whose engines admit the host; when the plugin lists no stable
 * version at all, the newest admitted prerelease (DSH market's defaultVersion rule). Then (no admitted version, or
 * no hostVersion) the newest stable, else the newest. Returns `{ chosen, count, compatible }` or null when no
 * candidate has a valid version. `compatible` is null without hostVersion.
 */
export function chooseVersion(candidates, hostVersion) {
  const valid = []
  for (const c of candidates) {
    const parsed = parse(c?.version)
    if (parsed) valid.push({ c, parsed })
  }
  if (!valid.length) return null
  valid.sort((a, b) => compare(b.parsed, a.parsed))
  const stable = valid.filter((x) => !x.parsed.prerelease.length)
  if (hostVersion) {
    const admitted = (x) => enginesAdmit(x.c.engines ?? null, hostVersion)
    const pick = stable.length ? stable.find(admitted) : valid.find(admitted)
    if (pick) return { chosen: pick.c, count: valid.length, compatible: true }
  }
  const pick = stable[0] ?? valid[0]
  return { chosen: pick.c, count: valid.length, compatible: hostVersion ? false : null }
}

/** A complete Offering with every field present (null/[] defaults), in the documented order. */
export function makeOffering(fields) {
  return {
    sourceId: fields.sourceId,
    name: fields.name,
    title: fields.title ?? null,
    description: fields.description ?? null,
    category: fields.category ?? null,
    keywords: fields.keywords ?? [],
    version: fields.version ?? null,
    versionCount: fields.versionCount ?? (fields.version ? 1 : 0),
    publishedAt: fields.publishedAt ?? null,
    engines: fields.engines ?? null,
    repo: fields.repo ?? null,
    directory: fields.directory ?? null,
    homepage: fields.homepage ?? null,
    icon: fields.icon ?? null,
    install: fields.install,
    stars: fields.stars ?? null,
    labels: fields.labels ?? [],
  }
}

/** A short source-local category id (≤ 64 chars), or null. */
export function cleanCategory(value) {
  return typeof value === 'string' && value.trim() && value.length <= 64 ? value.trim() : null
}

/** Skip tally shared by readers: `count(reason, detail)` bumps `skippedBy` and keeps ≤ 20 warning strings. */
export function skipTally(maxWarnings = 20) {
  const skippedBy = {}
  const warnings = []
  let skipped = 0
  return {
    count(reason, detail) {
      skipped++
      skippedBy[reason] = (skippedBy[reason] ?? 0) + 1
      if (detail && warnings.length < maxWarnings) warnings.push(`${detail}: ${reason}`)
    },
    result() {
      return { skipped, skippedBy, warnings }
    },
  }
}
