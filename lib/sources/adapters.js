/**
 * Named adapters for the few non-format-1 catalogs worth reading, each → Offerings:
 * - the radar's own repo list (dsh-radar/v1 plugins-all): unpinned `github:owner/repo` installs;
 * - dsh-plugin-shop (schemaVersion 5, a pointer file naming a content-addressed data file);
 * - npm search v1 pages (keywords:dsh-plugin; npm caps paging depth, so this is a partial, experimental view).
 * Plus `detectFormat` for user-supplied URLs. Everything else must be format 1: we do not write an adapter per
 * community schema. Pure functions; fetching and hash checks live in store.js.
 */

import {
  DESCRIPTION_MAX, SKIP, TITLE_MAX, cleanCategory, cleanCount, cleanDirectory, cleanEngines, cleanIcon, cleanKeywords,
  cleanText, gitInstall, githubHeadInstall, httpUrl, isPackageName, makeOffering, npmInstall, repoFromUrl, skipTally,
  tarballInstall, tarballRepo, toUnixSeconds,
} from './offer.js'
import { parse } from './semver.js'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const RADAR_VERDICTS = new Set(['ok', 'incompatible', 'pending', 'untested'])
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const SHOP_KIND_RANK = { npm: 0, tarball: 1, git: 2 }

/**
 * Which reader a fetched document needs: 'format1' | 'shop-pointer' | 'shop-data' | 'npm-search', or null.
 * Shop documents are recognized by shape whatever their schemaVersion; readShop rejects versions it does not know.
 */
export function detectFormat(doc) {
  if (!isObject(doc)) return null
  if (doc.format === 1 && Array.isArray(doc.plugins)) return 'format1'
  if (typeof doc.schemaVersion === 'number') {
    if (Array.isArray(doc.plugins)) return 'shop-data'
    if (isObject(doc.plugins) && typeof doc.plugins.url === 'string') return 'shop-pointer'
  }
  if (Array.isArray(doc.objects) && (typeof doc.total === 'number' || doc.objects.some((o) => isObject(o?.package)))) {
    return 'npm-search'
  }
  return null
}

/** Strip the radar's trailing description markers (〔PR〕, 〔📦〕) and its `—` placeholder. */
function radarDescription(desc) {
  if (typeof desc !== 'string') return null
  let text = desc.trim()
  for (;;) {
    const next = text.replace(/\s*〔(?:PR|📦)〕\s*$/u, '')
    if (next === text) break
    text = next
  }
  if (!text || text === '—') return null
  return cleanText(text, DESCRIPTION_MAX)
}

/**
 * Offerings from a radar `dsh-radar/v1` plugins-all document: one per repo with a known verdict, installed from
 * the default branch (`github:owner/repo`, unpinned, not repairable). Name and title are the repo name part.
 * @throws TypeError('not a dsh-radar/v1 document')
 */
export function readRadarRepos(pluginsAll, { sourceId } = {}) {
  if (!isObject(pluginsAll) || pluginsAll.schema !== 'dsh-radar/v1' || !Array.isArray(pluginsAll.plugins)) {
    throw new TypeError('not a dsh-radar/v1 document')
  }
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const seen = new Set()
  pluginsAll.plugins.forEach((row, i) => {
    if (!isObject(row) || typeof row.repo !== 'string' || !REPO.test(row.repo)) {
      tally.count(SKIP.entry, `plugins[${i}]`)
      return
    }
    const key = row.repo.toLowerCase()
    if (seen.has(key)) {
      tally.count(SKIP.duplicate, `plugins[${i}] ${row.repo}`)
      return
    }
    if (!RADAR_VERDICTS.has(row.verdict)) {
      tally.count(SKIP.verdict, `plugins[${i}] ${row.repo}`)
      return
    }
    const name = row.repo.split('/')[1]
    if (!isPackageName(name, { caseInsensitive: true })) {
      tally.count(SKIP.name, `plugins[${i}] ${row.repo}`)
      return
    }
    const { install, error } = githubHeadInstall(row.repo)
    if (error) {
      tally.count(error, `plugins[${i}] ${row.repo}`)
      return
    }
    seen.add(key)
    offerings.push(makeOffering({
      sourceId,
      name,
      title: name,
      description: radarDescription(row.desc),
      repo: key,
      homepage: `https://github.com/${row.repo}`,
      install,
      stars: cleanCount(row.stars),
    }))
  })
  const { skipped, skippedBy } = tally.result()
  return { offerings, skipped, skippedBy }
}

