/**
 * Tests for lib/sources/merge.js: identity and conflict rules of mergeCatalog, the
 * radar overlay, buildIndex/queryCatalog search, filters, facets, sorting and paging.
 * Offerings are built by hand so these tests do not depend on the source readers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIndex, compareVersions, mergeCatalog, queryCatalog } from '../lib/sources/merge.js'

/** A minimal npm offering; `extra` overrides any field. */
function off(sourceId, name, extra = {}) {
  const version = extra.version === undefined ? '1.0.0' : extra.version
  return {
    sourceId,
    name,
    title: null,
    description: null,
    category: null,
    keywords: [],
    version,
    publishedAt: null,
    engines: null,
    repo: null,
    directory: null,
    homepage: null,
    icon: null,
    install: { kind: 'npm', spec: `${name}@${version}`, registry: null, pinned: true, repairable: true },
    stars: null,
    labels: [],
    ...extra,
  }
}

/** A radar-repos (github-head) offering. */
function head(repo, extra = {}) {
  return off('radar-repos', repo.split('/')[1], {
    version: null,
    repo,
    title: repo.split('/')[1],
    install: { kind: 'github-head', spec: `github:${repo}`, registry: null, pinned: false, repairable: false },
    ...extra,
  })
}

const src = (id, offerings, trust = 'browse') => ({ id, trust, offerings })
const byKey = (items) => Object.fromEntries(items.map((it) => [it.key, it]))

test('same name and same repo across sources merges into one item, offers in priority order', () => {
  const { items, conflicts, bySource } = mergeCatalog([
    src('awesome', [off('awesome', 'dsh-foo', { repo: 'a/foo', version: '1.0.0' })], 'builtin'),
    src('who', [off('who', 'DSH-Foo', { repo: 'a/foo', version: '2.0.0' })]),
  ])
  assert.equal(items.length, 1)
  assert.deepEqual(conflicts, [])
  const it = items[0]
  assert.equal(it.key, 'n:dsh-foo')
  assert.equal(it.name, 'dsh-foo')
  assert.equal(it.conflict, false)
  assert.deepEqual(it.offers.map((o) => o.sourceId), ['awesome', 'who'])
  assert.equal(it.offers[0].trust, 'builtin')
  assert.equal(it.chosen, 0)
  assert.equal(it.offers[it.chosen].version, '1.0.0', 'highest priority wins even with an older version')
  assert.equal(bySource.awesome.items, 1)
  assert.equal(bySource.who.items, 1)
})

test('same name and different repos become conflict items with distinct keys', () => {
  const { items, conflicts } = mergeCatalog([
    src('awesome', [off('awesome', 'dsh-foo', { repo: 'a/foo' })]),
    src('who', [off('who', 'dsh-foo', { repo: 'b/foo' })]),
  ])
  assert.equal(items.length, 2)
  const keys = items.map((it) => it.key)
  assert.deepEqual(keys, ['n:dsh-foo#a/foo/', 'n:dsh-foo#b/foo/'])
  assert.ok(items.every((it) => it.conflict))
  assert.deepEqual(conflicts, [{ name: 'dsh-foo', keys }])
})

test('offerings without a repo attach to the highest-priority offering that has one', () => {
  const { items } = mergeCatalog([
    src('s0', [off('s0', 'x')]),
    src('s1', [off('s1', 'x', { repo: 'b/x' })]),
    src('s2', [off('s2', 'x', { repo: 'c/x' })]),
    src('s3', [off('s3', 'x')]),
  ])
  const k = byKey(items)
  assert.equal(items.length, 2)
  assert.deepEqual(k['n:x#b/x/'].offers.map((o) => o.sourceId), ['s0', 's1', 's3'])
  assert.deepEqual(k['n:x#c/x/'].offers.map((o) => o.sourceId), ['s2'])
})

test('offerings with no repo at all form one item', () => {
  const { items } = mergeCatalog([src('s0', [off('s0', 'x')]), src('s1', [off('s1', 'x')])])
  assert.equal(items.length, 1)
  assert.equal(items[0].key, 'n:x')
  assert.equal(items[0].repo, null)
  assert.equal(items[0].radarShared, 0)
})

