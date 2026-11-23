import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { REASON, detect, id, read, title } from '../lib/sources/community/awesome-plugins.js'

const load = (path) => JSON.parse(readFileSync(new URL(`./fixtures/sources/${path}`, import.meta.url), 'utf8'))
const DOC = load('community/awesome-plugins.json')
const clone = () => structuredClone(DOC)
const byName = (offerings, name) => offerings.find((o) => o.name === name)
const entry = (fields) => ({
  name: 'x', owner: 'o', url: 'https://github.com/o/x', npm: null, version: null,
  install: 'dsh plugin --profile web add github:o/x', ...fields,
})
const docWith = (...plugins) => ({ ...clone(), plugins })

test('awesome-plugins: id and title', () => {
  assert.equal(id, 'awesome-plugins')
  assert.ok(title.zh && title.en)
})

test('awesome-plugins: detect is true for its own fixture and false for every other fixture', () => {
  assert.equal(detect(DOC), true)
  const dir = new URL('./fixtures/sources/', import.meta.url)
  const others = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f)
  for (const f of readdirSync(new URL('community/', dir))) {
    if (f.endsWith('.json') && f !== 'awesome-plugins.json') others.push(`community/${f}`)
  }
  assert.ok(others.length >= 5)
  for (const f of others) assert.equal(detect(load(f)), false, f)
  for (const junk of [null, [], 'x', {}, { plugins: [] }, { ...DOC, format: 1 }, { ...DOC, schemaVersion: 5 },
    { ...DOC, categories: [] }, { ...DOC, plugins: [{ name: 'a', url: 'u' }] }]) {
    assert.equal(detect(junk), false)
  }
  // One malformed leading entry does not hide the document; read skips it.
  const oneBad = docWith(null, ...DOC.plugins)
  assert.equal(detect(oneBad), true)
  assert.equal(read(oneBad, { sourceId: 's' }).skippedBy['invalid-entry'], 1)
})

test('awesome-plugins: read rejects other documents and a missing sourceId', () => {
  assert.throws(() => read({ format: 1, plugins: [] }, { sourceId: 's' }), TypeError)
  assert.throws(() => read(DOC, {}), TypeError)
  assert.throws(() => read(DOC), TypeError)
})

test('awesome-plugins: real entries → npm, release tarball and github-head offerings', () => {
  const { offerings, skipped, skippedBy, warnings } = read(DOC, { sourceId: 'ap' })
  assert.equal(offerings.length, 16)
  assert.equal(skipped, 3)
  assert.deepEqual(skippedBy, { [REASON.latestTarball]: 1, [REASON.subdirHead]: 2 })
  assert.equal(warnings.length, 3)

  // npm in a monorepo subdir: name from `npm`, repo + directory from `url`.
  const living = byName(offerings, 'dsh-living')
  assert.equal(living.install.spec, 'dsh-living@0.3.14')
  assert.equal(living.install.kind, 'npm')
  assert.equal(living.install.repairable, true)
  assert.equal(living.title, 'dsh-living#core')
  assert.equal(living.repo, 'alexisvon/dsh-living')
  assert.equal(living.directory, 'packages/core')
  assert.equal(living.homepage, 'https://github.com/AlexisVon/dsh-living/tree/main/packages/core')
  assert.equal(byName(offerings, '@anonyjcy/dsh-j-space').install.spec, '@anonyjcy/dsh-j-space@1.2.6')

  // npm preferred over the entry's tarball, and over an unpinned /releases/latest/ tarball.
  assert.equal(byName(offerings, '@benrong/dsh-prompt-polish').install.kind, 'npm')
  assert.equal(byName(offerings, 'dsh-outsourcing-expert').install.spec, 'dsh-outsourcing-expert@1.2.5')

  // Release tarball: pinned, repo is the repo it is served from, version from the release tag.
  const whale = byName(offerings, 'dsh-big-fat-whale-maid-adaptive')
  assert.equal(whale.install.kind, 'tarball')
  assert.equal(whale.install.pinned, true)
  assert.equal(whale.install.repairable, false)
  assert.equal(whale.install.spec,
    'https://github.com/CanaryJing/dsh-big-fat-whale-maid-adaptive/releases/download/v3.2.4/dsh-preset-big-fat-whale-maid-adaptive-3.2.4.tgz')
  assert.equal(whale.version, '3.2.4')
  assert.equal(whale.repo, 'canaryjing/dsh-big-fat-whale-maid-adaptive')

  // `repo#subdir` display names: name from the npm-pack file name, directory from `url` of the same repo.
  const amoji = byName(offerings, 'amoji-dsh')
  assert.equal(amoji.title, 'amoji#amoji')
  assert.equal(amoji.repo, '5101good/amoji')
  assert.equal(amoji.directory, 'adapters/dsh')
  assert.equal(byName(offerings, 'dsh-paperflight').version, '0.1.0-preview.60')
  // A tag that is not a semver gives no version; a display name falls back to the tarball's repo name.
  assert.equal(byName(offerings, 'dsh-intelligent-UI').version, null)
  assert.equal(byName(offerings, 'dsh-qq-zone').title, 'DSH QQ Zone')

  // github-head: unpinned, identity is the installed repo; a non-ASCII display name → repo name.
  const bot = byName(offerings, 'milancat-bot')
  assert.deepEqual(bot.install, { kind: 'github-head', spec: 'github:alexbu512/milancat-bot', registry: null, pinned: false, repairable: false })
  assert.equal(bot.repo, 'alexbu512/milancat-bot')
  assert.equal(bot.version, null)
  assert.equal(byName(offerings, 'dsh-usage-printer').title, '小票机用量卡（dsh-usage-printer）')

  assert.deepEqual(byName(offerings, 'portable-dsh-multi-agent-plugin').labels, ['ap:red-lines'])
  for (const o of offerings) {
    assert.equal(o.sourceId, 'ap')
    assert.ok(o.description?.en && o.description?.zh, o.name)
  }
})

