import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import * as lanshu from '../lib/sources/community/lanshu-api.js'
import { detectFormat } from '../lib/sources/adapters.js'

const dir = new URL('./fixtures/sources/', import.meta.url)
const fixture = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'))
const DOC = fixture('community/lanshu-api.json')
const SHA = 'a'.repeat(40)

/** A minimal pinned row in the API's shape; the site's install command follows repo/commit/url unless given. */
const row = (over = {}) => {
  const r = {
    id: 'o/p', name: 'p', owner: 'o', repo: 'o/p', url: 'https://github.com/o/p', category: 'tools',
    description: { en: 'x', zh: 'x' }, curated: false, stars: 1, homepage: null,
    manifest: { state: 'verified', packageName: 'p', version: '1.0.0', lifecycleScripts: [] },
    screening: { state: 'review' }, attention: { level: 'review', reasons: [] }, screenedCommit: SHA,
    ...over,
  }
  if (!('installCommand' in over)) {
    const dir = /\/tree\/[^/]+\/(.+)$/.exec(r.url ?? '')?.[1]
    r.installCommand = `dsh plugin --profile web add github:${r.repo}#${r.screenedCommit}${dir ? `&path:/${dir}` : ''}`
  }
  return r
}
const doc = (plugins) => ({ ...DOC, plugins })
const readOne = (r) => lanshu.read(doc([r]), { sourceId: 's' })

test('lanshu-api exports the community adapter interface', () => {
  assert.equal(lanshu.id, 'lanshu-api')
  assert.equal(typeof lanshu.title.zh, 'string')
  assert.equal(typeof lanshu.title.en, 'string')
  assert.equal(typeof lanshu.detect, 'function')
  assert.equal(typeof lanshu.read, 'function')
})

test('detect: true on the live fixture, false on every other source family', () => {
  assert.equal(lanshu.detect(DOC), true)
  assert.equal(lanshu.detect(doc([])), true)
  const others = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.ok(others.length >= 5)
  for (const f of others) assert.equal(lanshu.detect(fixture(f)), false, f)
  // and on the other community families' fixtures, whichever exist
  for (const f of readdirSync(new URL('community/', dir))) {
    if (f.endsWith('.json') && f !== 'lanshu-api.json') assert.equal(lanshu.detect(fixture(`community/${f}`)), false, f)
  }
  for (const d of [null, [], 'x', 4, { schemaVersion: 4, plugins: [] }, { format: 1, plugins: [] },
    { schemaVersion: 5, plugins: { url: 'p.json', sha256: 'a'.repeat(64) } }, { objects: [], total: 0 },
    { schema: 'dsh-radar/v1', plugins: [] }, { ...DOC, plugins: [{ name: 'x', version: '1.0.0' }] },
    { ...DOC, format: 1 }, { ...DOC, automation: [] }]) {
    assert.equal(lanshu.detect(d), false, JSON.stringify(d)?.slice(0, 60))
  }
  // schemaVersion 4 with a plugins array: the shared detector must not take it for shop data
  assert.equal(detectFormat(DOC), 'community:lanshu-api')
})

test('read: throws TypeError for foreign documents, other schema versions and a missing sourceId', () => {
  assert.throws(() => lanshu.read(fixture('shop-plugins.json'), { sourceId: 's' }), TypeError)
  assert.throws(() => lanshu.read({ ...DOC, schemaVersion: 5 }, { sourceId: 's' }),
    { name: 'TypeError', message: 'unsupported lanshuagent schemaVersion' })
  assert.throws(() => lanshu.read(DOC, {}), TypeError)
  assert.throws(() => lanshu.read(DOC), TypeError)
})

