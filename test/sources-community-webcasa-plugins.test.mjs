import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { detect, id, read, title } from '../lib/sources/community/webcasa-plugins.js'

const load = (rel) => JSON.parse(readFileSync(new URL(`./fixtures/sources/${rel}`, import.meta.url), 'utf8'))
const DOC = load('community/webcasa-plugins.json')
const SOURCE = 'webcasa'

const entry = (over = {}) => ({
  slug: 'x',
  name: 'dsh-x',
  nameZh: 'dsh-x',
  description: 'X',
  descriptionZh: 'X',
  npmPackage: 'dsh-x',
  categories: ['workflow'],
  repoUrl: 'https://github.com/a/dsh-x',
  author: 'a',
  license: 'MIT',
  latestVersion: '1.0.0',
  downloadsCached: 0,
  stars: 1,
  securityStatus: 'clean',
  sourceType: 'registry',
  installCommand: 'dsh plugin --profile <name> add dsh-x',
  cordisUrl: 'https://cordis.run/plugins/x',
  ...over,
})
const doc = (plugins) => ({ version: '2026-08-25', total: plugins.length, generatedAt: '2026-08-25T00:00:00Z', plugins })

test('module shape', () => {
  assert.equal(id, 'webcasa-plugins')
  assert.equal(typeof title.zh, 'string')
  assert.equal(typeof title.en, 'string')
})

test('detect: true for the live fixture, false for every other family', () => {
  assert.equal(detect(DOC), true)
  const dir = new URL('./fixtures/sources/', import.meta.url)
  const others = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.ok(others.length >= 5)
  for (const f of others) assert.equal(detect(load(f)), false, f)
  for (const d of [null, [], 'x', { plugins: [] }, { format: 1, plugins: [entry()] },
    { ...doc([entry()]), schemaVersion: 5 }, { ...doc([entry()]), version: '1.0.0' }, doc([]),
    doc([{ slug: 'x', name: 'y' }]), { schema: 'dsh-radar/v1', ...doc([entry()]) }]) {
    assert.equal(detect(d), false, JSON.stringify(d)?.slice(0, 60))
  }
  assert.equal(detect(doc([entry()])), true)
})

test('read: real registry and github entries', () => {
  const r = read(DOC, { sourceId: SOURCE, hostVersion: '0.5.0' })
  assert.equal(r.skipped, 0)
  assert.equal(r.offerings.length, DOC.plugins.length)
  const byName = new Map(r.offerings.map((o) => [o.name, o]))

  const modlens = byName.get('@liustack/modlens')
  assert.deepEqual(modlens.install, { kind: 'npm', spec: '@liustack/modlens@3.24.2', registry: null, pinned: true, repairable: true })
  assert.equal(modlens.version, '3.24.2')
  assert.equal(modlens.repo, 'liustack/modlens')
  assert.equal(modlens.homepage, 'https://github.com/liustack/modlens')
  assert.equal(modlens.stars, 3604)
  assert.equal(modlens.category, 'plugin-productivity')
  assert.equal(modlens.description.en, 'Plug-in vision for text-only LLMs, powered by the free Antigravity CLI')
  assert.equal(typeof modlens.description.zh, 'string')

  // github: name is the declared package name, identity and spec are the repo that gets installed.
  const genui = byName.get('@changfenhuang/dsh-genui')
  assert.deepEqual(genui.install, { kind: 'github-head', spec: 'github:omdsh-dev/dsh-genui', registry: null, pinned: false, repairable: false })
  assert.equal(genui.repo, 'omdsh-dev/dsh-genui')
  assert.equal(genui.version, null, 'an unpinned head has no stated version')
  const teams = byName.get('@nanmicoder/dsh-agent-teams')
  assert.equal(teams.install.spec, 'github:NanmiCoder/dsh-agent-teams', 'spec keeps the case the list states')
  assert.equal(teams.repo, 'nanmicoder/dsh-agent-teams')
  const delivery = byName.get('delivery-review-plugin')
  assert.equal(delivery.repo, 'xiaoxiao-svg/delivery-review-dsh-plugin')

  assert.equal(byName.get('dsh-skill-manager').stars, null, 'null stars')
  assert.equal(byName.get('@dsh-plugin/dsh-review-loop').description, null, 'null description')
  const same = r.offerings.find((o) => typeof o.description === 'string')
  assert.ok(same, 'identical en/zh collapses to one string')
  assert.equal(r.offerings.filter((o) => o.install.kind === 'npm').length, DOC.plugins.filter((p) => p.sourceType === 'registry').length)
})

