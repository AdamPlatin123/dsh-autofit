// Repair rules on snippets taken from the plugins they were reproduced on (.lab/RESULTS.md).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fixPatchDialect, fixSchemaAdditionalProperties, fixServiceRenames, fixToolOutput, residuals, widenRequirements } from '../lib/autofix/rules.js'

function pkgDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autofit-rule-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  return dir
}
const read = (dir, f) => readFileSync(path.join(dir, f), 'utf8')

test('A widen-peer: only the requirements the host reported (dsh-period-report)', () => {
  const dir = pkgDir({ 'package.json': { name: 'dsh-period-report', version: '0.2.1', peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' } } })
  const c = widenRequirements(dir, { host: { version: '0.2.1-rc.2' }, layers: { L1: { requirements: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' } } } })
  const pkg = JSON.parse(read(dir, 'package.json'))
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '^0.1.0-rc.6 || ^0.2.1-rc.2')
  assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '^4.0.1')
  assert.equal(c.length, 1)
  rmSync(dir, { recursive: true })
})

test('A widen-engines (dsh-dingtalk >=0.2.1-rc.3 on rc.2)', () => {
  const dir = pkgDir({ 'package.json': { name: 'dsh-dingtalk', engines: { dsh: '>=0.2.1-rc.3' } } })
  widenRequirements(dir, { host: { version: '0.2.1-rc.2' }, layers: { L1: { requirements: { 'engines.dsh': '>=0.2.1-rc.3' } } } })
  assert.equal(JSON.parse(read(dir, 'package.json')).engines.dsh, '>=0.2.1-rc.3 || ^0.2.1-rc.2')
  rmSync(dir, { recursive: true })
})

test('A patch-dialect (dsh-insurance-actuary)', () => {
  const dir = pkgDir({ 'package.json': { name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } }, 'cordis.patch.yml': "insert:\n  - id: insurance-actuary\n    name: '@kevinsales/dsh-insurance-actuary'\n" })
  assert.equal(fixPatchDialect(dir, { codes: ['legacy-patch-dialect'] }).length, 1)
  assert.equal(read(dir, 'cordis.patch.yml'), "- insert:\n    - id: insurance-actuary\n      name: '@kevinsales/dsh-insurance-actuary'\n")
  rmSync(dir, { recursive: true })
})

test('B schema-additional-properties: keyed path from the host error (dsh-period-report)', () => {
  const dir = pkgDir({ 'package.json': { name: 'x' }, 'index.js': "const s = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, config: { type: 'object' }, other: { type: 'object' } } }\n" })
  const c = fixSchemaAdditionalProperties(dir, { layers: { L2: { host: { failures: [{ error: 'JsonSchemaError: unsupported JSON schema: schema.properties.config.additionalProperties must be explicitly true or false' }] } } } })
  assert.equal(c.length, 1)
  const src = read(dir, 'index.js')
  assert.match(src, /config: \{ type: 'object', additionalProperties: true \}/)
  assert.match(src, /other: \{ type: 'object' \}/, 'only the reported key is touched')
  assert.equal(fixSchemaAdditionalProperties(dir, { layers: { L2: { host: { failures: [{ error: 'schema.properties.config.additionalProperties must be explicitly true or false' }] } } } }).length, 0, 'idempotent')
  rmSync(dir, { recursive: true })
})

test('B tool-output: register() without output gets one; tools that have it are untouched (dsh-insurance-actuary)', () => {
  const dir = pkgDir({ 'package.json': { name: 'x' }, 'index.js': "export function apply(ctx) {\n  ctx.tools.register({\n    name: 'a',\n    description: 'x { not a brace }',\n    parameters: { type: 'object', properties: {} },\n    execute: async (args) => ({ systemPrompt: '}', instruction: `${args.q}` }),\n  })\n  ctx.tools.register({ name: 'b', description: 'y', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) })\n}\n" })
  const c = fixToolOutput(dir, { codes: ['tool-output-required'] })
  assert.equal(c.length, 1)
  const src = read(dir, 'index.js')
  assert.equal((src.match(/output:/g) ?? []).length, 2)
  assert.doesNotThrow(() => new Function(src.replace('export ', '')))
  rmSync(dir, { recursive: true })
})

test('B service-rename settingsScope → configForms only when the plugin waits for the old name', () => {
  const dir = pkgDir({ 'package.json': { name: 'x' }, 'client.js': "export const inject = ['settingsScope']\nctx.settingsScope.open()\n" })
  assert.equal(fixServiceRenames(dir, { layers: { L2: { client: { failures: [{ error: 'dsh-x: pending (waiting for service: configForms)' }] } } } }).length, 0, 'plugin newer than host: no rename')
  assert.equal(fixServiceRenames(dir, { layers: { L2: { client: { failures: [{ error: 'dsh-vision-router: pending (waiting for service: settingsScope)' }] } } } }).length, 1)
  assert.equal(read(dir, 'client.js'), "export const inject = ['configForms']\nctx.configForms.open()\n")
  rmSync(dir, { recursive: true })
})

test('residuals: blocked builds need approval; client asset URLs go to the agent tier', () => {
  const r = residuals({ codes: ['build-scripts-blocked', 'native-build', 'client-asset-404'], layers: { L1: { blockedBuilds: ['node-pty@1.1.0'] } } })
  assert.deepEqual(r.needsApproval[0].packages, ['node-pty'])
  assert.ok(r.unresolved.some((u) => u.code === 'client-asset-404'))
})

test('residuals: a passing plugin does not ask to approve build scripts; an unexplained failure goes to the agent tier', () => {
  assert.deepEqual(residuals({ verdict: 'pass', codes: ['build-scripts-blocked'], layers: { L1: { blockedBuilds: ['onnxruntime-node@1.0.0'] } } }).needsApproval, [])
  const r = residuals({ verdict: 'fail', codes: [], layers: { L2: { client: { failures: [{ entry: 'dsh-codex-connect', error: 'dsh-codex-connect: failed', codes: [] }] } } } })
  assert.equal(r.unresolved[0].code, 'unknown-failure')
})
