/**
 * Tests for the catalog wiring: the pure helpers in lib/sources/catalog.js (request sanitizing, the 0.4.0-compatible
 * wire item, chips, freshness, status rows, host markets, the job trust gate), then the Host bundle's routes driven
 * through a fake Cordis context with a stubbed global fetch serving the fixtures (no network, no real trials).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RADAR_SOURCES } from '../lib/radar.js'
import {
  CATALOG_LIMIT_DEFAULT, SOURCE_RETRY_MS, SOURCE_TTL_MS, catalogRequest, catalogUnavailable, chipPredicate,
  hostMarketList, isFresh, jobGate, legacyView, offersPlugins, sourceStatus, wireItem,
} from '../lib/sources/catalog.js'
import { mergeCatalog } from '../lib/sources/merge.js'
import { AWESOME_SOURCES, DEFAULT_SOURCES } from '../lib/sources/store.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sources')
const fixture = (name) => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'))
const OLD_ITEM_FIELDS = ['name', 'title', 'description', 'category', 'version', 'engines', 'repository', 'homepage', 'spec', 'radar', 'stars']
const NEW_ITEM_FIELDS = ['key', 'sources', 'chosenSource', 'install', 'conflict', 'radarShared', 'updatedAt', 'trust']

function off(sourceId, name, extra = {}) {
  return {
    sourceId, name, title: null, description: null, category: null, keywords: [], version: '1.0.0', publishedAt: null,
    engines: null, repo: null, directory: null, homepage: null, icon: null,
    install: { kind: 'npm', spec: `${name}@1.0.0`, registry: null, pinned: true, repairable: true }, stars: null, labels: [],
    ...extra,
  }
}

/* ------------------------------------------------------------------ pure helpers */

test('catalogRequest: a 0.4.0 body keeps 0.4.0 defaults and new fields are optional and sanitized', () => {
  assert.deepEqual(catalogRequest({}), { q: '', offset: 0, limit: CATALOG_LIMIT_DEFAULT, sort: 'stars' })
  assert.deepEqual(catalogRequest(null), { q: '', offset: 0, limit: 30, sort: 'stars' })
  assert.deepEqual(catalogRequest({ q: 'x'.repeat(300), offset: '-4', limit: 500 }), { q: 'x'.repeat(200), offset: 0, limit: 60, sort: 'stars' })
  assert.equal(catalogRequest({ limit: 0 }).limit, 30) // 0.4.0: `|| 30`
  const r = catalogRequest({ sources: ['awesome', 7, '../x', 'radar-repos'], category: 'tools', radar: 'ok', sort: 'updated', installed: false })
  assert.deepEqual(r.sources, ['awesome', 'radar-repos'])
  assert.equal(r.category, 'tools')
  assert.equal(r.radar, 'ok')
  assert.equal(r.sort, 'updated')
  assert.equal(r.installed, false)
  const bad = catalogRequest({ sources: 'awesome', category: '', radar: 'maybe', sort: 'random', installed: 'yes', itemKeys: 1 })
  assert.deepEqual(Object.keys(bad).sort(), ['limit', 'offset', 'q', 'sort'])
  assert.equal(catalogRequest({ itemKeys: true }).itemKeys, true)
  assert.equal(bad.sort, 'stars')
})

test('chipPredicate: installed / not installed by package name, none without the chip', () => {
  assert.equal(chipPredicate({}, ['a']), undefined)
  const yes = chipPredicate({ installed: true }, ['Dsh-Foo', '@s/bar'])
  assert.equal(yes({ name: 'dsh-foo' }), true)
  assert.equal(yes({ name: '@s/bar' }), true)
  assert.equal(yes({ name: 'other' }), false)
  const no = chipPredicate({ installed: false }, null)
  assert.equal(no({ name: 'anything' }), true)
})

