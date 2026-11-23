import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { detect, id, read, title } from '../lib/sources/community/omni-catalog.js'

const dir = new URL('./fixtures/sources/', import.meta.url)
const load = (url) => JSON.parse(readFileSync(url, 'utf8'))
const OMNI = load(new URL('./community/omni-catalog.json', dir))
const SHA = 'c'.repeat(40)

/** A minimal valid source entry; `over` replaces top-level fields. */
const entry = (over = {}) => ({
  schemaVersion: 1,
  name: 'dsh-x',
  description: { en: 'x', evidencePath: 'README.md' },
  kind: 'plugin',
  source: { repository: 'https://github.com/o/x', subpath: null, commit: SHA },
  package: { ecosystem: 'source' },
  dsh: { profiles: ['web'] },
  verification: { status: 'eligible' },
  popularity: { starsPolicy: 'exact-repository', stars: 3 },
  ...over,
})
const doc = (entries) => ({ format: 'omni-dsh-catalog-v1', catalogRevision: 'r', count: entries.length, entries })

test('omni-catalog: interface and strict detect', () => {
  assert.equal(id, 'omni-catalog')
  assert.ok(title.zh && title.en)
  assert.equal(detect(OMNI), true)
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    assert.equal(detect(load(new URL(name, dir))), false, name)
  }
  for (const d of [null, [], 'x', { format: 1, plugins: [] }, { schemaVersion: 5, plugins: [] }, { objects: [], total: 0 },
    { schema: 'dsh-radar/v1', plugins: [] }, { format: 'omni-dsh-catalog-v2', catalogRevision: 'r', entries: [] },
    { format: 'omni-dsh-catalog-v1', entries: [] }, { format: 'omni-dsh-catalog-v1', catalogRevision: 'r', entries: {} },
    { ...doc([]), plugins: [] }]) {
    assert.equal(detect(d), false, JSON.stringify(d)?.slice(0, 60))
  }
  assert.throws(() => read({ format: 1, plugins: [] }, { sourceId: 's' }), TypeError)
  assert.throws(() => read(OMNI, {}), TypeError)
  assert.throws(() => read(OMNI), TypeError)
})

test('omni-catalog: real entries become pinned npm or git offerings', () => {
  const r = read(OMNI, { sourceId: 'omni', hostVersion: '0.2.1' })
  assert.equal(r.skipped, 0)
  assert.deepEqual(r.warnings, [])
  assert.equal(r.offerings.length, OMNI.entries.length)
  const by = new Map(r.offerings.map((o) => [`${o.name}|${o.repo}`, o]))
  for (const o of r.offerings) assert.equal(o.install.pinned, true)

  const mem = by.get('dsh-project-memory|00080000/dsh-project-memory')
  assert.deepEqual(mem.install, {
    kind: 'git', spec: 'git+https://github.com/00080000/dsh-project-memory.git#338b96e73786967c6486a6507940bd393b0a7203',
    registry: null, pinned: true, repairable: false,
  })
  assert.deepEqual(mem.description, { en: OMNI.entries[0].description.en }, 'evidencePath is not a locale')
  assert.equal(mem.category, 'memory-rag')
  assert.equal(mem.stars, 1)
  assert.deepEqual(mem.labels, ['omni:profile-web'])

  // monorepo subpath: identity is the fork it installs from, whatever package name it claims; parent stars dropped
  const cli = by.get('@deepseek-ai/dsh-cli-app|007m7/deepcode')
  assert.equal(cli.install.spec,
    'git+https://github.com/007M7/DeepCode.git#a0edf49d2e41adfa573bf3c5656f0cafee3caf45&path:/packages/bundle/cli-app')
  assert.equal(cli.directory, 'packages/bundle/cli-app')
  assert.equal(cli.stars, null)

  // npm (cross-checked against registry.npmjs.org: same version and integrity, repository Ultronen/dsh-archived-chats)
  const chats = by.get('dsh-archived-chats|ultronen/dsh-archived-chats')
  assert.deepEqual(chats.install, { kind: 'npm', spec: 'dsh-archived-chats@1.4.1', registry: null, pinned: true, repairable: true })
  assert.equal(chats.title, 'Archive Management', 'entry name is the display title, package name is the name')
  assert.equal(chats.version, '1.4.1')

  const preview = by.get('@undeadsheep/dsh-file-preview|undeadsheep/dsh-file-preview')
  assert.equal(preview.install.spec, '@undeadsheep/dsh-file-preview@0.1.2')
  assert.equal(preview.directory, 'packages/dsh-file-preview')
  assert.deepEqual(preview.labels, ['omni:profile-default'])

  assert.deepEqual(by.get('dsh-chat-manager|wsl043/dsh-chat-manager').labels, ['omni:archived', 'omni:profile-web'])
  assert.ok(r.offerings.some((o) => o.labels.includes('omni:skin-theme')))
  assert.ok(r.offerings.some((o) => o.labels.includes('omni:client-interface')))
  // one name from several repos stays as several offerings (merge.js shows the conflict)
  assert.equal(r.offerings.filter((o) => o.name === 'dsh-file-upload').length, 2)
  assert.equal(r.offerings.filter((o) => o.name === '@deepseek-ai/dsh-tui').length, 2)
})