test('read: live fixture → pinned git offerings only where the site issued the install command', () => {
  const r = lanshu.read(DOC, { sourceId: 'lanshu', hostVersion: '0.5.0' })
  const issued = DOC.plugins.filter((p) => p.screenedCommit && p.installCommand && p.screening.state !== 'blocked')
  assert.equal(r.offerings.length, issued.length)
  assert.equal(r.offerings.length + r.skipped, DOC.plugins.length)
  assert.deepEqual(r.skippedBy, { unpinned: 4, 'screening-blocked': 3, 'not-issued': 5 })
  for (const o of r.offerings) {
    const src = DOC.plugins.find((p) => p.repo.toLowerCase() === o.repo)
    assert.equal(o.install.kind, 'git')
    assert.equal(o.install.pinned, true)
    assert.equal(o.install.spec, `git+https://github.com/${src.repo}.git#${src.screenedCommit}`)
    assert.ok(src.installCommand.endsWith(`github:${src.repo}#${src.screenedCommit}`))
  }
  // checked by hand against the live API (2026-11-21)
  const navbar = r.offerings.find((o) => o.repo === 'vlln/dsh-navbar')
  assert.deepEqual(
    [navbar.name, navbar.version, navbar.category, navbar.stars, navbar.homepage, navbar.install.spec, navbar.labels],
    ['@vlln/dsh-navbar', '0.4.0', 'ui', 11, 'https://github.com/vlln/dsh-navbar',
      'git+https://github.com/vlln/dsh-navbar.git#e53adfc8c837ebcb4b6a52c2c4baf7cb6e8b795e',
      ['lanshu:curated', 'lanshu:screening-clear']])
  // screened rows the site withholds an install for (installCommand null) are not offered, whatever their findings
  for (const repo of ['saikel-orado-liu/dsh-cost-meter', 'techflag/dsh-plugin-ssh', 'mxl2498/dsh-balance']) {
    assert.equal(r.offerings.find((o) => o.repo === repo), undefined, repo)
  }
  assert.ok(r.warnings.length > 0 && r.warnings.length <= 20)
})

test('read: names, lifecycle label and same-name repos', () => {
  const meter = readOne(row({ manifest: { packageName: '@x/meter', version: '1.0.0', lifecycleScripts: ['postinstall'] } }))
    .offerings[0]
  assert.equal(meter.name, '@x/meter', 'name is the manifest package, not the repo')
  assert.ok(meter.labels.includes('s:lifecycle-scripts'))
  // a manifest name npm would reject falls back to the repo name
  assert.equal(readOne(row({ manifest: { packageName: 'Bad Name', version: '1.0.0' } })).offerings[0].name, 'p')
  // two repos publishing the same package name stay separate offerings (merge.js shows the conflict)
  const two = lanshu.read(doc([row({ repo: 'a/lens' }), row({ repo: 'b/lens' })]), { sourceId: 's' })
  assert.equal(two.offerings.length, 2)
})

test('read: only the install command the site issued is offered (regression: null command was offered)', () => {
  const skip = (over) => readOne(row(over)).skippedBy
  assert.deepEqual(skip({ installCommand: null }), { 'not-issued': 1 })
  assert.deepEqual(skip({ installCommand: `dsh plugin add github:o/p#${'b'.repeat(40)}` }), { 'not-issued': 1 })
  assert.deepEqual(skip({ installCommand: `dsh plugin add github:evil/p#${SHA}` }), { 'not-issued': 1 })
  assert.deepEqual(skip({ installCommand: `dsh plugin add github:o/p#${SHA}; rm -rf /` }), { 'not-issued': 1 })
  assert.deepEqual(skip({ installCommand: { toString: 1 } }), { 'not-issued': 1 })
  // a monorepo row needs a command naming its directory
  assert.deepEqual(skip({ url: 'https://github.com/o/p/tree/main/packages/x', installCommand: `dsh plugin add github:o/p#${SHA}` }),
    { 'not-issued': 1 })
  assert.deepEqual(skip({ installCommand: `dsh plugin add github:o/p#${SHA}` }), {})
})

