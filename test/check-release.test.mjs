// scripts/check-release.mjs: what would ship, and whether this run may publish it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPackage, checkPublish } from '../scripts/check-release.mjs'

const PKG = {
  name: 'x', version: '1.2.3',
  bin: { x: 'bin/x.js' },
  exports: { '.': './bundle/index.js', './locale/*.json': './bundle/locale/*.json' },
  dsh: { bundle: { patch: './bundle/cordis.patch.yml' } },
  files: ['bin/', 'bundle/', 'README.md'],
}
const FILES = ['package.json', 'README.md', 'bin/x.js', 'bundle/index.js', 'bundle/locale/en.json', 'bundle/cordis.patch.yml']
const reader = (over = {}) => (f) => over[f] ?? (f === 'bin/x.js' ? '#!/usr/bin/env node\nimport "y"\n' : 'ok\n')

test('a package that ships what it promises passes', () => {
  assert.deepEqual(checkPackage(PKG, FILES, reader()), [])
})

test('a CRLF shebang, a CRLF file, a missing target and a stray file are each reported', () => {
  const files = [...FILES.filter((f) => f !== 'bundle/cordis.patch.yml'), 'test/a.test.mjs']
  const problems = checkPackage(PKG, files, reader({ 'bin/x.js': '#!/usr/bin/env node\r\nimport "y"\r\n', 'README.md': 'a\r\nb\r\n' }))
  assert.ok(problems.some((p) => p.startsWith('bin/x.js: bin must start')), problems.join('\n'))
  assert.ok(problems.some((p) => p.startsWith('README.md: CRLF')))
  assert.ok(problems.some((p) => p.startsWith('bundle/cordis.patch.yml: promised')))
  assert.ok(problems.some((p) => p.startsWith('test/a.test.mjs: packed but not listed')))
})

test('an export wildcard needs at least one packed match', () => {
  const problems = checkPackage(PKG, FILES.filter((f) => !f.startsWith('bundle/locale/')), reader())
  assert.deepEqual(problems, ['bundle/locale/*.json: matches no packed file'])
})

test('CI publishes only from the matching tag', () => {
  const ci = (type, name) => checkPublish('1.2.3', { env: { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: type, GITHUB_REF_NAME: name } })
  assert.deepEqual(ci('tag', 'v1.2.3'), [])
  assert.equal(ci('tag', 'v1.2.4').length, 1)
  assert.equal(ci('branch', 'main').length, 1)
})

test('a local publish needs a clean tree and HEAD tagged v<version>', () => {
  const git = (status, tags) => (args) => (args[0] === 'status' ? status : tags)
  assert.deepEqual(checkPublish('1.2.3', { env: {}, git: git('', 'v1.2.3\n') }), [])
  assert.equal(checkPublish('1.2.3', { env: {}, git: git(' M lib/a.js\n', 'v1.2.3\n') }).length, 1)
  assert.equal(checkPublish('1.2.3', { env: {}, git: git('', '') }).length, 1)
})