test('wireItem: every 0.4.0 field (title a string, spec of the chosen offer) plus the new ones', () => {
  const { items } = mergeCatalog([
    { id: 'awesome', trust: 'builtin', offerings: [off('awesome', 'dsh-foo', { title: { zh: '福', en: 'Foo' }, description: { en: 'd' }, category: 'tools', repo: 'o/foo', homepage: 'https://h', engines: '^0.2.0' })] },
    { id: 'who', trust: 'host', offerings: [off('who', 'dsh-foo', { version: '2.0.0', repo: 'o/foo', install: { kind: 'git', spec: 'git+https://github.com/o/foo.git#' + 'a'.repeat(40), registry: null, pinned: true, repairable: false } })] },
    { id: 'radar-repos', trust: 'browse', offerings: [off('radar-repos', 'lonely', { version: null, repo: 'o/lonely', install: { kind: 'github-head', spec: 'github:o/lonely', registry: null, pinned: false, repairable: false } })] },
  ], { radar: new Map([['o/foo', { verdict: 'ok', stars: 9 }]]) })
  const foo = wireItem(items.find((i) => i.name === 'dsh-foo'))
  for (const k of [...OLD_ITEM_FIELDS, ...NEW_ITEM_FIELDS]) assert.ok(Object.hasOwn(foo, k), k)
  assert.equal(foo.title, '福')
  assert.deepEqual(foo.description, { en: 'd' })
  assert.equal(foo.spec, 'dsh-foo@1.0.0')
  assert.equal(foo.version, '1.0.0')
  assert.equal(foo.engines, '^0.2.0')
  assert.equal(foo.repository, 'https://github.com/o/foo')
  assert.equal(foo.radar, 'ok')
  assert.equal(foo.stars, 9)
  assert.equal(foo.key, 'n:dsh-foo')
  assert.deepEqual(foo.sources, ['awesome', 'who'])
  assert.equal(foo.chosenSource, 'awesome')
  assert.deepEqual(foo.install, { kind: 'npm', pinned: true, repairable: true })
  assert.equal(foo.trust, 'builtin')
  const lonely = wireItem(items.find((i) => i.name === 'lonely'))
  assert.equal(lonely.title, 'lonely') // no title: the name, as 0.4.0 did
  assert.equal(lonely.spec, 'github:o/lonely')
  assert.equal(lonely.version, null)
  assert.deepEqual(lonely.install, { kind: 'github-head', pinned: false, repairable: false })
  assert.equal(lonely.trust, 'browse')
})

test('isFresh: 30 min after a good load, 2 min after a failed or stale one', () => {
  const now = 10_000_000
  assert.equal(isFresh(null, now), false)
  assert.equal(isFresh({ at: now - SOURCE_TTL_MS + 1, meta: { state: 'ok' } }, now), true)
  assert.equal(isFresh({ at: now - SOURCE_TTL_MS, meta: { state: 'ok' } }, now), false)
  assert.equal(isFresh({ at: now - SOURCE_RETRY_MS + 1, meta: { state: 'failed' } }, now), true)
  assert.equal(isFresh({ at: now - SOURCE_RETRY_MS, meta: { state: 'failed' } }, now), false)
  assert.equal(isFresh({ at: now - SOURCE_RETRY_MS, meta: { state: 'stale' } }, now), false)
  assert.equal(isFresh({ loading: Promise.resolve() }, now), false)
})

test('sourceStatus and catalogUnavailable: 502 only when no plugin source has any data and one failed', () => {
  const states = new Map([
    ['awesome', { meta: { state: 'failed', count: 0, error: { code: 'timeout', message: 'slow' } } }],
    ['radar', { meta: { state: 'ok', count: 5 } }],
  ])
  assert.deepEqual(sourceStatus(DEFAULT_SOURCES, states).map((r) => [r.id, r.state]),
    [['awesome', 'failed'], ['radar', 'ok'], ['radar-repos', 'disabled'], ['npm', 'disabled']], 'browse-only sources start disabled')
  const rows = sourceStatus(DEFAULT_SOURCES.map((s) => (s.id === 'radar-repos' ? { ...s, enabled: true } : s)), states)
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [['awesome', 'failed'], ['radar', 'ok'], ['radar-repos', 'pending'], ['npm', 'disabled']])
  assert.equal(rows[0].error.code, 'timeout')
  assert.equal(rows[0].trust, 'builtin')
  assert.match(catalogUnavailable(rows), /awesome: slow/) // the radar overlay alone is no catalog
  rows[2].state = 'ok'
  rows[2].count = 0
  assert.match(catalogUnavailable(rows), /^awesome: slow$/)
  rows[0].state = 'ok'
  assert.equal(catalogUnavailable(rows), null) // empty but not failed: an empty catalog, not an error
  rows[2].state = 'stale'
  rows[2].count = 3
  assert.equal(catalogUnavailable(rows), null)
  assert.equal(catalogUnavailable([]), null)
  assert.equal(offersPlugins({ kind: 'radar-overlay' }), false)
  assert.equal(offersPlugins({ kind: 'host-market' }), true)
})

