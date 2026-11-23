import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { detect, id, read, title } from '../lib/sources/community/yelebai-registry.js'

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const DOC = load('./fixtures/sources/community/yelebai-registry.json')
const SHA = 'a'.repeat(40)

const entry = (over = {}, install = {}) => ({
  owner: 'o',
  repo: 'p',
  fullName: 'o/p',
  description: 'd',
  stars: 1,
  packageName: 'p',
  version: '1.0.0',
  verifiedCommit: SHA,
  htmlUrl: 'https://github.com/o/p',
  topics: ['dsh-plugin'],
  ...over,
  install: { mode: 'automatic', source: 'github', spec: `github:o/p#${SHA}`, ...install },
})
const doc = (plugins) => ({ schemaVersion: 2, generatedAt: '2026-11-12T18:47:30.683Z', plugins })

test('id and title', () => {
  assert.equal(id, 'yelebai-registry')
  assert.equal(typeof title.zh, 'string')
  assert.equal(typeof title.en, 'string')
})

test('detect: true for the registry, false for every other family', () => {
  assert.equal(detect(DOC), true)
  for (const f of readdirSync(new URL('./fixtures/sources/', import.meta.url))) {
    if (!f.endsWith('.json')) continue
    assert.equal(detect(load(`./fixtures/sources/${f}`)), false, f)
  }
  for (const f of readdirSync(new URL('./fixtures/sources/community/', import.meta.url))) {
    if (!f.endsWith('.json') || f === 'yelebai-registry.json') continue
    assert.equal(detect(load(`./fixtures/sources/community/${f}`)), false, f)
  }
  const shopLike = { schemaVersion: 2, generatedAt: 'x', plugins: [{ name: 'p', source: 'npm', version: '1.0.0' }] }
  for (const d of [null, [], 'x', doc([]), shopLike, { ...DOC, schemaVersion: 5 }, { ...DOC, generatedAt: 1 },
    { ...DOC, format: 1 }, { schemaVersion: 2, plugins: DOC.plugins }]) {
    assert.equal(detect(d), false, JSON.stringify(d)?.slice(0, 60))
  }
  assert.equal(detect(doc([7, entry()])), true, 'one junk row in the sample does not reject the document')
})

test('read: real entries become pinned git and npm installs', () => {
  const r = read(DOC, { sourceId: 'yb', hostVersion: '0.2.1' })
  assert.equal(r.offerings.length, DOC.plugins.length - 4)
  assert.deepEqual(r.skippedBy, { 'ambiguous-repo': 4 })
  const by = (repo, name) => r.offerings.find((o) => o.repo === repo && (!name || o.name === name))
  const git = by('00080000/dsh-project-memory')
  assert.equal(git.name, '@yolk_vat-y/dsh-project-memory', 'the name is packageName')
  assert.deepEqual(git.install, {
    kind: 'git', spec: 'git+https://github.com/00080000/dsh-project-memory.git#34d5f5084068956357bb326638165938e67543fa',
    registry: null, pinned: true, repairable: false,
  })
  assert.equal(git.version, '0.7.0')
  assert.equal(git.stars, 33)
  assert.equal(git.homepage, 'https://github.com/00080000/dsh-project-memory')
  assert.equal(git.description, 'Read-time project memory plugin for DeepSeek Harness (dsh)')
  assert.ok(git.keywords.includes('dsh-plugin'))
  assert.deepEqual(git.labels, [])
  const mixed = by('01ngvi-qingyi/dsh-mistral-pro')
  assert.equal(mixed.install.spec,
    'git+https://github.com/01NGVI-QINGYI/dsh-mistral-pro.git#263a4f0e7f62438eb3c5ab05c89c51a5aa7e9ae8')
  const npm = by('0-v-0/dsh-grantwrite-patch')
  assert.deepEqual(npm.install, { kind: 'npm', spec: 'dsh-grantwrite-patch@0.1.0', registry: null, pinned: true, repairable: true })
  assert.equal(by('0xsline/dsh-spotlight').install.spec, '@0xsline/dsh-spotlight@0.0.2')
  assert.equal(by('jcs130/dsh-minecraft-agent').version, '0.3.0-rc.26')
  assert.deepEqual(by('030611/dsh-verification-receipt').labels, ['yb:guided'])
  assert.equal(by('jydsh/dsh-ding-card').version, null, '2026.11.06 is not semver; still offered at its commit')
  // two repos with the same package name both stay: merge.js shows the conflict
  assert.equal(r.offerings.filter((o) => o.name === 'dsh-token-stats').length, 2)
})

