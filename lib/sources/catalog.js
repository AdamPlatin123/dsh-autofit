/**
 * Pure helpers behind the Host bundle's catalog routes (bundle/index.js): request sanitizing, the wire shape of a
 * catalog item, the installed-chip predicate, per-source status rows and freshness, the host market list, and the
 * trust gate for "Install with autofix" jobs.
 *
 * Why a separate module: the bundle's route handlers need a live Host to run, but these decisions (what an old 0.4.0
 * client still receives, which source may start a job, when a failed source is retried) are the parts most likely to
 * regress, so they live here where node:test can reach them. No I/O, never prints, never throws on request data
 * (bad request fields are dropped, as a 0.4.0 request carries none of them).
 */

export const SOURCE_TTL_MS = 30 * 60 * 1000
export const SOURCE_RETRY_MS = 2 * 60 * 1000
export const CATALOG_LIMIT_DEFAULT = 30
export const CATALOG_LIMIT_MAX = 60
const SORTS = new Set(['stars', 'updated', 'name'])
const RADAR_FILTERS = new Set(['ok', 'incompatible', 'pending', 'none'])
const OFFERING_KINDS = new Set(['builtin-index', 'radar-repos', 'npm-search', 'host-market', 'user-index'])
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The catalog request as the query layer takes it. 0.4.0 fields: `q` (≤ 200 chars), `offset`, `limit` (1..60,
 * default 30). New optional fields: `sources` (source ids), `category`, `radar` (ok|incompatible|pending|none),
 * `sort` (stars|updated|name, default stars), `installed` (true: only installed here, false: only not installed),
 * and `itemKeys: true`, which a client sends when it tells items apart by `key` and names the offer's `sourceId`
 * when it starts a job. Without `itemKeys` the request is treated as a 0.4.0 client's (see legacyView).
 * Invalid new fields are ignored rather than rejected, so a request without them behaves exactly like 0.4.0.
 */
export function catalogRequest(body) {
  const b = isObject(body) ? body : {}
  const out = {
    q: typeof b.q === 'string' ? b.q.slice(0, 200) : '',
    offset: Math.max(0, Number.parseInt(b.offset ?? 0, 10) || 0),
    limit: Math.min(CATALOG_LIMIT_MAX, Math.max(1, Number.parseInt(b.limit ?? CATALOG_LIMIT_DEFAULT, 10) || CATALOG_LIMIT_DEFAULT)),
    sort: SORTS.has(b.sort) ? b.sort : 'stars',
  }
  if (Array.isArray(b.sources)) out.sources = b.sources.filter((s) => typeof s === 'string' && ID.test(s)).slice(0, 50)
  if (typeof b.category === 'string' && b.category && b.category.length <= 100) out.category = b.category
  if (RADAR_FILTERS.has(b.radar)) out.radar = b.radar
  if (typeof b.installed === 'boolean') out.installed = b.installed
  if (b.itemKeys === true) out.itemKeys = true
  return out
}

/**
 * The items a 0.4.0 client may be shown. That client keys its cards by `name` (duplicate names break its React
 * list) and starts jobs with `{ spec }` only, so the Host cannot apply the browse-source trust gate to its installs.
 * So: no item whose chosen offer comes from a browse-only source, and one item per lowercase name: a `n:` item
 * before a `gh:` one, then the item whose chosen offer has the best source priority, then merge order.
 * @param {object[]} items - merged items (merge order)
 * @param {(sourceId: string) => number} priorityOf - lower is preferred (position in the priority-sorted config)
 * @returns {Set<object>} the items to keep
 */
