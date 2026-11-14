/**
 * The catalog source store: which sources exist (built-in defaults merged with `<dataDir>/sources.json`), how a
 * source's document is fetched (size cap, timeout that covers the body, ETag revalidation, redirect policy), and how
 * a source is loaded into Offerings with an on-disk cache that keeps serving stale data when a source is down.
 *
 * Why: the catalog now reads many indexes, some 30 MB and some run by strangers. A slow or hostile source must not
 * hang the Host, fill memory or break the catalog, and a source that is down must not empty it. So fetches are
 * bounded, every outcome of `loadSource` is data (it never throws), and user-added indexes never follow redirects.
 *
 * Timestamps in `meta` are milliseconds since the epoch (the `now` seam), unlike Offering.publishedAt (seconds).
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile as fsReadFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { RADAR_SOURCES, radarMap } from '../radar.js'
import { detectFormat, npmSearchUrls, readNpmSearch, readRadarRepos, readShop, shopDataUrl } from './adapters.js'
import { readFormat1 } from './format1.js'
import { enginesAdmit } from './offer.js'

export const AWESOME_SOURCES = [
  'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json',
  'https://awesome-dsh-plugin.com/index.json',
]

/**
 * Built-in sources. Users may change `enabled`, `priority`, and `trust` where trust is not 'builtin'.
 * Browse-only sources start disabled: the client has no control yet to mark a source trusted, so their cards could
 * only answer 409, and an older client would not send the source id the trust gate needs.
 */
export const DEFAULT_SOURCES = Object.freeze([
  { id: 'awesome', kind: 'builtin-index', title: { zh: 'awesome 索引', en: 'awesome index' }, urls: AWESOME_SOURCES, enabled: true, trust: 'builtin', priority: 10 },
  { id: 'radar', kind: 'radar-overlay', title: { zh: '插件雷达', en: 'Plugin radar' }, urls: RADAR_SOURCES, enabled: true, trust: 'builtin', priority: 0 },
  { id: 'radar-repos', kind: 'radar-repos', title: { zh: '雷达收录的仓库', en: 'Radar repositories' }, urls: RADAR_SOURCES, enabled: false, trust: 'browse', priority: 90 },
  { id: 'npm', kind: 'npm-search', title: { zh: 'npm 搜索（实验）', en: 'npm search (experimental)' }, enabled: false, trust: 'browse', priority: 95 },
].map((s) => Object.freeze({ ...s, urls: s.urls ? Object.freeze([...s.urls]) : undefined })))

