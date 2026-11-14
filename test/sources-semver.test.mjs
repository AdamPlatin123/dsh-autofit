import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { dshPackageDir } from '../lib/describe.js'
import { RANGE_MAX, compare, parse, prerelease, rcompare, satisfies, valid, validRange } from '../lib/sources/semver.js'

/** The semver package that ships inside the local DSH install (no devDependency), or undefined. */
function officialSemver() {
  try {
    return createRequire(path.join(dshPackageDir(), 'package.json'))('semver')
  } catch {
    return undefined
  }
}

test('parse and valid accept strict SemVer 2.0.0 only', () => {
  assert.deepEqual(parse('1.2.3-rc.10+build.5'), {
    major: 1, minor: 2, patch: 3, prerelease: ['rc', 10], build: ['build', '5'], version: '1.2.3-rc.10',
  })
  const table = [
    ['0.0.0', '0.0.0'],
    ['1.2.3', '1.2.3'],
    ['0.2.1-rc.2', '0.2.1-rc.2'],
    ['1.0.0-alpha-1.0', '1.0.0-alpha-1.0'],
    ['1.0.0-0A.is.legal', '1.0.0-0A.is.legal'],
    ['1.2.3+meta', '1.2.3'],
    ['v1.2.3', null],
    [' 1.2.3', null],
    ['=1.2.3', null],
    ['1.2', null],
    ['1', null],
    ['01.2.3', null],
    ['1.02.3', null],
    ['1.2.3-01', null],
    ['1.2.3-', null],
    ['1.2.3-rc..1', null],
    ['1.2.3+', null],
    ['1.2.3.4', null],
    ['x.1.2', null],
    ['', null],
    [`1.2.${'9'.repeat(20)}`, null],
    [null, null],
    [123, null],
  ]
  for (const [input, want] of table) assert.equal(valid(input), want, JSON.stringify(input))
})