/**
 * The data file a dsh-plugin-shop pointer names: `{ url, sha256 }`, the URL resolved against `pointerUrl`.
 * store.js must check the downloaded bytes against `sha256` before reading them.
 * @throws TypeError for a pointer that is not schemaVersion 5 or lacks a usable `plugins.url` / `plugins.sha256`.
 */
export function shopDataUrl(pointer, pointerUrl) {
  if (!isObject(pointer) || !isObject(pointer.plugins)) throw new TypeError('not a dsh-plugin-shop pointer')
  if (pointer.schemaVersion !== 5) throw new TypeError('unsupported dsh-plugin-shop schemaVersion')
  const { url, sha256 } = pointer.plugins
  if (typeof url !== 'string' || !url || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new TypeError('not a dsh-plugin-shop pointer')
  }
  let resolved
  try {
    resolved = new URL(url, pointerUrl)
  } catch {
    throw new TypeError('dsh-plugin-shop pointer url does not resolve')
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
    throw new TypeError('dsh-plugin-shop pointer url must be http(s)')
  }
  return { url: resolved.href, sha256 }
}

/** The semver a shop entry declares: manifestVersion, else `version` with a leading v; null for commits/tags. */
function shopVersion(p) {
  if (parse(p.manifestVersion)) return p.manifestVersion
  if (typeof p.version === 'string') {
    const v = p.version.replace(/^v/i, '')
    if (parse(v)) return v
  }
  return null
}

function shopEngines(p) {
  if (isObject(p.compatibility) && typeof p.compatibility.dsh === 'string' && p.compatibility.dsh.trim()) {
    return cleanEngines(p.compatibility.dsh)
  }
  return typeof p.engines === 'string' && p.engines.trim() ? cleanEngines(p.engines) : null
}

/**
 * One shop entry → `{ offering }` or `{ error }`.
 * npm → `name@version`; github + https tarball → the tarball URL; github without tarball → git spec at the commit
 * in `version` (40 lowercase hex) with `&path:/<subdir>`.
 * Identity follows what is installed: a git spec is built from `repo`, so `repo` (and `subdir`) is the identity;
 * a tarball has the identity of `repo` only when it is served from that GitHub repo (tarballRepo), else none. The
 * self-declared `repository` is used for npm entries only.
 */
function readShopEntry(p, sourceId) {
  if (!isObject(p)) return { error: SKIP.entry }
  const name = p.name
  let target
  let version = null
  let directory = null
  let repo = null
  if (p.source === 'npm') {
    if (!isPackageName(name)) return { error: SKIP.name }
    if (!parse(p.version)) return { error: SKIP.version }
    version = p.version
    target = npmInstall(name, p.version, p.registry)
  } else if (p.source === 'github') {
    if (!isPackageName(name, { caseInsensitive: true })) return { error: SKIP.name }
    if (typeof p.repo !== 'string' || !REPO.test(p.repo)) return { error: SKIP.source }
    if (p.subdir !== undefined && p.subdir !== null && p.subdir !== '') {
      directory = cleanDirectory(p.subdir)
      if (directory === null) return { error: SKIP.source }
    }
    version = shopVersion(p)
    if (isObject(p.tarball) && p.tarball.url !== undefined) {
      target = tarballInstall(p.tarball.url)
      if (tarballRepo(p.tarball.url) === p.repo.toLowerCase()) repo = p.repo.toLowerCase()
      else directory = null
    } else if (typeof p.version === 'string' && COMMIT.test(p.version)) {
      target = gitInstall(`https://github.com/${p.repo}.git`, p.version, directory)
      repo = p.repo.toLowerCase()
    } else {
      return { error: SKIP.source }
    }
  } else {
    return { error: SKIP.source }
  }
  if (target.error) return { error: target.error }
  const catalog = isObject(p.catalog) ? p.catalog : {}
  if (p.source === 'npm') {
    const fromRepo = repoFromUrl(p.repository)
    repo = fromRepo.repo ?? (typeof p.repo === 'string' && REPO.test(p.repo) ? p.repo.toLowerCase() : null)
    directory = fromRepo.directory
  }
  const labels = []
  if (typeof p.tier === 'string' && /^[a-z0-9-]{1,32}$/.test(p.tier)) labels.push(`${sourceId}:${p.tier}`)
  if (p.archived === true) labels.push(`${sourceId}:archived`)
  return {
    offering: makeOffering({
      sourceId,
      name,
      title: cleanText(catalog.title, TITLE_MAX),
      description: cleanText(catalog.summary, DESCRIPTION_MAX),
      category: cleanCategory(catalog.category),
      keywords: cleanKeywords(p.keywords),
      version,
      versionCount: version ? 1 : 0,
      publishedAt: toUnixSeconds(p.publishedAt, { minYear: 2020 }),
      engines: shopEngines(p),
      repo,
      directory,
      homepage: httpUrl(p.homepage),
      icon: cleanIcon(p.icon),
      install: target.install,
      stars: cleanCount(p.stars),
      labels,
    }),
  }
}

