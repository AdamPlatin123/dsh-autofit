import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { detectFormat, npmSearchUrls, readNpmSearch, readRadarRepos, readShop, shopDataUrl } from '../lib/sources/adapters.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), 'utf8'))
const RADAR = fixture('radar-plugins-all.json')
const SHOP = fixture('shop-plugins.json')
const SHOP_POINTER = fixture('shop-pointer.json')
const NPM_PAGE = fixture('npm-search-page.json')
const SHA = 'b'.repeat(40)

test('detectFormat recognizes every readable shape', () => {
  assert.equal(detectFormat({ format: 1, plugins: [] }), 'format1')
  assert.equal(detectFormat(SHOP_POINTER), 'shop-pointer')
  assert.equal(detectFormat(SHOP), 'shop-data')
  assert.equal(detectFormat({ schemaVersion: 9, plugins: [] }), 'shop-data', 'readShop rejects the version, not detect')
  assert.equal(detectFormat(NPM_PAGE), 'npm-search')
  for (const doc of [null, [], 'x', RADAR, { format: 2, plugins: [] }, { plugins: [] }, { objects: [] }]) {
    assert.equal(detectFormat(doc), null, JSON.stringify(doc)?.slice(0, 40))
  }
})

test('readRadarRepos offers unpinned GitHub installs for real radar rows', () => {
  const r = readRadarRepos(RADAR, { sourceId: 'radar-repos' })
  assert.equal(r.offerings.length, RADAR.plugins.length - 1)
  assert.deepEqual(r.skippedBy, { 'invalid-name': 1 }, '.dsh-plugin-installer is not a package name')
  const o = new Map(r.offerings.map((x) => [x.repo, x]))
  const first = o.get('ranxianglei/billion-context')
  assert.equal(first.name, 'billion-context')
  assert.equal(first.title, 'billion-context')
  assert.equal(first.stars, 6477)
  assert.equal(first.version, null)
  assert.equal(first.homepage, 'https://github.com/ranxianglei/billion-context')
  assert.deepEqual(first.install, { kind: 'github-head', spec: 'github:ranxianglei/billion-context', registry: null, pinned: false, repairable: false })
  const mixedCase = o.get('anionex/dsh-vision-toolkit')
  assert.equal(mixedCase.install.spec, 'github:Anionex/dsh-vision-toolkit', 'spec keeps the repo as the radar states it')
  assert.equal(o.get('openma-ai/open-managed-agents').description,
    'Self-host AI agents with Claude Managed Agents and OpenAI Agents API support')
  assert.equal(o.get('memtensor/memmy-agent').description, null, '—〔📦〕 is a placeholder')
  assert.equal(o.get('moeblack/dsh-prompt-studio').description.endsWith('(Prompt Studio)'), true)
})

test('readRadarRepos skips unknown verdicts, duplicates and junk rows', () => {
  const doc = {
    schema: 'dsh-radar/v1',
    plugins: [
      { repo: 'a/one', verdict: 'ok', stars: 1, desc: '—' },
      { repo: 'A/One', verdict: 'ok' },
      { repo: 'a/two', verdict: 'weird' },
      { repo: 'not a repo', verdict: 'ok' },
      null,
      { repo: 'a/three', verdict: 'untested', stars: 'many' },
    ],
  }
  const r = readRadarRepos(doc, { sourceId: 'rr' })
  assert.deepEqual(r.offerings.map((o) => o.name), ['one', 'three'])
  assert.deepEqual(r.skippedBy, { duplicate: 1, 'unknown-verdict': 1, 'invalid-entry': 2 })
  assert.equal(r.offerings[1].stars, null)
  assert.throws(() => readRadarRepos({ schema: 'x', plugins: [] }, { sourceId: 'rr' }), /dsh-radar\/v1/)
})

