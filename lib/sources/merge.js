/**
 * Merge offerings from many catalog sources into one list of catalog items, then
 * index and query that list (text search, filters, facets, sorting, paging).
 *
 * Why: the same plugin is offered by several indexes (awesome, community format-1
 * indexes, the radar's repo list, dsh-plugin-shop, npm search). The user should see
 * one card per plugin with every source's offer attached, conflicting packages that
 * share a name kept apart, and the radar verdict/stars overlaid by GitHub repo.
 * Queries must stay fast on ~60,000 items, so all per-item work (haystack, sort
 * orders, facet keys) happens once in buildIndex and a query is a single pass.
 *
 * Pure module: no I/O, never prints; bad arguments throw TypeError.
 */

import { createHash } from 'node:crypto'

const VERDICTS = new Set(['ok', 'incompatible', 'pending', 'untested'])
const RADAR_FILTERS = new Set(['ok', 'incompatible', 'pending', 'none'])
const SORTS = new Set(['stars', 'updated', 'name'])
const MAX_KEYWORDS = 20
const MAX_WORDS = 8
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1000

/**
 * Merge offerings from `sources` (PRIORITY order, index 0 = highest) into catalog items.
 *
 * - Identity: offerings are grouped by lowercase name; inside a name group they are
 *   clustered by GitHub repo. Offerings with a repo but no directory join the
 *   highest-priority cluster of the same repo; offerings that name different
 *   directories of the same repo stay apart. npm offerings with no repo join the cluster
 *   of the highest-priority offering that has one (or form their own); git/tarball
 *   offerings with no GitHub repo form one cluster per install location.
 *   One cluster → key `n:<name>`; several → `n:<name>#<repo>/<dir>` (`n:<name>#url:<hash>`
 *   for an install-location cluster) with `conflict: true`.
 * - Offerings with install.kind 'github-head' (the radar's repo list) are dropped when
 *   any other item has the same repo; otherwise they become `gh:<repo>` items.
 * - `radar` (Map 'owner/repo' → { verdict, stars }) overlays verdict and stars.
 *
 * @param {{ id: string, trust?: string, offerings: object[] }[]} sources
 * @param {{ radar?: Map<string, { verdict?: string, stars?: number }> | null, hostVersion?: string }} [options]
 * @returns {{ items: object[], bySource: Record<string, { offerings: number, items: number, skipped: number, dropped: number }>,
 *   conflicts: { name: string, keys: string[] }[] }}
 */
export function mergeCatalog(sources, { radar = null } = {}) {
  if (!Array.isArray(sources)) throw new TypeError('mergeCatalog: sources must be an array')
  if (radar != null && !(radar instanceof Map)) throw new TypeError('mergeCatalog: radar must be a Map or null')

  const bySource = Object.create(null)
  /** @type {Map<string, Entry[]>} lowercase name → entries in priority order */
  const groups = new Map()
  /** github-head entries by repo, priority order */
  const heads = new Map()
  let seq = 0
  sources.forEach((src, rank) => {
    if (!src || typeof src.id !== 'string' || !Array.isArray(src.offerings)) {
      throw new TypeError(`mergeCatalog: source ${rank} must be { id, offerings[] }`)
    }
    const stats = bySource[src.id] ??= { offerings: 0, items: 0, skipped: 0, dropped: 0 }
    const trust = src.trust ?? null
    for (const o of src.offerings) {
      if (!o || typeof o.name !== 'string' || !o.name || !o.install || typeof o.install.spec !== 'string') {
        stats.skipped++
        continue
      }
      stats.offerings++
      const e = { o, sourceId: src.id, trust, rank, seq: seq++ }
      if (o.install.kind === 'github-head') {
        if (!o.repo) { stats.skipped++; stats.offerings--; continue }
        pushTo(heads, o.repo, e)
      } else {
        pushTo(groups, o.name.toLowerCase(), e)
      }
    }
  })

  const items = []
  const conflicts = []
  const repoCount = new Map()
  for (const [lname, entries] of groups) {
    const clusters = clusterEntries(entries)
    if (clusters.length === 1) {
      items.push(buildItem(`n:${lname}`, clusters[0], false, radar))
    } else {
      const keys = []
      for (const c of clusters) {
        const key = c.url ? `n:${lname}#url:${shortHash(c.url)}` : `n:${lname}#${c.repo ?? ''}/${c.dir ?? ''}`
        keys.push(key)
        items.push(buildItem(key, c, true, radar))
      }
      conflicts.push({ name: lname, keys })
    }
  }
  for (const it of items) if (it.repo) repoCount.set(it.repo, (repoCount.get(it.repo) ?? 0) + 1)

  for (const [repo, entries] of heads) {
    if (repoCount.has(repo)) {
      for (const e of entries) bySource[e.sourceId].dropped++
      continue
    }
    items.push(buildItem(`gh:${repo}`, { repo, dir: null, entries }, false, radar))
    repoCount.set(repo, 1)
  }

  for (const it of items) {
    it.radarShared = it.repo ? repoCount.get(it.repo) : 0
    const seen = new Set()
    for (const off of it.offers) {
      if (seen.has(off.sourceId)) continue
      seen.add(off.sourceId)
      bySource[off.sourceId].items++
    }
  }
  return { items, bySource, conflicts }
}