/**
 * Offerings from a dsh-plugin-shop data file (`{ schemaVersion: 5, plugins: [...] }`). Each shop entry names one
 * version, so there is no version choice; `hostVersion` is accepted for interface symmetry and not used.
 * @returns `{ offerings, skipped, skippedBy }`
 * @throws TypeError('unsupported dsh-plugin-shop schemaVersion') for another schemaVersion, and
 *   TypeError('not a dsh-plugin-shop data file') for other shapes.
 */
export function readShop(data, { sourceId } = {}) {
  if (!isObject(data) || !Array.isArray(data.plugins)) throw new TypeError('not a dsh-plugin-shop data file')
  if (data.schemaVersion !== 5) throw new TypeError('unsupported dsh-plugin-shop schemaVersion')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const byIdentity = new Map()
  data.plugins.forEach((p, i) => {
    const { offering, error } = readShopEntry(p, sourceId)
    if (error) {
      tally.count(error, `plugins[${i}]`)
      return
    }
    // The shop lists one package name from several repos (forks, monorepo moves) and the same repo both as an
    // npm package and as a GitHub commit. Keep one offering per name + repo + directory, preferring the
    // repairable npm install; different repos stay separate so merge.js can show them as conflicts.
    const identity = `${offering.name.toLowerCase()}|${offering.repo ?? ''}|${offering.directory ?? ''}`
    const at = byIdentity.get(identity)
    if (at === undefined) {
      byIdentity.set(identity, offerings.length)
      offerings.push(offering)
      return
    }
    tally.count(SKIP.duplicate, `plugins[${i}]`)
    if (SHOP_KIND_RANK[offering.install.kind] < SHOP_KIND_RANK[offerings[at].install.kind]) offerings[at] = offering
  })
  const { skipped, skippedBy } = tally.result()
  return { offerings, skipped, skippedBy }
}

/**
 * Page URLs of an npm registry search: `from` = 0, size, 2·size… while `from + size <= max`
 * (npm refuses deeper pages; the defaults give 21 pages, from 0 to 5000).
 */
export function npmSearchUrls({ text = 'keywords:dsh-plugin', size = 250, max = 5250 } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('text must be a non-empty string')
  if (!Number.isInteger(size) || size < 1 || size > 250) throw new TypeError('size must be an integer in 1..250')
  if (!Number.isInteger(max) || max < size) throw new TypeError('max must be an integer >= size')
  const urls = []
  for (let from = 0; from + size <= max; from += size) {
    urls.push(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${size}&from=${from}`)
  }
  return urls
}

/**
 * Offerings from npm search v1 responses (`{ objects: [{ package }] }`), deduped by name across pages
 * (the first page wins). Spec `name@version` on the public registry.
 * @param pages - one response or an array of responses; a page that is not a search response throws TypeError.
 * @returns `{ offerings, skipped, skippedBy }`
 */
export function readNpmSearch(pages, { sourceId } = {}) {
  const list = Array.isArray(pages) ? pages : [pages]
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const names = new Set()
  for (const page of list) {
    if (!isObject(page) || !Array.isArray(page.objects)) throw new TypeError('not an npm search response')
    for (const object of page.objects) {
      const pkg = isObject(object) ? object.package : undefined
      if (!isObject(pkg)) {
        tally.count(SKIP.entry)
        continue
      }
      const { name, version } = pkg
      if (!isPackageName(name)) {
        tally.count(SKIP.name)
        continue
      }
      if (names.has(name)) {
        tally.count(SKIP.duplicate)
        continue
      }
      if (!parse(version)) {
        tally.count(SKIP.version)
        continue
      }
      const target = npmInstall(name, version, null)
      if (target.error) {
        tally.count(target.error)
        continue
      }
      names.add(name)
      const links = isObject(pkg.links) ? pkg.links : {}
      const fromRepo = repoFromUrl(links.repository)
      offerings.push(makeOffering({
        sourceId,
        name,
        description: cleanText(pkg.description, DESCRIPTION_MAX),
        keywords: cleanKeywords(pkg.keywords),
        version,
        versionCount: 1,
        publishedAt: toUnixSeconds(pkg.date),
        repo: fromRepo.repo,
        directory: fromRepo.directory,
        homepage: httpUrl(links.homepage),
        install: target.install,
      }))
    }
  }
  const { skipped, skippedBy } = tally.result()
  return { offerings, skipped, skippedBy }
}
