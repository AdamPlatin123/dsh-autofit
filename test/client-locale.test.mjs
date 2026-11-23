// The client bundle (bundle/client.js) is a ModuleLoader script, not a module: load it in a VM with stub host
// objects, capture the locale dictionary it registers, and check that both locales carry every key the code uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SRC = readFileSync(new URL('../bundle/client.js', import.meta.url), 'utf8')

function loadClient() {
  let def = null
  const window = { __ModuleLoader__: { load: (d) => { def = d } } }
  vm.runInNewContext(SRC, { window, document: {}, navigator: {}, setTimeout, clearTimeout, console })
  assert.ok(def && typeof def.factory === 'function', 'client registers a module with a factory')
  const React = { createElement: () => null, Fragment: 'Fragment', useCallback: (f) => f, useEffect: () => {}, useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}] }
  const plugin = def.factory((name) => (name === 'react' ? React : null))
  let dictionary = null
  const slots = []
  const ctx = {
    inject: () => {},
    effect: (fn) => fn(),
    locale: { register: (ns, dict) => { dictionary = dict; return () => {} }, bind: () => (k) => k },
    slots: { inject: (name, fn) => { slots.push(name); fn() }, register: () => () => {} },
  }
  plugin.apply(ctx)
  return { plugin, dictionary, slots }
}

test('client: zh and en carry the same keys, all non-empty strings', () => {
  const { dictionary } = loadClient()
  assert.deepEqual(Object.keys(dictionary).sort(), ['en', 'zh'])
  assert.deepEqual(Object.keys(dictionary.zh).sort(), Object.keys(dictionary.en).sort())
  for (const lang of ['zh', 'en']) {
    for (const [k, v] of Object.entries(dictionary[lang])) assert.ok(typeof v === 'string' && v.trim(), `${lang}.${k} is empty`)
  }
})

test('client: every key the code looks up exists', () => {
  const { dictionary } = loadClient()
  const used = new Set()
  for (const m of SRC.matchAll(/\b(?:t|tt)\('([A-Za-z0-9]+)'\)/g)) used.add(m[1])
  for (const m of SRC.matchAll(/\bfmt\(t, '([A-Za-z0-9]+)'/g)) used.add(m[1])
  // Keys picked through lookup tables (state, kind, trust) or a ternary are quoted literals with these prefixes.
  for (const m of SRC.matchAll(/'((?:sources|presets)[A-Z][A-Za-z0-9]*)'/g)) used.add(m[1])
  assert.ok(used.size > 50)
  const missing = [...used].filter((k) => !Object.hasOwn(dictionary.en, k))
  assert.deepEqual(missing, [])
})

test('client: the sources panel calls routes the Host bundle serves', () => {
  const index = readFileSync(new URL('../bundle/index.js', import.meta.url), 'utf8')
  for (const path of ['/api/autofit/sources/list', '/api/autofit/sources/presets', '/api/autofit/sources/set']) {
    assert.ok(SRC.includes(`'${path}'`), `client calls ${path}`)
    assert.ok(index.includes(`'${path}'`), `bundle serves ${path}`)
  }
})

test('client: the sources panel refreshes source states after a change (regression: stuck at "pending")', () => {
  const panel = SRC.slice(SRC.indexOf('function SourcesPanel('), SRC.indexOf('const confirmBox = '))
  assert.ok(panel.length > 0)
  // the list is fetched again once the catalog reload settles, and polled while an enabled source is pending
  assert.match(panel, /Promise\.resolve\(onChanged \? onChanged\(\) : undefined\)\.then\(settled, settled\)/)
  assert.match(panel, /s\.enabled && s\.state === 'pending'/)
  assert.match(panel, /setInterval\(\(\) => void loadSources\(/)
  // and the catalog reload hands back its promise instead of discarding it
  assert.match(SRC, /const reloadCatalog = useCallback\(\(\) => load\(qRef\.current, 0\), \[load\]\)/)
  // preset attribution is localized like titles
  assert.ok(SRC.includes('pickText(p.attribution)'))
})