test('hostMarketList keeps http(s) index URLs only', () => {
  assert.deepEqual(hostMarketList([{ url: 'https://a/index.json', title: { en: 'A' } }, { url: 'file:///x' }, null, { url: 3 }, { url: 'http://b', error: 'down' }]), [
    { url: 'https://a/index.json', title: { en: 'A' }, description: null, error: null },
    { url: 'http://b', title: null, description: null, error: 'down' },
  ])
  assert.deepEqual(hostMarketList(undefined), [])
})

test('legacyView: a 0.4.0 client gets one item per name and nothing it would install from a browse-only source', () => {
  const { items } = mergeCatalog([
    { id: 'awesome', trust: 'builtin', offerings: [off('awesome', 'dsh-stall-guard', { repo: 'a/guard' }), off('awesome', 'twin', { repo: 'a/twin' })] },
    { id: 'who', trust: 'host', offerings: [off('who', 'twin', { repo: 'b/twin' }), off('who', 'solo-git', { repo: 'c/solo' })] },
    { id: 'radar-repos', trust: 'browse', offerings: [
      off('radar-repos', 'dsh-stall-guard', { version: null, repo: 'akira399/dsh-stall-guard', install: { kind: 'github-head', spec: 'github:akira399/dsh-stall-guard', registry: null, pinned: false, repairable: false } }),
      off('radar-repos', 'dsh-desktop', { version: null, repo: 'x/dsh-desktop', install: { kind: 'github-head', spec: 'github:x/dsh-desktop', registry: null, pinned: false, repairable: false } }),
    ] },
  ])
  const rank = new Map(['awesome', 'who', 'radar-repos'].map((id, i) => [id, i]))
  const keep = legacyView(items, (id) => rank.get(id) ?? Infinity)
  const kept = items.filter((it) => keep.has(it))
  assert.deepEqual(kept.map((it) => it.key).sort(), ['n:dsh-stall-guard', 'n:twin#a/twin/', 'n:solo-git'].sort())
  const names = kept.map((it) => it.name.toLowerCase())
  assert.equal(new Set(names).size, names.length, 'names are unique')
  for (const it of kept) assert.notEqual(it.offers[it.chosen].trust, 'browse')
  // with the user's priority flipped, the other twin is the one shown
  const flipped = legacyView(items, (id) => (id === 'who' ? 0 : 1))
  assert.ok([...flipped].some((it) => it.key === 'n:twin#b/twin/'))
})

test('jobGate: browse-only sources are refused with 409, untagged jobs pass', () => {
  const sources = [...DEFAULT_SOURCES, { id: 'user-abc', kind: 'user-index', trust: 'trusted' }]
  assert.deepEqual(jobGate({}, sources), { ok: true })
  assert.deepEqual(jobGate({ sourceId: 'awesome', key: 'n:x' }, sources), { ok: true })
  assert.deepEqual(jobGate({ sourceId: 'user-abc' }, sources), { ok: true })
  const g = jobGate({ sourceId: 'radar-repos', key: 'gh:o/r' }, sources)
  assert.equal(g.ok, false)
  assert.equal(g.status, 409)
  assert.equal(g.code, 'autofit/untrusted-source')
  assert.equal(jobGate({ sourceId: 'npm' }, sources).status, 409)
  assert.equal(jobGate({ sourceId: 'nope' }, sources).code, 'autofit/unknown-source')
  assert.equal(jobGate({ sourceId: '../x' }, sources).status, 400)
  assert.equal(jobGate({ sourceId: 7 }, sources).status, 400)
})