export const SOURCE_KINDS = ['builtin-index', 'radar-overlay', 'radar-repos', 'npm-search', 'host-market', 'user-index']
const SETTABLE_TRUST = new Set(['browse', 'trusted'])
const FIXED_TRUST = new Set(['builtin', 'host'])
const PRIORITY_HOST = 20
const PRIORITY_USER = 30
const PRIORITY_MAX = 1000
const URL_MAX = 2000
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const CONFIG_FILE = 'sources.json'
const CACHE_DIR = 'sources-cache'
// 2: offerings read with the identity and registry rules of the review fixes (a v1 cache could be revalidated by
// ETag forever and keep serving offerings the readers no longer produce).
const CACHE_V = 2

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function codedError(Kind, code, message, extra) {
  const err = new Kind(message)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

/* ------------------------------------------------------------------ config */

/**
 * A URL as compared for duplicates: parsed href without fragment, default port, or trailing slash on the path.
 * Returns `{ href }`, or `{ code }` ('scheme' | 'invalid') for a URL a source may not have.
 */
export function normalizeSourceUrl(url) {
  if (typeof url !== 'string' || !url.trim() || url.length > URL_MAX) return { code: 'invalid' }
  let u
  try {
    u = new URL(url.trim())
  } catch {
    return { code: /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) && !/^https?:/i.test(url.trim()) ? 'scheme' : 'invalid' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { code: 'scheme' }
  if (u.username || u.password) return { code: 'invalid' }
  u.hash = ''
  const href = u.href
  return { href, key: href.replace(/\/+(?=$|\?)/, '') }
}

/** Stable source id for a URL: `<prefix>-<10 hex of sha256(normalized url)>`. */
function idFor(prefix, href) {
  return `${prefix}-${createHash('sha256').update(href).digest('hex').slice(0, 10)}`
}

/**
 * Sources for the host market's configured format-1 index URLs (pluginMarket.listIndexes()): kind 'host-market',
 * trust 'host', priority 20 + position. Invalid URLs are left out.
 */
export function hostMarketSources(urls) {
  const out = []
  const seen = new Set()
  for (const url of Array.isArray(urls) ? urls : []) {
    const n = normalizeSourceUrl(url)
    if (!n.href || seen.has(n.key)) continue
    seen.add(n.key)
    out.push({ id: idFor('host', n.key), kind: 'host-market', title: null, urls: [n.href], enabled: true, trust: 'host', priority: PRIORITY_HOST + out.length })
  }
  return out
}

function sortSources(list) {
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.priority - b.s.priority || a.i - b.i)
    .map((x) => x.s)
}

function validPriority(p) {
  return Number.isInteger(p) && p >= 0 && p <= PRIORITY_MAX
}

function cleanTitle(title) {
  if (typeof title === 'string') return title.trim() ? title.trim().slice(0, 200) : undefined
  if (!isObject(title)) return undefined
  const out = {}
  for (const [k, v] of Object.entries(title)) {
    if (/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(k) && typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 200)
  }
  return Object.keys(out).length ? out : undefined
}

/** User-settable fields of one stored entry, invalid ones dropped. */
function userFields(entry, base) {
  const out = {}
  if (typeof entry.enabled === 'boolean') out.enabled = entry.enabled
  if (validPriority(entry.priority)) out.priority = entry.priority
  if (!FIXED_TRUST.has(base.trust) && SETTABLE_TRUST.has(entry.trust)) {
    out.trust = entry.trust
    if (entry.trust === 'trusted' && Number.isFinite(entry.trustedAt)) out.trustedAt = entry.trustedAt
  }
  return out
}

/**
 * The effective source list, sorted by priority (ascending, ties in default order): DEFAULT_SOURCES, then
 * `hostMarkets` (index URLs from the host, see hostMarketSources), each with the user's stored overrides, then the
 * user's own indexes. A missing, unreadable or malformed `<dataDir>/sources.json` gives the defaults; malformed
 * entries are dropped one by one. Never throws.
 * @param options.readFile - seam, `(path, 'utf8') → Promise<string>`.
 * @param options.hostMarkets - index URLs from the host market service, if any.
 */
export async function loadSourceConfig(dataDir, { readFile = fsReadFile, hostMarkets = [] } = {}) {
  let stored = {}
  try {
    const doc = JSON.parse(await readFile(path.join(dataDir, CONFIG_FILE), 'utf8'))
    if (isObject(doc)) stored = doc
  } catch { /* missing or garbage → defaults */ }
  const overrides = isObject(stored.overrides) ? stored.overrides : {}
  const base = [...DEFAULT_SOURCES.map((s) => ({ ...s, urls: s.urls ? [...s.urls] : undefined })), ...hostMarketSources(hostMarkets)]
  const out = base.map((s) => {
    const o = Object.hasOwn(overrides, s.id) && isObject(overrides[s.id]) ? userFields(overrides[s.id], s) : {}
    return { ...s, ...o }
  })
  const taken = new Set(out.flatMap((s) => (s.urls ?? []).map((u) => normalizeSourceUrl(u).key)))
  const ids = new Set(out.map((s) => s.id))
  let nextPriority = PRIORITY_USER
  for (const entry of Array.isArray(stored.user) ? stored.user : []) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !ID.test(entry.id) || ids.has(entry.id)) continue
    const n = normalizeSourceUrl(entry.url)
    if (!n.href || taken.has(n.key)) continue
    const fields = userFields(entry, { trust: 'browse' })
    const source = {
      id: entry.id,
      kind: 'user-index',
      title: cleanTitle(entry.title) ?? null,
      url: n.href,
      urls: [n.href],
      enabled: true,
      trust: 'browse',
      priority: nextPriority,
      ...fields,
    }
    nextPriority = Math.max(nextPriority, source.priority) + 1
    taken.add(n.key)
    ids.add(entry.id)
    out.push(source)
  }
  return sortSources(out)
}