test('read: bad entries are skipped and tallied', () => {
  const r = read(doc([
    entry(),
    null,
    entry({ npmPackage: 'Bad Name' }),
    entry({ npmPackage: 'dsh-y', latestVersion: '2026-08-01' }),
    entry({ npmPackage: 'dsh-z', sourceType: 'gitlab' }),
    entry({ sourceType: 'github', name: 'g', npmPackage: 'https://github.com/a/b/tree/main/pkg' }),
    entry({ sourceType: 'github', name: 'g', npmPackage: 'https://gitlab.com/a/b' }),
    entry({ sourceType: 'github', name: 'g', npmPackage: 'https://github.com/a/b#deadbeef' }),
    entry({ sourceType: 'github', name: 'dsh-x', npmPackage: 'https://github.com/a/dsh-x' }),
    entry(),
    entry({ sourceType: 'github', name: 'gh-ok', npmPackage: 'https://github.com/o/gh-ok.git', securityStatus: 'flagged' }),
  ]), { sourceId: SOURCE })
  assert.deepEqual(r.offerings.map((o) => `${o.name} ${o.install.spec}`),
    ['dsh-x dsh-x@1.0.0', 'gh-ok github:o/gh-ok'])
  assert.deepEqual(r.skippedBy, { 'invalid-entry': 1, 'invalid-name': 1, 'no-valid-version': 1, 'invalid-source': 4, duplicate: 2 })
  assert.equal(r.skipped, 9)
  assert.ok(r.warnings.length > 0)
  assert.deepEqual(r.offerings[1].labels, [`${SOURCE}:security-flagged`])
  assert.deepEqual(r.offerings[0].labels, [])
})

test('read: an npm entry beats a github-head entry of the same name and repo', () => {
  const r = read(doc([
    entry({ sourceType: 'github', name: 'dsh-x', npmPackage: 'https://github.com/a/dsh-x' }),
    entry(),
  ]), { sourceId: SOURCE })
  assert.equal(r.offerings.length, 1)
  assert.equal(r.offerings[0].install.kind, 'npm')
})

test('read: a github entry shows repoUrl and stars only when repoUrl is the installed repo (regression)', () => {
  const r = read(doc([
    entry({ sourceType: 'github', name: 'cool', npmPackage: 'https://github.com/evil/payload',
      repoUrl: 'https://github.com/famous/cool', stars: 9000 }),
    entry({ sourceType: 'github', name: 'mine', npmPackage: 'https://github.com/a/mine', repoUrl: 'https://github.com/A/mine', stars: 3 }),
  ]), { sourceId: SOURCE })
  assert.deepEqual(r.offerings.map((o) => [o.repo, o.homepage, o.stars]), [
    ['evil/payload', 'https://github.com/evil/payload', null],
    ['a/mine', 'https://github.com/A/mine', 3],
  ])
})

test('read: hostile values are rejected by the offer.js builders', () => {
  const long = 'a'.repeat(3000)
  const r = read(doc([
    entry({ npmPackage: '-dsh-x' }),
    entry({ npmPackage: `dsh-${long}` }),
    entry({ npmPackage: 'dsh-v', latestVersion: `1.0.0-${long}` }),
    entry({ sourceType: 'github', name: 'g1', npmPackage: 'javascript:alert(1)' }),
    entry({ sourceType: 'github', name: 'g2', npmPackage: 'https://github.com/-x/../y' }),
    entry({ sourceType: 'github', name: 'g3', npmPackage: 'https://github.com/a/..' }),
    entry({ sourceType: 'github', name: 'g4', npmPackage: 'https://user:pw@github.com/a/b' }),
    entry({ npmPackage: 'dsh-ok', repoUrl: 'javascript:alert(1)', cordisUrl: 'javascript:alert(2)', description: long, stars: -5 }),
  ]), { sourceId: SOURCE })
  assert.equal(r.offerings.length, 1)
  const ok = r.offerings[0]
  assert.equal(ok.name, 'dsh-ok')
  assert.equal(ok.homepage, null)
  assert.equal(ok.repo, null)
  assert.equal(ok.stars, null)
  assert.equal(ok.description.en.length, 600)
  assert.equal(ok.description.zh, 'X')
  assert.equal(r.skipped, 7)
})

test('read: TypeErrors for wrong documents and missing sourceId', () => {
  assert.throws(() => read({ format: 1, plugins: [] }, { sourceId: SOURCE }), TypeError)
  assert.throws(() => read(DOC, {}), TypeError)
  assert.throws(() => read(DOC), TypeError)
})
