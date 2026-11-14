/**
 * Reader for DSH plugin market index format 1 (the format DSH's own market reads) → Offerings.
 *
 * Unlike DSH's validator (parseMarketIndex), which rejects a whole index for its first bad member, this reader is
 * lenient per entry: community indexes run to 30 MB and 20k+ entries, and one bad entry must not hide the rest.
 * A bad entry is skipped and counted. Install specs follow DSH's marketInstallTarget exactly (see offer.js), and the
 * offered version follows chooseVersion (newest stable version whose engines.dsh admits the host).
 *
 * Identity: the GitHub repo (and directory) of a git-sourced offering is the one it installs from (`source.url`,
 * `source.path`), never the entry's self-declared `repository`, so a git entry cannot borrow another repo's radar
 * verdict, stars or catalog card. npm-sourced entries keep `repository` (the only repo they state).
 */

import {
  DESCRIPTION_MAX, SKIP, TITLE_MAX, chooseVersion, cleanCategory, cleanCount, cleanDirectory, cleanEngines, cleanIcon,
  cleanKeywords, cleanText, gitInstall, httpUrl, isPackageName, makeOffering, npmInstall, repoFromUrl, skipTally,
  toUnixSeconds,
} from './offer.js'
import { parse } from './semver.js'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function categoriesOf(metadata) {
  const out = {}
  const declared = isObject(metadata) && isObject(metadata.categories) ? metadata.categories : {}
  for (const [id, decl] of Object.entries(declared)) {
    if (!id || id.length > 64) continue
    const title = cleanText(isObject(decl) ? decl.title : undefined, TITLE_MAX)
    Object.defineProperty(out, id, { value: title ?? id, enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** The install target of one format-1 version entry: `{ install }` or `{ error }`. */
function targetOf(name, entry) {
  const source = entry.source
  if (!isObject(source)) return { error: SKIP.source }
  if (source.type === 'npm') {
    if (!isPackageName(name)) return { error: SKIP.name }
    return npmInstall(name, entry.version, source.registry)
  }
  if (source.type === 'git') return gitInstall(source.url, source.commit, source.path)
  return { error: SKIP.source }
}

/**
 * Read one plugin entry. Returns `{ offering }` or `{ error }`.
 * Versions with an invalid version string or an unusable source are dropped before the version choice.
 */
function readEntry(entry, { sourceId, indexUrl, hostVersion }) {
  if (!isObject(entry)) return { error: SKIP.entry }
  const name = entry.name
  if (!isPackageName(name, { caseInsensitive: true })) return { error: SKIP.name }
  if (!Array.isArray(entry.versions) || !entry.versions.length) return { error: SKIP.version }

  const candidates = []
  const seen = new Set()
  let firstError = null
  for (const v of entry.versions) {
    if (!isObject(v) || !parse(v.version) || seen.has(v.version)) {
      firstError ??= SKIP.version
      continue
    }
    const target = targetOf(name, v)
    if (target.error) {
      firstError ??= target.error
      continue
    }
    seen.add(v.version)
    const engines = isObject(v.engines) ? cleanEngines(v.engines.dsh) : null
    candidates.push({ version: v.version, engines, entry: v, install: target.install })
  }
  const choice = chooseVersion(candidates, hostVersion)
  if (!choice) return { error: firstError ?? SKIP.version }
  const { chosen } = choice

  const source = chosen.entry.source
  const repository = isObject(entry.repository) ? entry.repository : {}
  // git: what is installed decides the identity (a repo off GitHub has none); npm: the declared repository.
  const fromRepo = repoFromUrl(repository.url)
  const identity = source.type === 'git'
    ? { repo: repoFromUrl(source.url).repo, directory: cleanDirectory(source.path) }
    : { repo: fromRepo.repo, directory: cleanDirectory(repository.directory) ?? fromRepo.directory }
  const metadata = isObject(entry.metadata) ? entry.metadata : {}
  const sortKeys = isObject(metadata.sortKeys) ? metadata.sortKeys : {}
  const labels = Array.isArray(metadata.labels)
    ? metadata.labels.filter((l) => typeof l === 'string' && l && l.length <= 64).map((l) => `${sourceId}:${l}`)
    : []

  return {
    offering: makeOffering({
      sourceId,
      name,
      title: cleanText(entry.title, TITLE_MAX),
      description: cleanText(entry.description, DESCRIPTION_MAX),
      category: cleanCategory(metadata.category),
      keywords: cleanKeywords(metadata.keywords),
      version: chosen.version,
      versionCount: choice.count,
      publishedAt: toUnixSeconds(chosen.entry.publishTimestamp),
      engines: chosen.engines,
      repo: identity.repo,
      directory: identity.directory,
      homepage: httpUrl(entry.homepage),
      icon: cleanIcon(entry.icon, indexUrl),
      install: chosen.install,
      stars: cleanCount(sortKeys['github-stars']) ?? cleanCount(sortKeys.stars),
      labels,
    }),
  }
}

/**
 * Read a format-1 index document.
 * @param doc - the parsed JSON.
 * @param options.sourceId - id of the source config (stamped on every offering, prefixes labels).
 * @param options.indexUrl - the URL the index was read from; relative icons resolve against it.
 * @param options.hostVersion - running DSH version for the version choice; omit to take the newest stable.
 * @returns `{ title, description, categories, offerings, skipped, skippedBy, warnings }` where `skipped` counts
 *   dropped entries, `skippedBy` breaks it down by reason, and `warnings` holds at most 20 strings.
 * @throws TypeError('not a format-1 index') for anything but `{ format: 1, plugins: [] }`.
 */
export function readFormat1(doc, { sourceId, indexUrl, hostVersion } = {}) {
  if (!isObject(doc) || doc.format !== 1 || !Array.isArray(doc.plugins)) throw new TypeError('not a format-1 index')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const names = new Set()
  doc.plugins.forEach((entry, i) => {
    const name = isObject(entry) ? entry.name : undefined
    if (typeof name === 'string' && names.has(name)) {
      tally.count(SKIP.duplicate, `plugins[${i}] ${name}`)
      return
    }
    const { offering, error } = readEntry(entry, { sourceId, indexUrl, hostVersion })
    if (error) {
      tally.count(error, `plugins[${i}]${typeof name === 'string' ? ` ${name.slice(0, 80)}` : ''}`)
      return
    }
    names.add(name)
    offerings.push(offering)
  })
  return {
    title: cleanText(doc.title, TITLE_MAX),
    description: cleanText(doc.description, DESCRIPTION_MAX),
    categories: categoriesOf(doc.metadata),
    offerings,
    ...tally.result(),
  }
}