/**
 * @typedef {{ o: object, sourceId: string, trust: string | null, rank: number, seq: number }} Entry
 * @typedef {{ repo: string | null, dir: string | null, entries: Entry[] }} Cluster
 */

function pushTo(map, key, value) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function normDir(d) {
  if (typeof d !== 'string') return null
  const t = d.replace(/^\/+|\/+$/g, '')
  return t ? t : null
}

/** Cluster one name group's entries (already in priority order). @returns {Cluster[]} */
function clusterEntries(entries) {
  if (entries.length === 1) {
    const o = entries[0].o
    return [{ repo: o.repo || null, dir: normDir(o.directory), entries }]
  }
  /** repo → { dirs: Map(lowerDir → Cluster), bare: Entry[] } in first-seen (= priority) order */
  const repos = new Map()
  const loose = []
  for (const e of entries) {
    const repo = e.o.repo || null
    if (!repo) { loose.push(e); continue }
    let r = repos.get(repo)
    if (!r) repos.set(repo, r = { dirs: new Map(), bare: [], first: e.seq })
    const dir = normDir(e.o.directory)
    if (dir == null) { r.bare.push(e); continue }
    const k = dir.toLowerCase()
    const c = r.dirs.get(k)
    if (c) c.entries.push(e)
    else r.dirs.set(k, { repo, dir, entries: [e], first: e.seq })
  }
  // Only repo-less npm offerings may join a repo cluster: they install the same registry package by name. A git or
  // tarball offering without a GitHub repo installs something else (another host), so it forms a cluster of its
  // own per install location, which then shows as a conflict instead of riding on another plugin's card.
  const looseNpm = []
  const byUrl = new Map()
  for (const e of loose) {
    if (e.o.install.kind === 'npm') { looseNpm.push(e); continue }
    const url = installLocation(e.o.install)
    const c = byUrl.get(url)
    if (c) c.entries.push(e)
    else byUrl.set(url, { repo: null, dir: null, url, entries: [e], first: e.seq })
  }
  const clusters = []
  for (const [repo, r] of repos) {
    if (r.dirs.size === 0) {
      clusters.push({ repo, dir: null, entries: r.bare, first: r.first })
      continue
    }
    const list = [...r.dirs.values()]
    if (r.bare.length) {
      // Directory-less offers of this repo join the cluster of the highest-priority directory offer.
      list.sort((a, b) => a.first - b.first)
      list[0].entries.push(...r.bare)
      list[0].first = Math.min(list[0].first, r.first)
    }
    clusters.push(...list)
  }
  clusters.sort((a, b) => a.first - b.first)
  if (looseNpm.length) {
    // The highest-priority offering with a repo is the earliest by seq: that cluster takes the loose npm ones.
    if (clusters.length) clusters[0].entries.push(...looseNpm)
    else clusters.push({ repo: null, dir: null, entries: looseNpm, first: looseNpm[0].seq })
  }
  clusters.push(...byUrl.values())
  return clusters.sort((a, b) => a.first - b.first)
}