test('read: an npm package listed by several repos is skipped, not offered repo-less (regression)', () => {
  const r = read(DOC, { sourceId: 'yb' })
  assert.deepEqual(r.offerings.filter((o) => o.name === 'memory-eternal' || o.name === 'dsh-record-replay'), [])
  // merge.js would attach a repo-less npm offering to another author's repo card of the same name
  const contested = read(doc([
    entry({ fullName: 'a/kanban', packageName: 'kanban' }, { source: 'npm', spec: 'kanban@1.0.0' }),
    entry({ fullName: 'b/kanban', packageName: 'kanban', htmlUrl: 'https://github.com/b/kanban' },
      { source: 'npm', spec: 'kanban@1.0.0' }),
    entry({ fullName: 'c/kanban', packageName: 'kanban' }, { spec: `github:c/kanban#${SHA}` }),
  ]), { sourceId: 'yb' })
  assert.deepEqual(contested.offerings.map((o) => [o.install.kind, o.repo]), [['git', 'c/kanban']])
  assert.deepEqual(contested.skippedBy, { 'ambiguous-repo': 2 })
  // the same repo listing its own package twice is not contested
  const own = read(doc([
    entry({ packageName: 'k', version: '1.0.0' }, { source: 'npm', spec: 'k@1.0.0' }),
    entry({ packageName: 'k', version: '1.1.0' }, { source: 'npm', spec: 'k@1.1.0' }),
  ]), { sourceId: 'yb' })
  assert.deepEqual(own.offerings.map((o) => [o.install.spec, o.repo]), [['k@1.1.0', 'o/p']])
})

test('read: bad entries are skipped and counted', () => {
  const r = read(doc([
    entry(),
    7,
    entry({ fullName: 'o/q', packageName: 'q' }, { spec: `github:o/q#${SHA}&path:/x` }),
    entry({ fullName: 'o/r', packageName: 'r' }, { spec: 'github:o/r' }),
    entry({ fullName: 'o/s', packageName: 's' }, { spec: `github:o/..#${SHA}` }),
    entry({ packageName: 'n', version: '1.0.0' }, { source: 'npm', spec: 'n@2.0.0' }),
    entry({ packageName: 'm', version: 'latest' }, { source: 'npm', spec: 'm@latest' }),
    entry({ packageName: 'Up', version: '1.0.0' }, { source: 'npm', spec: 'Up@1.0.0' }),
    entry({ packageName: 'g' }, { source: 'gitlab', spec: 'gitlab:o/g' }),
    entry({ packageName: 'p' }, { source: 'npm', spec: 'p@1.0.0' }),
    { install: 'x' },
  ]), { sourceId: 'yb' })
  assert.deepEqual(r.offerings.map((o) => `${o.name} ${o.install.kind} ${o.repo}`), ['p npm o/p'])
  assert.deepEqual(r.skippedBy, {
    'invalid-entry': 2, 'invalid-source': 4, 'invalid-spec': 1, 'no-valid-version': 1, 'invalid-name': 1, duplicate: 1,
  })
  assert.equal(r.skipped, 10)
  assert.ok(r.warnings.length > 0)
})

test('read: hostile values are rejected by the offer.js builders', () => {
  const long = 'x'.repeat(5000)
  const r = read(doc([
    entry({ packageName: '-rf' }, { source: 'npm', spec: '-rf@1.0.0' }),
    entry({ packageName: '-rf' }),
    entry({ packageName: 'a' }, { spec: 'github:o/p#ABCDEF' + '0'.repeat(34) }),
    entry({ packageName: 'b' }, { spec: 'github:o/p#deadbeef' }),
    entry({ packageName: 'c' }, { spec: `github:-o/p#${SHA}` }),
    entry({ packageName: 'd' }, { spec: `javascript:alert(1)#${SHA}` }),
    entry({ packageName: long }),
    entry({ packageName: 'e', version: `1.0.0-${long}` }, { source: 'npm', spec: `e@1.0.0-${long}` }),
    entry({ packageName: 'f', description: long, htmlUrl: 'javascript:alert(1)' }, { source: 'npm', spec: 'f@1.0.0' }),
  ]), { sourceId: 'yb' })
  assert.deepEqual(r.offerings.map((o) => o.name), ['-rf', 'f'])
  const [dash, f] = r.offerings
  assert.equal(dash.install.spec, `git+https://github.com/o/p.git#${SHA}`, 'a git spec never starts with the name')
  assert.ok(f.description.length <= 600)
  assert.equal(f.repo, 'o/p')
  assert.equal(f.homepage, 'https://github.com/o/p', 'homepage comes from the repo, not the stated htmlUrl')
  for (const htmlUrl of ['javascript:alert(1)', 'https://github.com/someone/else']) {
    const noRepo = read(doc([entry({ fullName: 'bad', htmlUrl }, { source: 'npm', spec: 'p@1.0.0' })]),
      { sourceId: 'yb' }).offerings[0]
    assert.equal(noRepo.repo, null)
    assert.equal(noRepo.homepage, null, 'no repo → no homepage from the stated htmlUrl')
  }
  assert.equal(r.skipped, 7)
  assert.equal(r.skippedBy['invalid-spec'], 1, '-rf@1.0.0 fails isSafeSpec')
})

test('read: git identity is the installed repo, never fullName', () => {
  const [o] = read(doc([entry({ fullName: 'victim/famous', htmlUrl: 'https://github.com/victim/famous' })]),
    { sourceId: 'yb' }).offerings
  assert.equal(o.repo, 'o/p')
  assert.equal(o.homepage, 'https://github.com/o/p')
})

test('read: throws TypeError on other documents or a missing sourceId', () => {
  assert.throws(() => read({ schemaVersion: 5, plugins: [] }, { sourceId: 's' }), TypeError)
  assert.throws(() => read(DOC, {}), TypeError)
  assert.throws(() => read(DOC), TypeError)
})
