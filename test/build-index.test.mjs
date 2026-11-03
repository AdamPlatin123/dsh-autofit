import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { overlay } from '../scripts/build-index.mjs'
import { repoKey } from '../lib/radar.js'

/** The official format-1 validator, loaded from the local DSH install (no devDependency). */
async function officialParser() {
  try {
    const bin = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
    const pkg = path.join(path.dirname(bin), '..', 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js')
    return (await import(pathToFileURL(pkg).href)).parseMarketIndex
  } catch {
    return undefined
  }
}

const BASE = {
  format: 1,
  title: { zh: '测试市场', en: 'Test market' },
  metadata: { categories: { ui: { title: { en: 'UI' } } } },
  plugins: [
    { name: 'a', repository: { url: 'https://github.com/Owner/Repo-A' }, icon: 'icons/a.svg',
      metadata: { category: 'ui', labels: [], sortKeys: {} },
      versions: [{ version: '1.0.0', publishTimestamp: 1790000000, source: { type: 'npm' }, engines: {} }] },
    { name: 'b', repository: { url: 'https://github.com/owner/repo-b/tree/main/packages/b' },
      metadata: {}, versions: [{ version: '2.0.0', publishTimestamp: 1790000000, source: { type: 'npm' }, engines: { dsh: '>=0.2.0-0' } }] },
    { name: 'c', repository: { url: 'https://gitlab.com/owner/c' },
      metadata: {}, versions: [{ version: '0.1.0', publishTimestamp: 1790000000, source: { type: 'npm' }, engines: {} }] },
  ],
}
const RADAR = {
  schema: 'dsh-radar/v1',
  plugins: [
    { repo: 'owner/repo-a', verdict: 'ok', stars: 12 },
    { repo: 'owner/repo-b', verdict: 'untested', stars: 3 },
  ],
}

test('repoKey normalizes GitHub URLs and ignores other hosts', () => {
  assert.equal(repoKey('git+https://github.com/Foo/Bar.git'), 'foo/bar')
  assert.equal(repoKey('https://github.com/foo/bar/tree/main/x'), 'foo/bar')
  assert.equal(repoKey('https://gitlab.com/foo/bar'), undefined)
})

test('overlay labels matched plugins, keeps the rest, resolves relative icons', () => {
  const { index, stats } = overlay(BASE, RADAR, 'https://example.com/m/index.json')
  assert.deepEqual(stats, { plugins: 3, matched: 2 })
  const [a, b, c] = index.plugins
  assert.deepEqual(a.metadata.labels, ['radar-ok'])
  assert.equal(a.metadata.sortKeys.stars, 12)
  assert.equal(a.icon, 'https://example.com/m/icons/a.svg')
  assert.deepEqual(b.metadata.labels, ['radar-pending'])
  assert.equal(c.metadata.labels, undefined)
  assert.equal(BASE.plugins[0].metadata.labels.length, 0, 'base must not be mutated')
})

test('overlay rejects foreign documents', () => {
  assert.throws(() => overlay({ format: 2, plugins: [] }, RADAR), /format-1/)
  assert.throws(() => overlay(BASE, { schema: 'x', plugins: [] }), /dsh-radar\/v1/)
})

test('output passes the official DSH format-1 validator', async (t) => {
  const parse = await officialParser()
  if (!parse) return t.skip('dsh not installed locally')
  const { index } = overlay(BASE, RADAR, 'https://example.com/m/index.json')
  const parsed = parse(JSON.parse(JSON.stringify(index)), 'https://example.com/autofit/index.json')
  assert.equal(parsed.plugins.length, 3)
  assert.deepEqual(parsed.plugins[0].metadata.labels, ['radar-ok'])
  assert.equal(parsed.metadata.sortKeys.stars.order, 'desc')
})