/**
 * Persist the user's part of `sources` to `<dataDir>/sources.json` (written to a temp file, then renamed):
 * overrides (enabled, priority, trust, trustedAt) for built-in and host sources, whole entries for user indexes.
 */
export async function saveSourceConfig(dataDir, sources) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array')
  const overrides = {}
  const user = []
  for (const s of sources) {
    if (!isObject(s) || typeof s.id !== 'string') continue
    if (s.kind === 'user-index') {
      const entry = { id: s.id, url: s.url ?? s.urls?.[0], enabled: s.enabled !== false, trust: s.trust, priority: s.priority }
      if (s.title) entry.title = s.title
      if (s.trustedAt !== undefined) entry.trustedAt = s.trustedAt
      user.push(entry)
      continue
    }
    const o = { enabled: s.enabled !== false, priority: s.priority }
    if (!FIXED_TRUST.has(s.trust)) o.trust = s.trust
    if (s.trustedAt !== undefined) o.trustedAt = s.trustedAt
    overrides[s.id] = o
  }
  await mkdir(dataDir, { recursive: true })
  await writeAtomic(path.join(dataDir, CONFIG_FILE), `${JSON.stringify({ v: 1, overrides, user }, null, 2)}\n`)
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, text)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

const invalid = (message) => codedError(TypeError, 'invalid', message)

/**
 * Apply one user change to a source list and return the new list (sorted by priority); `sources` is not modified.
 * - `{ id, enabled?, trust?, priority? }`: trust ∈ browse|trusted, not on a 'builtin'/'host' source; setting
 *   'trusted' stamps `trustedAt` (options.now), leaving it clears it; priority is an integer 0..1000.
 * - `{ add: { url, trust?, title? } }`: a user index, http(s), ≤ 2000 chars, no credentials, not the URL of any
 *   existing source (compared normalized). Gets id `user-<hash>` and priority 30 + n (after the other user indexes).
 * - `{ remove: id }`: user indexes only.
 * @throws TypeError with `.code` 'scheme' | 'duplicate' | 'invalid' | 'not-found' | 'not-removable'.
 */
export function applySourceChange(sources, change, { now = Date.now } = {}) {
  if (!Array.isArray(sources)) throw invalid('sources must be an array')
  if (!isObject(change)) throw invalid('change must be an object')
  const list = sources.map((s) => ({ ...s }))
  const at = typeof now === 'function' ? now() : now

  if (Object.hasOwn(change, 'add')) {
    const add = change.add
    if (!isObject(add)) throw invalid('add must be an object')
    const n = normalizeSourceUrl(add.url)
    if (!n.href) throw codedError(TypeError, n.code, n.code === 'scheme' ? 'url must be http(s)' : 'url is not a usable URL')
    const taken = new Set(list.flatMap((s) => [s.url, ...(s.urls ?? [])].filter(Boolean).map((u) => normalizeSourceUrl(u).key)))
    if (taken.has(n.key)) throw codedError(TypeError, 'duplicate', 'this index is already a source')
    const trust = add.trust ?? 'browse'
    if (!SETTABLE_TRUST.has(trust)) throw invalid('trust must be browse or trusted')
    if (add.title !== undefined && add.title !== null && cleanTitle(add.title) === undefined) throw invalid('title must be a string or a locale map')
    const id = idFor('user', n.key)
    if (list.some((s) => s.id === id)) throw codedError(TypeError, 'duplicate', 'this index is already a source')
    const users = list.filter((s) => s.kind === 'user-index')
    const priority = users.length ? Math.max(PRIORITY_USER - 1, ...users.map((s) => s.priority)) + 1 : PRIORITY_USER
    const source = { id, kind: 'user-index', title: cleanTitle(add.title) ?? null, url: n.href, urls: [n.href], enabled: true, trust, priority: Math.min(priority, PRIORITY_MAX) }
    if (trust === 'trusted') source.trustedAt = at
    return { sources: sortSources([...list, source]) }
  }

  if (Object.hasOwn(change, 'remove')) {
    const i = list.findIndex((s) => s.id === change.remove)
    if (i < 0) throw codedError(TypeError, 'not-found', `no source ${String(change.remove)}`)
    if (list[i].kind !== 'user-index') throw codedError(TypeError, 'not-removable', 'only user-added indexes can be removed')
    list.splice(i, 1)
    return { sources: list }
  }

  if (typeof change.id !== 'string') throw invalid('change needs id, add or remove')
  const s = list.find((x) => x.id === change.id)
  if (!s) throw codedError(TypeError, 'not-found', `no source ${change.id}`)
  const known = new Set(['id', 'enabled', 'trust', 'priority'])
  if (Object.keys(change).some((k) => !known.has(k))) throw invalid('unknown field in change')
  if (change.enabled !== undefined) {
    if (typeof change.enabled !== 'boolean') throw invalid('enabled must be a boolean')
    s.enabled = change.enabled
  }
  if (change.priority !== undefined) {
    if (!validPriority(change.priority)) throw invalid(`priority must be an integer 0..${PRIORITY_MAX}`)
    s.priority = change.priority
  }
  if (change.trust !== undefined) {
    if (FIXED_TRUST.has(s.trust)) throw invalid(`the trust of ${s.id} is fixed`)
    if (!SETTABLE_TRUST.has(change.trust)) throw invalid('trust must be browse or trusted')
    if (change.trust === 'trusted' && s.trust !== 'trusted') s.trustedAt = at
    if (change.trust !== 'trusted') delete s.trustedAt
    s.trust = change.trust
  }
  return { sources: sortSources(list) }
}