/**
 * Where a repo-less git or tarball offering installs from, lowercase: the git URL plus `&path:/<dir>` without the
 * commit (versions of one location stay together), or the tarball URL.
 */
function installLocation(install) {
  const spec = String(install.spec)
  if (install.kind === 'git') {
    const m = /^([^#]*)#[^&]*(&path:.*)?$/.exec(spec)
    if (m) return `${m[1]}${m[2] ?? ''}`.toLowerCase()
  }
  return spec.toLowerCase()
}

/** A short stable id for a cluster key (keys stay short and safe to echo back in `/job/start`). */
function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** Build one catalog item from a cluster. Offers are ordered by source priority, ties by newer version. */
function buildItem(key, cluster, conflict, radar) {
  const entries = cluster.entries.length > 1 ? cluster.entries.slice().sort(compareEntries) : cluster.entries
  const top = entries[0].o
  let title = null, description = null, category = null, categorySource = null
  let homepage = null, icon = null, directory = cluster.dir, maxStars = null, updatedAt = null
  const keywords = []
  const kwSeen = new Set()
  const offers = new Array(entries.length)
  for (let i = 0; i < entries.length; i++) {
    const { o, sourceId, trust } = entries[i]
    if (title == null && hasText(o.title)) title = o.title
    if (description == null && hasText(o.description)) description = o.description
    if (category == null && typeof o.category === 'string' && o.category) { category = o.category; categorySource = sourceId }
    if (homepage == null && o.homepage) homepage = o.homepage
    if (icon == null && o.icon) icon = o.icon
    if (directory == null && o.directory) directory = normDir(o.directory)
    if (Number.isFinite(o.stars) && (maxStars == null || o.stars > maxStars)) maxStars = o.stars
    if (Number.isFinite(o.publishedAt) && (updatedAt == null || o.publishedAt > updatedAt)) updatedAt = o.publishedAt
    if (Array.isArray(o.keywords)) {
      for (const k of o.keywords) {
        if (typeof k !== 'string' || kwSeen.has(k) || keywords.length >= MAX_KEYWORDS) continue
        kwSeen.add(k)
        keywords.push(k)
      }
    }
    offers[i] = {
      sourceId,
      trust,
      version: o.version ?? null,
      publishedAt: Number.isFinite(o.publishedAt) ? o.publishedAt : null,
      engines: o.engines ?? null,
      install: o.install,
    }
  }
  const repo = cluster.repo ?? null
  const r = repo && radar ? radar.get(repo) : undefined
  const verdict = r && VERDICTS.has(r.verdict) ? r.verdict : null
  const stars = r && Number.isFinite(r.stars) ? r.stars : maxStars
  return {
    key,
    name: top.name,
    title: title ?? null,
    description: description ?? null,
    category,
    categorySource,
    keywords,
    repo,
    directory: directory ?? null,
    homepage,
    icon,
    stars,
    radar: verdict,
    radarShared: 0,
    updatedAt,
    offers,
    chosen: 0,
    conflict,
  }
}

function compareEntries(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank
  const v = compareVersions(b.o.version, a.o.version)
  return v !== 0 ? v : a.seq - b.seq
}

function hasText(v) {
  if (typeof v === 'string') return v.trim() !== ''
  if (v && typeof v === 'object') {
    for (const k in v) if (typeof v[k] === 'string' && v[k].trim() !== '') return true
  }
  return false
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Compare two version strings by semver precedence (only used to break ties between
 * offers of one source). Invalid or missing versions sort below valid ones.
 */
export function compareVersions(a, b) {
  const pa = typeof a === 'string' ? SEMVER.exec(a.trim()) : null
  const pb = typeof b === 'string' ? SEMVER.exec(b.trim()) : null
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d) return d > 0 ? 1 : -1
  }
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0
  const xa = pa[4].split('.'), xb = pb[4].split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1
    if (xb[i] === undefined) return 1
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i])
    if (na && nb) {
      const d = Number(xa[i]) - Number(xb[i])
      if (d) return d > 0 ? 1 : -1
    } else if (na !== nb) {
      return na ? -1 : 1
    } else if (xa[i] !== xb[i]) {
      return xa[i] < xb[i] ? -1 : 1
    }
  }
  return 0
}