test('a directory-less offer of a repo joins that repo\'s directory cluster', () => {
  const { items } = mergeCatalog([
    src('awesome', [off('awesome', 'p', { repo: 'm/mono' })]),
    src('who', [off('who', 'p', { repo: 'm/mono', directory: '/packages/p/' })]),
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].key, 'n:p')
  assert.equal(items[0].directory, 'packages/p')
})

test('same name in different directories of one repo conflicts', () => {
  const { items } = mergeCatalog([
    src('s0', [off('s0', 'p', { repo: 'm/mono', directory: 'a' })]),
    src('s1', [off('s1', 'p', { repo: 'm/mono', directory: 'b' })]),
  ])
  assert.deepEqual(items.map((it) => it.key), ['n:p#m/mono/a', 'n:p#m/mono/b'])
})

test('monorepo packages stay separate items and report radarShared', () => {
  const radar = new Map([['m/mono', { verdict: 'ok', stars: 50 }]])
  const { items } = mergeCatalog([
    src('awesome', [
      off('awesome', 'mono-a', { repo: 'm/mono', directory: 'packages/a' }),
      off('awesome', 'mono-b', { repo: 'm/mono', directory: 'packages/b' }),
      off('awesome', 'solo', { repo: 's/solo' }),
    ]),
  ], { radar })
  const k = byKey(items)
  assert.equal(k['n:mono-a'].radarShared, 2)
  assert.equal(k['n:mono-b'].radarShared, 2)
  assert.equal(k['n:solo'].radarShared, 1)
  assert.equal(k['n:mono-a'].radar, 'ok')
  assert.equal(k['n:mono-b'].stars, 50)
})

test('radar-repo offerings are dropped when another item covers the repo, kept as gh: otherwise', () => {
  const { items, bySource } = mergeCatalog([
    src('awesome', [off('awesome', 'mono-a', { repo: 'm/mono', directory: 'packages/a' })]),
    src('radar-repos', [head('m/mono'), head('o/lonely', { description: 'lonely one', stars: 3 })]),
  ])
  const k = byKey(items)
  assert.equal(items.length, 2)
  assert.ok(k['n:mono-a'])
  const gh = k['gh:o/lonely']
  assert.ok(gh)
  assert.equal(gh.name, 'lonely')
  assert.equal(gh.offers[0].install.kind, 'github-head')
  assert.equal(gh.offers[0].version, null)
  assert.equal(gh.stars, 3)
  assert.equal(gh.radarShared, 1)
  assert.equal(bySource['radar-repos'].dropped, 1)
  assert.equal(bySource['radar-repos'].items, 1)
})

test('a radar repo is dropped even when the covering item comes from a lower-priority source', () => {
  const { items } = mergeCatalog([
    src('radar-repos', [head('o/x')]),
    src('npm', [off('npm', 'dsh-x', { repo: 'o/x' })]),
  ])
  assert.deepEqual(items.map((it) => it.key), ['n:dsh-x'])
})

test('chosen offer: same source ties broken by newer version', () => {
  const { items } = mergeCatalog([
    src('s0', [
      off('s0', 'Tie', { repo: 'o/tie', version: '1.2.0' }),
      off('s0', 'tie', { repo: 'o/tie', version: '1.10.0' }),
    ]),
    src('s1', [off('s1', 'tie', { repo: 'o/tie', version: '9.0.0' })]),
  ])
  assert.equal(items.length, 1)
  const it = items[0]
  assert.deepEqual(it.offers.map((o) => `${o.sourceId}@${o.version}`), ['s0@1.10.0', 's0@1.2.0', 's1@9.0.0'])
  assert.equal(it.chosen, 0)
  assert.equal(it.name, 'tie', 'name comes from the chosen offer')
})

test('title/description/category fall back to the next source that has them', () => {
  const { items } = mergeCatalog([
    src('s0', [off('s0', 'f', { repo: 'o/f', title: '  ', description: { zh: '' }, homepage: 'https://h0' })]),
    src('s1', [off('s1', 'f', { title: 'Nice F', category: 'tools', icon: 'https://i1', keywords: ['a', 'b'] })]),
    src('s2', [off('s2', 'f', { description: { en: 'Desc' }, category: 'ui', keywords: ['b', 'c'], publishedAt: 1800000000 })]),
  ])
  const it = items[0]
  assert.equal(it.title, 'Nice F')
  assert.deepEqual(it.description, { en: 'Desc' })
  assert.equal(it.category, 'tools')
  assert.equal(it.categorySource, 's1')
  assert.equal(it.homepage, 'https://h0')
  assert.equal(it.icon, 'https://i1')
  assert.deepEqual(it.keywords, ['a', 'b', 'c'])
  assert.equal(it.updatedAt, 1800000000)
  assert.equal(it.repo, 'o/f')
})

