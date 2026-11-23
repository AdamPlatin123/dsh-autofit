/**
 * Community adapter: the w2112515 dsh-plugin-marketplace scanner catalog (`plugin-marketplace/catalog-v1.json`,
 * `{ schemaVersion: 1, scannerVersion, topic, integrity, summary, entries: [...], packs, ratings }`).
 *
 * Every entry is one GitHub repo pinned to a commit: `source.ref` is `git+https://github.com/<owner>/<repo>.git#<sha>`.
 * The install spec is rebuilt from that ref with gitInstall, and the offering's identity (repo) is the repo the ref
 * installs from; `repository.url` / `repository.fullName` are not trusted for identity. The package name and version
 * come from the scanned package.json at that commit and are metadata only.
 * Pure functions; fetching (and the 33 MB download) lives in store.js.
 */

import {
  DESCRIPTION_MAX, SKIP, cleanCount, cleanKeywords, cleanText, gitInstall, isPackageName, makeOffering, skipTally,
  toUnixSeconds,
} from '../offer.js'
import { parse } from '../semver.js'

export const id = 'w2112515-catalog'
export const title = { zh: 'w2112515 插件市场目录（catalog-v1）', en: 'w2112515 plugin marketplace catalog (catalog-v1)' }

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
// git+https://github.com/<owner>/<repo>.git#<40 lowercase hex>; owner/repo charset as GitHub allows.
const REF = /^git\+(https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)\.git)#([0-9a-f]{40})$/

/**
 * Whether `doc` is a catalog-v1 document: schemaVersion 1 plus the scanner's own top-level keys (scannerVersion,
 * topic, integrity, summary.entryCount) and an `entries` array, with no `plugins` / `format` / `schema` / `objects`
 * key that the format-1, shop, radar or npm readers use.
 */
export function detect(doc) {
  if (!isObject(doc) || doc.schemaVersion !== 1 || !Array.isArray(doc.entries)) return false
  if ('plugins' in doc || 'format' in doc || 'schema' in doc || 'objects' in doc) return false
  if (typeof doc.scannerVersion !== 'string' || typeof doc.topic !== 'string') return false
  if (!isObject(doc.integrity) || !isObject(doc.summary) || typeof doc.summary.entryCount !== 'number') return false
  const first = doc.entries[0]
  return first === undefined || (isObject(first) && isObject(first.source) && isObject(first.repository))
}

/** The install a `source.ref` names: `{ install, repo }` (repo lowercase owner/repo from the ref) or `{ error }`. */
function refInstall(source) {
  if (!isObject(source) || source.kind !== 'git' || typeof source.ref !== 'string') return { error: SKIP.source }
  // Only a root package.json matches a ref without a path; a subdirectory package would install the wrong thing.
  if (source.packageJsonPath !== undefined && source.packageJsonPath !== 'package.json') return { error: SKIP.source }
  const m = REF.exec(source.ref)
  if (!m || /^\.+$/.test(m[3])) return { error: SKIP.source }
  const target = gitInstall(m[1], m[4])
  if (target.error) return { error: target.error }
  return { install: target.install, repo: `${m[2]}/${m[3]}`.toLowerCase(), webUrl: `https://github.com/${m[2]}/${m[3]}` }
}

function readEntry(e, sourceId) {
  if (!isObject(e) || !isObject(e.package)) return { error: SKIP.entry }
  if (isObject(e.validation) && e.validation.status !== 'valid') return { error: SKIP.verdict }
  const name = e.package.name
  if (!isPackageName(name, { caseInsensitive: true })) return { error: SKIP.name }
  const target = refInstall(e.source)
  if (target.error) return { error: target.error }
  const version = typeof e.package.version === 'string' && parse(e.package.version) ? e.package.version : null
  const labels = []
  if (e.installability === 'manual') labels.push(`${sourceId}:manual`)
  if (isObject(e.repository) && e.repository.archived === true) labels.push(`${sourceId}:archived`)
  if (Array.isArray(e.riskSignals) && e.riskSignals.includes('lifecycle-script')) labels.push(`${sourceId}:lifecycle-script`)
  const keywords = cleanKeywords(Array.isArray(e.keywords) && e.keywords.length ? e.keywords : e.topics)
  return {
    offering: makeOffering({
      sourceId,
      name,
      description: cleanText(e.package.description, DESCRIPTION_MAX),
      keywords,
      version,
      versionCount: version ? 1 : 0,
      publishedAt: toUnixSeconds(e.lastCodePushAt, { minYear: 2020 }),
      repo: target.repo,
      directory: null,
      homepage: target.webUrl,
      install: target.install,
      stars: cleanCount(e.stars),
      labels,
    }),
  }
}

/**
 * Offerings from a catalog-v1 document, one per repo (a repeated repo is skipped as a duplicate). One package
 * name from several repos stays as several offerings so merge.js can show the conflict. The catalog names no
 * engines range (`compatibility` is a verdict string), so `hostVersion` is accepted for symmetry and not used.
 * @returns `{ offerings, skipped, skippedBy, warnings }`
 * @throws TypeError when `doc` is not a catalog-v1 document or `sourceId` is missing.
 */
export function read(doc, { sourceId } = {}) {
  if (!detect(doc)) throw new TypeError('not a w2112515 catalog-v1 document')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const repos = new Set()
  doc.entries.forEach((e, i) => {
    const { offering, error } = readEntry(e, sourceId)
    if (error) {
      tally.count(error, `entries[${i}]`)
      return
    }
    if (repos.has(offering.repo)) {
      tally.count(SKIP.duplicate, `entries[${i}] ${offering.repo}`)
      return
    }
    repos.add(offering.repo)
    offerings.push(offering)
  })
  return { offerings, ...tally.result() }
}
