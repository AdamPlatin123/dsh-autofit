/**
 * Community adapter: web-casa Awesome-DeepSeek-Harness-Plugins `data/plugins.json`
 * (`{ version: '<date>', total, generatedAt, plugins: [{ slug, name, npmPackage, sourceType, latestVersion, … }] }`).
 *
 * Two entry kinds:
 * - `sourceType: 'registry'`: `npmPackage` is the npm name → `name@latestVersion` on the public registry (pinned,
 *   though the list is a snapshot, so the version may be older than npm's latest). repo/directory come from
 *   `repoUrl`, as readShop does for npm entries.
 * - `sourceType: 'github'`: `npmPackage` is a bare `https://github.com/<owner>/<repo>` URL with no ref → unpinned
 *   `github:owner/repo`. Identity is that repo (what is installed); `latestVersion` describes some past default-branch
 *   head, so it is not offered as the version. `repoUrl` and `stars` are shown only when `repoUrl` is that repo.
 * There is no engines field; `hostVersion` is accepted for interface symmetry and not used. Pure functions.
 */

import {
  DESCRIPTION_MAX, SKIP, TITLE_MAX, cleanCategory, cleanCount, cleanText, githubHeadInstall, httpUrl, isPackageName,
  makeOffering, npmInstall, repoFromUrl, skipTally,
} from '../offer.js'
import { parse } from '../semver.js'

export const id = 'webcasa-plugins'
export const title = { zh: 'web-casa 插件精选列表', en: 'web-casa Awesome DeepSeek Harness Plugins' }

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const GITHUB_REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/
const STATUS = /^[a-z0-9-]{1,32}$/
const KIND_RANK = { npm: 0, 'github-head': 1 }
const ENTRY_KEYS = ['slug', 'npmPackage', 'sourceType', 'latestVersion', 'installCommand']

function looksLikeEntry(p) {
  return isObject(p) && ENTRY_KEYS.every((k) => k in p) && typeof p.slug === 'string'
}

/**
 * True only for this list: a date `version`, numeric `total`, string `generatedAt`, a `plugins` array whose first
 * object entries carry slug/npmPackage/sourceType/latestVersion/installCommand, and none of the format-1, shop,
 * radar or npm-search markers.
 */
export function detect(doc) {
  if (!isObject(doc) || !Array.isArray(doc.plugins)) return false
  if ('format' in doc || 'schemaVersion' in doc || 'schema' in doc || 'objects' in doc) return false
  if (typeof doc.version !== 'string' || !DATE.test(doc.version)) return false
  if (typeof doc.total !== 'number' || typeof doc.generatedAt !== 'string') return false
  const head = doc.plugins.slice(0, 5).filter(isObject)
  return head.length > 0 && head.every(looksLikeEntry)
}

function description(p) {
  const en = cleanText(p.description, DESCRIPTION_MAX)
  const zh = cleanText(p.descriptionZh, DESCRIPTION_MAX)
  if (en && zh && en !== zh) return { en, zh }
  return en ?? zh
}

/** One list entry → `{ offering }` or `{ error }`. */
function readEntry(p, sourceId) {
  if (!isObject(p)) return { error: SKIP.entry }
  let name
  let version = null
  let repo = null
  let directory = null
  let target
  if (p.sourceType === 'registry') {
    name = p.npmPackage
    if (!isPackageName(name)) return { error: SKIP.name }
    if (!parse(p.latestVersion)) return { error: SKIP.version }
    version = p.latestVersion
    target = npmInstall(name, version, null)
    ;({ repo, directory } = repoFromUrl(p.repoUrl))
  } else if (p.sourceType === 'github') {
    name = p.name
    if (!isPackageName(name, { caseInsensitive: true })) return { error: SKIP.name }
    const m = typeof p.npmPackage === 'string' ? GITHUB_REPO_URL.exec(p.npmPackage) : null
    if (!m) return { error: SKIP.source }
    target = githubHeadInstall(m[1])
    repo = m[1].toLowerCase()
  } else {
    return { error: SKIP.source }
  }
  if (target.error) return { error: target.error }
  // a github entry installs `repo`: `repoUrl` (and its stars) count only when they name that same repo
  const urlIsInstalled = p.sourceType === 'registry' || repoFromUrl(p.repoUrl).repo === repo
  const labels = []
  if (typeof p.securityStatus === 'string' && STATUS.test(p.securityStatus) && p.securityStatus !== 'clean') {
    labels.push(`${sourceId}:security-${p.securityStatus}`)
  }
  return {
    offering: makeOffering({
      sourceId,
      name,
      title: cleanText(p.name, TITLE_MAX),
      description: description(p),
      category: Array.isArray(p.categories) ? cleanCategory(p.categories[0]) : null,
      version,
      versionCount: version ? 1 : 0,
      repo,
      directory,
      homepage: urlIsInstalled ? httpUrl(p.repoUrl) ?? httpUrl(p.cordisUrl) : `https://github.com/${repo}`,
      install: target.install,
      stars: urlIsInstalled ? cleanCount(p.stars) : null,
      labels,
    }),
  }
}

/**
 * Offerings from a web-casa plugins.json. One offering per name + repo + directory; on a clash the pinned npm
 * install wins over github-head.
 * @returns `{ offerings, skipped, skippedBy, warnings }`
 * @throws TypeError when `detect(doc)` is false or `sourceId` is missing.
 */
export function read(doc, { sourceId } = {}) {
  if (!detect(doc)) throw new TypeError('not a web-casa plugins.json document')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const byIdentity = new Map()
  doc.plugins.forEach((p, i) => {
    const { offering, error } = readEntry(p, sourceId)
    if (error) {
      tally.count(error, `plugins[${i}]`)
      return
    }
    const identity = `${offering.name.toLowerCase()}|${offering.repo ?? ''}|${offering.directory ?? ''}`
    const at = byIdentity.get(identity)
    if (at === undefined) {
      byIdentity.set(identity, offerings.length)
      offerings.push(offering)
      return
    }
    tally.count(SKIP.duplicate, `plugins[${i}]`)
    if (KIND_RANK[offering.install.kind] < KIND_RANK[offerings[at].install.kind]) offerings[at] = offering
  })
  return { offerings, ...tally.result() }
}
