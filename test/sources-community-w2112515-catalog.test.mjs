import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import * as adapter from '../lib/sources/community/w2112515-catalog.js'

const { detect, read } = adapter
const dir = new URL('./fixtures/sources/', import.meta.url)
const load = (url) => JSON.parse(readFileSync(url, 'utf8'))
const CATALOG = load(new URL('community/w2112515-catalog.json', dir))
const SHA = 'c'.repeat(40)

const entry = (over = {}) => ({
  repositoryId: '1',
  repository: { fullName: 'o/p', url: 'https://github.com/o/p', defaultBranch: 'main', commitSha: SHA, archived: false },
  package: { name: 'p', version: '1.0.0', description: 'd' },
  topics: ['t'],
  keywords: ['k'],
  stars: 1,
  lastCodePushAt: '2026-10-01T00:00:00Z',
  source: { kind: 'git', ref: `git+https://github.com/o/p.git#${SHA}`, packageJsonPath: 'package.json' },
  validation: { status: 'valid', code: 'valid-bundle', message: null },
  compatibility: 'unknown',
  installability: 'one-click-eligible',
  riskSignals: ['git-source'],
  ...over,
})
const doc = (entries) => ({
  schemaVersion: 1, generatedAt: '2026-11-21T00:00:00Z', scannerVersion: '7', topic: 'dsh-plugin',
  integrity: { algorithm: 'sha256', digest: '0'.repeat(64) }, summary: { entryCount: entries.length }, entries,
})

test('exports the community adapter interface', () => {
  assert.deepEqual(Object.keys(adapter).sort(), ['detect', 'id', 'read', 'title'])
  assert.equal(adapter.id, 'w2112515-catalog')
  assert.ok(adapter.title.zh && adapter.title.en)
})

test('detect: true for catalog-v1, false for every other family', () => {
  assert.equal(detect(CATALOG), true)
  assert.equal(detect(doc([])), true)
  const others = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, load(new URL(f, dir))])
  for (const f of readdirSync(new URL('community/', dir))) {
    if (!f.endsWith('.json') || f === 'w2112515-catalog.json') continue
    try {
      others.push([`community/${f}`, load(new URL(`community/${f}`, dir))])
    } catch {
      // another adapter's fixture that is still being written
    }
  }
  assert.ok(others.length >= 5)
  for (const [f, d] of others) assert.equal(detect(d), false, f)
  const { entries, ...head } = CATALOG
  for (const d of [null, [], 'x', { format: 1, plugins: [] }, { schemaVersion: 1, entries: [] },
    { ...head, entries, plugins: [] }, { ...head, entries, schemaVersion: 2 }, { ...head, entries: {} },
    { ...head, entries, integrity: 'x' }, { ...head, entries: [7] }]) {
    assert.equal(detect(d), false, JSON.stringify(d)?.slice(0, 60))
  }
})

test('read: real entries become pinned git offerings built from source.ref', () => {
  const r = read(CATALOG, { sourceId: 'w', hostVersion: '0.2.1' })
  assert.deepEqual(r.skippedBy, { 'invalid-name': 2 }, '_turn-sound and a non-ASCII scoped name are not package names')
  assert.equal(r.offerings.length, CATALOG.entries.length - 2)
  const by = new Map(r.offerings.map((o) => [o.repo, o]))
  const memory = by.get('00080000/dsh-project-memory')
  assert.equal(memory.name, '@yolk_vat-y/dsh-project-memory')
  assert.equal(memory.version, '0.7.1')
  assert.deepEqual(memory.install, {
    kind: 'git', spec: 'git+https://github.com/00080000/dsh-project-memory.git#d8b4788e2ae535768bb643440b4eeb22812d1830',
    registry: null, pinned: true, repairable: false,
  })
  assert.equal(memory.homepage, 'https://github.com/00080000/dsh-project-memory')
  assert.equal(memory.stars, 32)
  assert.equal(memory.publishedAt, Math.floor(Date.parse('2026-11-21T07:00:23Z') / 1000))
  assert.deepEqual(memory.labels, [])
  assert.equal(memory.engines, null)
  assert.deepEqual(by.get('0-v-0/dsh-grantwrite-patch').labels, ['w:manual'])
  assert.deepEqual(by.get('030611/qiushi-dsh-evidence-audit').labels, ['w:manual', 'w:lifecycle-script'])
  assert.deepEqual(by.get('01men/boxfill').keywords, CATALOG.entries[4].topics.slice(0, 12), 'topics when keywords are empty')
  assert.equal(by.get('1624318455/dsh-plugin-adapter').version, null, 'a non-string version is dropped')
  assert.equal(by.get('1015677515/dsh-prompt-errornotes-desk').name, 'dsh-prompt-ErrorNotes-desk', 'repo is lowercase')
  // one package name from two repos: both stay, merge.js shows the conflict
  assert.deepEqual(r.offerings.filter((o) => o.name === 'dsh-council').map((o) => o.repo),
    ['0131kikimy/dsh-council', 'fufengyuan/dsh-council'])
  for (const o of r.offerings) {
    const e = CATALOG.entries.find((x) => x.repository.fullName.toLowerCase() === o.repo)
    assert.equal(o.install.spec, e.source.ref)
  }
})