test('stars: radar wins, else max source stars, else null; radar verdict overlay', () => {
  const radar = new Map([
    ['o/r', { verdict: 'incompatible', stars: 7 }],
    ['o/nostars', { verdict: 'untested' }],
  ])
  const { items } = mergeCatalog([
    src('s0', [
      off('s0', 'r', { repo: 'o/r', stars: 100 }),
      off('s0', 'nostars', { repo: 'o/nostars', stars: 4 }),
      off('s0', 'none', { repo: 'o/none' }),
    ]),
    src('s1', [off('s1', 'nostars', { repo: 'o/nostars', stars: 9 })]),
  ], { radar })
  const k = byKey(items)
  assert.equal(k['n:r'].stars, 7)
  assert.equal(k['n:r'].radar, 'incompatible')
  assert.equal(k['n:nostars'].stars, 9)
  assert.equal(k['n:nostars'].radar, 'untested')
  assert.equal(k['n:none'].stars, null)
  assert.equal(k['n:none'].radar, null)
})

test('mergeCatalog rejects bad input and skips malformed offerings', () => {
  assert.throws(() => mergeCatalog(null), TypeError)
  assert.throws(() => mergeCatalog([{ id: 'x' }]), TypeError)
  assert.throws(() => mergeCatalog([], { radar: {} }), TypeError)
  const { items, bySource } = mergeCatalog([src('s', [null, { name: 'x' }, off('s', 'ok')])])
  assert.equal(items.length, 1)
  assert.equal(bySource.s.skipped, 2)
  assert.equal(bySource.s.offerings, 1)
})

test('compareVersions follows semver precedence', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1)
  assert.equal(compareVersions('nope', '0.0.1'), -1)
  assert.equal(compareVersions(null, null), 0)
})

/** A small catalog for query tests. */
function sample() {
  const radar = new Map([
    ['o/alpha', { verdict: 'ok', stars: 30 }],
    ['o/beta', { verdict: 'incompatible', stars: 10 }],
    ['o/gamma', { verdict: 'pending', stars: 20 }],
    ['o/delta', { verdict: 'untested' }],
  ])
  const merged = mergeCatalog([
    src('awesome', [
      off('awesome', 'alpha-chart', { repo: 'o/alpha', category: 'ui', title: 'Alpha Chart', publishedAt: 300 }),
      off('awesome', 'beta-memory', { repo: 'o/beta', category: 'memory', description: { zh: '记忆插件', en: 'Memory plugin' }, publishedAt: 100 }),
      off('awesome', 'gamma-tool', { repo: 'o/gamma', category: 'tools', keywords: ['chart'] }),
    ]),
    src('who', [
      off('who', 'alpha-chart', { repo: 'o/alpha', category: 'charts' }),
      off('who', 'delta-ui', { repo: 'o/delta', category: 'ui', publishedAt: 200 }),
      off('who', 'epsilon', { directory: 'pkg/eps', install: { kind: 'git', spec: 'git+https://github.com/z/eps.git#' + 'a'.repeat(40) + '&path:/pkg/eps', registry: null, pinned: true, repairable: false } }),
    ]),
  ], { radar })
  return buildIndex(merged.items)
}

const names = (res) => res.items.map((it) => it.name)

test('query: words AND across name, title, description, keywords, spec', () => {
  const ix = sample()
  assert.deepEqual(names(queryCatalog(ix, { q: 'chart', sort: 'name' })), ['alpha-chart', 'gamma-tool'])
  assert.deepEqual(names(queryCatalog(ix, { q: 'ALPHA  chart' })), ['alpha-chart'])
  assert.deepEqual(names(queryCatalog(ix, { q: '记忆' })), ['beta-memory'])
  assert.deepEqual(names(queryCatalog(ix, { q: 'git+https://github.com/z/eps' })), ['epsilon'])
  assert.deepEqual(names(queryCatalog(ix, { q: 'pkg/eps' })), ['epsilon'])
  assert.deepEqual(names(queryCatalog(ix, { q: 'chart memory' })), [])
  assert.equal(queryCatalog(ix, {}).total, 5)
})