test('awesome-plugins: bad entries are skipped and tallied, never thrown', () => {
  const r = read(docWith(
    null,
    'x',
    entry({ name: 'a', npm: 'a', version: 'latest' }),
    entry({ name: 'b', npm: 'B-Upper', version: '1.0.0' }),
    entry({ name: 'c', install: 'dsh plugin add github:o/c#main', url: 'https://github.com/o/c' }),
    entry({ name: 'd', install: 'rm -rf /' }),
    entry({ name: 'e', install: 'dsh plugin add github:o/other', url: 'https://github.com/o/e' }),
    entry({ name: 'f', install: 'dsh plugin add github:o/f', url: 'https://github.com/o/f/tree/main/sub' }),
    entry({ name: '???', install: 'dsh plugin add github:o/x#path:/a' }),
    entry({ name: 'g', url: 'https://github.com/o/g', install: 'dsh plugin add github:o/g' }),
    entry({ name: 'g', url: 'https://github.com/o/g', install: 'dsh plugin add github:o/g' }),
  ), { sourceId: 's' })
  assert.deepEqual(r.skippedBy, {
    'invalid-entry': 2,
    'no-valid-version': 1,
    'invalid-name': 1,
    [REASON.ref]: 1,
    'invalid-source': 1,
    [REASON.ambiguousRepo]: 2,
    [REASON.subdirHead]: 1,
    duplicate: 1,
  })
  assert.deepEqual(r.offerings.map((o) => o.install.spec), ['github:o/g'])
})

test('awesome-plugins: a pinned github commit becomes a git install of that repo', () => {
  const sha = 'a'.repeat(40)
  const { offerings } = read(docWith(entry({ name: 'h', install: `dsh plugin add github:O/H#${sha}` })), { sourceId: 's' })
  assert.equal(offerings[0].install.spec, `git+https://github.com/O/H.git#${sha}`)
  assert.equal(offerings[0].repo, 'o/h')
  assert.equal(offerings[0].install.pinned, true)
})

test('awesome-plugins: tarball identity comes from where it is served, not from `url`', () => {
  const { offerings } = read(docWith(entry({
    name: 't', url: 'https://github.com/victim/repo/tree/main/pkg',
    tarball: 'https://github.com/attacker/evil/releases/download/v1.0.0/t-1.0.0.tgz',
  })), { sourceId: 's' })
  assert.equal(offerings[0].repo, 'attacker/evil')
  assert.equal(offerings[0].directory, null)
})

