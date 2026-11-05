// describe(): kind / surfaces / target profile / profile impact, on minimal synthetic packages modelled on
// dsh-tui (frontend), dsh-plugin-desktop (shell), ds-bot (service) and an ordinary extension.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { describe } from '../lib/describe.js'

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'describe')
const CORE = new Set(['tool-bash', 'tool-fs', 'tool-fs-search', 'plan-mode', 'skill-filesystem', 'sandbox-policy', 'web-runtime', 'agent-loop'])
const d = (name) => describe(path.join(FX, name), { core: CORE })

test('frontend: disables core rows, touches sandbox policy, wants its own profile', (t) => {
  const r = d('frontend')
  if (r.profileImpact.inserts.length === 0) return t.skip('dsh (for its yaml module) not installed locally')
  assert.equal(r.kind, 'frontend')
  assert.equal(r.targetProfile, 'fx-front')
  assert.equal(r.profileImpact.disablesCore.length, 5)
  assert.deepEqual(r.profileImpact.security, ['sandbox-policy'])
  assert.equal(r.profileImpact.level, 'high')
  assert.ok(r.surfaces.includes('terminal'))
})

test('shell: electron peer + embedded runtime, plugins belong to that runtime', (t) => {
  const r = d('shell')
  if (r.profileImpact.inserts.length === 0) return t.skip('dsh not installed locally')
  assert.equal(r.kind, 'shell')
  assert.equal(r.targetProfile, 'own-runtime')
  assert.equal(r.requirements.embeddedRuntime, '0.1.5-rc.2')
  assert.deepEqual(r.requirements.nativeModules, ['koffi'])
  assert.deepEqual(r.profileImpact.reconfiguresCore, ['web-runtime'])
})

test('service: long-lived + credentials + endpoint', () => {
  const r = d('service')
  assert.equal(r.kind, 'service')
  assert.deepEqual(r.requirements.env, ['FX_BOT_TOKEN'])
  assert.deepEqual(r.requirements.endpoints, ['https://api.example-im.com'])
})

test('extension: low impact, web target', () => {
  const r = d('extension')
  assert.equal(r.kind, 'extension')
  assert.equal(r.targetProfile, 'web')
  assert.equal(r.profileImpact.level, 'low')
  assert.ok(r.surfaces.includes('web-client'))
})

test('lite patch reader covers the row-operation subset', async () => {
  const { parsePatchLite } = await import('../lib/describe.js')
  const doc = parsePatchLite(`- id: tool-bash\n  disabled: true\n- id: approval\n  config:\n    policy: !!js "x"\n- insert:\n    - id: a\n      name: pkg-a\n    - id: b\n      name: pkg-a/b\n- id: web\n  name: other-impl\n`)
  assert.deepEqual(doc[0], { id: 'tool-bash', disabled: true })
  assert.equal(doc[1].config, true)
  assert.deepEqual(doc[2].insert.map((r) => r.id), ['a', 'b'])
  assert.equal(doc[3].name, 'other-impl')
})

test('dshPackageDir reads wrapper scripts and honours the override', async () => {
  const { dshPackageDir } = await import('../lib/describe.js')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofit-shim-'))
  const pkg = path.join(root, 'rt', 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.2"}')
  const shim = path.join(root, 'dsh')
  fs.writeFileSync(shim, `#!/bin/sh\nexec node ${pkg}/lib/bin.js "$@"\n`)
  assert.equal(dshPackageDir(shim, {}), pkg)
  assert.equal(dshPackageDir('/nope', { DSH_AUTOFIT_DSH_DIR: pkg }), pkg)
  fs.rmSync(root, { recursive: true, force: true })
})
