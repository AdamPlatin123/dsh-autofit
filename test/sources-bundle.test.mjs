/**
 * Host bundle behaviour under load and change (review regressions): a due reload of a source that already has data
 * does not hold up catalog requests (stale-while-revalidate), concurrent `/sources/set` changes are all kept, and a
 * disabled source's data is dropped. A fresh bundle instance (its own module state) runs against a fake Cordis
 * context and a stubbed global fetch; no network, no trials.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const SLOW = 'https://slow.test/index.json'
const index = (name) => JSON.stringify({ format: 1, plugins: [{ name, versions: [{ version: '1.0.0', source: { type: 'npm' } }] }] })
const RADAR = JSON.stringify({ schema: 'dsh-radar/v1', generated_at: '2026-11-13T00:00:00Z', plugins: [] })

let home
let routes
let realFetch
let realNow
let clock = 0
let hang = false
const hanging = []
const fetched = []

const until = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(cond(), 'condition not reached')
}

async function call(name, payload = {}) {
  const res = await routes[`/api/autofit/${name}`].fetch(new Request(`http://host/api/autofit/${name}`, { method: 'POST', body: JSON.stringify(payload) }))
  return { status: res.status, body: await res.json() }
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'dsh-autofit-test-bundle-'))
  realFetch = globalThis.fetch
  realNow = Date.now
  Date.now = () => realNow() + clock
  globalThis.fetch = (url, init = {}) => {
    url = String(url)
    fetched.push(url)
    if (url === SLOW && hang) {
      return new Promise((resolve, reject) => {
        hanging.push(reject)
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    const body = url.includes('radar') ? RADAR : url === SLOW ? index('from-slow') : index('from-awesome')
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  routes = {}
  // A separate module instance, so this file's catalog state does not mix with sources-catalog.test.mjs.
  const { apply } = await import('../bundle/index.js?sources-bundle-test')
  apply({
    get: (name) => (name === 'profileContext' ? { home } : undefined),
    effect: (fn, label) => { if (!String(label).includes('install watcher')) fn() },
    connection: { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } },
    logger: { warn() {}, info() {} },
  })
})

after(() => {
  for (const reject of hanging) reject(new Error('test over'))
  globalThis.fetch = realFetch
  Date.now = realNow
  rmSync(home, { recursive: true, force: true })
})

test('concurrent /sources/set changes are applied one after another and none is lost', async () => {
  const results = await Promise.all([
    call('sources/set', { add: { url: 'https://a.test/index.json' } }),
    call('sources/set', { add: { url: 'https://b.test/index.json' } }),
    call('sources/set', { id: 'npm', enabled: true }),
    call('sources/set', { id: 'npm', priority: 96 }),
  ])
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200])
  const stored = JSON.parse(readFileSync(path.join(home, 'autofit', 'sources.json'), 'utf8'))
  assert.deepEqual(stored.user.map((u) => u.url).sort(), ['https://a.test/index.json', 'https://b.test/index.json'])
  assert.equal(stored.overrides.npm.enabled, true)
  assert.equal(stored.overrides.npm.priority, 96)
  // reset for the next tests: only the slow index besides the defaults
  for (const u of stored.user) assert.equal((await call('sources/set', { remove: u.id })).status, 200)
  assert.equal((await call('sources/set', { id: 'npm', enabled: false })).status, 200)
})

test('a due reload of a source that has data does not hold up the catalog (stale-while-revalidate)', async () => {
  const add = await call('sources/set', { add: { url: SLOW, trust: 'trusted' } })
  assert.equal(add.status, 200)
  const first = await call('catalog', { itemKeys: true })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.value.items.map((it) => it.name).sort(), ['from-awesome', 'from-slow'])

  hang = true
  clock += 31 * 60 * 1000 // every source is due
  const before = fetched.length
  const t = realNow()
  const second = await call('catalog', { itemKeys: true })
  const ms = realNow() - t
  assert.equal(second.status, 200)
  assert.ok(ms < 2000, `the request took ${ms} ms`)
  assert.deepEqual(second.body.value.items.map((it) => it.name).sort(), ['from-awesome', 'from-slow'], 'served from the data at hand')
  await until(() => hanging.length === 1)
  assert.ok(fetched.slice(before).includes(SLOW), 'the reload was started in the background')
  // a second request while the reload hangs does not start another one, and does not wait either
  const third = await call('catalog', { itemKeys: true })
  assert.equal(third.status, 200)
  assert.equal(fetched.slice(before).filter((u) => u === SLOW).length, 1)
  hang = false
  for (const reject of hanging.splice(0)) reject(new TypeError('fetch failed'))
})

test('disabling a source drops its data: re-enabling it loads it again', async () => {
  const id = (await call('sources/list')).body.value.sources.find((s) => s.url === SLOW).id
  clock += 31 * 60 * 1000
  await call('catalog', { itemKeys: true })
  await new Promise((resolve) => setTimeout(resolve, 50)) // let the background reload land
  await call('catalog', { itemKeys: true })
  const loads = () => fetched.filter((u) => u === SLOW).length
  const before = loads()
  assert.equal((await call('sources/set', { id, enabled: false })).status, 200)
  const off = await call('catalog', { itemKeys: true })
  assert.deepEqual(off.body.value.items.map((it) => it.name), ['from-awesome'])
  assert.equal((await call('sources/set', { id, enabled: true })).status, 200)
  const on = await call('catalog', { itemKeys: true })
  assert.equal(loads(), before + 1, 'nothing of the disabled source was kept, so it loads again (within its TTL)')
  assert.deepEqual(on.body.value.items.map((it) => it.name).sort(), ['from-awesome', 'from-slow'])
})
