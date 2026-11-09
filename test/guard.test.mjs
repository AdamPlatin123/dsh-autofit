// Guardrails on repairs: what the agent may change, how its edits are recorded, and rules that stay on target.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { repairWithAgent } from '../lib/autofix/agent.js'
import { agentChanges, review, snapshot, unifiedDiff } from '../lib/autofix/guard.js'
import { pack, provenance } from '../lib/autofix/index.js'
import { fixSchemaAdditionalProperties, fixServiceRenames, widenRequirements } from '../lib/autofix/rules.js'

const PKG = { name: 'autofit-agent-target', version: '1.0.0', type: 'module', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0' }, dependencies: { 'some-lib': '^1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }
const INDEX = "export function apply(ctx) {\n  const log = ctx.logger.child('autofit-agent-target')\n  ctx.connection.fetch.register({ path: '/api/target/stats' })\n  ctx.connection.fetch.register({ path: '/api/target/echo' })\n}\n"

function plugin(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autofit-guard-'))
  const all = { 'package.json': JSON.stringify(PKG, null, 2), 'index.js': INDEX, 'cordis.patch.yml': '- insert:\n    - id: target\n', ...files }
  for (const [name, body] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), body)
  }
  return dir
}
const edit = (dir, file, fn) => writeFileSync(path.join(dir, file), fn(readFileSync(path.join(dir, file), 'utf8')))
const editPkg = (dir, fn) => edit(dir, 'package.json', (t) => { const p = JSON.parse(t); fn(p); return JSON.stringify(p, null, 2) })

test('the lab repair (one line) is accepted and recorded as a diff', () => {
  const dir = plugin()
  const before = snapshot(dir)
  edit(dir, 'index.js', (t) => t.replace("ctx.logger.child('autofit-agent-target')", 'ctx.logger'))
  const r = review(before, dir)
  assert.deepEqual(r.violations, [])
  assert.deepEqual(r.files, [{ file: 'index.js', status: 'modified', added: 1, removed: 1 }])
  assert.equal(r.lines, 2)
  assert.match(r.diff, /^--- a\/index\.js\n\+\+\+ b\/index\.js\n@@ -1,5 \+1,5 @@\n/)
  assert.match(r.diff, /\n-  const log = ctx\.logger\.child\('autofit-agent-target'\)\n\+  const log = ctx\.logger\n/)
  assert.deepEqual(agentChanges(r.files), [{ tier: 'agent', rule: 'agent-edit', file: 'index.js', detail: 'modified: +1 −1 lines (see autofit.diff)' }])
  rmSync(dir, { recursive: true })
})

test('what autofit itself writes (version, autofit metadata, autofit.diff, JSON layout) is not counted as an edit', () => {
  const dir = plugin()
  const before = snapshot(dir)
  editPkg(dir, (p) => { p.version = '1.0.0+autofit.a1'; p.autofit = { from: 'x', round: 'a1', changes: [] } })
  edit(dir, 'package.json', (t) => t.replace(/\n {2}/g, '\n    '))
  writeFileSync(path.join(dir, 'autofit.diff'), 'whatever')
  const r = review(before, dir)
  assert.deepEqual(r.files, [])
  assert.deepEqual(r.violations, [])
  rmSync(dir, { recursive: true })
})

test('package identity, dependencies, scripts and the bundle patch are off limits', () => {
  for (const [what, change, expect] of [
    ['name', (d) => editPkg(d, (p) => { p.name = 'other' }), /"name" may not be changed/],
    ['dependencies', (d) => editPkg(d, (p) => { p.dependencies['some-lib'] = '^2.0.0' }), /"dependencies" may not be changed/],
    ['scripts', (d) => editPkg(d, (p) => { p.scripts = { postinstall: 'node x.js' } }), /"scripts" may not be changed/],
    ['dsh.bundle', (d) => editPkg(d, (p) => { p.dsh.bundle.patch = './other.yml' }), /"dsh\.bundle" may not be changed/],
    ['patch file', (d) => edit(d, 'cordis.patch.yml', (t) => `${t}- disable: [web-ui]\n`), /bundle patch/],
    ['peer narrowed', (d) => editPkg(d, (p) => { p.peerDependencies['@deepseek-ai/dsh-tools'] = '^0.2.1' }), /keep the original range/],
    ['peer removed', (d) => editPkg(d, (p) => { delete p.peerDependencies['@deepseek-ai/dsh-tools'] }), /was removed/],
    ['registration dropped', (d) => edit(d, 'index.js', (t) => t.replace("  ctx.connection.fetch.register({ path: '/api/target/echo' })\n", '')), /register\(\.\.\.\) call\(s\) removed/],
    ['file emptied', (d) => edit(d, 'index.js', () => ''), /emptied/],
    ['invalid manifest', (d) => edit(d, 'package.json', (t) => t.slice(0, -2)), /no longer valid JSON/],
  ]) {
    const dir = plugin()
    const before = snapshot(dir)
    change(dir)
    assert.ok(review(before, dir).violations.some((v) => expect.test(v)), `${what}: ${JSON.stringify(review(before, dir).violations)}`)
    rmSync(dir, { recursive: true })
  }
})