/* ------------------------------------------------------------------ fetch */

/**
 * GET a JSON document with hard limits.
 * - `timeoutMs` covers connecting, headers and the whole body; `maxBytes` caps the (decoded) body, checked against
 *   Content-Length first and then while streaming.
 * - `etag` sends If-None-Match; a 304 answers `{ status: 304, etag, bytes: 0 }` without a value.
 * - `redirect: 'error'` refuses any 3xx (implemented with fetch's 'manual' mode so the refusal is a clean code).
 * @returns `{ status: 200, value, etag, bytes, sha256, url }` (url = the final URL after redirects) or the 304 form.
 * @throws Error with `.code` ∈ timeout|connect|redirect|http|not-json|too-large (`.status` for http).
 */
export async function fetchJson(url, { fetch = globalThis.fetch, timeoutMs = 20000, maxBytes = 128 * 2 ** 20, redirect = 'follow', etag } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const fail = (code, message, extra) => codedError(Error, code, `${url}: ${message}`, { url, ...extra })
  try {
    const headers = { accept: 'application/json' }
    if (etag) headers['if-none-match'] = etag
    let res
    try {
      res = await fetch(url, { signal: controller.signal, redirect: redirect === 'error' ? 'manual' : redirect, headers })
    } catch (err) {
      if (timedOut) throw fail('timeout', `no answer within ${timeoutMs} ms`)
      if (redirect !== 'error' && /redirect/i.test(`${err?.message} ${err?.cause?.message}`)) throw fail('redirect', 'too many or bad redirects')
      throw fail('connect', err?.cause?.code ?? err?.cause?.message ?? err?.message ?? 'fetch failed')
    }
    const resEtag = res.headers.get('etag')
    if (res.status === 304 && etag) {
      await res.body?.cancel().catch(() => {})
      return { status: 304, etag: resEtag ?? etag, bytes: 0, url: res.url || url }
    }
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {})
      throw fail('http', 'HTTP 304 without a cached ETag', { status: 304 })
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {})
      throw fail('redirect', `refused a redirect (HTTP ${res.status})`, { status: res.status })
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw fail('http', `HTTP ${res.status}`, { status: res.status })
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {})
      throw fail('too-large', `body of ${declared} bytes exceeds ${maxBytes}`)
    }
    const hash = createHash('sha256')
    const chunks = []
    let bytes = 0
    try {
      if (res.body) {
        for await (const chunk of res.body) {
          bytes += chunk.byteLength
          if (bytes > maxBytes) {
            controller.abort()
            throw fail('too-large', `body exceeds ${maxBytes} bytes`)
          }
          hash.update(chunk)
          chunks.push(chunk)
        }
      }
    } catch (err) {
      if (err?.code === 'too-large') throw err
      if (timedOut) throw fail('timeout', `body not complete within ${timeoutMs} ms`)
      throw fail('connect', `body interrupted: ${err?.cause?.code ?? err?.message ?? err}`)
    }
    if (timedOut) throw fail('timeout', `body not complete within ${timeoutMs} ms`)
    let value
    try {
      let text = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      value = JSON.parse(text)
    } catch {
      throw fail('not-json', 'body is not JSON')
    }
    return { status: 200, value, etag: resEtag, bytes, sha256: hash.digest('hex'), url: res.url || url }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ cache */