test('read: codex-pick only when the review was made at the installed commit', () => {
  const at = (reviewedCommit) => readOne(row({ codexPick: { reviewedCommit } })).offerings[0].labels
  assert.ok(at(SHA).includes('s:codex-pick'))
  assert.ok(!at('c'.repeat(40)).includes('s:codex-pick'))
  assert.ok(!at(undefined).includes('s:codex-pick'))
})

test('read: a monorepo url names the installed directory; another repo in the url is refused', () => {
  const ok = readOne(row({ url: 'https://github.com/o/p/tree/main/packages/x' }))
  assert.equal(ok.offerings[0].directory, 'packages/x')
  assert.equal(ok.offerings[0].install.spec, `git+https://github.com/o/p.git#${SHA}&path:/packages/x`)
  const other = readOne(row({ url: 'https://github.com/evil/q/tree/main/packages/x' }))
  assert.deepEqual(other.skippedBy, { 'invalid-source': 1 })
  const dotdot = readOne(row({ url: 'https://github.com/o/p/tree/main/../x' }))
  assert.equal(dotdot.offerings.length, 0)
})

test('read: identity is the installed repo, never a declared one; duplicates of repo + directory are skipped', () => {
  const r = lanshu.read(doc([
    row({ repo: 'evil/payload', homepage: 'https://github.com/good/popular', manifest: { packageName: 'popular', version: '1.0.0' } }),
    row(), row({ repo: 'O/P' }), 'junk', null, row({ manifest: null }),
  ]), { sourceId: 's' })
  assert.deepEqual(r.offerings.map((o) => [o.name, o.repo]), [['popular', 'evil/payload'], ['p', 'o/p']])
  assert.deepEqual(r.skippedBy, { duplicate: 1, 'invalid-entry': 3 })
})

test('read: hostile values are rejected by the offer.js builders', () => {
  const skip = (over) => readOne(row(over)).skippedBy
  assert.deepEqual(skip({ screenedCommit: 'A'.repeat(40) }), { 'invalid-source': 1 })
  assert.deepEqual(skip({ screenedCommit: 'a'.repeat(39) }), { 'invalid-source': 1 })
  assert.deepEqual(skip({ screenedCommit: `${SHA} --upload-pack=x` }), { 'invalid-source': 1 })
  assert.deepEqual(skip({ screenedCommit: 1234 }), { 'invalid-source': 1 })
  assert.deepEqual(skip({ repo: '-o/p' }), {}, 'a leading dash in the owner still yields a git+https spec')
  assert.ok(readOne(row({ repo: '-o/p' })).offerings[0].install.spec.startsWith('git+https://'))
  assert.deepEqual(skip({ repo: 'o/p x' }), { 'invalid-source': 1 })
  assert.deepEqual(skip({ repo: 'o/..' }), { 'invalid-source': 1 })
  assert.deepEqual(skip({ repo: 'o/p/q' }), { 'invalid-source': 1 })
  assert.deepEqual(skip({ repo: `o/${'p'.repeat(3000)}` }), { 'invalid-spec': 1 })
  assert.deepEqual(skip({ screenedCommit: null }), { unpinned: 1 })
  assert.deepEqual(skip({ screening: { state: 'blocked' } }), { 'screening-blocked': 1 })
  const o = readOne(row({
    homepage: 'javascript:alert(1)', name: 'x'.repeat(5000), description: { en: 'd'.repeat(5000), 'bad locale!': 'y' },
    manifest: { packageName: '-evil', version: 'not-semver' }, category: 'c'.repeat(100), stars: -1,
  })).offerings[0]
  assert.equal(o.homepage, 'https://github.com/o/p')
  assert.equal(o.title.length, 200)
  assert.deepEqual(Object.keys(o.description), ['en'])
  assert.equal(o.description.en.length, 600)
  assert.equal(o.version, null)
  assert.equal(o.category, null)
  assert.equal(o.stars, null)
  assert.ok(!o.install.spec.startsWith('-'))
})
