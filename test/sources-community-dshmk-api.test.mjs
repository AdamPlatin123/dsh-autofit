import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import * as dshmk from '../lib/sources/community/dshmk-api.js'

const dir = new URL('./fixtures/sources/', import.meta.url)
const load = (url) => JSON.parse(readFileSync(url, 'utf8'))
const DOC = load(new URL('community/dshmk-api.json', dir))
const SHA = 'a'.repeat(40)

/** A minimal valid document around `rows`. */
function doc(rows) {
  return { schemaVersion: 1, generatedAt: '2026-11-21T00:00:00Z', source: { label: 'GitHub Topic', topic: 'dsh-plugin' }, stats: { fetched: rows.length }, repositories: rows }
}
const row = (fullName, extra = {}) => ({ fullName, stars: 1, validation: { verified: true, sourceSha: SHA }, ...extra })

test('exports the community adapter interface', () => {
  assert.equal(dshmk.id, 'dshmk-api')
  assert.equal(typeof dshmk.title.zh, 'string')
  assert.equal(typeof dshmk.title.en, 'string')
  assert.deepEqual(Object.keys(dshmk).sort(), ['detect', 'id', 'read', 'title'])
})

test('detect is true on the live fixture and false on every other family', () => {
  assert.equal(dshmk.detect(DOC), true)
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    assert.equal(dshmk.detect(load(new URL(name, dir))), false, name)
  }
  // Other community families' fixtures, whichever exist when the suite runs.
  const community = new URL('community/', dir)
  for (const name of readdirSync(community).filter((f) => f.endsWith('.json') && f !== 'dshmk-api.json')) {
    assert.equal(dshmk.detect(load(new URL(name, community))), false, `community/${name}`)
  }
  // The same repo's older catalog.json: same envelope, rows without validation.
  const catalog = { ...DOC, repositories: DOC.repositories.map(({ validation, install, ...rest }) => rest) }
  assert.equal(dshmk.detect(catalog), false)
  for (const bad of [null, [], 'x', { format: 1, plugins: [] }, { schemaVersion: 5, plugins: [] },
    { schema: 'dsh-radar/v1', plugins: [] }, { objects: [], total: 0 }, { ...DOC, schemaVersion: 2 },
    { ...DOC, source: null }, { ...DOC, stats: {} }, { ...DOC, plugins: [] }, { ...DOC, repositories: {} }]) {
    assert.equal(dshmk.detect(bad), false, JSON.stringify(bad)?.slice(0, 60))
  }
  assert.equal(dshmk.detect(doc([])), false, 'empty list without stats.validationStatuses')
  assert.equal(dshmk.detect({ ...doc([]), stats: { fetched: 0, validationStatuses: {} } }), true)
})