export function legacyView(items, priorityOf) {
  const best = new Map()
  const rank = (it) => [it.key?.startsWith('gh:') ? 1 : 0, priorityOf(it.offers?.[it.chosen ?? 0]?.sourceId)]
  for (const it of Array.isArray(items) ? items : []) {
    const chosen = it?.offers?.[it.chosen ?? 0]
    if (!chosen || chosen.trust === 'browse') continue
    const name = String(it.name).toLowerCase()
    const prev = best.get(name)
    if (prev) {
      const [a1, a2] = rank(it)
      const [b1, b2] = rank(prev)
      if (a1 > b1 || (a1 === b1 && !(a2 < b2))) continue
    }
    best.set(name, it)
  }
  return new Set(best.values())
}

/**
 * The extra filter for the `installed` chip: `undefined` when the request has no chip, else a predicate on the
 * item's package name against the profile's dependency names (compared lowercase).
 * @param {{ installed?: boolean }} request
 * @param {Iterable<string> | null} installedNames - dependency names of the current profile (null: unknown)
 */
export function chipPredicate(request, installedNames) {
  if (typeof request?.installed !== 'boolean') return undefined
  const names = new Set()
  for (const n of installedNames ?? []) if (typeof n === 'string') names.add(n.toLowerCase())
  const want = request.installed
  return (item) => names.has(String(item?.name ?? '').toLowerCase()) === want
}

/** A title (string or locale map) as the 0.4.0 wire had it: one string, zh first, then en, then the name. */
function legacyTitle(title, name) {
  if (typeof title === 'string' && title.trim()) return title
  if (isObject(title)) {
    const pick = [title.zh, title.en, ...Object.values(title)].find((v) => typeof v === 'string' && v.trim())
    if (pick) return pick
  }
  return name
}

/**
 * One merged catalog item (lib/sources/merge.js) on the wire. Keeps every 0.4.0 field (`name, title, description,
 * category, version, engines, repository, homepage, spec, radar, stars`; `title` stays a string, `spec`, `version`
 * and `engines` come from the chosen offer) and adds `key, sources, chosenSource, install, conflict, radarShared,
 * updatedAt, trust, icon, directory`.
 */
export function wireItem(item) {
  const offers = Array.isArray(item?.offers) ? item.offers : []
  const chosen = offers[Number.isInteger(item?.chosen) ? item.chosen : 0] ?? offers[0] ?? null
  const install = chosen?.install ?? null
  const sources = []
  for (const o of offers) if (o?.sourceId && !sources.includes(o.sourceId)) sources.push(o.sourceId)
  return {
    name: item.name,
    title: legacyTitle(item.title, item.name),
    description: item.description ?? null,
    category: item.category ?? null,
    version: chosen?.version ?? null,
    engines: chosen?.engines ?? null,
    repository: item.repo ? `https://github.com/${item.repo}` : null,
    homepage: item.homepage ?? null,
    spec: install?.spec ?? item.name,
    radar: item.radar ?? null,
    stars: Number.isFinite(item.stars) ? item.stars : null,
    key: item.key ?? null,
    sources,
    chosenSource: chosen?.sourceId ?? null,
    install: install ? { kind: install.kind, pinned: install.pinned !== false, repairable: install.repairable === true } : null,
    conflict: item.conflict === true,
    radarShared: Number.isFinite(item.radarShared) ? item.radarShared : 0,
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null,
    trust: chosen?.trust ?? null,
    icon: item.icon ?? null,
    directory: item.directory ?? null,
  }
}

/** Whether a source kind contributes offerings (the radar overlay only labels them). */
export function offersPlugins(source) {
  return OFFERING_KINDS.has(source?.kind)
}

/**
 * Whether a loaded source state can be served without reloading: an 'ok' load for `ttlMs`, anything else (stale or
 * failed, e.g. the radar being down) only for `retryMs`, so a failure is retried soon instead of cached for 30 min.
 * @param {{ at: number, meta?: { state?: string } } | null | undefined} state
 */
export function isFresh(state, now, { ttlMs = SOURCE_TTL_MS, retryMs = SOURCE_RETRY_MS } = {}) {
  if (!state || !Number.isFinite(state.at)) return false
  const age = now - state.at
  return age >= 0 && age < (state.meta?.state === 'ok' ? ttlMs : retryMs)
}

