// Regression for the 0.3.5 host crash on Windows: "fatal load failure: EPERM … rmSync … dsh-autofit-probe-*".
// Cleanup of a throwaway dir that cannot be removed must report, never throw; stale leftovers are swept later.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { safeRemove, sweepStale } from '../lib/probe/cleanup.js'

const rootOk = process.getuid?.() === 0

test('safeRemove returns false instead of throwing when the directory cannot be removed', { skip: rootOk || process.platform === 'win32' }, () => {
  const base = mkdtempSync(path.join(tmpdir(), 'autofit-cleanup-'))
  const locked = path.join(base, 'dsh-autofit-probe-x')
  mkdirSync(path.join(locked, 'inner'), { recursive: true })
  writeFileSync(path.join(locked, 'inner', 'f'), 'x')
  chmodSync(locked, 0o500) // entries of `locked` can't be unlinked: stands in for a Windows open-file EPERM
  try {
    assert.doesNotThrow(() => safeRemove(locked, { retries: 0, defer: false }))
    assert.equal(safeRemove(locked, { retries: 0, defer: false }), false)
  } finally {
    chmodSync(locked, 0o700)
    rmSync(base, { recursive: true, force: true })
  }
})

test('safeRemove removes a normal directory and tolerates a missing one', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dsh-autofit-probe-'))
  writeFileSync(path.join(d, 'f'), 'x')
  assert.equal(safeRemove(d), true)
  assert.equal(existsSync(d), false)
  assert.equal(safeRemove(d), true)
})

test('sweepStale removes only our old throwaway dirs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'autofit-sweep-'))
  const old = path.join(root, 'dsh-autofit-probe-old')
  const fresh = path.join(root, 'dsh-autofit-probe-new')
  const other = path.join(root, 'someone-elses-dir')
  for (const d of [old, fresh, other]) mkdirSync(d)
  const past = new Date(Date.now() - 2 * 3600_000)
  utimesSync(old, past, past)
  utimesSync(other, past, past)
  assert.equal(sweepStale({ root }), 1)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true)
  assert.equal(existsSync(other), true)
  rmSync(root, { recursive: true, force: true })
})