test('query: source, category, radar filters and predicate', () => {
  const ix = sample()
  assert.deepEqual(names(queryCatalog(ix, { sources: ['who'], sort: 'name' })), ['alpha-chart', 'delta-ui', 'epsilon'])
  assert.deepEqual(names(queryCatalog(ix, { sources: ['nope'] })), [])
  assert.deepEqual(names(queryCatalog(ix, { category: 'ui', sort: 'name' })), ['alpha-chart', 'delta-ui'])
  assert.deepEqual(names(queryCatalog(ix, { radar: 'pending', sort: 'name' })), ['delta-ui', 'gamma-tool'])
  assert.deepEqual(names(queryCatalog(ix, { radar: 'none' })), ['epsilon'])
  assert.deepEqual(names(queryCatalog(ix, { radar: 'ok' })), ['alpha-chart'])
  assert.deepEqual(names(queryCatalog(ix, { predicate: (it) => it.name.startsWith('e') })), ['epsilon'])
})

test('facets exclude their own filter and include the others', () => {
  const ix = sample()
  const res = queryCatalog(ix, { sources: ['who'], category: 'ui', radar: 'ok' })
  assert.deepEqual(names(res), ['alpha-chart'])
  // sources facet: category=ui and radar=ok apply, source filter does not
  assert.deepEqual(res.facets.sources, { awesome: 1, who: 1 })
  // categories facet: sources=who and radar=ok apply
  assert.deepEqual(res.facets.categories, { ui: 1 })
  // radar facet: sources=who and category=ui apply
  assert.deepEqual(res.facets.radar, { ok: 1, incompatible: 0, pending: 1, none: 0 })

  const all = queryCatalog(ix, {})
  assert.deepEqual(all.facets.sources, { awesome: 3, who: 3 })
  assert.deepEqual(all.facets.categories, { ui: 2, memory: 1, tools: 1 })
  assert.deepEqual(all.facets.radar, { ok: 1, incompatible: 1, pending: 2, none: 1 })

  const pred = queryCatalog(ix, { radar: 'ok', predicate: (it) => it.name !== 'beta-memory' })
  assert.equal(pred.facets.radar.incompatible, 0, 'predicate applies to facets too')
  const text = queryCatalog(ix, { q: 'chart' })
  assert.deepEqual(text.facets.categories, { ui: 1, tools: 1 }, 'text query applies to facets')
})

test('sorts: stars and updated put nulls last, ties by name', () => {
  const ix = sample()
  assert.deepEqual(names(queryCatalog(ix, {})), ['alpha-chart', 'gamma-tool', 'beta-memory', 'delta-ui', 'epsilon'])
  assert.deepEqual(names(queryCatalog(ix, { sort: 'updated' })), ['alpha-chart', 'delta-ui', 'beta-memory', 'epsilon', 'gamma-tool'])
  assert.deepEqual(names(queryCatalog(ix, { sort: 'name' })), ['alpha-chart', 'beta-memory', 'delta-ui', 'epsilon', 'gamma-tool'])
})

test('paging: offset and limit slice the sorted result, total is unaffected', () => {
  const ix = sample()
  const p1 = queryCatalog(ix, { sort: 'name', offset: 0, limit: 2 })
  const p2 = queryCatalog(ix, { sort: 'name', offset: 2, limit: 2 })
  const p3 = queryCatalog(ix, { sort: 'name', offset: 4, limit: 2 })
  assert.deepEqual([...names(p1), ...names(p2), ...names(p3)], ['alpha-chart', 'beta-memory', 'delta-ui', 'epsilon', 'gamma-tool'])
  assert.equal(p3.total, 5)
  assert.equal(queryCatalog(ix, { offset: 99 }).items.length, 0)
  const bad = queryCatalog(ix, { offset: -3, limit: 0 })
  assert.equal(bad.offset, 0)
  assert.equal(bad.limit, 50)
  assert.equal(queryCatalog(ix, { limit: 1e9 }).limit, 1000)
})

