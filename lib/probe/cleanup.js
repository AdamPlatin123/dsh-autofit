/**
 * Throwaway-directory cleanup that can never take the host down.
 *
 * On Windows a file still open by any process (a trial's grandchild — a plugin's proxy, tunnel or Electron helper —
 * that outlived the tree kill, an antivirus scan, an indexer) makes `rm` fail with EPERM/EBUSY. In 0.3.5 that error
 * escaped a background trial and killed the DSH host ("fatal load failure: EPERM … dsh-autofit-probe-*"). Here a
 * removal is retried, then deferred, and never throws; leftovers are swept on the next start.
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const TEMP_PREFIXES = ['dsh-autofit-probe-', 'dsh-autofit-detect-', 'dsh-autofit-fix-', 'dsh-autofit-cdp-']
const deferred = new Set()
const LATER_MS = 60_000

/** Remove a directory; returns true when it is gone. Never throws. */
export function safeRemove(dir, { retries = 4, defer = true } = {}) {
  if (!dir) return true
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: retries, retryDelay: 250 })
    deferred.delete(dir)
    return true
  } catch {
    if (defer && !deferred.has(dir)) {
      deferred.add(dir)
      const t = setTimeout(() => { deferred.delete(dir); safeRemove(dir, { retries, defer: false }) }, LATER_MS)
      t.unref?.()
    }
    return false
  }
}

/** Remove our own throwaway directories older than `maxAgeMs` from the temp root. Never throws. */
export function sweepStale({ root = tmpdir(), maxAgeMs = 60 * 60_000, now = Date.now() } = {}) {
  let removed = 0
  let names = []
  try { names = readdirSync(root) } catch { return 0 }
  for (const name of names) {
    if (!TEMP_PREFIXES.some((p) => name.startsWith(p))) continue
    const full = path.join(root, name)
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue
    } catch { continue }
    if (safeRemove(full, { retries: 1, defer: false })) removed++
  }
  return removed
}
