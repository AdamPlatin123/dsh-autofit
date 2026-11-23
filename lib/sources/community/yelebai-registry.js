/**
 * Community adapter: the YELEBAI dsh-plugin-marketplace registry (`registry/plugins.json`, schemaVersion 2, ~25 MB,
 * ~19k entries) and its stale copy wsifan31-bit/Smart-DSH-Market, one document
 * `{ schemaVersion: 2, generatedAt, plugins: [{ fullName, packageName, version, verifiedCommit, install{...}, ... }] }`.
 * Each entry carries a ready, pinned `install.spec`: `github:<owner>/<repo>#<40-hex commit>` or npm `<name>@<version>`.
 *
 * Specs are rebuilt with the offer.js builders, never passed through: a `github:` spec becomes the git install
 * `git+https://github.com/<owner>/<repo>.git#<commit>`, an npm spec must equal `packageName@version`.
 * Identity: a git offering's repo is the owner/repo its spec installs, never `fullName`/`htmlUrl`. An npm entry's
 * repo is its `fullName` (the only repo it states, as format1/shop keep `repository` for npm), unless entries
 * from several repos list the same npm package (forks listing the upstream package, or unrelated repos reusing a
 * name): then which repo publishes it is unknown, and a repo-less npm offering would be attached by merge.js to
 * whichever repo card has that name, so those entries are skipped (`ambiguous-repo`). No directory: the registry
 * installs repository roots. The homepage is the repo's GitHub page, never the stated `htmlUrl`.
 * Pure functions; fetching lives in store.js.
 */

import {
  DESCRIPTION_MAX, SKIP, cleanCount, cleanKeywords, cleanText, gitInstall, isPackageName, makeOffering,
  npmInstall, skipTally, toUnixSeconds,
} from '../offer.js'
import { compare, parse } from '../semver.js'

export const id = 'yelebai-registry'
export const title = { zh: 'YELEBAI 插件市场注册表', en: 'YELEBAI plugin marketplace registry' }

/** Skip reasons beyond offer.js SKIP that this adapter counts in `skippedBy`. */
export const REASON = { ambiguousRepo: 'ambiguous-repo' }

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const GITHUB_SPEC = /^github:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)#([0-9a-f]{40})$/
const KIND_RANK = { npm: 0, git: 1 }
const DETECT_SAMPLE = 5

function looksLikeEntry(p) {
  return isObject(p) && typeof p.fullName === 'string' && 'verifiedCommit' in p && 'packageName' in p &&
    isObject(p.install) && typeof p.install.spec === 'string' && typeof p.install.mode === 'string'
}

/**
 * True only for this registry family: `schemaVersion` 2, a string `generatedAt`, a `plugins` array, none of the
 * keys other families use at the top (format, schema, objects, metadata), and one of the first rows shaped like a
 * registry entry (fullName + verifiedCommit + packageName + install{spec, mode}). dsh-plugin-shop data
 * (schemaVersion 5, entries with name/source) and format-1 indexes never match. An empty registry is not
 * recognized: there is nothing to read.
 */
export function detect(doc) {
  if (!isObject(doc) || doc.schemaVersion !== 2 || typeof doc.generatedAt !== 'string') return false
  if (!Array.isArray(doc.plugins) || doc.plugins.length === 0) return false
  if ('format' in doc || 'schema' in doc || 'objects' in doc || 'metadata' in doc) return false
  return doc.plugins.slice(0, DETECT_SAMPLE).some(looksLikeEntry)
}

/** One registry entry → `{ offering }` or `{ error }`; `npmClaims` maps an npm package name to the repos listing it. */
function readEntry(p, sourceId, npmClaims) {
  if (!isObject(p) || !isObject(p.install) || typeof p.install.spec !== 'string') return { error: SKIP.entry }
  const { spec, source } = p.install
  const name = p.packageName
  const version = parse(p.version) ? p.version : null
  let target
  let repo
  if (source === 'github') {
    if (!isPackageName(name, { caseInsensitive: true })) return { error: SKIP.name }
    const m = GITHUB_SPEC.exec(spec)
    if (!m || /^\.+$/.test(m[2])) return { error: SKIP.source }
    target = gitInstall(`https://github.com/${m[1]}/${m[2]}.git`, m[3])
    repo = `${m[1]}/${m[2]}`.toLowerCase()
  } else if (source === 'npm') {
    if (!isPackageName(name)) return { error: SKIP.name }
    if (!version) return { error: SKIP.version }
    if (spec !== `${name}@${version}`) return { error: SKIP.spec }
    target = npmInstall(name, version, null)
    const claims = npmClaims.get(name)
    if (!claims || claims.size !== 1) return { error: REASON.ambiguousRepo }
    repo = [...claims][0]
  } else {
    return { error: SKIP.source }
  }
  if (target.error) return { error: target.error }
  const labels = p.install.mode === 'guided' ? [`${sourceId}:guided`] : []
  return {
    offering: makeOffering({
      sourceId,
      name,
      description: cleanText(p.description, DESCRIPTION_MAX),
      keywords: cleanKeywords(p.topics),
      version,
      versionCount: version ? 1 : 0,
      publishedAt: toUnixSeconds(p.updatedAt, { minYear: 2020 }),
      repo,
      homepage: repo ? `https://github.com/${repo}` : null,
      install: target.install,
      stars: cleanCount(p.stars),
      labels,
    }),
  }
}

/** The lowercase GitHub repo an entry states (`fullName`), or null. */
function statedRepo(p) {
  return isObject(p) && typeof p.fullName === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(p.fullName)
    ? p.fullName.toLowerCase()
    : null
}

/**
 * Offerings from a registry document. Each entry pins one version, so there is no version choice; `hostVersion`
 * is accepted for interface symmetry and not used. Entries are skipped and counted, never fatal. One offering per
 * name + repo, preferring the repairable npm install, then the newest version; the same name from different repos stays separate so
 * merge.js can show the conflict.
 * @returns `{ offerings, skipped, skippedBy, warnings }`
 * @throws TypeError when `detect(doc)` is false or `sourceId` is missing.
 */
export function read(doc, { sourceId } = {}) {
  if (!detect(doc)) throw new TypeError('not a YELEBAI registry document')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const npmClaims = new Map()
  for (const p of doc.plugins) {
    if (!isObject(p) || !isObject(p.install) || p.install.source !== 'npm' || typeof p.packageName !== 'string') continue
    const set = npmClaims.get(p.packageName) ?? new Set()
    set.add(statedRepo(p))
    npmClaims.set(p.packageName, set)
  }
  const tally = skipTally()
  const offerings = []
  const byIdentity = new Map()
  doc.plugins.forEach((p, i) => {
    const { offering, error } = readEntry(p, sourceId, npmClaims)
    if (error) {
      tally.count(error, `plugins[${i}]`)
      return
    }
    const identity = `${offering.name.toLowerCase()}|${offering.repo ?? ''}`
    const at = byIdentity.get(identity)
    if (at === undefined) {
      byIdentity.set(identity, offerings.length)
      offerings.push(offering)
      return
    }
    tally.count(SKIP.duplicate, `plugins[${i}]`)
    const kept = offerings[at]
    const rank = KIND_RANK[offering.install.kind] - KIND_RANK[kept.install.kind]
    if (rank < 0 || (rank === 0 && offering.version && kept.version && compare(offering.version, kept.version) > 0)) {
      offerings[at] = offering
    }
  })
  return { offerings, ...tally.result() }
}