/* ------------------------------------------------------------------ bundle routes (fake Host) */

const HOST_INDEX = 'https://market.example/index.json'
let home
let routes
let realFetch
let fetched
let failing = new Set()

function serve(url) {
  fetched.push(url)
  if (failing.has(url)) return new Response('down', { status: 500 })
  let doc
  if (url === AWESOME_SOURCES[0] || url === HOST_INDEX) doc = fixture('format1-whoishuhu.json')
  else if (RADAR_SOURCES.includes(url)) doc = fixture('radar-plugins-all.json')
  else return new Response('nope', { status: 404 })
  return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function call(name, payload = {}) {
  const route = routes[`/api/autofit/${name}`]
  assert.ok(route, `route ${name}`)
  const res = await route.fetch(new Request(`http://host/api/autofit/${name}`, { method: 'POST', body: JSON.stringify(payload) }))
  return { status: res.status, body: await res.json() }
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'dsh-autofit-test-catalog-'))
  realFetch = globalThis.fetch
  fetched = []
  globalThis.fetch = async (url) => serve(String(url))
  routes = {}
  const { apply } = await import('../bundle/index.js')
  const scope = {
    pluginMarket: { listIndexes: () => [{ url: HOST_INDEX, title: { en: 'Example market' } }, { url: 'not a url' }] },
    on() {},
    effect() {},
  }
  apply({
    get: (name) => (name === 'profileContext' ? { home } : undefined),
    effect: (fn, label) => { if (!String(label).includes('install watcher')) fn() },
    connection: { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } },
    logger: { warn() {}, info() {} },
    inject: (deps, cb) => { assert.deepEqual(deps, ['pluginMarket']); cb(scope) },
  })
})

after(() => {
  globalThis.fetch = realFetch
  rmSync(home, { recursive: true, force: true })
})