test('queryCatalog validates its options', () => {
  const ix = sample()
  assert.throws(() => queryCatalog({}, {}), TypeError)
  assert.throws(() => queryCatalog(ix, { sort: 'random' }), TypeError)
  assert.throws(() => queryCatalog(ix, { radar: 'maybe' }), TypeError)
  assert.throws(() => queryCatalog(ix, { sources: 'who' }), TypeError)
  assert.throws(() => queryCatalog(ix, { q: 3 }), TypeError)
  assert.throws(() => queryCatalog(ix, { predicate: true }), TypeError)
  assert.throws(() => buildIndex(null), TypeError)
})

/** A git offering (repo derived from the git URL, as the readers do). */
function git(sourceId, name, url, extra = {}) {
  return off(sourceId, name, {
    install: { kind: 'git', spec: `git+${url}.git#${'a'.repeat(40)}`, registry: null, pinned: true, repairable: false },
    ...extra,
  })
}

test('a repo-less git offering does not join another plugin\'s card: it is its own cluster, shown as a conflict', () => {
  const { items, conflicts } = mergeCatalog([
    src('awesome', [off('awesome', 'dsh-plugin-other', { repo: 'good/other' })], 'builtin'),
    src('u1', [git('u1', 'dsh-plugin-other', 'https://gitlab.com/evil/payload')], 'trusted'),
  ])
  assert.equal(items.length, 2)
  for (const it of items) assert.equal(it.conflict, true)
  const good = items.find((it) => it.repo === 'good/other')
  assert.deepEqual(good.offers.map((o) => o.sourceId), ['awesome'])
  const evil = items.find((it) => it.repo === null)
  assert.match(evil.key, /^n:dsh-plugin-other#url:[0-9a-f]{12}$/)
  assert.deepEqual(evil.offers.map((o) => o.install.spec), [`git+https://gitlab.com/evil/payload.git#${'a'.repeat(40)}`])
  assert.equal(conflicts.length, 1)
  // even ranked first, the off-GitHub git offer never becomes the trusted card's spec
  const flipped = mergeCatalog([
    src('u1', [git('u1', 'dsh-plugin-other', 'https://gitlab.com/evil/payload')], 'trusted'),
    src('awesome', [off('awesome', 'dsh-plugin-other', { repo: 'good/other' })], 'builtin'),
  ])
  const card = flipped.items.find((it) => it.repo === 'good/other')
  assert.equal(card.offers[0].install.spec, 'dsh-plugin-other@1.0.0')
})

test('repo-less npm offerings still join the repo cluster; git offerings of one location stay together', () => {
  const { items } = mergeCatalog([
    src('a', [off('a', 'p', { repo: 'o/p' })], 'builtin'),
    src('b', [off('b', 'p', { version: '1.1.0' })]),
  ])
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].offers.map((o) => o.sourceId), ['a', 'b'])
  const loose = mergeCatalog([
    src('a', [git('a', 'q', 'https://gitlab.com/o/q')]),
    src('b', [off('b', 'q', { install: { kind: 'git', spec: `git+https://gitlab.com/O/Q.git#${'b'.repeat(40)}`, registry: null, pinned: true, repairable: false } })]),
  ])
  assert.equal(loose.items.length, 1, 'same location, different commits: one card')
  assert.equal(loose.items[0].key, 'n:q')
  const mixed = mergeCatalog([src('a', [off('a', 'r')]), src('b', [git('b', 'r', 'https://gitlab.com/o/r')])])
  assert.equal(mixed.items.length, 2, 'a repo-less npm package and an off-GitHub git repo are different plugins')
})

test('facets count catalog ids that collide with Object.prototype names', () => {
  const { items } = mergeCatalog([src('__proto__', [off('__proto__', 'a', { category: '__proto__' }), off('__proto__', 'b', { category: 'tools' })])])
  const r = queryCatalog(buildIndex(items), {})
  assert.equal(r.total, 2)
  assert.deepEqual(Object.entries(r.facets.categories).sort(), [['__proto__', 1], ['tools', 1]])
  assert.deepEqual(Object.entries(r.facets.sources), [['__proto__', 2]])
  assert.equal(JSON.parse(JSON.stringify(r.facets)).categories.__proto__, 1)
  assert.equal(Object.getPrototypeOf(r.facets.categories), Object.prototype, 'no pollution, plain object')
  assert.equal(queryCatalog(buildIndex(items), { category: '__proto__' }).total, 1)
})