/**
 * Precompute everything a query needs, once per merge: one lowercase haystack per item
 * (name, title and description values, category, repo, directory, every offer spec,
 * keywords), per-item source ids and radar bucket, and the three sort orders.
 *
 * @param {object[]} items  items from mergeCatalog
 */
export function buildIndex(items) {
  if (!Array.isArray(items)) throw new TypeError('buildIndex: items must be an array')
  const n = items.length
  const hay = new Array(n)
  const srcIds = []
  const srcNum = new Map()
  const itemSrc = new Array(n)
  const bucket = new Uint8Array(n) // 0 ok, 1 incompatible, 2 pending/untested, 3 none
  const lname = new Array(n)
  for (let i = 0; i < n; i++) {
    const it = items[i]
    const parts = [it.name]
    addText(parts, it.title)
    addText(parts, it.description)
    if (it.category) parts.push(it.category)
    if (it.repo) parts.push(it.repo)
    if (it.directory) parts.push(it.directory)
    const ids = []
    for (const off of it.offers) {
      if (off.install && off.install.spec) parts.push(off.install.spec)
      let s = srcNum.get(off.sourceId)
      if (s === undefined) { s = srcIds.length; srcIds.push(off.sourceId); srcNum.set(off.sourceId, s) }
      if (!ids.includes(s)) ids.push(s)
    }
    if (it.keywords && it.keywords.length) parts.push(it.keywords.join(' '))
    hay[i] = parts.join('\n').toLowerCase()
    itemSrc[i] = ids
    bucket[i] = it.radar === 'ok' ? 0 : it.radar === 'incompatible' ? 1 : it.radar ? 2 : 3
    lname[i] = String(it.name).toLowerCase()
  }
  const byName = Array.from({ length: n }, (_, i) => i)
  const nameCmp = (a, b) => (lname[a] < lname[b] ? -1 : lname[a] > lname[b] ? 1 : a - b)
  byName.sort(nameCmp)
  const nameRank = new Uint32Array(n)
  for (let r = 0; r < n; r++) nameRank[byName[r]] = r
  const descNullLast = (field) => {
    const vals = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const v = items[i][field]
      vals[i] = Number.isFinite(v) ? v : -Infinity
    }
    const order = Array.from({ length: n }, (_, i) => i)
    order.sort((a, b) => {
      const va = vals[a], vb = vals[b]
      if (va !== vb) return va > vb ? -1 : 1
      return nameRank[a] - nameRank[b]
    })
    return Uint32Array.from(order)
  }
  return {
    items,
    hay,
    srcIds,
    itemSrc,
    bucket,
    order: { name: Uint32Array.from(byName), stars: descNullLast('stars'), updated: descNullLast('updatedAt') },
  }
}

function addText(parts, v) {
  if (typeof v === 'string') { if (v) parts.push(v); return }
  if (v && typeof v === 'object') for (const k in v) if (typeof v[k] === 'string' && v[k]) parts.push(v[k])
}

const BUCKET_NAMES = ['ok', 'incompatible', 'pending', 'none']