test('catalog route: a 0.4.0 request gets every old field, plus facets and source status', async () => {
  const { status, body } = await call('catalog', {})
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  const v = body.value
  for (const k of ['total', 'items', 'offset', 'limit', 'source', 'radarAt', 'facets', 'sourceStatus']) assert.ok(Object.hasOwn(v, k), k)
  assert.equal(v.offset, 0)
  assert.equal(v.limit, 30)
  assert.equal(v.source, AWESOME_SOURCES[0])
  assert.equal(v.radarAt, '2026-11-13T21:16:09Z')
  assert.ok(v.total >= 10, `total ${v.total}`)
  assert.ok(v.items.every((it) => it.trust !== 'browse'), 'radar-repos is off by default')
  for (const it of v.items) {
    for (const k of [...OLD_ITEM_FIELDS, ...NEW_ITEM_FIELDS]) assert.ok(Object.hasOwn(it, k), `${it.name}: ${k}`)
    assert.equal(typeof it.title, 'string')
    assert.equal(typeof it.spec, 'string')
  }
  const stars = v.items.map((it) => it.stars ?? -1)
  assert.deepEqual(stars, [...stars].sort((a, b) => b - a)) // stars sort, as 0.4.0
  const host = v.sourceStatus.find((s) => s.kind === 'host-market')
  assert.equal(host.trust, 'host')
  assert.equal(host.url, HOST_INDEX)
  assert.equal(host.state, 'ok')
  assert.deepEqual(v.sourceStatus.map((s) => s.id).slice(0, 2), ['radar', 'awesome'])
  // git entries of the format-1 fixture keep their git spec instead of name@version
  const git = v.items.find((it) => it.install?.kind === 'git')
  if (git) assert.match(git.spec, /^git\+https:\/\//)
})

test('catalog route: sources load once per TTL; filters and the radar-repos source work', async () => {
  const on = await call('sources/set', { id: 'radar-repos', enabled: true })
  assert.equal(on.status, 200)
  await call('catalog', { itemKeys: true }) // first load of radar-repos
  const before = fetched.length
  const { body } = await call('catalog', { sources: ['radar-repos'], limit: 60, sort: 'name', itemKeys: true })
  assert.equal(fetched.length, before, 'fresh sources are not fetched again')
  assert.ok(body.value.total > 0)
  for (const it of body.value.items) assert.ok(it.sources.includes('radar-repos'))
  const names = body.value.items.map((it) => it.name.toLowerCase())
  assert.deepEqual(names, [...names].sort())
  const head = body.value.items.find((it) => it.install.kind === 'github-head')
  assert.ok(head)
  assert.equal(head.install.pinned, false)
  assert.equal(head.trust, 'browse')
  const ok = await call('catalog', { radar: 'ok' })
  for (const it of ok.body.value.items) assert.equal(it.radar, 'ok')
  // the same catalog for a request without itemKeys (a 0.4.0 client): no browse-only cards, unique names
  const legacy = await call('catalog', { limit: 60 })
  const all = await call('catalog', { limit: 60, itemKeys: true })
  assert.ok(all.body.value.items.some((it) => it.trust === 'browse'))
  assert.ok(legacy.body.value.items.every((it) => it.trust !== 'browse'))
  const legacyNames = legacy.body.value.items.map((it) => it.name.toLowerCase())
  assert.equal(new Set(legacyNames).size, legacyNames.length)
  assert.ok(legacy.body.value.total < all.body.value.total)
})

test('job/start: a browse-only source is refused before any trial starts', async () => {
  const r = await call('job/start', { spec: 'github:yexi-by/dsh-unrestricted', key: 'gh:yexi-by/dsh-unrestricted', sourceId: 'radar-repos' })
  assert.equal(r.status, 409)
  assert.equal(r.body.error.code, 'autofit/untrusted-source')
  const unknown = await call('job/start', { spec: 'x', sourceId: 'nope' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.code, 'autofit/unknown-source')
  const list = await call('job/list')
  assert.deepEqual(list.body.value, [])
})

test('sources routes: list, set (persisted), refresh with a failing radar keeps serving', async () => {
  const list = await call('sources/list')
  assert.equal(list.body.ok, true)
  assert.deepEqual(list.body.value.hostMarkets.map((m) => m.url), [HOST_INDEX])
  const bad = await call('sources/set', { add: { url: 'ftp://x/index.json' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'autofit/source-scheme')
  const fixed = await call('sources/set', { id: 'awesome', trust: 'trusted' })
  assert.equal(fixed.status, 400)
  const missing = await call('sources/set', { id: 'nope', enabled: false })
  assert.equal(missing.status, 404)
  const set = await call('sources/set', { id: 'radar-repos', trust: 'trusted' })
  assert.equal(set.status, 200)
  assert.equal(set.body.value.sources.find((s) => s.id === 'radar-repos').trust, 'trusted')
  const stored = JSON.parse(readFileSync(path.join(home, 'autofit', 'sources.json'), 'utf8'))
  assert.equal(stored.overrides['radar-repos'].trust, 'trusted')
  const back = await call('sources/set', { id: 'radar-repos', trust: 'browse' })
  assert.equal(back.status, 200)

  for (const u of RADAR_SOURCES) failing.add(u)
  const refreshed = await call('sources/refresh', { id: 'radar' })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.value.sources.find((s) => s.id === 'radar').state, 'stale') // cache from the first load
  const cat = await call('catalog', {})
  assert.equal(cat.status, 200)
  assert.equal(cat.body.value.radarAt, '2026-11-13T21:16:09Z')
  failing = new Set()
  const nf = await call('sources/refresh', { id: 'nope' })
  assert.equal(nf.status, 404)
})

test('sources/probe: bad URLs are 400 and a readable index is previewed', async () => {
  const bad = await call('sources/probe', { url: 'ftp://x' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'autofit/invalid-source-url')
  const none = await call('sources/probe', {})
  assert.equal(none.status, 400)
  const ok = await call('sources/probe', { url: HOST_INDEX })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.value.format, 'format1')
  assert.equal(ok.body.value.count, 10)
  assert.ok(ok.body.value.duplicates > 0)
  const down = await call('sources/probe', { url: 'https://market.example/missing.json' })
  assert.equal(down.status, 502)
  assert.equal(down.body.error.details.code, 'http')
})
