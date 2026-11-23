/**
 * Community adapter: the awesome-omni-dsh-plugins catalog (`format: 'omni-dsh-catalog-v1'`, one static JSON at
 * https://dsh-plugins.omniskill.online/catalog.json; catalog data CC0-1.0). Every entry names a GitHub repository,
 * a 40-hex commit and an optional subpath; many also name a published npm package with version and integrity.
 *
 * Install: npm `name@version` when the entry lists an npm package (repairable, as readShop prefers), else a git spec
 * pinned to `source.commit` with `&path:/<subpath>`. The entry's own `install` string (unpinned `github:` at the
 * default branch) is never used. Identity: a git offering's repo/directory are the ones its spec installs from; an
 * npm offering takes them from `source`, which is the catalog's own (verified) repository mapping, like readShop does
 * for npm `repository`. Pure function; fetching lives in store.js.
 */

import {
  DESCRIPTION_MAX, SKIP, TITLE_MAX, cleanCategory, cleanCount, cleanDirectory, cleanKeywords, cleanText, gitInstall,
  isPackageName, makeOffering, npmInstall, skipTally,
} from '../offer.js'
import { parse } from '../semver.js'

export const id = 'omni-catalog'
export const title = { zh: 'Omni DSH 插件目录', en: 'Omni DSH plugin catalog' }

const FORMAT = 'omni-dsh-catalog-v1'
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/
const KIND_RANK = { npm: 0, git: 1 }
const COMMIT = /^[0-9a-f]{40}$/

/** True only for an omni-dsh-catalog-v1 document: the format tag, an entries array and the catalog's own keys. */
export function detect(doc) {
  return isObject(doc) && doc.format === FORMAT && Array.isArray(doc.entries) && typeof doc.catalogRevision === 'string' &&
    !('plugins' in doc) && !('schemaVersion' in doc) && !('objects' in doc) && !('schema' in doc)
}

/** `owner/repo` (as written) of a github.com repository URL, or null. */
function githubRepo(url) {
  if (typeof url !== 'string' || url.length > 300) return null
  const m = GITHUB_REPO.exec(url)
  if (!m || /^\.+$/.test(m[2])) return null
  return `${m[1]}/${m[2]}`
}

/** One catalog entry → `{ offering }` or `{ error }`. */
function readEntry(e, sourceId) {
  if (!isObject(e) || e.schemaVersion !== 1 || !isObject(e.source)) return { error: SKIP.entry }
  const src = e.source
  const repoName = githubRepo(src.repository)
  if (!repoName) return { error: SKIP.source }
  let directory = null
  if (src.subpath !== undefined && src.subpath !== null && src.subpath !== '') {
    directory = cleanDirectory(src.subpath)
    if (directory === null || directory !== src.subpath) return { error: SKIP.source }
  }
  const pkg = isObject(e.package) ? e.package : {}
  let name
  let version = null
  let target
  if (pkg.ecosystem === 'npm' && pkg.name !== undefined) {
    name = pkg.name
    if (!isPackageName(name)) return { error: SKIP.name }
    if (!parse(pkg.version)) return { error: SKIP.version }
    version = pkg.version
    target = npmInstall(name, version, null)
  } else {
    name = e.name
    if (!isPackageName(name, { caseInsensitive: true })) return { error: SKIP.name }
    target = gitInstall(`https://github.com/${repoName}.git`, src.commit, directory)
  }
  if (target.error) return { error: target.error }
  const description = isObject(e.description) ? { ...e.description } : e.description
  if (isObject(description)) delete description.evidencePath
  const labels = []
  if (typeof e.kind === 'string' && e.kind !== 'plugin' && /^[a-z0-9-]{1,32}$/.test(e.kind)) labels.push(`${sourceId}:${e.kind}`)
  // 'eligible' is every live entry, so only another status (in practice 'archived') is worth a label
  const status = isObject(e.verification) ? e.verification.status : null
  if (typeof status === 'string' && status !== 'eligible' && /^[a-z0-9-]{1,32}$/.test(status)) labels.push(`${sourceId}:${status}`)
  // the DSH profiles the plugin targets (web, headless, default, tui): installs land in a profile
  const profiles = isObject(e.dsh) && Array.isArray(e.dsh.profiles) ? e.dsh.profiles : []
  for (const p of profiles) {
    if (typeof p !== 'string' || !/^[a-z0-9-]{1,32}$/.test(p)) continue
    const label = `${sourceId}:profile-${p}`
    if (!labels.includes(label) && labels.length < 8) labels.push(label)
  }
  const pop = isObject(e.popularity) ? e.popularity : {}
  return {
    offering: makeOffering({
      sourceId,
      name,
      title: cleanText(e.name, TITLE_MAX),
      description: cleanText(description, DESCRIPTION_MAX),
      category: cleanCategory(e.primaryCategory),
      keywords: cleanKeywords(e.tags),
      version,
      versionCount: version ? 1 : 0,
      repo: repoName.toLowerCase(),
      directory,
      // only a validated commit goes into the link (npm entries never reach gitInstall's check)
      homepage: `https://github.com/${repoName}${directory !== null && typeof src.commit === 'string' && COMMIT.test(src.commit) ? `/tree/${src.commit}/${directory}` : ''}`,
      install: target.install,
      // stars of a monorepo parent are not this plugin's; the catalog says so in starsPolicy
      stars: pop.starsPolicy === 'exact-repository' ? cleanCount(pop.stars) : null,
      labels,
    }),
  }
}

/**
 * Offerings from an omni-dsh-catalog-v1 document, one per name + repo + directory (npm preferred over git).
 * `hostVersion` is accepted for interface symmetry: entries carry no engines range.
 * @returns `{ offerings, skipped, skippedBy, warnings }`
 * @throws TypeError when `detect(doc)` is false or `sourceId` is missing.
 */
export function read(doc, { sourceId } = {}) {
  if (!detect(doc)) throw new TypeError('not an omni-dsh-catalog-v1 document')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const byIdentity = new Map()
  doc.entries.forEach((e, i) => {
    const { offering, error } = readEntry(e, sourceId)
    if (error) {
      tally.count(error, `entries[${i}]`)
      return
    }
    const identity = `${offering.name.toLowerCase()}|${offering.repo}|${offering.directory ?? ''}`
    const at = byIdentity.get(identity)
    if (at === undefined) {
      byIdentity.set(identity, offerings.length)
      offerings.push(offering)
      return
    }
    tally.count(SKIP.duplicate, `entries[${i}]`)
    if (KIND_RANK[offering.install.kind] < KIND_RANK[offerings[at].install.kind]) offerings[at] = offering
  })
  return { offerings, ...tally.result() }
}