test('compare orders by SemVer precedence (spec section 11) and ignores build metadata', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11',
    '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0-0', '2.0.0', '10.0.0']
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(compare(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`)
    }
  }
  assert.equal(compare('1.2.3+a', '1.2.3+b'), 0)
  assert.equal(rcompare('1.0.0', '2.0.0'), 1)
  assert.deepEqual(['0.3.0', '0.10.0', '0.2.0-rc.1', '0.2.0'].sort(rcompare), ['0.10.0', '0.3.0', '0.2.0', '0.2.0-rc.1'])
  assert.throws(() => compare('1.2', '1.2.3'), TypeError)
})

test('prerelease returns identifiers or null', () => {
  assert.deepEqual(prerelease('0.2.1-rc.2'), ['rc', 2])
  assert.equal(prerelease('0.2.1'), null)
  assert.equal(prerelease('garbage'), null)
})

test('satisfies: range table (default options)', () => {
  /** [range, [versions that match], [versions that do not]] */
  const table = [
    ['^1.2.3', ['1.2.3', '1.9.0'], ['1.2.2', '2.0.0', '2.0.0-0', '1.3.0-rc.1']],
    ['^0.2.0', ['0.2.0', '0.2.9'], ['0.3.0', '0.1.9', '0.2.1-rc.2']],
    ['^0.2', ['0.2.0', '0.2.5'], ['0.3.0']],
    ['^0.0.3', ['0.0.3'], ['0.0.4', '0.0.2']],
    ['^0.0', ['0.0.0', '0.0.9'], ['0.1.0']],
    ['^0', ['0.0.0', '0.99.0'], ['1.0.0']],
    ['^1.x', ['1.0.0', '1.9.9'], ['2.0.0']],
    ['^1.2.3-beta.2', ['1.2.3-beta.2', '1.2.3-beta.10', '1.2.3', '1.9.0'], ['1.2.3-beta.1', '1.2.4-beta.1', '2.0.0']],
    ['~1.2.3', ['1.2.3', '1.2.9'], ['1.3.0', '1.2.2']],
    ['~1.2', ['1.2.0', '1.2.9'], ['1.3.0']],
    ['~1', ['1.0.0', '1.9.9'], ['2.0.0']],
    ['~>1.2', ['1.2.4'], ['1.3.0']],
    ['~ 1.2.3', ['1.2.3'], ['1.3.0']],
    ['>=1.2.3', ['1.2.3', '9.0.0'], ['1.2.2', '1.2.3-rc.1']],
    ['>1.2.3', ['1.2.4'], ['1.2.3']],
    ['>1.2', ['1.3.0'], ['1.2.9']],
    ['>1', ['2.0.0'], ['1.9.9']],
    ['<=1.2', ['1.2.9', '0.1.0'], ['1.3.0']],
    ['<1.2', ['1.1.9'], ['1.2.0']],
    ['<1', ['0.9.9'], ['1.0.0']],
    ['>= 1.2.3 < 2', ['1.5.0'], ['2.0.0', '1.0.0']],
    ['=1.2.3', ['1.2.3', 'v1.2.3', ' 1.2.3 '], ['1.2.4']],
    ['1.2.3', ['1.2.3'], ['1.2.4']],
    ['1.x', ['1.0.0', '1.9.0'], ['2.0.0']],
    ['1.2.X', ['1.2.0', '1.2.9'], ['1.3.0']],
    ['1.*', ['1.4.0'], ['0.9.0']],
    ['*', ['0.0.0', '99.0.0'], ['1.0.0-rc.1']],
    ['', ['1.0.0'], ['1.0.0-rc.1']],
    ['x', ['1.0.0'], []],
    ['>=*', ['1.0.0'], []],
    ['<*', [], ['1.0.0', '0.0.0']],
    ['1.2.3 - 2.3.4', ['1.2.3', '2.3.4'], ['2.3.5', '1.2.2']],
    ['1.2 - 2.3', ['1.2.0', '2.3.9'], ['2.4.0']],
    ['1 - 2', ['1.0.0', '2.9.9'], ['3.0.0']],
    ['1.2.3 || ^2', ['1.2.3', '2.5.0'], ['1.2.4', '3.0.0']],
    ['>=0.2.0-rc.2 <0.3.0-0', ['0.2.0-rc.2', '0.2.0', '0.2.9'], ['0.2.1-rc.2', '0.3.0']],
    ['0.2.0-rc.2 || 0.2.1-rc.3', ['0.2.0-rc.2', '0.2.1-rc.3'], ['0.2.1-rc.2']],
    ['1.0.0-rc.1 || *', ['2.0.0'], ['1.0.0-rc.1']],
    ['>=1.2.3+build <2', ['1.2.3'], ['2.0.0']],
    ['garbage', [], ['1.0.0']],
    ['1.2.3.4', [], ['1.2.3']],
    ['>=1.2.3 <1.2.3', [], ['1.2.3']],
  ]
  for (const [range, yes, no] of table) {
    for (const v of yes) assert.equal(satisfies(v, range), true, `${v} in ${JSON.stringify(range)}`)
    for (const v of no) assert.equal(satisfies(v, range), false, `${v} not in ${JSON.stringify(range)}`)
  }
  assert.equal(satisfies('not-a-version', '*'), false)
  assert.equal(satisfies('1.0.0', 42), false)
})

test('satisfies with includePrerelease (how DSH checks engines.dsh)', () => {
  const inc = { includePrerelease: true }
  const host = '0.2.1-rc.2'
  assert.equal(satisfies(host, '^0.2.0', inc), true)
  assert.equal(satisfies(host, '^0.2.0-rc.2', inc), true)
  assert.equal(satisfies(host, '>=0.2.0-0', inc), true)
  assert.equal(satisfies(host, '*', inc), true)
  assert.equal(satisfies(host, '0.2.x', inc), true)
  assert.equal(satisfies(host, '~0.2.1', inc), false)
  assert.equal(satisfies(host, '>=0.2.1', inc), false)
  assert.equal(satisfies(host, '^0.1.0-rc.6', inc), false)
  assert.equal(satisfies(host, '0.2.1-rc.3', inc), false)
  // a caret on a full release version keeps a plain lower bound even here (node-semver 7.8)
  assert.equal(satisfies('0.2.0-rc.2', '^0.2.0', inc), false)
  assert.equal(satisfies('0.2.0-rc.2', '^0.2', inc), true)
})

test('validRange desugars like semver.validRange and rejects garbage', () => {
  assert.equal(validRange('^1.2.3'), '>=1.2.3 <2.0.0-0')
  assert.equal(validRange('~1.2'), '>=1.2.0 <1.3.0-0')
  assert.equal(validRange('1.2.3 - 2.3'), '>=1.2.3 <2.4.0-0')
  assert.equal(validRange('*'), '*')
  assert.equal(validRange('<*'), '<0.0.0-0')
  assert.equal(validRange('1.x', { includePrerelease: true }), '>=1.0.0-0 <2.0.0-0')
  assert.equal(validRange('garbage'), null)
  assert.equal(validRange('>=1.2.3 garbage'), null)
  assert.equal(validRange(undefined), null)
})

const VERSIONS = ['0.0.0', '0.0.1', '0.0.2-0', '0.1.0', '0.1.9', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-alpha.1',
  '0.2.1-rc.2', '0.2.1-rc.10', '0.2.1', '0.2.2-rc.1', '0.3.0-0', '0.3.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta',
  '1.0.0', '1.2.3', '1.2.3-beta.2', '1.2.3-beta.10', '1.2.4-pr.1', '1.3.0-0', '1.9.9', '2.0.0-0', '2.0.0', '2.5.0',
  '10.0.0', 'v1.2.3', ' 1.2.3 ', '1.2.3+build.5', '1.2', '01.2.3', '1.2.3-01', 'x']
const RANGES = ['^0.2.0', '^0.2.0-rc.2', '^0.2', '^0', '^0.0.1', '^0.0', '^1.2.3', '^1.2.3-beta.2', '^1.2', '^1', '^1.x',
  '^*', '~0.2.1-rc.1', '~1.2.3', '~1.2', '~1', '~>1.2', '~ 1.2.3', '>=0.2.0-rc.1', '>=0.2.0-0', '>0.2.0', '>0.2', '>1',
  '<=0.2', '<=1', '<0.2.1', '<1', '<1.2', '>=1.2', '>= 1.2.3 < 2', '=1.2.3', '1.2.3', '1.x', '1.2.x', '1.X', '1.*', '*',
  'x', '', '>=*', '<*', '>*', '1.2.3 - 2.3.4', '1.2 - 2.3', '1 - 2', '1.2.3-beta.2 - 2.0.0', '1.2.3 - 2.0.0-rc.1',
  '* - 2', '1.2.3 || ^2', '>=0.1.0-rc.8 <0.2.0 || 0.2.0-rc.2 || 0.2.1-rc.2', '>=0.2.0-rc.2 <0.3.0-0',
  '>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0', '0.2.0-rc.2 || 0.2.1-rc.3 || 0.2.2-rc.1', '^0.1.7-rc.2 || ^0.2.0',
  '1.0.0-alpha || *', '1.2.3 ||', '<0.0.0-0 || 1.x', '>=0.0.0', '>=0.0.0-0', '^v1.2.3', 'v1.2.3', '1.2.3+build',
  '>=1.2.3+b <2', '1.x.3', 'x.1', '1.2.3.4', 'garbage', '>=1.2.3 garbage', '^01.2', '>=0.2.0-rc.2 <0.3', '0.2.1-rc.2',
  '<=1.2.3-rc.1', '>1.2.3-rc.1', '1.2.3-rc.1 - 1.2.3', '~0.0.1', '~0', '^0.0.1-rc.1', '==1.2.3', '>=1.2.3 <1.2.3',
  '>=0.0.1-rc <2', '^0.1.0-rc.6', '0.2.1-rc.2 || >=0.2.2-0']

test('agrees with the semver package shipped inside DSH', (t) => {
  const semver = officialSemver()
  if (!semver) return t.skip('dsh not installed locally')
  const disagreements = []
  let pairs = 0
  for (const includePrerelease of [false, true]) {
    for (const range of RANGES) {
      for (const version of VERSIONS) {
        pairs++
        const want = semver.satisfies(version, range, { includePrerelease })
        const got = satisfies(version, range, { includePrerelease })
        if (want !== got) disagreements.push({ version, range, includePrerelease, want, got })
      }
      const want = semver.validRange(range, { includePrerelease })
      const got = validRange(range, { includePrerelease })
      if (want !== got) disagreements.push({ range, includePrerelease, validRange: { want, got } })
    }
  }
  const strict = VERSIONS.filter((v) => !/^v|^\s|\s$/.test(v))
  for (const v of strict) {
    if (semver.valid(v) !== valid(v)) disagreements.push({ valid: v, want: semver.valid(v), got: valid(v) })
  }
  const good = strict.filter((v) => valid(v))
  for (const a of good) for (const b of good) {
    if (semver.compare(a, b) !== compare(a, b)) disagreements.push({ compare: [a, b] })
  }
  assert.ok(pairs >= 200, `checked ${pairs} (version, range) pairs`)
  assert.deepEqual(disagreements, [])
})

test('hostile ranges are bounded: over RANGE_MAX is invalid, and a long-but-allowed range parses in linear time', () => {
  assert.equal(RANGE_MAX, 256)
  const ok = `>=0.0.1 ${' '.repeat(RANGE_MAX - 16)}<9.0.0`
  assert.equal(ok.length <= RANGE_MAX, true)
  assert.equal(satisfies('0.2.1', ok, { includePrerelease: true }), true, 'whitespace runs inside the cap still parse')
  assert.equal(satisfies('0.2.1', `${ok} `.padEnd(RANGE_MAX + 1, ' '), { includePrerelease: true }), false)
  assert.equal(validRange('>=0.0.1 '.repeat(40)), null)
  // Before the cap and the safe whitespace quantifiers, '='.repeat(32000) took about 2 s (quadratic backtracking).
  for (const unit of ['=', 'v', '>=', '1.', ' =', '- ', '1 ']) {
    const t = performance.now()
    for (let i = 0; i < 200; i++) satisfies('0.2.1', unit.repeat(RANGE_MAX).slice(0, RANGE_MAX - 3) + i, { includePrerelease: true })
    satisfies('0.2.1', unit.repeat(32000), { includePrerelease: true })
    const ms = performance.now() - t
    assert.ok(ms < 400, `${JSON.stringify(unit)}: ${ms} ms for 201 distinct hostile ranges`)
  }
})