function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * Query an index built by buildIndex.
 *
 * - `q`: words (whitespace separated, case-insensitive), every word must be a substring of the haystack.
 * - `sources`: source ids; an item matches if any of its offers comes from one of them.
 * - `category`: exact item category id. `radar`: 'ok' | 'incompatible' | 'pending' (incl. untested) | 'none'.
 * - `predicate(item)`: optional extra filter, applied to the result and to every facet.
 * - `sort`: 'stars' (default) | 'updated' | 'name'; nulls last, ties by name.
 * - Facets count over the query result with every filter EXCEPT the facet's own.
 *
 * @returns {{ total: number, items: object[], offset: number, limit: number,
 *   facets: { sources: Record<string, number>, categories: Record<string, number>, radar: Record<string, number> } }}
 */
export function queryCatalog(index, { q = '', sources, category, radar, sort = 'stars', offset = 0, limit = DEFAULT_LIMIT, predicate } = {}) {
  if (!index || !Array.isArray(index.hay) || !index.order) throw new TypeError('queryCatalog: index must come from buildIndex')
  if (typeof q !== 'string') throw new TypeError('queryCatalog: q must be a string')
  if (!SORTS.has(sort)) throw new TypeError(`queryCatalog: unknown sort '${sort}'`)
  if (radar != null && !RADAR_FILTERS.has(radar)) throw new TypeError(`queryCatalog: unknown radar filter '${radar}'`)
  if (sources != null && !Array.isArray(sources)) throw new TypeError('queryCatalog: sources must be an array of ids')
  if (category != null && typeof category !== 'string') throw new TypeError('queryCatalog: category must be a string')
  if (predicate != null && typeof predicate !== 'function') throw new TypeError('queryCatalog: predicate must be a function')
  offset = Number.isInteger(offset) && offset > 0 ? offset : 0
  limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT

  const { items, hay, srcIds, itemSrc, bucket } = index
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS)
  const nWords = words.length
  // Source filter as a per-source-number mask; unknown ids simply match nothing.
  let srcMask = null
  if (sources) {
    srcMask = new Uint8Array(srcIds.length)
    for (const id of sources) {
      const s = srcIds.indexOf(id)
      if (s >= 0) srcMask[s] = 1
    }
  }
  const radarBucket = radar == null ? -1 : BUCKET_NAMES.indexOf(radar)
  const order = index.order[sort]

  const srcCount = new Uint32Array(srcIds.length)
  const catCount = new Map()
  const radarCount = [0, 0, 0, 0]
  const hits = []

  outer: for (let r = 0; r < order.length; r++) {
    const i = order[r]
    if (nWords) {
      const h = hay[i]
      for (let w = 0; w < nWords; w++) if (!h.includes(words[w])) continue outer
    }
    const ids = itemSrc[i]
    let okS = true
    if (srcMask) {
      okS = false
      for (let k = 0; k < ids.length; k++) if (srcMask[ids[k]]) { okS = true; break }
    }
    const it = items[i]
    const okC = category == null || it.category === category
    const okR = radarBucket < 0 || bucket[i] === radarBucket
    // At most one filter may fail for the item to count in some facet.
    const fails = (okS ? 0 : 1) + (okC ? 0 : 1) + (okR ? 0 : 1)
    if (fails > 1) continue
    if (predicate && !predicate(it)) continue
    if (okC && okR) for (let k = 0; k < ids.length; k++) srcCount[ids[k]]++
    if (okS && okR && it.category) catCount.set(it.category, (catCount.get(it.category) ?? 0) + 1)
    if (okS && okC) radarCount[bucket[i]]++
    if (fails === 0) hits.push(i)
  }

  const facets = { sources: {}, categories: {}, radar: {} }
  // Ids come from catalogs: define them as own properties so an id like '__proto__' is counted, not swallowed.
  for (let s = 0; s < srcIds.length; s++) if (srcCount[s]) setOwn(facets.sources, srcIds[s], srcCount[s])
  for (const [c, n] of catCount) setOwn(facets.categories, c, n)
  for (let b = 0; b < 4; b++) facets.radar[BUCKET_NAMES[b]] = radarCount[b]
  const page = hits.slice(offset, offset + limit).map((i) => items[i])
  return { total: hits.length, items: page, offset, limit, facets }
}