test('read pins every live row to its validated commit', () => {
  const r = dshmk.read(DOC, { sourceId: 'dshmk', hostVersion: '0.2.1' })
  assert.equal(r.skipped, 0)
  assert.deepEqual(r.skippedBy, {})
  assert.deepEqual(r.warnings, [])
  assert.equal(r.offerings.length, DOC.repositories.length)
  const by = new Map(r.offerings.map((o) => [o.repo, o]))
  const whale = by.get('meteornox/deepseek-balance-whale-widget')
  assert.equal(whale.name, 'DeepSeek-Balance-Whale-Widget')
  assert.equal(whale.title, 'DeepSeek-Balance-Whale-Widget')
  assert.deepEqual(whale.install, {
    kind: 'git',
    spec: 'git+https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget.git#5247dd6813d6e4430728f39ccc63d43cda046022',
    registry: null,
    pinned: true,
    repairable: false,
  })
  assert.equal(whale.directory, null)
  assert.equal(whale.version, null)
  assert.equal(whale.stars, 7403)
  assert.equal(whale.category, 'development')
  assert.equal(whale.homepage, 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget')
  assert.deepEqual(whale.labels, ['dshmk:verified'])
  assert.ok(whale.keywords.includes('dsh-plugin') && whale.keywords.length <= 12)
  assert.ok(whale.description.startsWith('DeepSeek Harness'))
  // README-mined candidates point elsewhere; identity and spec still follow fullName.
  const uiskin = by.get('chouxiaohuai/dsh-uiskin-theme')
  assert.equal(uiskin.install.spec,
    'git+https://github.com/chouxiaohuai/dsh-uiskin-theme.git#a355a9b16ba692b7551ffac0a6a6a9fea1149e49')
  assert.equal(by.get('zseven-w/dsh-game-studio').homepage, 'https://finiking.github.io/dsh-games/wall/')
  assert.equal(by.get('ftshare-lab/dsh_kline').name, 'dsh_kline')
  for (const o of r.offerings) {
    assert.equal(o.sourceId, 'dshmk')
    assert.match(o.install.spec, /^git\+https:\/\/github\.com\/[^#]+\.git#[0-9a-f]{40}$/)
  }
})

test('read skips bad rows and tallies them', () => {
  const r = dshmk.read(doc([
    row('ok/one'),
    row('OK/One'),
    null,
    { fullName: 'no/validation' },
    row('bad/sha', { validation: { sourceSha: 'A'.repeat(40) } }),
    row('short/sha', { validation: { sourceSha: 'abc' } }),
    row('not a repo'),
    row('a/.dsh-plugin'),
    row('ok/two', { stars: -1, archived: true, validation: { verified: false, sourceSha: SHA } }),
  ]), { sourceId: 's' })
  assert.deepEqual(r.offerings.map((o) => o.name), ['one', 'two'])
  assert.deepEqual(r.skippedBy, { duplicate: 1, 'invalid-entry': 2, 'invalid-source': 3, 'invalid-name': 1 })
  assert.equal(r.skipped, 7)
  assert.equal(r.warnings.length, 7)
  assert.equal(r.offerings[1].stars, null)
  assert.deepEqual(r.offerings[1].labels, ['s:archived'])
})

test('hostile values are rejected or neutralized by the offer.js builders', () => {
  const long = `x/${'a'.repeat(3000)}`
  const r = dshmk.read(doc([
    row(long),
    row('-x/evil'),
    row('a/b', { validation: { sourceSha: `${SHA} --upload-pack=x` } }),
    row('a/c', { homepage: 'javascript:alert(1)', description: 'd'.repeat(5000), category: 'c'.repeat(100), topics: ['x'.repeat(80), 'ok'] }),
    row('a/d', { validation: { sourceSha: SHA }, url: 'https://github.com/evil/other', install: { candidates: [{ source: 'github', specifier: 'github:evil/other' }] } }),
  ]), { sourceId: 's' })
  assert.deepEqual(r.offerings.map((o) => o.repo), ['-x/evil', 'a/c', 'a/d'])
  assert.equal(r.skippedBy['invalid-name'], 1, 'overlong repo name')
  assert.equal(r.skippedBy['invalid-source'], 1, 'non-40-hex commit')
  const [dash, c, d] = r.offerings
  assert.ok(dash.install.spec.startsWith('git+https://'), 'a leading - never starts the spec')
  assert.equal(c.homepage, 'https://github.com/a/c')
  assert.ok(c.description.length <= 600)
  assert.equal(c.category, null)
  assert.deepEqual(c.keywords, ['ok'])
  assert.equal(d.repo, 'a/d', 'identity is what is installed, not url or candidates')
  assert.equal(d.install.spec, `git+https://github.com/a/d.git#${SHA}`)
})

test('read throws TypeError on other documents and a missing sourceId', () => {
  assert.throws(() => dshmk.read({ format: 1, plugins: [] }, { sourceId: 's' }), TypeError)
  assert.throws(() => dshmk.read(DOC, {}), TypeError)
  assert.throws(() => dshmk.read(DOC), TypeError)
})
