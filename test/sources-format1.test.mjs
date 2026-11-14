import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { dshPackageDir } from '../lib/describe.js'
import { readFormat1 } from '../lib/sources/format1.js'
import { chooseVersion, enginesAdmit, gitInstall, npmInstall } from '../lib/sources/offer.js'

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/sources/format1-whoishuhu.json', import.meta.url), 'utf8'))
const INDEX_URL = 'https://dsh.example/market/index.json'
const HOST = '0.2.1-rc.2'
const SHA = 'a'.repeat(40)

/** DSH's format-1 module from the local install (no devDependency), or undefined. */
async function officialMarketIndex() {
  try {
    const dir = path.join(dshPackageDir(), 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js')
    return await import(pathToFileURL(dir).href)
  } catch {
    return undefined
  }
}

function officialSemver() {
  try {
    return createRequire(path.join(dshPackageDir(), 'package.json'))('semver')
  } catch {
    return undefined
  }
}

const byName = (offerings) => new Map(offerings.map((o) => [o.name, o]))
const npmVersion = (version, extra = {}) => ({ version, publishTimestamp: 1790000000, source: { type: 'npm' }, ...extra })

test('readFormat1 rejects documents that are not format 1', () => {
  for (const doc of [null, [], {}, { format: 2, plugins: [] }, { format: 1 }, { format: 1, plugins: {} }]) {
    assert.throws(() => readFormat1(doc, { sourceId: 'x' }), { name: 'TypeError', message: 'not a format-1 index' })
  }
  assert.throws(() => readFormat1({ format: 1, plugins: [] }, {}), TypeError)
})

test('readFormat1 reads a real (trimmed) whoishuhu index', () => {
  const r = readFormat1(FIXTURE, { sourceId: 'who', indexUrl: INDEX_URL, hostVersion: HOST })
  assert.equal(r.offerings.length, FIXTURE.plugins.length)
  assert.equal(r.skipped, 0)
  assert.deepEqual(r.title, { en: 'DSH Plugin Index (dsh-plugin tag)', zh: 'DSH 插件索引（dsh-plugin 标签）' })
  assert.deepEqual(r.categories, {})
  const o = byName(r.offerings)

  // versions[0] needs dsh 0.2.2-rc.1, 8.3.2 needs 0.2.1-rc.3: the newest version the host admits is 8.3.1
  const scriptor = o.get('@linfengqaqtat/dsh-scriptor')
  assert.equal(scriptor.version, '8.3.1')
  assert.equal(scriptor.versionCount, 4)
  assert.equal(scriptor.engines, '0.2.1-rc.2')
  assert.deepEqual(scriptor.install, {
    kind: 'npm', spec: '@linfengqaqtat/dsh-scriptor@8.3.1', registry: null, pinned: true, repairable: true,
  })
  assert.equal(scriptor.repo, 'lingfengqaq/webnovel-writer')
  assert.equal(scriptor.directory, 'packages/bundle')
  assert.equal(scriptor.stars, 7940)

  // a prerelease versions[0] loses to the newest stable version
  assert.equal(o.get('dsh-blender-plugin').version, '3.0.6')
  assert.equal(o.get('dsh-blender-plugin').install.spec,
    'git+https://github.com/sixtysevenlf/dsh-blender-plugin.git#59f68b48af1055fa2688899deac44317c1f7e6dd')
  // only prereleases: the newest one the host admits
  assert.equal(o.get('@szx-a/dsh-layered-memory-architecture').version, '0.3.0-rc.3')

  const git = o.get('answer-me-with-html')
  assert.equal(git.install.kind, 'git')
  assert.equal(git.install.pinned, true)
  assert.equal(git.install.repairable, false)
  assert.equal(git.icon, null, 'data: icons are dropped')
  assert.equal(git.repo, 'qingyuna/answer-me-with-html')

  const base = o.get('@deepseek-ai/dsh-base')
  assert.equal(base.install.spec,
    'git+https://github.com/fufankeji/deepseek-harness-studio.git#257d429156a243517a2cafdff777125cd3fb6d54&path:/packages/bundle/base')
  // repository.url says deepseek-ai/deepseek-harness, but the git source (what gets installed) is a fork: the
  // identity is the fork, so it cannot borrow the upstream's radar verdict, stars or card
  assert.equal(base.repo, 'fufankeji/deepseek-harness-studio', 'the git source url decides the repo, not repository.url')
  assert.equal(base.directory, 'packages/bundle/base')

  assert.equal(o.get('dsh-whale-widget').icon, 'https://dsh.example/market/icons/d2d6f7bda2ea71f2.png')
  const bridge = o.get('dsh-vscode-bridge')
  assert.equal(bridge.repo, 'yaodongh/dsh-vscode-bridge', 'no repository: repo comes from the git source')
  assert.equal(bridge.stars, null)
  assert.equal(bridge.publishedAt, FIXTURE.plugins.find((p) => p.name === 'dsh-vscode-bridge').versions[0].publishTimestamp)
  // no version admits the host: fall back to the newest stable
  assert.equal(o.get('dsh-mascot-pet').version, '0.1.0')
  for (const offering of r.offerings) {
    assert.deepEqual(Object.keys(offering), ['sourceId', 'name', 'title', 'description', 'category', 'keywords', 'version',
      'versionCount', 'publishedAt', 'engines', 'repo', 'directory', 'homepage', 'icon', 'install', 'stars', 'labels'])
    assert.equal(offering.sourceId, 'who')
    assert.ok(offering.keywords.length <= 12)
  }
})

test('without hostVersion the newest stable (else newest) version is offered', () => {
  const o = byName(readFormat1(FIXTURE, { sourceId: 'who', indexUrl: INDEX_URL }).offerings)
  assert.equal(o.get('@linfengqaqtat/dsh-scriptor').version, '8.4.0')
  assert.equal(o.get('dsh-blender-plugin').version, '3.0.6')
  assert.equal(o.get('@szx-a/dsh-layered-memory-architecture').version, '0.3.0-rc.4')
})

test('readFormat1 is lenient per entry and counts what it skips', () => {
  const plugins = [
    'not an object',
    { name: 'Bad Name', versions: [npmVersion('1.0.0')] },
    { name: 'UpperNpm', versions: [npmVersion('1.0.0')] },
    { name: 'UpperGit', versions: [{ version: '1.0.0', source: { type: 'git', url: 'https://github.com/o/r', commit: SHA } }] },
    { name: 'dup', versions: [npmVersion('1.0.0')] },
    { name: 'dup', versions: [npmVersion('2.0.0')] },
    { name: 'http-git', versions: [{ version: '1.0.0', source: { type: 'git', url: 'http://github.com/o/r', commit: SHA } }] },
    { name: 'short-commit', versions: [{ version: '1.0.0', source: { type: 'git', url: 'https://github.com/o/r', commit: 'abc' } }] },
    { name: 'dotdot', versions: [{ version: '1.0.0', source: { type: 'git', url: 'https://github.com/o/r', commit: SHA, path: '../x' } }] },
    { name: 'svn', versions: [{ version: '1.0.0', source: { type: 'svn' } }] },
    { name: 'no-versions', versions: [] },
    { name: 'bad-versions', versions: [npmVersion('latest'), npmVersion('v1.0.0')] },
    { name: 'mixed', versions: [npmVersion('nope'), npmVersion('0.9.0'), npmVersion('1.1.0'), npmVersion('1.0.0')] },
    { name: 'reg', versions: [npmVersion('1.0.0', { source: { type: 'npm', registry: 'https://npm.example.com/r' } })] },
    { name: 'reg-default', versions: [npmVersion('1.0.0', { source: { type: 'npm', registry: 'https://registry.npmjs.org' } })] },
    {
      name: 'texts', title: 'x'.repeat(500), description: { en: '  hello  ', zh: '', 'not a locale!': 'y' },
      homepage: 'javascript:alert(1)', icon: 'data:image/png;base64,AAAA',
      repository: { url: 'https://github.com/Owner/Repo/tree/main/packages/texts' },
      metadata: { category: 'tools', keywords: [...'ABCDEFGHIJKLMNOP'].map((c) => `K${c}`), labels: ['hot'], sortKeys: { stars: 5 } },
      versions: [npmVersion('1.0.0', { engines: { dsh: '' } })],
    },
  ]
  const r = readFormat1({ format: 1, title: 'T', plugins, metadata: { categories: { tools: { title: { en: 'Tools' } } } } },
    { sourceId: 'u', indexUrl: INDEX_URL, hostVersion: HOST })
  assert.deepEqual(r.categories, { tools: { en: 'Tools' } })
  assert.equal(r.title, 'T')
  assert.deepEqual(r.skippedBy, {
    'invalid-entry': 1, 'invalid-name': 2, duplicate: 1, 'invalid-source': 4, 'no-valid-version': 2,
    'unsupported-registry': 1,
  })
  assert.equal(r.skipped, 11)
  assert.ok(r.warnings.length > 0 && r.warnings.every((w) => typeof w === 'string'))
  const o = byName(r.offerings)
  assert.deepEqual([...o.keys()], ['UpperGit', 'dup', 'mixed', 'reg-default', 'texts'])
  assert.equal(o.get('dup').version, '1.0.0', 'the first entry of a name wins')
  assert.equal(o.get('mixed').version, '1.1.0', 'unsorted versions are sorted; invalid ones dropped')
  assert.equal(o.get('mixed').versionCount, 3)
  assert.equal(o.get('reg-default').install.registry, null)
  assert.equal(o.get('reg-default').install.repairable, true)
  const texts = o.get('texts')
  assert.equal(texts.title.length, 200)
  assert.deepEqual(texts.description, { en: 'hello' })
  assert.equal(texts.homepage, null)
  assert.equal(texts.icon, null)
  assert.equal(texts.repo, 'owner/repo')
  assert.equal(texts.directory, 'packages/texts')
  assert.equal(texts.category, 'tools')
  assert.equal(texts.keywords.length, 12)
  assert.equal(texts.keywords[0], 'ka')
  assert.deepEqual(texts.labels, ['u:hot'])
  assert.equal(texts.stars, 5)
  assert.equal(texts.version, '1.0.0', 'an empty engines.dsh never admits the host, so the newest stable is the fallback')
})

test('warnings are capped at 20', () => {
  const plugins = Array.from({ length: 30 }, (_, i) => ({ name: `Bad Name ${i}`, versions: [npmVersion('1.0.0')] }))
  const r = readFormat1({ format: 1, plugins }, { sourceId: 'x' })
  assert.equal(r.skipped, 30)
  assert.equal(r.warnings.length, 20)
})

test('chooseVersion and enginesAdmit follow DSH rules', () => {
  assert.equal(enginesAdmit(null, HOST), true)
  assert.equal(enginesAdmit('', HOST), false)
  assert.equal(enginesAdmit('not a range', HOST), false)
  assert.equal(enginesAdmit('^0.2.0', HOST), true)
  assert.equal(chooseVersion([{ version: 'x' }], HOST), null)
  const c = chooseVersion([
    { version: '2.0.0', engines: '>=0.3.0' }, { version: '1.5.0-rc.1', engines: null }, { version: '1.4.0', engines: '^0.2.0' },
  ], HOST)
  assert.equal(c.chosen.version, '1.4.0')
  assert.equal(c.compatible, true)
  assert.equal(chooseVersion([{ version: '2.0.0', engines: '>=0.3.0' }], HOST).compatible, false)
  assert.equal(chooseVersion([{ version: '2.0.0' }]).compatible, null)
})

test('install specs mirror DSH marketInstallTarget on the same entries', async (t) => {
  const official = await officialMarketIndex()
  const semver = officialSemver()
  if (!official || !semver) return t.skip('dsh not installed locally')
  // The real fixture has npm, git and git+path entries; no live index uses source.registry yet, so one
  // synthetic npm+registry entry (shaped like the fixture's npm entries) is added: DSH installs it from that
  // registry, which the trial/repair/install path cannot do yet, so the reader leaves it out.
  const doc = structuredClone(FIXTURE)
  doc.plugins.push({
    name: '@scope/private-reg',
    versions: [npmVersion('1.2.0', { source: { type: 'npm', registry: 'https://npm.pkg.example.com/team' } }),
      npmVersion('1.1.0', { source: { type: 'npm', registry: 'https://npm.pkg.example.com/team' } })],
  })
  const parsed = official.parseMarketIndex(doc, INDEX_URL)
  const ours = byName(readFormat1(doc, { sourceId: 'who', indexUrl: INDEX_URL, hostVersion: HOST }).offerings)
  const kinds = new Set()
  for (const plugin of parsed.plugins) {
    const offering = ours.get(plugin.name)
    if (plugin.versions.every((v) => v.source.registry)) {
      assert.equal(offering, undefined, `${plugin.name}: registry-only entries are skipped`)
      kinds.add('npm+registry')
      continue
    }
    assert.ok(offering, plugin.name)
    const version = plugin.versions.find((v) => v.version === offering.version)
    const target = official.marketInstallTarget(plugin.name, version)
    assert.equal(offering.install.spec, target.spec, plugin.name)
    assert.equal(offering.install.registry, target.registry ?? null, plugin.name)
    kinds.add(`${version.source.type}${version.source.path ? '+path' : ''}${version.source.registry ? '+registry' : ''}`)

    // DSH market's defaultVersion: newest compatible stable, or newest compatible prerelease when none is stable
    const compatible = plugin.versions.filter((v) => v.engines.dsh === undefined ||
      (v.engines.dsh.trim() !== '' && semver.satisfies(HOST, v.engines.dsh, { includePrerelease: true })))
    const stable = plugin.versions.some((v) => semver.prerelease(v.version) === null)
    const dshDefault = compatible.find((v) => !stable || semver.prerelease(v.version) === null)?.version
    if (dshDefault !== undefined) assert.equal(offering.version, dshDefault, plugin.name)
  }
  assert.deepEqual([...kinds].sort(), ['git', 'git+path', 'npm', 'npm+registry'])
})

test('spec helpers refuse unsafe or non-canonical input', () => {
  assert.equal(gitInstall('https://github.com/o/r/', SHA).error, 'invalid-source')
  assert.equal(gitInstall('https://github.com/o', SHA).error, 'invalid-source')
  assert.equal(gitInstall('https://github.com/o/r.tgz', SHA).error, 'invalid-source')
  assert.equal(gitInstall('https://u:p@github.com/o/r', SHA).error, 'invalid-source')
  assert.equal(gitInstall('https://github.com/o/r', SHA.toUpperCase()).error, 'invalid-source')
  assert.equal(gitInstall('https://github.com/o/r.git', SHA, 'a/b').install.spec, `git+https://github.com/o/r.git#${SHA}&path:/a/b`)
  assert.equal(npmInstall('-rf', '1.0.0').error, 'invalid-spec', 'a spec never starts with -')
  assert.equal(npmInstall('a', '1.0.0', 'ftp://x').error, 'invalid-source')
  assert.equal(npmInstall('a', `1.0.0 ${'x'}`).error, 'invalid-spec')
})

test('npm entries naming a non-default registry are skipped (the install path cannot honour the registry)', () => {
  assert.equal(npmInstall('a', '1.0.0', 'https://npm.corp.example/').error, 'unsupported-registry')
  assert.equal(npmInstall('a', '1.0.0', 'https://registry.npmjs.org').install.registry, null)
  const r = readFormat1({ format: 1, plugins: [
    { name: 'internal-tool', versions: [npmVersion('1.0.0', { source: { type: 'npm', registry: 'https://npm.corp.example/' } })] },
    // a mixed entry falls back to its public versions
    { name: 'mixed-reg', versions: [npmVersion('2.0.0', { source: { type: 'npm', registry: 'https://npm.corp.example/' } }), npmVersion('1.0.0')] },
  ] }, { sourceId: 'u' })
  assert.deepEqual(r.skippedBy, { 'unsupported-registry': 1 })
  assert.deepEqual(r.offerings.map((o) => [o.name, o.install.spec, o.install.registry, o.install.repairable]), [['mixed-reg', 'mixed-reg@1.0.0', null, true]])
})

test('a git entry takes its repo from what it installs, never from a self-declared repository.url', () => {
  const r = readFormat1({ format: 1, plugins: [
    { name: 'dsh-plugin-popular', repository: { url: 'https://github.com/good/popular', directory: 'pkg' },
      versions: [{ version: '9.0.0', publishTimestamp: 1, source: { type: 'git', url: 'https://github.com/evil/payload', commit: SHA } }] },
    { name: 'dsh-plugin-other', repository: { url: 'https://github.com/good/other' },
      versions: [{ version: '1.0.0', source: { type: 'git', url: 'https://gitlab.com/evil/payload', commit: SHA, path: 'x' } }] },
    { name: 'dsh-plugin-npm', repository: { url: 'https://github.com/good/npm', directory: 'packages/a' }, versions: [npmVersion('1.0.0')] },
  ] }, { sourceId: 'u' })
  const o = byName(r.offerings)
  assert.equal(o.get('dsh-plugin-popular').repo, 'evil/payload')
  assert.equal(o.get('dsh-plugin-popular').directory, null, 'repository.directory does not apply to a git source')
  assert.equal(o.get('dsh-plugin-other').repo, null, 'a git source off GitHub has no GitHub identity')
  assert.equal(o.get('dsh-plugin-other').directory, 'x')
  assert.equal(o.get('dsh-plugin-npm').repo, 'good/npm')
  assert.equal(o.get('dsh-plugin-npm').directory, 'packages/a')
})

test('a hostile engines.dsh cannot stall the reader: long ranges are capped, invalid, and cheap', () => {
  const plugins = Array.from({ length: 5 }, (_, i) => ({
    name: `slow-${i}`,
    versions: [npmVersion('2.0.0', { engines: { dsh: '='.repeat(40000) } }), npmVersion('1.0.0', { engines: { dsh: `${'=v '.repeat(20000)}${i}` } })],
  }))
  const t = performance.now()
  const r = readFormat1({ format: 1, plugins }, { sourceId: 'u', hostVersion: HOST })
  const ms = performance.now() - t
  assert.equal(r.offerings.length, 5)
  assert.ok(ms < 500, `read took ${ms} ms`)
  for (const o of r.offerings) {
    assert.equal(o.version, '2.0.0', 'no version admits the host: newest stable')
    assert.ok(o.engines.length <= 257 && o.engines.endsWith('…'), 'the stored range is cut and marked')
    assert.equal(enginesAdmit(o.engines, HOST), false)
  }
  assert.equal(chooseVersion([{ version: '1.0.0', engines: `${'>=0.0.1 '.repeat(40)}` }], HOST).compatible, false,
    'a range over 256 chars is invalid even when every comparator would admit the host')
})