test('widening a peer the way the rules do is allowed', () => {
  const dir = plugin()
  const before = snapshot(dir)
  editPkg(dir, (p) => { p.peerDependencies['@deepseek-ai/dsh-tools'] = '^0.1.0 || ^0.2.1-rc.2' })
  const r = review(before, dir)
  assert.deepEqual(r.violations, [])
  assert.equal(r.files[0].file, 'package.json')
  rmSync(dir, { recursive: true })
})

test('edits beyond the size budget are refused', () => {
  const dir = plugin()
  const before = snapshot(dir)
  writeFileSync(path.join(dir, 'big.js'), Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i}`).join('\n'))
  assert.ok(review(before, dir).violations.some((v) => /lines changed/.test(v)))
  for (let i = 0; i < 9; i++) writeFileSync(path.join(dir, `f${i}.js`), 'x\n')
  assert.ok(review(before, dir, { files: 8, lines: 10_000 }).violations.some((v) => /files changed/.test(v)))
  rmSync(dir, { recursive: true })
})

test('unified diff: separate hunks, line numbers, added file', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n')
  const b = a.replace('l2\n', 'L2\n').replace('l18\n', 'L18\n')
  const d = unifiedDiff('x.js', a, b)
  assert.equal(d.added, 2)
  assert.equal(d.removed, 2)
  assert.deepEqual(d.text.split('\n').filter((l) => l.startsWith('@@')), ['@@ -1,5 +1,5 @@', '@@ -15,6 +15,6 @@'])
  assert.match(unifiedDiff('n.js', '', 'one\ntwo').text, /@@ -0,0 \+1,2 @@\n\+one\n\+two/)
})

test('agent: run_trial is refused while a guardrail is broken, then allowed once reverted', async () => {
  const dir = plugin()
  const before = snapshot(dir)
  const script = [
    [['write_file', { path: 'cordis.patch.yml', content: '- disable: [everything]\n' }]],
    [['run_trial', {}]],
    [['write_file', { path: 'cordis.patch.yml', content: '- insert:\n    - id: target\n' }]],
    [['replace_in_file', { path: 'index.js', old_text: "ctx.logger.child('autofit-agent-target')", new_text: 'ctx.logger' }]],
    [['run_trial', {}]],
    [['finish', { summary: 'dropped logger.child' }]],
  ]
  let i = 0
  const llm = {
    async *stream() {
      const calls = script[i++] ?? []
      for (const [n, c] of calls.entries()) yield { type: 'block-end', index: n, block: { type: 'tool-call', id: `c${i}-${n}`, name: c[0], arguments: JSON.stringify(c[1]) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
  const events = []
  let trials = 0
  const r = await repairWithAgent({
    dir, spec: 'x', initial: { verdict: 'fail', layers: {} }, llm, model: { provider: 'p', model: 'm' }, onEvent: (e) => events.push(e),
    guard: (d) => review(before, d).violations,
    trial: async () => { trials++; return { verdict: 'pass', codes: [], layers: {} } },
  })
  assert.equal(trials, 1, 'the refused trial never ran')
  assert.equal(r.passed, true)
  const refused = events.find((e) => e.type === 'trial-refused')
  assert.ok(refused.reasons.some((x) => /bundle patch/.test(x)))
  assert.ok(events.some((e) => e.type === 'tool-result' && e.name === 'run_trial' && !e.ok && /refused/.test(e.text)))
  rmSync(dir, { recursive: true })
})

test('a repaired package names a local source by file name only', () => {
  assert.equal(provenance('C:\\Users\\someone\\lab\\autofit-agent-target-1.0.0.tgz'), 'file:autofit-agent-target-1.0.0.tgz')
  assert.equal(provenance('file:/home/someone/p.tgz'), 'file:p.tgz')
  assert.equal(provenance('dsh-period-report@0.2.1'), 'dsh-period-report@0.2.1')
})

test('a second repair of the same plugin never replaces the tarball an earlier one installed from', () => {
  const dir = plugin()
  const out = mkdtempSync(path.join(tmpdir(), 'autofit-out-'))
  try {
    edit(dir, 'index.js', (s) => s.replace("ctx.logger.child('autofit-agent-target')", 'ctx.logger'))
    const first = pack(dir, out, 'a1', 'x.tgz', [])
    const bytes = readFileSync(first.file)
    edit(dir, 'index.js', (s) => s.replace('const log = ctx.logger', 'const log = ctx.logger ?? console'))
    const second = pack(dir, out, 'a1', 'x.tgz', [])
    assert.notEqual(second.file, first.file)
    assert.match(path.basename(first.file), /^autofit-agent-target-1\.0\.0\+autofit\.a1-[0-9a-f]{10}\.tgz$/)
    assert.deepEqual(readFileSync(first.file), bytes)
    assert.deepEqual(readdirSync(out).sort(), [path.basename(first.file), path.basename(second.file)].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

// The collateral edits the rules used to make (synthetic case from the 2026-11-09 review).
test('rules: service rename touches only the service references', () => {
  const dir = plugin({
    'package.json': JSON.stringify({ name: 'p', dsh: { settingsScope: 'user', inject: ['settingsScope'] } }),
    'lib/index.js': "export const inject = ['settingsScope']\nexport function apply(ctx) {\n  const prefs = ctx.settingsScope\n  const alt = ctx.get('settingsScope')\n  ctx.inject(['settingsScope'], (sub) => sub.settingsScope.open())\n  const saved = store.get('settingsScope')\n  log('settingsScope ready')\n}\n",
  })
  fixServiceRenames(dir, { layers: { L2: { client: { failures: [{ error: 'p: pending (waiting for service: settingsScope)' }] } } } })
  const src = readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8')
  assert.equal(src, "export const inject = ['configForms']\nexport function apply(ctx) {\n  const prefs = ctx.configForms\n  const alt = ctx.get('configForms')\n  ctx.inject(['configForms'], (sub) => sub.configForms.open())\n  const saved = store.get('settingsScope')\n  log('settingsScope ready')\n}\n")
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).dsh, { settingsScope: 'user', inject: ['configForms'] })
  rmSync(dir, { recursive: true })
})

test('rules: schema fix stays inside schema properties and tool registrations', () => {
  const dir = plugin({
    'lib/index.js': "const opts = { config: { type: 'object' } }\nctx.tools.register({ name: 't', parameters: { type: 'object' }, output: { schema: { type: 'object', additionalProperties: false, properties: { config: { type: 'object' } } } } })\n",
    'lib/vendor/ajv-like.js': "const s = { schema: { type: 'object', properties: { config: {} } } }\n",
  })
  const errors = [{ error: 'tool t: schema.properties.config.additionalProperties must be explicitly true or false' }, { error: 'tool t: schema.additionalProperties must be explicitly true or false' }]
  fixSchemaAdditionalProperties(dir, { layers: { L2: { host: { failures: errors } } } })
  const src = readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8')
  assert.match(src, /^const opts = \{ config: \{ type: 'object' \} \}/, 'an options bag named config is untouched')
  assert.match(src, /parameters: \{ type: 'object', additionalProperties: true \}/)
  assert.match(src, /properties: \{ config: \{ type: 'object', additionalProperties: true \} \}/)
  assert.equal(readFileSync(path.join(dir, 'lib', 'vendor', 'ajv-like.js'), 'utf8'), "const s = { schema: { type: 'object', properties: { config: {} } } }\n", 'a schema outside a registration is untouched')
  rmSync(dir, { recursive: true })
})

test('rules: a requirement that is a plain dependency is not widened', () => {
  const dir = plugin()
  const c = widenRequirements(dir, { host: { version: '0.2.2-rc.1' }, layers: { L1: { requirements: { 'some-lib': '^1.0.0', '@deepseek-ai/dsh-tools': '^0.1.0' } } } })
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['some-lib'], '^1.0.0')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '^0.1.0 || ^0.2.2-rc.1')
  assert.deepEqual(c.map((x) => x.rule), ['widen-peer'])
  rmSync(dir, { recursive: true })
})