test('readShop reads real dsh-plugin-shop entries: npm, git commit, git subdir, tarball', () => {
  const r = readShop(SHOP, { sourceId: 'shop', hostVersion: '0.2.1-rc.2' })
  assert.equal(r.skipped, 0)
  assert.equal(r.offerings.length, SHOP.plugins.length)
  const [npm, compat, git, subdir, tarball, archived, forkGit, forkNpm, declared] = r.offerings
  assert.deepEqual(npm.install, { kind: 'npm', spec: '@0x0lab/dsh-llm-proxy@2.1.0', registry: null, pinned: true, repairable: true })
  assert.equal(npm.repo, 'reyesyang/dsh-llm-http-proxy')
  assert.equal(npm.icon, null, 'shop icons are content hashes, not URLs')
  assert.equal(npm.category, 'provider')
  assert.equal(npm.publishedAt, Math.floor(Date.parse(SHOP.plugins[0].publishedAt) / 1000))
  assert.deepEqual(npm.labels, ['shop:community'])
  assert.equal(compat.engines, '0.2.1-rc.2', 'compatibility.dsh is the engines range')
  assert.equal(git.install.spec,
    'git+https://github.com/3ChatAI-NCT/3chatai-deepseek-harness-plugin.git#d741956969f0adcd523c13d682e9ca8d7b313cb0')
  assert.equal(git.version, '2.1.4', 'manifestVersion, since `version` is the commit')
  assert.equal(git.install.repairable, false)
  assert.equal(subdir.install.spec,
    'git+https://github.com/4fuu/dsh-standard-plus.git#589276d79cff0f5f9c9e80f1854af6207c8043b7&path:/packages/dsh-standard-plus')
  assert.equal(subdir.directory, 'packages/dsh-standard-plus')
  assert.equal(subdir.engines, '0.2.2-rc.1')
  assert.equal(tarball.install.kind, 'tarball')
  assert.equal(tarball.install.spec, SHOP.plugins[4].tarball.url)
  assert.equal(tarball.version, '0.2.1')
  assert.equal(tarball.install.repairable, false)
  assert.deepEqual(archived.labels, ['shop:community', 'shop:archived'])
  assert.equal(archived.version, null)
  // one name from two repos (a fork as a GitHub commit, the original on npm): both stay, merge shows the conflict
  assert.equal(forkGit.name, forkNpm.name)
  assert.notEqual(forkGit.repo, forkNpm.repo)
  assert.deepEqual(declared.description, SHOP.plugins[8].catalog.summary)
})

test('readShop: schema checks, skips, one offering per name + repo + directory', () => {
  assert.throws(() => readShop({ schemaVersion: 4, plugins: [] }, { sourceId: 's' }),
    { name: 'TypeError', message: 'unsupported dsh-plugin-shop schemaVersion' })
  assert.throws(() => readShop({ schemaVersion: 5 }, { sourceId: 's' }), TypeError)
  const base = { catalog: { category: 'tool', summary: { en: 'x' } }, publishedAt: '2019-01-01T00:00:00Z' }
  const plugins = [
    { ...base, name: 'p', source: 'github', repo: 'o/p', version: SHA },
    { ...base, name: 'p', source: 'npm', version: '1.0.0', repository: 'https://github.com/o/p' },
    { ...base, name: 'p', source: 'github', repo: 'fork/p', version: SHA },
    { ...base, name: 'q', source: 'github', repo: 'o/q', version: 'v1.0.0' },
    { ...base, name: 'r', source: 'github', repo: 'o/r', version: SHA, subdir: '../up' },
    { ...base, name: 's', source: 'github', repo: 'o/s', version: 'v1.0.0', tarball: { url: 'http://x.example/s.tgz' } },
    { ...base, name: 'Up', source: 'npm', version: '1.0.0' },
    { ...base, name: 't', source: 'npm', version: 'latest' },
    { ...base, name: 'u', source: 'gitlab' },
    7,
  ]
  const r = readShop({ schemaVersion: 5, plugins }, { sourceId: 's' })
  assert.deepEqual(r.offerings.map((o) => `${o.name} ${o.install.kind} ${o.repo}`), ['p npm o/p', 'p git fork/p'])
  assert.equal(r.offerings[0].publishedAt, null, 'dates before 2020 are ignored')
  assert.deepEqual(r.skippedBy, { duplicate: 1, 'invalid-source': 4, 'invalid-name': 1, 'no-valid-version': 1, 'invalid-entry': 1 })
})

test('shopDataUrl resolves the pointer and exposes the expected hash', () => {
  const ptrUrl = 'https://cdn.example.com/shop/v5/index.json'
  assert.deepEqual(shopDataUrl(SHOP_POINTER, ptrUrl), {
    url: `https://cdn.example.com/shop/v5/${SHOP_POINTER.plugins.url}`,
    sha256: SHOP_POINTER.plugins.sha256,
  })
  assert.throws(() => shopDataUrl({ ...SHOP_POINTER, schemaVersion: 6 }, ptrUrl), /schemaVersion/)
  assert.throws(() => shopDataUrl({ schemaVersion: 5, plugins: { url: 'x.json', sha256: 'nope' } }, ptrUrl), TypeError)
  assert.throws(() => shopDataUrl({ schemaVersion: 5, plugins: { url: 'file:///etc/passwd', sha256: 'a'.repeat(64) } }, ptrUrl), TypeError)
  assert.throws(() => shopDataUrl({ schemaVersion: 5, plugins: { url: 'x.json', sha256: 'a'.repeat(64) } }, 'not a url'), TypeError)
})

