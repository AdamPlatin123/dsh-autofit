/**
 * Tests for which specs autofix can repair: npm names and local files are repaired; git specs, GitHub shorthands and
 * remote tarballs are trial-installed only and end with outcome 'not-repairable' (the trial result still counts:
 * a passing git spec installs as is). The trial itself goes through the `probeFn` seam, so nothing is installed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NOT_REPAIRABLE, autofitPipeline, autofix, localPath, repairableSpec } from '../lib/autofix/index.js'

const SHA = 'e485cbe0ece0ad4d79d1ebd84d4f55222c5c85e0'

test('repairableSpec truth table', () => {
  for (const spec of ['pkg', 'dsh-foo@1.2.3', '@s/p@1.2.3', '@s/p', 'npm:p@^1', 'p@latest', './x', '../x.tgz', 'C:\\x.tgz', 'C:/plugins/x', 'file:x.tgz', '/abs/dir']) {
    assert.equal(repairableSpec(spec), true, spec)
  }
  for (const spec of [
    `git+https://github.com/o/r.git#${SHA}`,
    `git+https://github.com/o/r.git#${SHA}&path:/packages/x`,
    'github:o/r',
    'o/r',
    'o/r#main',
    'git@github.com:o/r.git',
    'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
    'https://codeload.github.com/o/r/tar.gz/abc',
    'pkg@github:o/r',
  ]) {
    assert.equal(repairableSpec(spec), false, spec)
  }
})

test('localPath never treats a URL as a local file', () => {
  assert.equal(localPath('https://h/x.tgz'), null)
  assert.equal(localPath('git+https://github.com/o/r.git'), null)
  assert.equal(localPath('file:x.tgz'), 'x.tgz')
  assert.equal(localPath('C:\\x.tgz'), 'C:\\x.tgz')
  assert.equal(localPath('dsh-foo'), null)
})

const trialOf = (verdict) => async (spec) => ({ spec, verdict, codes: verdict === 'pass' ? [] : ['schema-additional-properties'], layers: {} })

test('autofitPipeline: a failing git spec ends as not-repairable after the trial, without unpacking', async () => {
  const events = []
  const spec = `git+https://github.com/o/r.git#${SHA}&path:/plugin`
  const r = await autofitPipeline(spec, { probeFn: trialOf('fail'), onEvent: (e) => events.push(e) })
  assert.equal(r.outcome, 'not-repairable')
  assert.equal(r.reason, NOT_REPAIRABLE)
  assert.equal(r.final.verdict, 'fail')
  assert.deepEqual(events.map((e) => e.stage ?? e.type), ['trial', 'original', 'done'])
  assert.equal(events.at(-1).outcome, 'not-repairable')
  const tarball = await autofitPipeline('https://registry.npmjs.org/x/-/x-1.0.0.tgz', { probeFn: trialOf('incompatible') })
  assert.equal(tarball.outcome, 'not-repairable')
})

test('autofitPipeline: a passing git spec still installs the original spec', async () => {
  const r = await autofitPipeline('github:o/r', { probeFn: trialOf('pass') })
  assert.equal(r.outcome, 'pass')
  assert.equal(r.install, 'github:o/r')
})

test('autofix: a failing git spec reports notRepairable with the trial verdict', async () => {
  const r = await autofix(`git+https://github.com/o/r.git#${SHA}`, { probeFn: trialOf('fail') })
  assert.equal(r.verdict, 'fail')
  assert.equal(r.notRepairable, true)
  assert.equal(r.reason, NOT_REPAIRABLE)
  assert.equal(r.rounds.length, 1)
  assert.equal(r.artifact, null)
  assert.equal(r.error, undefined)
})
