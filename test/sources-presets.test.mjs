import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRESET_ADAPTERS, PRESETS, presetById } from '../lib/sources/presets.js'
import { DEFAULT_SOURCES, normalizeSourceUrl } from '../lib/sources/store.js'
import { COMMUNITY_ADAPTERS } from '../lib/sources/community/index.js'

const ADAPTERS = COMMUNITY_ADAPTERS.map((a) => a.id)
const KEYS = ['id', 'title', 'url', 'format', 'homepage', 'repo', 'license', 'attribution', 'entries', 'plugins', 'notes', 'checkedAt']

test('preset ids are unique, kebab-case and found by presetById', () => {
  const ids = PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const p of PRESETS) {
    assert.match(p.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.equal(presetById(p.id), p)
  }
  assert.equal(presetById('nope'), null)
  assert.equal(presetById('__proto__'), null)
  assert.throws(() => presetById(undefined), TypeError)
})

test('preset urls are https, usable, unique and not a built-in source url', () => {
  const builtin = new Set(DEFAULT_SOURCES.flatMap((s) => s.urls ?? []).map((u) => normalizeSourceUrl(u).key))
  const keys = new Set()
  for (const p of PRESETS) {
    const n = normalizeSourceUrl(p.url)
    assert.ok(n.href, `${p.id}: ${n.code}`)
    assert.equal(new URL(p.url).protocol, 'https:', p.id)
    assert.ok(!keys.has(n.key), `${p.id} duplicates a url`)
    keys.add(n.key)
    assert.ok(!builtin.has(n.key), `${p.id} is a built-in source`)
    if (p.homepage !== null) assert.equal(new URL(p.homepage).protocol, 'https:', p.id)
  }
})

test('every preset names a known format and has the full documented shape', () => {
  assert.deepEqual([...PRESET_ADAPTERS].sort(), [...ADAPTERS].sort())
  for (const p of PRESETS) {
    assert.deepEqual(Object.keys(p), KEYS, p.id)
    assert.ok(p.format === 'format1' || ADAPTERS.includes(p.format), `${p.id}: ${p.format}`)
    assert.ok(p.title.zh && p.title.en, p.id)
    assert.ok(p.repo === null || /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(p.repo), p.id)
    assert.ok(p.license === null || /^[A-Za-z0-9.+-]+$/.test(p.license), `${p.id}: license is an SPDX id or null`)
    assert.ok(p.attribution === null || (typeof p.attribution.zh === 'string' && typeof p.attribution.en === 'string'),
      `${p.id}: attribution is a { zh, en } map so the Chinese UI shows it in Chinese`)
    assert.ok(typeof p.notes === 'string' && p.notes, p.id)
    assert.match(p.checkedAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(Number.isInteger(p.entries) && p.entries > 0, `${p.id}: every preset is measured`)
    assert.equal(p.plugins.npm + p.plugins.git + p.plugins.other, p.entries, p.id)
  }
  for (const f of ADAPTERS) assert.ok(PRESETS.some((p) => p.format === f), `no preset for adapter ${f}`)
})

test('presets are deeply frozen', () => {
  assert.ok(Object.isFrozen(PRESETS))
  for (const p of PRESETS) {
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.title), p.id)
    if (p.attribution) assert.ok(Object.isFrozen(p.attribution), p.id)
    if (p.plugins) assert.ok(Object.isFrozen(p.plugins), p.id)
  }
  assert.throws(() => { PRESETS[0].url = 'https://evil.example/' }, TypeError)
})

test('dsh.so carries its attribution terms', () => {
  const p = presetById('dsh-so')
  assert.equal(p.license, 'CC-BY-4.0')
  assert.match(p.attribution.en, /dsh\.so/)
  assert.match(p.attribution.zh, /dsh\.so/)
  assert.match(p.attribution.zh, /注明来源/)
})