test('readNpmSearch reads a real search page and dedupes across pages', () => {
  const r = readNpmSearch(NPM_PAGE, { sourceId: 'npm' })
  assert.equal(r.offerings.length, NPM_PAGE.objects.length)
  assert.equal(r.skipped, 0)
  const first = r.offerings[0]
  const pkg = NPM_PAGE.objects[0].package
  assert.equal(first.name, pkg.name)
  assert.equal(first.version, pkg.version)
  assert.deepEqual(first.install, { kind: 'npm', spec: `${pkg.name}@${pkg.version}`, registry: null, pinned: true, repairable: true })
  assert.equal(first.repo, 'dsh-market/dsh-market')
  assert.equal(first.homepage, 'https://dshmarket.com/')
  assert.equal(first.publishedAt, Math.floor(Date.parse(pkg.date) / 1000))
  assert.ok(first.keywords.includes('dsh-plugin'))

  const second = { objects: [NPM_PAGE.objects[0], { package: { name: 'new-one', version: '0.1.0' } },
    { package: { name: 'Bad', version: '1.0.0' } }, { package: { name: 'nover', version: 'x' } }, {}] }
  const both = readNpmSearch([NPM_PAGE, second], { sourceId: 'npm' })
  assert.equal(both.offerings.length, NPM_PAGE.objects.length + 1)
  assert.deepEqual(both.skippedBy, { duplicate: 1, 'invalid-name': 1, 'no-valid-version': 1, 'invalid-entry': 1 })
  assert.throws(() => readNpmSearch([{ nope: 1 }], { sourceId: 'npm' }), /npm search/)
})

test('npmSearchUrls pages up to the npm depth cap', () => {
  const urls = npmSearchUrls()
  assert.equal(urls.length, 21)
  assert.equal(urls[0], 'https://registry.npmjs.org/-/v1/search?text=keywords%3Adsh-plugin&size=250&from=0')
  assert.ok(urls.at(-1).endsWith('&from=5000'))
  assert.deepEqual(npmSearchUrls({ text: 'dsh', size: 100, max: 250 }).map((u) => new URL(u).searchParams.get('from')), ['0', '100'])
  assert.throws(() => npmSearchUrls({ size: 0 }), TypeError)
  assert.throws(() => npmSearchUrls({ size: 251 }), TypeError)
})

test('readShop: the repo of a git or tarball offering is the one it installs from, not the declared repository', () => {
  const plugins = [
    // a git spec built from `repo` cannot pose as the repo `repository` names
    { name: 'dsh-plugin-popular', source: 'github', repo: 'evil/payload', repository: 'https://github.com/good/popular', version: SHA },
    // a tarball served from another host has no GitHub identity, whatever `repo` says
    { name: 'dsh-plugin-x', source: 'github', repo: 'good/popular', subdir: 'pkg', tarball: { url: 'https://evil.example/x.tgz' } },
    // a release asset of `repo` keeps it
    { name: 'dsh-plugin-y', source: 'github', repo: 'Good/Y', tarball: { url: 'https://github.com/good/y/releases/download/v1.0.0/y-1.0.0.tgz' } },
    { name: 'dsh-plugin-z', source: 'github', repo: 'good/z', tarball: { url: 'https://codeload.github.com/good/z/tar.gz/refs/tags/v1' } },
    { name: 'dsh-plugin-w', source: 'github', repo: 'good/w', tarball: { url: 'https://github.com/other/w/releases/download/v1/w.tgz' } },
    { name: 'dsh-reg', source: 'npm', version: '1.0.0', registry: 'https://npm.corp.example/' },
  ]
  const r = readShop({ schemaVersion: 5, plugins }, { sourceId: 's' })
  assert.deepEqual(r.offerings.map((o) => [o.name, o.repo, o.directory]), [
    ['dsh-plugin-popular', 'evil/payload', null],
    ['dsh-plugin-x', null, null],
    ['dsh-plugin-y', 'good/y', null],
    ['dsh-plugin-z', 'good/z', null],
    ['dsh-plugin-w', null, null],
  ])
  assert.deepEqual(r.skippedBy, { 'unsupported-registry': 1 })
})

test('readShop caps a hostile engines range', () => {
  const r = readShop({ schemaVersion: 5, plugins: [{ name: 'e', source: 'npm', version: '1.0.0', compatibility: { dsh: '='.repeat(50000) } }] }, { sourceId: 's' })
  assert.equal(r.offerings[0].engines.length, 257)
})