function cacheFile(dataDir, id) {
  if (!dataDir || typeof id !== 'string' || !ID.test(id)) return null
  return path.join(dataDir, CACHE_DIR, `${id}.json`)
}

/** A radar cache entry as `new Map(entries)` needs it: `[ 'owner/repo', { verdict, … } ]`. */
const isRadarEntry = (e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && isObject(e[1])

/**
 * The cache document of source `id`, or null when it is missing or fails validation (then no ETag is sent either,
 * so a damaged cache is replaced by a full download instead of being revalidated forever with 304s).
 */
async function readCache(dataDir, id, field) {
  const file = cacheFile(dataDir, id)
  if (!file) return null
  try {
    const doc = JSON.parse(await fsReadFile(file, 'utf8'))
    if (!isObject(doc) || doc.v !== CACHE_V || !isObject(doc.meta) || !Array.isArray(doc[field])) return null
    if (field === 'radar' && !doc.radar.every(isRadarEntry)) return null
    if (field === 'offerings' && !doc.offerings.every(isObject)) return null
    return doc
  } catch {
    return null
  }
}

/** Write the cache; a failure only costs the next start its stale fallback, so it is reported, not thrown. */
async function writeCache(dataDir, id, doc) {
  const file = cacheFile(dataDir, id)
  if (!file) return null
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeAtomic(file, JSON.stringify({ v: CACHE_V, ...doc }))
    return null
  } catch (err) {
    return `cache not written: ${err?.message ?? err}`
  }
}

function errorData(err) {
  const out = { code: typeof err?.code === 'string' ? err.code : 'error', message: String(err?.message ?? err).slice(0, 500) }
  if (Number.isInteger(err?.status)) out.status = err.status
  return out
}

/* ------------------------------------------------------------------ load */

const formatError = (message) => codedError(Error, 'format', message)

/** Read a fetched document of an index-like source (format 1, dsh-plugin-shop pointer/data, npm search page). */
async function readIndexDocument(got, { source, hostVersion, fetchOpts, cached }) {
  const sourceId = source.id
  const format = detectFormat(got.value)
  try {
    if (format === 'format1') {
      const r = readFormat1(got.value, { sourceId, indexUrl: got.url, hostVersion })
      return { format, offerings: r.offerings, skipped: r.skipped, title: r.title, description: r.description, categories: r.categories, bytes: got.bytes }
    }
    if (format === 'shop-data') {
      const r = readShop(got.value, { sourceId, hostVersion })
      return { format, offerings: r.offerings, skipped: r.skipped, bytes: got.bytes }
    }
    if (format === 'npm-search') {
      const r = readNpmSearch(got.value, { sourceId })
      return { format, offerings: r.offerings, skipped: r.skipped, bytes: got.bytes }
    }
    if (format === 'shop-pointer') {
      const { url, sha256 } = shopDataUrl(got.value, got.url)
      if (cached && cached.meta.dataSha256 === sha256 && cached.meta.hostVersion === (hostVersion ?? null)) {
        return { format, reused: true, dataSha256: sha256, bytes: got.bytes }
      }
      const data = await fetchJson(url, fetchOpts)
      if (data.sha256 !== sha256) {
        throw codedError(Error, 'integrity', `${url}: sha256 ${data.sha256} does not match the pointer's ${sha256}`)
      }
      const r = readShop(data.value, { sourceId, hostVersion })
      return { format, offerings: r.offerings, skipped: r.skipped, dataSha256: sha256, bytes: got.bytes + data.bytes }
    }
  } catch (err) {
    if (err instanceof TypeError && !err.code) throw formatError(err.message)
    throw err
  }
  throw formatError('not a format-1 index, dsh-plugin-shop file or npm search response')
}

