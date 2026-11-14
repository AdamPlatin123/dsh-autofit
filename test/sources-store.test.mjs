import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import {
  DEFAULT_SOURCES, applySourceChange, fetchJson, hostMarketSources, loadRadar, loadSource, loadSourceConfig,
  probeSource, saveSourceConfig,
} from '../lib/sources/store.js'
import * as publicApi from '../lib/sources/index.js'

const fixtureText = (name) => readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), 'utf8')
const FORMAT1 = fixtureText('format1-whoishuhu.json')
const RADAR = fixtureText('radar-plugins-all.json')
const SHOP = fixtureText('shop-plugins.json')
const SHOP_POINTER = fixtureText('shop-pointer.json')
const NPM_PAGE = fixtureText('npm-search-page.json')
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/* A local HTTP server on an ephemeral 127.0.0.1 port; each test installs its own routes. */
let server
let base
let routes = {}
const hits = []
before(async () => {
  server = createServer((req, res) => {
    hits.push({ url: req.url, inm: req.headers['if-none-match'] ?? null })
    const route = routes[req.url.split('?')[0]]
    if (!route) {
      res.writeHead(404).end('no route')
      return
    }
    route(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})
const reset = (r) => {
  routes = r
  hits.length = 0
}
const json = (body, { etag, status = 200, type = 'application/json' } = {}) => (req, res) => {
  if (etag && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end()
    return
  }
  const headers = { 'content-type': type }
  if (etag) headers.etag = etag
  res.writeHead(status, headers).end(body)
}
const tmp = () => mkdtempSync(path.join(tmpdir(), 'autofit-sources-'))

/* ------------------------------------------------------------------ fetchJson */

test('fetchJson: 200 with hash and ETag, then 304 when the ETag still matches', async () => {
  reset({ '/i.json': json(FORMAT1, { etag: '"v1"' }) })
  const got = await fetchJson(`${base}/i.json`)
  assert.equal(got.status, 200)
  assert.equal(got.etag, '"v1"')
  assert.equal(got.bytes, Buffer.byteLength(FORMAT1))
  assert.equal(got.sha256, sha256(FORMAT1))
  assert.equal(got.value.format, 1)
  assert.equal(got.url, `${base}/i.json`)
  const again = await fetchJson(`${base}/i.json`, { etag: '"v1"' })
  assert.deepEqual({ status: again.status, etag: again.etag, bytes: again.bytes, value: again.value }, { status: 304, etag: '"v1"', bytes: 0, value: undefined })
  assert.equal(hits[1].inm, '"v1"')
  const changed = await fetchJson(`${base}/i.json`, { etag: '"v0"' })
  assert.equal(changed.status, 200, 'a stale ETag gets the body')
})

test('fetchJson: the timeout covers the body, and a slow but timely server is fine', async () => {
  reset({
    '/stall': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"format":1,"plugins":[')
    },
    '/slow-headers': (req, res) => { setTimeout(() => { if (!res.destroyed) res.end('{}') }, 1500) },
    '/slow': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"a":')
      setTimeout(() => res.end('1}'), 300)
    },
  })
  const t0 = Date.now()
  await assert.rejects(fetchJson(`${base}/stall`, { timeoutMs: 300 }), (err) => err.code === 'timeout' && /body/.test(err.message))
  assert.ok(Date.now() - t0 < 1500, 'gave up at the timeout')
  await assert.rejects(fetchJson(`${base}/slow-headers`, { timeoutMs: 300 }), { code: 'timeout' })
  assert.deepEqual((await fetchJson(`${base}/slow`, { timeoutMs: 3000 })).value, { a: 1 })
})

test('fetchJson: maxBytes aborts on Content-Length and while streaming', async () => {
  const big = JSON.stringify({ pad: 'x'.repeat(200_000) })
  reset({
    '/declared': json(big),
    '/chunked': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      let n = 0
      const pump = () => {
        if (res.destroyed || n++ > 2000) return res.end()
        res.write('x'.repeat(1024), () => setImmediate(pump))
      }
      pump()
    },
  })
  await assert.rejects(fetchJson(`${base}/declared`, { maxBytes: 1000 }), { code: 'too-large' })
  await assert.rejects(fetchJson(`${base}/chunked`, { maxBytes: 64 * 1024 }), { code: 'too-large' })
  assert.equal((await fetchJson(`${base}/declared`, { maxBytes: 300_000 })).bytes, big.length)
})

test('fetchJson: redirects are refused with redirect "error", followed otherwise', async () => {
  reset({
    '/moved': (req, res) => res.writeHead(302, { location: '/i.json' }).end(),
    '/i.json': json('{"ok":true}'),
  })
  await assert.rejects(fetchJson(`${base}/moved`, { redirect: 'error' }), (err) => err.code === 'redirect' && err.status === 302)
  const got = await fetchJson(`${base}/moved`)
  assert.deepEqual(got.value, { ok: true })
  assert.equal(got.url, `${base}/i.json`)
})

test('fetchJson: non-JSON, HTTP errors and refused connections carry codes', async () => {
  reset({
    '/html': json('<html>nope</html>', { type: 'text/html' }),
    '/bom': json('\ufeff{"b":1}'),
    '/500': json('{"error":1}', { status: 500 }),
    '/304': (req, res) => res.writeHead(304).end(),
  })
  await assert.rejects(fetchJson(`${base}/html`), { code: 'not-json' })
  assert.deepEqual((await fetchJson(`${base}/bom`)).value, { b: 1 })
  await assert.rejects(fetchJson(`${base}/500`), (err) => err.code === 'http' && err.status === 500)
  await assert.rejects(fetchJson(`${base}/missing`), (err) => err.code === 'http' && err.status === 404)
  await assert.rejects(fetchJson(`${base}/304`), (err) => err.code === 'http' && err.status === 304, 'a 304 we did not ask for is not a body')
  const closed = createServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const port = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  await assert.rejects(fetchJson(`http://127.0.0.1:${port}/x`, { timeoutMs: 5000 }), { code: 'connect' })
})

/* ------------------------------------------------------------------ loadSource */

const NOW = () => 1_800_000_000_000

test('loadSource: fresh load writes the cache; a 304 reuses it', async () => {
  const dataDir = tmp()
  try {
    reset({ '/idx.json': json(FORMAT1, { etag: '"e1"' }) })
    const source = { id: 'who', kind: 'user-index', urls: [`${base}/idx.json`], trust: 'browse' }
    const first = await loadSource(source, { dataDir, now: NOW, hostVersion: '0.2.1-rc.2' })
    assert.equal(first.meta.state, 'ok')
    assert.equal(first.meta.format, 'format1')
    assert.equal(first.meta.etag, '"e1"')
    assert.equal(first.meta.okAt, NOW())
    assert.equal(first.meta.count, first.offerings.length)
    assert.ok(first.offerings.length >= 5)
    assert.ok(first.offerings.every((o) => o.sourceId === 'who'))
    const cache = JSON.parse(readFileSync(path.join(dataDir, 'sources-cache', 'who.json'), 'utf8'))
    assert.equal(cache.v, 2)
    assert.equal(cache.offerings.length, first.offerings.length)

    const second = await loadSource(source, { dataDir, now: () => NOW() + 1000, hostVersion: '0.2.1-rc.2' })
    assert.equal(hits.at(-1).inm, '"e1"', 'revalidated with the cached ETag')
    assert.equal(second.meta.state, 'ok')
    assert.equal(second.meta.okAt, NOW() + 1000)
    assert.deepEqual(second.offerings, first.offerings)
    assert.deepEqual(second.meta.categories, first.meta.categories)

    await loadSource(source, { dataDir, now: NOW, hostVersion: '0.1.5' })
    assert.equal(hits.at(-1).inm, null, 'a cache built for another host version is not revalidated')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadSource: failure serves the stale cache, or fails empty without one; never throws', async () => {
  const dataDir = tmp()
  try {
    reset({ '/idx.json': json(FORMAT1) })
    const source = { id: 'who', kind: 'builtin-index', urls: [`${base}/idx.json`] }
    const ok = await loadSource(source, { dataDir, now: NOW })
    reset({ '/idx.json': json('oops', { status: 500 }) })
    const stale = await loadSource(source, { dataDir, now: () => NOW() + 5 })
    assert.equal(stale.meta.state, 'stale')
    assert.deepEqual(stale.meta.error, { code: 'http', message: `${base}/idx.json: HTTP 500`, status: 500 })
    assert.equal(stale.meta.okAt, NOW(), 'okAt is the last success')
    assert.equal(stale.meta.fetchedAt, NOW() + 5)
    assert.deepEqual(stale.offerings, ok.offerings)

    const none = await loadSource({ ...source, id: 'other' }, { dataDir, now: NOW })
    assert.equal(none.meta.state, 'failed')
    assert.equal(none.meta.error.code, 'http')
    assert.deepEqual(none.offerings, [])

    reset({ '/idx.json': json('{"hello":1}') })
    const wrong = await loadSource({ ...source, id: 'third' }, { dataDir, now: NOW })
    assert.equal(wrong.meta.error.code, 'format')
    for (const bad of [null, {}, { id: 'x', kind: 'nope', urls: [] }, { id: 'x', kind: 'user-index', urls: [] }]) {
      const r = await loadSource(bad, { dataDir, now: NOW })
      assert.equal(r.meta.state, 'failed')
    }
    const noDir = await loadSource(source, { now: NOW, fetch: async () => { throw new TypeError('fetch failed') } })
    assert.equal(noDir.meta.error.code, 'connect', 'works without a dataDir and with an injected fetch')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadSource: tries the next URL when the first fails', async () => {
  reset({ '/a': json('nope', { status: 503 }), '/b': json(FORMAT1) })
  const r = await loadSource({ id: 'awesome', kind: 'builtin-index', urls: [`${base}/a`, `${base}/b`] }, { now: NOW })
  assert.equal(r.meta.state, 'ok')
  assert.equal(r.meta.url, `${base}/b`)
})

test('loadSource: a user index may not redirect; a built-in one may', async () => {
  reset({ '/go': (req, res) => res.writeHead(301, { location: '/idx.json' }).end(), '/idx.json': json(FORMAT1) })
  const user = await loadSource({ id: 'u', kind: 'user-index', urls: [`${base}/go`] }, { now: NOW })
  assert.equal(user.meta.state, 'failed')
  assert.equal(user.meta.error.code, 'redirect')
  const builtin = await loadSource({ id: 'b', kind: 'builtin-index', urls: [`${base}/go`] }, { now: NOW })
  assert.equal(builtin.meta.state, 'ok')
})

test('loadSource: dsh-plugin-shop pointer → data, sha256 checked, unchanged data not downloaded again', async () => {
  const dataDir = tmp()
  try {
    const pointer = JSON.parse(SHOP_POINTER)
    pointer.plugins = { url: 'data/plugins.json', sha256: sha256(SHOP) }
    reset({ '/shop/ptr.json': json(JSON.stringify(pointer)), '/shop/data/plugins.json': json(SHOP) })
    const source = { id: 'shop', kind: 'user-index', urls: [`${base}/shop/ptr.json`] }
    const r = await loadSource(source, { dataDir, now: NOW })
    assert.equal(r.meta.state, 'ok')
    assert.equal(r.meta.format, 'shop-pointer')
    assert.equal(r.meta.dataSha256, sha256(SHOP))
    assert.ok(r.offerings.length > 0)
    assert.deepEqual(hits.map((h) => h.url), ['/shop/ptr.json', '/shop/data/plugins.json'])

    reset({ '/shop/ptr.json': json(JSON.stringify(pointer)), '/shop/data/plugins.json': json(SHOP) })
    const again = await loadSource(source, { dataDir, now: NOW })
    assert.deepEqual(hits.map((h) => h.url), ['/shop/ptr.json'], 'same sha256 → cached offerings')
    assert.deepEqual(again.offerings, r.offerings)

    // The real pointer names its real data file; serving our trimmed fixture there must fail the hash check.
    const real = JSON.parse(SHOP_POINTER)
    reset({ '/shop/ptr.json': json(SHOP_POINTER), [`/shop/${real.plugins.url}`]: json(SHOP) })
    const bad = await loadSource({ ...source, id: 'shop2' }, { dataDir, now: NOW })
    assert.equal(bad.meta.state, 'failed')
    assert.equal(bad.meta.error.code, 'integrity')
    const staleBad = await loadSource(source, { dataDir, now: NOW })
    assert.equal(staleBad.meta.state, 'stale', 'a mismatch keeps the last good data')
    assert.equal(staleBad.meta.error.code, 'integrity')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadSource: radar repos and the radar overlay', async () => {
  const dataDir = tmp()
  try {
    reset({ '/radar.json': json(RADAR, { etag: 'W/"r"' }) })
    const repos = await loadSource({ id: 'radar-repos', kind: 'radar-repos', urls: [`${base}/radar.json`] }, { dataDir, now: NOW })
    assert.equal(repos.meta.state, 'ok')
    assert.equal(repos.meta.skipped, 1)
    assert.ok(repos.offerings.every((o) => o.install.kind === 'github-head'))

    const radar = await loadSource({ id: 'radar', kind: 'radar-overlay', urls: [`${base}/radar.json`] }, { dataDir, now: NOW })
    assert.ok(radar.radar instanceof Map)
    assert.equal(radar.radar.get('ranxianglei/billion-context').stars, 6477)
    const again = await loadRadar({ id: 'radar', urls: [`${base}/radar.json`] }, { dataDir, now: NOW })
    assert.equal(hits.at(-1).inm, 'W/"r"')
    assert.equal(again.radar.size, radar.radar.size)
    reset({})
    const stale = await loadRadar({ id: 'radar', urls: [`${base}/radar.json`] }, { dataDir, now: NOW })
    assert.equal(stale.meta.state, 'stale')
    assert.equal(stale.radar.size, radar.radar.size)
    const failed = await loadRadar({ id: 'radar-x', urls: [`${base}/radar.json`] }, { dataDir, now: NOW })
    assert.equal(failed.meta.state, 'failed')
    assert.equal(failed.radar.size, 0)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadSource: npm search pages until a page adds no new names', async () => {
  const page = JSON.parse(NPM_PAGE)
  const urls = []
  const delays = []
  const fetch = async (url, init) => {
    urls.push(url)
    const from = Number(new URL(url).searchParams.get('from'))
    const body = from === 0 ? page : from === 250 ? { ...page, objects: page.objects.slice(0, 5) } : { objects: [], total: 0 }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const r = await loadSource({ id: 'npm', kind: 'npm-search' }, { fetch, now: NOW, delay: async (ms) => { delays.push(ms) }, delayMs: 7 })
  assert.equal(r.meta.state, 'ok')
  assert.equal(r.meta.pages, 2)
  assert.equal(urls.length, 2, 'the second page repeated names, so paging stopped')
  assert.deepEqual(delays, [7])
  assert.equal(r.offerings.length, page.objects.length)
  assert.ok(r.offerings.every((o) => o.install.kind === 'npm' && o.install.repairable))
})

/* ------------------------------------------------------------------ probe */

test('probeSource summarizes an index for the add-source dialog', async () => {
  reset({ '/idx.json': json(FORMAT1), '/go': (req, res) => res.writeHead(302, { location: '/idx.json' }).end(), '/x': json('[]') })
  const doc = JSON.parse(FORMAT1)
  const first = doc.plugins[0].name
  const p = await probeSource(`${base}/idx.json`, { hostVersion: '0.2.1-rc.2', existing: [{ key: `n:${first.toLowerCase()}`, name: first, repo: null }] })
  assert.equal(p.format, 'format1')
  assert.equal(p.count, p.npm + p.git + p.other)
  assert.ok(p.count > 0)
  assert.ok(p.enginesDeclared <= p.count)
  assert.ok(p.compatible <= p.count)
  assert.equal(p.samples.length, 3)
  assert.equal(p.duplicates, 1)
  assert.equal(p.conflicts, 0)
  assert.equal(p.bytes, Buffer.byteLength(FORMAT1))
  const noHost = await probeSource(`${base}/idx.json`, { existing: new Map([['n:x', { key: `n:${first.toLowerCase()}#zzz/other/`, name: first, repo: 'zzz/other' }]]) })
  assert.equal(noHost.compatible, null)
  assert.ok(noHost.conflicts + noHost.duplicates >= 1)
  await assert.rejects(probeSource(`${base}/go`), { code: 'redirect' })
  await assert.rejects(probeSource(`${base}/x`), { code: 'format' })
  await assert.rejects(probeSource('file:///etc/passwd'), { code: 'scheme' })
})

/* ------------------------------------------------------------------ config */

test('loadSourceConfig: defaults when the file is missing or garbage', async () => {
  const dataDir = tmp()
  try {
    const ids = (list) => list.map((s) => s.id)
    const defaults = await loadSourceConfig(dataDir)
    assert.deepEqual(ids(defaults), ['radar', 'awesome', 'radar-repos', 'npm'])
    assert.deepEqual(defaults.map((s) => s.priority), [0, 10, 90, 95])
    assert.equal(defaults.find((s) => s.id === 'npm').enabled, false)
    for (const text of ['not json', '[]', 'null', '{"overrides":5,"user":"x"}']) {
      writeFileSync(path.join(dataDir, 'sources.json'), text)
      assert.deepEqual(await loadSourceConfig(dataDir), defaults, text)
    }
    assert.deepEqual(await loadSourceConfig(dataDir, { readFile: async () => { throw new Error('EACCES') } }), defaults)
    // Defaults are not shared mutable state.
    defaults[0].urls.push('x')
    assert.equal(DEFAULT_SOURCES[0].urls.length, 2)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('source changes: add, trust, priority, enable, remove, save and load round trip', async () => {
  const dataDir = tmp()
  try {
    let sources = await loadSourceConfig(dataDir, { hostMarkets: ['https://market.example/index.json', 'ftp://x', 'https://market.example/index.json#a'] })
    const host = sources.find((s) => s.kind === 'host-market')
    assert.equal(sources.filter((s) => s.kind === 'host-market').length, 1, 'invalid and duplicate host URLs dropped')
    assert.equal(host.trust, 'host')
    assert.equal(host.priority, 20)
    assert.match(host.id, /^host-[0-9a-f]{10}$/)

    const at = () => 1234
    ;({ sources } = applySourceChange(sources, { add: { url: 'https://who.example/index.json', title: 'Who' } }, { now: at }))
    ;({ sources } = applySourceChange(sources, { add: { url: 'http://b.example/i.json', trust: 'trusted' } }, { now: at }))
    const users = sources.filter((s) => s.kind === 'user-index')
    assert.deepEqual(users.map((s) => [s.priority, s.trust, s.trustedAt]), [[30, 'browse', undefined], [31, 'trusted', 1234]])
    assert.equal(users[0].title, 'Who')
    assert.match(users[0].id, /^user-[0-9a-f]{10}$/)

    const u = users[0].id
    ;({ sources } = applySourceChange(sources, { id: u, trust: 'trusted' }, { now: () => 99 }))
    assert.equal(sources.find((s) => s.id === u).trustedAt, 99)
    ;({ sources } = applySourceChange(sources, { id: 'radar-repos', trust: 'trusted', priority: 5 }, { now: () => 7 }))
    assert.equal(sources[1].id, 'radar-repos', 'priority re-sorts')
    ;({ sources } = applySourceChange(sources, { id: 'npm', enabled: true }))
    ;({ sources } = applySourceChange(sources, { id: users[1].id, trust: 'browse' }))
    assert.equal(sources.find((s) => s.id === users[1].id).trustedAt, undefined, 'leaving trusted clears trustedAt')

    await saveSourceConfig(dataDir, sources)
    const loaded = await loadSourceConfig(dataDir, { hostMarkets: ['https://market.example/index.json'] })
    assert.deepEqual(loaded, sources)

    const before = JSON.stringify(sources)
    ;({ sources } = applySourceChange(sources, { remove: u }))
    assert.equal(sources.some((s) => s.id === u), false)
    assert.equal(JSON.parse(before).some((s) => s.id === u), true, 'input list untouched')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('applySourceChange: every validation error code', async () => {
  const sources = await loadSourceConfig(path.join(tmpdir(), 'autofit-no-such-dir'), { hostMarkets: ['https://market.example/index.json'] })
  const host = sources.find((s) => s.kind === 'host-market').id
  const { sources: withUser } = applySourceChange(sources, { add: { url: 'https://a.example/i.json' } })
  const code = (change, list = withUser) => {
    try {
      applySourceChange(list, change)
    } catch (err) {
      assert.ok(err instanceof TypeError)
      return err.code
    }
    return 'accepted'
  }
  assert.equal(code({ add: { url: 'ftp://a.example/i.json' } }), 'scheme')
  assert.equal(code({ add: { url: 'file:///C:/x.json' } }), 'scheme')
  assert.equal(code({ add: { url: 'javascript:alert(1)' } }), 'scheme')
  assert.equal(code({ add: { url: 'https://a.example/i.json#x' } }), 'duplicate')
  assert.equal(code({ add: { url: 'HTTPS://A.EXAMPLE:443/i.json' } }), 'duplicate')
  assert.equal(code({ add: { url: 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json' } }), 'duplicate', 'a built-in URL')
  assert.equal(code({ add: { url: 'https://market.example/index.json/' } }), 'duplicate', 'a host market URL')
  assert.equal(code({ add: { url: `https://a.example/${'x'.repeat(2000)}` } }), 'invalid')
  assert.equal(code({ add: { url: 'not a url' } }), 'invalid')
  assert.equal(code({ add: { url: 'https://user:pw@a.example/j.json' } }), 'invalid')
  assert.equal(code({ add: { url: 'https://b.example/i.json', trust: 'builtin' } }), 'invalid')
  assert.equal(code({ add: { url: 'https://b.example/i.json', title: 5 } }), 'invalid')
  assert.equal(code({ add: 'https://b.example/i.json' }), 'invalid')
  assert.equal(code({ id: 'awesome', trust: 'browse' }), 'invalid', 'builtin trust is fixed')
  assert.equal(code({ id: host, trust: 'trusted' }), 'invalid', 'host trust is fixed')
  assert.equal(code({ id: 'npm', trust: 'host' }), 'invalid')
  assert.equal(code({ id: 'npm', priority: 1.5 }), 'invalid')
  assert.equal(code({ id: 'npm', priority: -1 }), 'invalid')
  assert.equal(code({ id: 'npm', enabled: 'yes' }), 'invalid')
  assert.equal(code({ id: 'npm', url: 'https://x' }), 'invalid')
  assert.equal(code(null), 'invalid')
  assert.equal(code({}), 'invalid')
  assert.equal(code({ id: 'nope', enabled: true }), 'not-found')
  assert.equal(code({ remove: 'nope' }), 'not-found')
  assert.equal(code({ remove: 'awesome' }), 'not-removable')
  assert.equal(code({ remove: host }), 'not-removable')
  assert.equal(code({ id: 'npm', enabled: true }), 'accepted')
  assert.equal(code({ add: { url: 'https://b.example/i.json' } }), 'accepted')
})

test('loadSourceConfig drops malformed stored entries one by one', async () => {
  const dataDir = tmp()
  try {
    writeFileSync(path.join(dataDir, 'sources.json'), JSON.stringify({
      v: 1,
      overrides: { awesome: { enabled: false, trust: 'browse', priority: 'high' }, npm: { enabled: true, trust: 'trusted', trustedAt: 5 }, ghost: { enabled: false } },
      user: [
        { id: 'user-ok', url: 'https://ok.example/i.json', enabled: false, trust: 'trusted', trustedAt: 3, priority: 40 },
        { id: 'user-dup', url: 'https://ok.example/i.json' },
        { id: 'user-ftp', url: 'ftp://x/i.json' },
        { id: '../evil', url: 'https://evil.example/i.json' },
        { id: 'awesome', url: 'https://other.example/i.json' },
        'junk',
      ],
    }))
    const s = await loadSourceConfig(dataDir)
    const by = Object.fromEntries(s.map((x) => [x.id, x]))
    assert.deepEqual(Object.keys(by).sort(), ['awesome', 'npm', 'radar', 'radar-repos', 'user-ok'])
    assert.equal(by.awesome.enabled, false)
    assert.equal(by.awesome.trust, 'builtin', 'builtin trust is not overridable from the file')
    assert.equal(by.awesome.priority, 10)
    assert.deepEqual([by.npm.enabled, by.npm.trust, by.npm.trustedAt], [true, 'trusted', 5])
    assert.deepEqual([by['user-ok'].enabled, by['user-ok'].trust, by['user-ok'].priority], [false, 'trusted', 40])
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('hostMarketSources gives stable ids; the public entry re-exports the store', () => {
  const a = hostMarketSources(['https://m.example/i.json'])
  const b = hostMarketSources(['https://m.example/i.json/'])
  assert.equal(a[0].id, b[0].id)
  assert.deepEqual(hostMarketSources(null), [])
  for (const name of ['loadSource', 'loadRadar', 'fetchJson', 'probeSource', 'applySourceChange', 'loadSourceConfig',
    'saveSourceConfig', 'readFormat1', 'readShop', 'mergeCatalog', 'queryCatalog', 'buildIndex', 'detectFormat']) {
    assert.equal(typeof publicApi[name], 'function', name)
  }
})

test('a corrupt cache file is ignored, not fatal', async () => {
  const dataDir = tmp()
  try {
    mkdirSync(path.join(dataDir, 'sources-cache'), { recursive: true })
    writeFileSync(path.join(dataDir, 'sources-cache', 'who.json'), '{"v":1,"meta":{},"offerings":"no"}')
    reset({})
    const r = await loadSource({ id: 'who', kind: 'user-index', urls: [`${base}/gone`] }, { dataDir, now: NOW })
    assert.equal(r.meta.state, 'failed')
    assert.ok(existsSync(path.join(dataDir, 'sources-cache', 'who.json')))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadRadar never throws on a damaged cache, and a damaged cache is not revalidated with its ETag', async () => {
  const dataDir = tmp()
  try {
    mkdirSync(path.join(dataDir, 'sources-cache'), { recursive: true })
    const file = path.join(dataDir, 'sources-cache', 'radar.json')
    writeFileSync(file, JSON.stringify({ v: 2, meta: { url: `${base}/radar.json`, etag: 'W/"r"', hostVersion: null }, radar: [1] }))
    reset({})
    const down = await loadRadar({ id: 'radar', urls: [`${base}/radar.json`] }, { dataDir, now: NOW })
    assert.equal(down.meta.state, 'failed', 'the damaged cache counts as no cache')
    assert.equal(down.radar.size, 0)
    // the server would answer 304 to the damaged cache's ETag; without it the full document is fetched and repairs it
    reset({ '/radar.json': (req, res) => (req.headers['if-none-match'] === 'W/"r"' ? res.writeHead(304).end() : json(RADAR, { etag: 'W/"r"' })(req, res)) })
    const up = await loadRadar({ id: 'radar', urls: [`${base}/radar.json`] }, { dataDir, now: NOW })
    assert.equal(hits.at(-1).inm, null)
    assert.equal(up.meta.state, 'ok')
    assert.ok(up.radar.size > 0)
    writeFileSync(file, JSON.stringify({ v: 2, meta: {}, radar: [['o/r', { verdict: 'ok' }], ['bad']] }))
    reset({})
    assert.equal((await loadRadar({ id: 'radar', urls: [`${base}/radar.json`] }, { dataDir, now: NOW })).meta.state, 'failed')
    // offerings caches from before the identity/registry fixes (v 1) are not reused
    writeFileSync(path.join(dataDir, 'sources-cache', 'who.json'), JSON.stringify({ v: 1, meta: { url: `${base}/gone` }, offerings: [] }))
    assert.equal((await loadSource({ id: 'who', kind: 'user-index', urls: [`${base}/gone`] }, { dataDir, now: NOW })).meta.state, 'failed')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