test('omni-catalog: never uses the unpinned install string or a declared identity', () => {
  const r = read(doc([entry({ install: 'dsh plugin add github:evil/payload', repository: 'https://github.com/good/popular' })]),
    { sourceId: 's' })
  assert.equal(r.offerings[0].install.spec, `git+https://github.com/o/x.git#${SHA}`)
  assert.equal(r.offerings[0].repo, 'o/x')
})

test('omni-catalog: bad entries are skipped and tallied, duplicates prefer npm', () => {
  const src = (over) => ({ repository: 'https://github.com/o/x', subpath: null, commit: SHA, ...over })
  const entries = [
    entry(),
    entry({ package: { ecosystem: 'npm', name: 'dsh-x', version: '1.0.0' } }), // same identity, npm wins
    7,
    entry({ schemaVersion: 2 }),
    entry({ source: null }),
    entry({ source: src({ repository: 'https://gitlab.com/o/x' }) }),
    entry({ source: src({ repository: 'javascript:alert(1)' }) }),
    entry({ source: src({ repository: `https://github.com/o/${'x'.repeat(400)}` }) }),
    entry({ source: src({ commit: 'abc123' }) }),
    entry({ source: src({ commit: SHA.toUpperCase() }) }),
    entry({ source: src({ subpath: '../up' }) }),
    entry({ source: src({ subpath: '/abs/' }) }),
    entry({ name: 7 }),
    entry({ name: 'a'.repeat(300) }),
    entry({ package: { ecosystem: 'npm', name: '-x', version: '1.0.0' } }),
    entry({ package: { ecosystem: 'npm', name: 'Up', version: '1.0.0' } }),
    entry({ package: { ecosystem: 'npm', name: 'dsh-y', version: 'latest' } }),
    entry({ name: 'dsh-z', description: 'd'.repeat(5000), tags: ['A', 'a', 'b'], popularity: { starsPolicy: 'exact-repository', stars: -1 } }),
  ]
  const r = read(doc(entries), { sourceId: 's' })
  assert.deepEqual(r.offerings.map((o) => `${o.name} ${o.install.kind}`), ['dsh-x npm', 'dsh-z git'])
  assert.deepEqual(r.skippedBy, {
    duplicate: 1, 'invalid-entry': 3, 'invalid-source': 7, 'invalid-name': 3, 'invalid-spec': 1, 'no-valid-version': 1,
  })
  assert.equal(r.skipped, 16)
  assert.ok(r.warnings.length > 0 && r.warnings.length <= 20)
  const z = r.offerings[1]
  assert.equal(z.description.length, 600)
  assert.deepEqual(z.keywords, ['a', 'b'])
  assert.equal(z.stars, null)
  for (const o of r.offerings) assert.ok(!o.install.spec.startsWith('-'))
})

test('omni-catalog: raw values are never coerced into labels or links (regression: one entry threw)', () => {
  const npmSub = (commit) => entry({
    source: { repository: 'https://github.com/o/x', subpath: 'packages/x', commit },
    package: { ecosystem: 'npm', name: 'dsh-x', version: '1.0.0' },
  })
  const r = read(doc([
    entry({ name: 'a', dsh: { profiles: [{ toString: 1 }, null, 7, 'web', 'Bad!'] } }),
    npmSub({ toString: 1 }),
    entry({ name: 'b', source: { repository: 'https://github.com/o/b', subpath: 'p', commit: 'main/../../../evil?x=1' },
      package: { ecosystem: 'npm', name: 'b', version: '1.0.0' } }),
    npmSub(SHA),
  ]), { sourceId: 's' })
  const a = r.offerings.find((o) => o.name === 'a')
  assert.deepEqual(a.labels, ['s:profile-web'])
  assert.equal(r.offerings.find((o) => o.name === 'b').homepage, 'https://github.com/o/b')
  const xs = r.offerings.filter((o) => o.name === 'dsh-x')
  assert.equal(xs.length, 1, 'same name + repo + directory: one offering')
  assert.equal(r.skippedBy.duplicate, 1)
  // the first npm entry (bad commit) is kept; its link drops the /tree path
  assert.equal(xs[0].homepage, 'https://github.com/o/x')
  assert.equal(read(doc([npmSub(SHA)]), { sourceId: 's' }).offerings[0].homepage, `https://github.com/o/x/tree/${SHA}/packages/x`)
})