/** Fetch options a source gets: user indexes refuse redirects. */
function fetchOptionsFor(source, { fetch, timeoutMs, maxBytes }) {
  const opts = { fetch, redirect: source.kind === 'user-index' ? 'error' : 'follow' }
  if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs
  if (maxBytes !== undefined) opts.maxBytes = maxBytes
  return opts
}

function urlsOf(source) {
  const urls = Array.isArray(source.urls) && source.urls.length ? source.urls : source.url ? [source.url] : []
  return urls.filter((u) => typeof u === 'string' && u)
}

/**
 * Try each URL of `source` in order; `read(got, url)` turns a 200 into a result. A 304 (sent only for the URL the
 * cache came from, and only while the cache was built for the same hostVersion) answers `{ notModified }`.
 */
async function firstThatLoads(source, cached, hostVersion, fetchOpts, read) {
  const urls = urlsOf(source)
  if (!urls.length) throw codedError(Error, 'invalid', `source ${source.id} has no URL`)
  let lastError
  for (const url of urls) {
    try {
      const etag = cached && cached.meta.url === url && cached.meta.hostVersion === (hostVersion ?? null) ? cached.meta.etag : undefined
      const got = await fetchJson(url, { ...fetchOpts, etag: etag ?? undefined })
      if (got.status === 304) return { url, etag: got.etag, notModified: true }
      return { url, etag: got.etag, ...(await read(got)) }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

/** Fetch every npm search page (with `delay` between pages) until a page adds no new names. */
async function loadNpmPages(source, { fetchOpts, delay, delayMs }) {
  const search = isObject(source.search) ? source.search : {}
  const urls = npmSearchUrls(search)
  const pages = []
  const names = new Set()
  let partial = null
  for (const [i, url] of urls.entries()) {
    if (i > 0) await delay(delayMs)
    let got
    try {
      got = await fetchJson(url, fetchOpts)
    } catch (err) {
      if (!pages.length) throw err
      partial = `stopped after ${pages.length} pages: ${err.message}`
      break
    }
    if (detectFormat(got.value) !== 'npm-search') {
      if (!pages.length) throw formatError(`${url}: not an npm search response`)
      partial = `stopped after ${pages.length} pages: page ${i + 1} is not a search response`
      break
    }
    const before = names.size
    for (const o of got.value.objects) if (typeof o?.package?.name === 'string') names.add(o.package.name)
    pages.push(got.value)
    if (names.size === before) break
  }
  const r = readNpmSearch(pages, { sourceId: source.id })
  return { format: 'npm-search', offerings: r.offerings, skipped: r.skipped, pages: pages.length, warning: partial, url: urls[0] }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Load one source into Offerings, through the cache `<dataDir>/sources-cache/<id>.json` = `{ v: 2, meta, offerings }`.
 * Never throws: a failure answers the cached offerings with state 'stale' (or `[]` with state 'failed') and
 * `meta.error = { code, message, status? }`. Kind 'radar-overlay' is delegated to loadRadar (`{ radar, meta }`).
 *
 * @param options.fetch, options.timeoutMs, options.maxBytes - passed to fetchJson.
 * @param options.hostVersion - running DSH version for the version choice (a cache built for another one is not
 *   revalidated with its ETag).
 * @param options.now - clock seam, `() → ms`.
 * @param options.delay, options.delayMs - npm search paging seam (default 300 ms between pages).
 * @returns `{ offerings, meta: { fetchedAt, okAt, count, skipped, etag, url, format, title, description,
 *   categories, state, error? } }`
 */
export async function loadSource(source, { dataDir, fetch = globalThis.fetch, hostVersion, now = Date.now, timeoutMs, maxBytes, delay = sleep, delayMs = 300 } = {}) {
  if (source?.kind === 'radar-overlay') return loadRadar(source, { dataDir, fetch, now, timeoutMs, maxBytes })
  const fetchedAt = now()
  const id = source?.id
  const cached = await readCache(dataDir, id, 'offerings')
  try {
    if (!isObject(source) || typeof id !== 'string' || !id) throw codedError(Error, 'invalid', 'source must have an id')
    if (!SOURCE_KINDS.includes(source.kind)) throw codedError(Error, 'invalid', `unknown source kind ${source.kind}`)
    const fetchOpts = fetchOptionsFor(source, { fetch, timeoutMs, maxBytes })
    let got
    if (source.kind === 'npm-search') {
      got = await loadNpmPages(source, { fetchOpts, delay, delayMs })
    } else if (source.kind === 'radar-repos') {
      got = await firstThatLoads(source, cached, hostVersion, fetchOpts, async (res) => {
        try {
          const r = readRadarRepos(res.value, { sourceId: id })
          return { format: 'radar-repos', offerings: r.offerings, skipped: r.skipped, bytes: res.bytes }
        } catch (err) {
          throw formatError(err.message)
        }
      })
    } else {
      got = await firstThatLoads(source, cached, hostVersion, fetchOpts,
        (res) => readIndexDocument(res, { source, hostVersion, fetchOpts, cached }))
    }
    const reuse = got.notModified || got.reused
    if (reuse && !cached) throw codedError(Error, 'http', 'not modified, but nothing is cached')
    const offerings = reuse ? cached.offerings : got.offerings
    const prev = reuse ? cached.meta : {}
    const meta = {
      fetchedAt,
      okAt: fetchedAt,
      count: offerings.length,
      skipped: reuse ? prev.skipped ?? 0 : got.skipped ?? 0,
      etag: got.etag ?? null,
      url: got.url ?? null,
      format: got.format ?? prev.format ?? null,
      title: reuse ? prev.title ?? null : got.title ?? null,
      description: reuse ? prev.description ?? null : got.description ?? null,
      categories: reuse ? prev.categories ?? {} : got.categories ?? {},
      hostVersion: hostVersion ?? null,
      state: 'ok',
    }
    const dataSha256 = got.dataSha256 ?? (got.notModified ? prev.dataSha256 : undefined)
    if (dataSha256) meta.dataSha256 = dataSha256
    if (got.bytes !== undefined) meta.bytes = got.bytes
    if (got.pages !== undefined) meta.pages = got.pages
    const warning = got.warning ?? (await writeCache(dataDir, id, { meta, offerings }))
    if (warning) meta.warning = warning
    return { offerings, meta }
  } catch (err) {
    const error = errorData(err)
    if (cached) {
      return { offerings: cached.offerings, meta: { ...cached.meta, count: cached.offerings.length, fetchedAt, state: 'stale', error } }
    }
    return {
      offerings: [],
      meta: { fetchedAt, okAt: null, count: 0, skipped: 0, etag: null, url: null, format: null, title: null, description: null, categories: {}, hostVersion: hostVersion ?? null, state: 'failed', error },
    }
  }
}

/**
 * Load the radar overlay: `{ radar: Map 'owner/repo' → { verdict, label, stars }, meta }` (lib/radar.js radarMap),
 * with the same cache, ETag and stale rules as loadSource (cache field `radar` holds the map's entries) and
 * `meta.generatedAt` from the document. Never throws; a failure without cache answers an empty Map.
 */
export async function loadRadar(source, { dataDir, fetch = globalThis.fetch, now = Date.now, timeoutMs, maxBytes } = {}) {
  const fetchedAt = now()
  const id = source?.id
  const cached = await readCache(dataDir, id, 'radar')
  try {
    if (!isObject(source) || typeof id !== 'string' || !id) throw codedError(Error, 'invalid', 'source must have an id')
    const fetchOpts = fetchOptionsFor(source, { fetch, timeoutMs, maxBytes })
    const got = await firstThatLoads(source, cached, null, fetchOpts, async (res) => {
      let map
      try {
        map = radarMap(res.value)
      } catch (err) {
        throw formatError(err.message)
      }
      return { entries: [...map], generatedAt: res.value.generated_at ?? null, bytes: res.bytes }
    })
    if (got.notModified && !cached) throw codedError(Error, 'http', 'not modified, but nothing is cached')
    const entries = got.notModified ? cached.radar : got.entries
    const meta = {
      fetchedAt,
      okAt: fetchedAt,
      count: entries.length,
      skipped: 0,
      etag: got.etag ?? null,
      url: got.url,
      format: 'dsh-radar/v1',
      generatedAt: got.notModified ? cached.meta.generatedAt ?? null : got.generatedAt,
      hostVersion: null,
      state: 'ok',
    }
    const warning = await writeCache(dataDir, id, { meta, radar: entries })
    if (warning) meta.warning = warning
    return { radar: new Map(entries), meta }
  } catch (err) {
    const error = errorData(err)
    if (cached) {
      return { radar: new Map(cached.radar), meta: { ...cached.meta, fetchedAt, state: 'stale', error } }
    }
    return { radar: new Map(), meta: { fetchedAt, okAt: null, count: 0, skipped: 0, etag: null, url: null, format: null, generatedAt: null, hostVersion: null, state: 'failed', error } }
  }
}

/* ------------------------------------------------------------------ probe */

function nameKeyOf(item) {
  if (typeof item === 'string') {
    const m = /^n:([^#]+)/.exec(item)
    return m ? { name: m[1], repo: null } : null
  }
  if (!isObject(item)) return null
  const name = typeof item.name === 'string' ? item.name.toLowerCase() : /^n:([^#]+)/.exec(item.key ?? '')?.[1]
  return name ? { name, repo: typeof item.repo === 'string' ? item.repo : null } : null
}

/**
 * Preview a URL for the add-source dialog, without storing anything. Fetches with `redirect: 'error'` (as a user
 * index will be) and reads it like loadSource would.
 * @param options.existing - the current catalog items (array or Map values of `{ key, name, repo }`) or their keys.
 *   An offering whose name an existing item has is a duplicate when the repos agree (or either is unknown), and a
 *   conflict when both name a repo and they differ.
 * @returns `{ format, title, description, count, skipped, npm, git, other, enginesDeclared, compatible, categories,
 *   bytes, samples, duplicates, conflicts }` (`compatible` is null without hostVersion).
 * @throws Error with `.code` as fetchJson's, plus 'format' and 'integrity'.
 */
export async function probeSource(url, { fetch = globalThis.fetch, hostVersion, existing, timeoutMs, maxBytes } = {}) {
  const n = normalizeSourceUrl(url)
  if (!n.href) throw codedError(TypeError, n.code, n.code === 'scheme' ? 'url must be http(s)' : 'url is not a usable URL')
  const source = { id: 'probe', kind: 'user-index', urls: [n.href] }
  const fetchOpts = fetchOptionsFor(source, { fetch, timeoutMs, maxBytes })
  const got = await fetchJson(n.href, fetchOpts)
  const r = await readIndexDocument(got, { source, hostVersion, fetchOpts, cached: null })
  const counts = { npm: 0, git: 0, other: 0 }
  let enginesDeclared = 0
  let compatible = hostVersion ? 0 : null
  for (const o of r.offerings) {
    const kind = o.install.kind
    counts[kind === 'npm' || kind === 'git' ? kind : 'other']++
    if (o.engines !== null) enginesDeclared++
    if (hostVersion && enginesAdmit(o.engines, hostVersion)) compatible++
  }
  const known = new Map()
  const list = existing instanceof Map ? [...existing.values()] : Array.isArray(existing) || existing instanceof Set ? [...existing] : []
  for (const item of list) {
    const k = nameKeyOf(item)
    if (!k) continue
    const repos = known.get(k.name) ?? new Set()
    repos.add(k.repo)
    known.set(k.name, repos)
  }
  let duplicates = 0
  let conflicts = 0
  for (const o of r.offerings) {
    const repos = known.get(o.name.toLowerCase())
    if (!repos) continue
    if (o.repo === null || repos.has(null) || repos.has(o.repo)) duplicates++
    else conflicts++
  }
  return {
    format: r.format,
    title: r.title ?? null,
    description: r.description ?? null,
    count: r.offerings.length,
    skipped: r.skipped,
    ...counts,
    enginesDeclared,
    compatible,
    categories: r.categories ?? {},
    bytes: r.bytes,
    samples: r.offerings.slice(0, 3).map((o) => o.name),
    duplicates,
    conflicts,
  }
}