/**
 * Status rows for the client: one per configured source in priority order, with the load state of enabled ones.
 * @param {object[]} sources - from loadSourceConfig
 * @param {Map<string, { meta?: object }>} states - last load per source id
 */
export function sourceStatus(sources, states) {
  return (Array.isArray(sources) ? sources : []).map((s) => {
    const meta = states?.get?.(s.id)?.meta ?? null
    return {
      id: s.id,
      kind: s.kind,
      title: s.title ?? meta?.title ?? null,
      url: s.url ?? s.urls?.[0] ?? null,
      enabled: s.enabled !== false,
      trust: s.trust ?? null,
      trustedAt: s.trustedAt ?? null,
      priority: Number.isFinite(s.priority) ? s.priority : null,
      state: s.enabled === false ? 'disabled' : meta?.state ?? 'pending',
      count: meta?.count ?? null,
      skipped: meta?.skipped ?? null,
      okAt: meta?.okAt ?? null,
      fetchedAt: meta?.fetchedAt ?? null,
      error: meta?.error ? { code: meta.error.code ?? null, message: String(meta.error.message ?? '').slice(0, 600), status: meta.error.status ?? null } : null,
      warning: meta?.warning ? String(meta.warning).slice(0, 600) : null,
    }
  })
}

/**
 * The catalog cannot be served (route answers 502) only when enabled plugin sources exist, none has any offerings
 * (fresh or cached), and at least one failed. Returns the reason, or null when the catalog can be served.
 */
export function catalogUnavailable(rows) {
  const plugin = (Array.isArray(rows) ? rows : []).filter((r) => r.enabled && OFFERING_KINDS.has(r.kind))
  if (!plugin.length || plugin.some((r) => r.count > 0)) return null
  const failed = plugin.filter((r) => r.state === 'failed')
  if (!failed.length) return null
  return failed.map((r) => `${r.id}: ${r.error?.message || r.error?.code || 'failed'}`).join('; ').slice(0, 800)
}

/**
 * The host market's index list (pluginMarket.listIndexes()) reduced to what we use: http(s) URLs with their title,
 * description and last error. Anything malformed is dropped.
 */
export function hostMarketList(indexes) {
  const out = []
  for (const i of Array.isArray(indexes) ? indexes : []) {
    if (!isObject(i) || typeof i.url !== 'string' || !/^https?:\/\//i.test(i.url)) continue
    out.push({ url: i.url, title: i.title ?? null, description: i.description ?? null, error: typeof i.error === 'string' ? i.error : null })
  }
  return out
}

/**
 * Trust gate of `/job/start`. A job started from a catalog card names the offer's `sourceId` (and the item `key`);
 * a source the user only browses (trust 'browse') may not start an install until the user marks it trusted.
 * A job without `sourceId` (the free-form "Install with Autofit…" dialog, or a 0.4.0 client) is not gated: the user
 * typed or chose that spec themselves. This is a consent step in the UI, not a security boundary.
 * @returns `{ ok: true }` or `{ ok: false, status, code, message }`.
 */
export function jobGate({ sourceId, key } = {}, sources) {
  if (sourceId === undefined || sourceId === null) return { ok: true }
  if (typeof sourceId !== 'string' || !ID.test(sourceId) || (key !== undefined && key !== null && (typeof key !== 'string' || key.length > 600))) {
    return { ok: false, status: 400, code: 'autofit/invalid-source', message: 'sourceId must be a source id and key a catalog key.' }
  }
  const source = (Array.isArray(sources) ? sources : []).find((s) => s.id === sourceId)
  if (!source) return { ok: false, status: 400, code: 'autofit/unknown-source', message: `Unknown catalog source ${sourceId}.` }
  if (source.trust === 'browse') {
    return { ok: false, status: 409, code: 'autofit/untrusted-source', message: `${sourceId} is a browse-only source: mark it trusted before installing from it.` }
  }
  return { ok: true }
}
