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