test('awesome-plugins: homepage and stars come from `url` only when it is the installed repo (regression)', () => {
  const sha = 'a'.repeat(40)
  const famous = { url: 'https://github.com/famous/cool-plugin', stars: 9000 }
  const r = read(docWith(
    entry({ name: 'cool-plugin', ...famous, install: `dsh plugin add github:evil/payload#${sha}` }),
    entry({ name: 'tb', ...famous, tarball: 'https://github.com/evil/tb/releases/download/v1.0.0/tb-1.0.0.tgz' }),
    entry({ name: 'own', url: 'https://github.com/o/own', stars: 5, install: `dsh plugin add github:o/own#${sha}` }),
    entry({ name: 'ext', ...famous, tarball: 'https://example.com/ext-1.0.0.tgz' }),
  ), { sourceId: 's' })
  const at = (n) => { const o = byName(r.offerings, n); return [o.repo, o.homepage, o.stars] }
  assert.deepEqual(at('cool-plugin'), ['evil/payload', 'https://github.com/evil/payload', null])
  assert.deepEqual(at('tb'), ['evil/tb', 'https://github.com/evil/tb', null])
  assert.deepEqual(at('own'), ['o/own', 'https://github.com/o/own', 5])
  assert.deepEqual(at('ext'), [null, null, null])
})

test('awesome-plugins: GitHub tarballs that follow a ref are unpinned, not offered (regression)', () => {
  const sha = 'b'.repeat(40)
  const tb = (tarball) => read(docWith(entry({ name: 't', url: 'https://github.com/alice/tool', tarball })), { sourceId: 's' })
  for (const url of [
    'https://github.com/alice/tool/archive/refs/heads/main.tar.gz',
    'https://github.com/alice/tool/archive/main.tar.gz',
    'https://github.com/alice/tool/archive/refs/tags/v1.0.0.tar.gz',
    'https://github.com/alice/tool/releases/latest/download/t.tgz',
    'https://codeload.github.com/alice/tool/tar.gz/main',
    'https://codeload.github.com/alice/tool/tar.gz/refs/heads/main',
  ]) assert.deepEqual(tb(url).skippedBy, { [REASON.latestTarball]: 1 }, url)
  for (const url of [
    'https://github.com/alice/tool/releases/download/v1.0.0/t-1.0.0.tgz',
    `https://github.com/alice/tool/archive/${sha}.tar.gz`,
    `https://codeload.github.com/alice/tool/tar.gz/${sha}`,
  ]) {
    const { offerings } = tb(url)
    assert.equal(offerings[0]?.install.pinned, true, url)
    assert.equal(offerings[0].repo, 'alice/tool')
  }
})

test('awesome-plugins: hostile values are rejected by the offer.js builders', () => {
  const long = 'a'.repeat(2100)
  const r = read(docWith(
    entry({ name: 'h1', tarball: 'javascript:alert(1)//x.tgz' }),
    entry({ name: 'h2', tarball: 'http://github.com/o/h2/releases/download/v1/h2.tgz' }),
    entry({ name: 'h3', tarball: `https://github.com/o/h3/releases/download/v1/${long}.tgz` }),
    entry({ name: 'h4', npm: '-rf', version: '1.0.0' }),
    entry({ name: 'h5', install: 'dsh plugin add -github:o/h5' }),
    entry({ name: 'h6', install: 'dsh plugin add github:o/h6#abc123' }),
    entry({ name: 'h7', install: `dsh plugin add github:${long}/x` }),
    entry({ name: 'h8', install: 'dsh plugin add github:o/..', url: 'https://github.com/o/..' }),
    entry({ name: 'h9', tarball: 'https://user:pw@github.com/o/h9/releases/download/v1/h9.tgz' }),
    entry({ name: long, install: 'dsh plugin add github:o/x', url: 'https://github.com/o/x' }),
  ), { sourceId: 's' })
  assert.equal(r.skipped, 9)
  assert.equal(r.offerings.length, 1)
  // An overlong display name is not a package name: the offering falls back to the repo name, title is capped.
  assert.equal(r.offerings[0].name, 'x')
  assert.ok(r.offerings[0].title.length <= 200)
  for (const w of r.warnings) assert.ok(w.length < 100)
})