test('read: schema checks and skipped entries', () => {
  assert.throws(() => read({ format: 1, plugins: [] }, { sourceId: 'w' }), TypeError)
  assert.throws(() => read(CATALOG, {}), TypeError)
  assert.throws(() => read(CATALOG), TypeError)
  const r = read(doc([
    entry(),
    entry({ repository: { fullName: 'o/p2' } }), // same ref → duplicate repo
    entry({ validation: { status: 'invalid' } }),
    entry({ package: { name: 'Bad Name', version: '1.0.0' } }),
    entry({ package: null }),
    entry({ source: { kind: 'npm', ref: 'p@1.0.0' } }),
    entry({ source: { kind: 'git', ref: `git+https://github.com/o/q.git#${SHA}`, packageJsonPath: 'packages/q/package.json' } }),
    7,
  ]), { sourceId: 'w' })
  assert.deepEqual(r.offerings.map((o) => o.repo), ['o/p'])
  assert.deepEqual(r.skippedBy, { duplicate: 1, 'unknown-verdict': 1, 'invalid-name': 1, 'invalid-entry': 2, 'invalid-source': 2 })
  assert.equal(r.skipped, 7)
  assert.ok(r.warnings.length > 0)
})

test('read: identity is the repo the ref installs from, not the declared repository', () => {
  const r = read(doc([entry({
    repository: { fullName: 'good/popular', url: 'https://github.com/good/popular', commitSha: SHA },
    package: { name: 'popular', version: '9.9.9' },
    source: { kind: 'git', ref: `git+https://github.com/Evil/Payload.git#${SHA}` },
  })]), { sourceId: 'w' })
  assert.equal(r.offerings[0].repo, 'evil/payload')
  assert.equal(r.offerings[0].homepage, 'https://github.com/Evil/Payload')
  assert.equal(r.offerings[0].install.spec, `git+https://github.com/Evil/Payload.git#${SHA}`)
})

test('read: hostile refs and values are rejected', () => {
  const refs = [
    `javascript:alert(1)//github.com/o/p.git#${SHA}`,
    `git+http://github.com/o/p.git#${SHA}`,
    `git+https://evil.example/o/p.git#${SHA}`,
    `git+https://user:pw@github.com/o/p.git#${SHA}`,
    `git+https://github.com/o/p.git#${'C'.repeat(40)}`,
    'git+https://github.com/o/p.git#main',
    `git+https://github.com/o/p.git#${SHA.slice(1)}`,
    `git+https://github.com/o/p.git?x=1#${SHA}`,
    `git+https://github.com/o/p.git#${SHA}&path:/../x`,
    `git+https://github.com/o/../p.git#${SHA}`,
    `-git+https://github.com/o/p.git#${SHA}`,
    `git+https://github.com/o/p .git#${SHA}`,
    `git+https://github.com/o/${'a'.repeat(3000)}.git#${SHA}`,
  ]
  const r = read(doc(refs.map((ref, i) => entry({ package: { name: `p${i}`, version: '1.0.0' }, source: { kind: 'git', ref } }))),
    { sourceId: 'w' })
  assert.deepEqual(r.offerings, [])
  assert.deepEqual(r.skippedBy, { 'invalid-source': refs.length - 1, 'invalid-spec': 1 })
  const long = read(doc([entry({ package: { name: 'p', version: '1.0.0', description: 'x'.repeat(100000) }, keywords: ['y'.repeat(60), 'ok'] })]),
    { sourceId: 'w' })
  assert.equal(long.offerings[0].description.length, 600)
  assert.deepEqual(long.offerings[0].keywords, ['ok'])
  const name = read(doc([entry({ package: { name: 'x'.repeat(300), version: '1.0.0' } })]), { sourceId: 'w' })
  assert.deepEqual(name.skippedBy, { 'invalid-name': 1 })
})
