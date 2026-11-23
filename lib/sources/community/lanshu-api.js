/**
 * Community adapter for the lanshuagent DSH plugin directory API (https://dsh.lanshuagent.com/api/plugins, the
 * site behind cclank/dsh-plugin-hub): one static JSON, `{ schemaVersion: 4, generatedAt, automation, sources,
 * summary, categories, plugins: [...] }`, the whole list in one response (no paging).
 *
 * Every row is a GitHub repo. The site screens a repo at one commit (`screenedCommit`, 40 hex) and, when it
 * clears it, prints an install command `dsh plugin [--profile x] add github:<repo>#<screenedCommit>`; that commit
 * is what we offer, as a pinned git install of the repo root (or of the `/tree/<ref>/<dir>` directory the row's
 * `url` names, only when the command names that `&path:/<dir>`). Rows are skipped when:
 * - they have no screened commit (`unpinned`); the `manifest.packageName@version` the site lists comes from the
 *   repo's package.json, not from npm, so it is unverified;
 * - the site set no install command, or one that does not install exactly that repo, commit and directory
 *   (`not-issued`): most screened rows awaiting review are like this, and the site withholds the install;
 * - the site's screening blocked them (`screening-blocked`).
 * Identity follows what is installed: `repo` (and directory) come from the row's `repo`, never from a declared
 * repository. The name is the screened manifest's package name, else the repo name.
 */

import {
  DESCRIPTION_MAX, SKIP, TITLE_MAX, cleanCategory, cleanCount, cleanText, gitInstall, httpUrl, isPackageName,
  makeOffering, repoFromUrl, skipTally,
} from '../offer.js'
import { parse } from '../semver.js'

export const id = 'lanshu-api'
export const title = { zh: 'lanshuagent DSH 插件目录 API', en: 'lanshuagent DSH plugin directory API' }

/** Extra skip reasons this adapter counts, besides offer.js SKIP. */
export const LANSHU_SKIP = { unpinned: 'unpinned', notIssued: 'not-issued', blocked: 'screening-blocked' }

const SCHEMA_VERSION = 4
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const LABEL = /^[a-z0-9-]{1,32}$/
const INSTALL = /^dsh\s+plugin\s+(?:--profile\s+[a-z0-9-]{1,32}\s+)?add\s+(\S+)$/

/** The spec token of the site's `dsh plugin [--profile x] add <spec>` command, or null. */
function issuedSpec(cmd) {
  if (typeof cmd !== 'string' || cmd.length > 2000) return null
  const m = INSTALL.exec(cmd.trim())
  return m ? m[1] : null
}
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A row as this API writes it: an `owner/repo`, a manifest object and a screening object. */
function looksLikeRow(p) {
  return isObject(p) && typeof p.repo === 'string' && isObject(p.manifest) && isObject(p.screening) &&
    'screenedCommit' in p
}

/**
 * Whether `doc` is a lanshuagent directory document: numeric schemaVersion, string generatedAt, the
 * `automation` / `summary` / `sources` / `categories` objects, and a plugins array whose rows (when any) carry
 * repo + manifest + screening + screenedCommit. Format-1 indexes, shop files, npm search pages and radar documents
 * lack these keys.
 */
export function detect(doc) {
  if (!isObject(doc) || typeof doc.schemaVersion !== 'number' || typeof doc.generatedAt !== 'string') return false
  if (!isObject(doc.automation) || !isObject(doc.summary) || !isObject(doc.sources) || !isObject(doc.categories)) {
    return false
  }
  if (!Array.isArray(doc.plugins) || 'format' in doc) return false
  return doc.plugins.length === 0 || doc.plugins.slice(0, 20).some(looksLikeRow)
}

/** The package name to show: the screened manifest's, else the repo name part; null when neither is valid. */
function rowName(p, repo) {
  const declared = isObject(p.manifest) ? p.manifest.packageName : undefined
  if (isPackageName(declared, { caseInsensitive: true })) return declared
  const fallback = repo.split('/')[1]
  return isPackageName(fallback, { caseInsensitive: true }) ? fallback : null
}

function rowLabels(p, sourceId) {
  const labels = []
  const push = (l) => { if (LABEL.test(l)) labels.push(`${sourceId}:${l}`) }
  if (p.curated === true) push('curated')
  // the review covers the installed code only when it was made at the screened commit
  if (isObject(p.codexPick) && p.codexPick.reviewedCommit === p.screenedCommit) push('codex-pick')
  if (typeof p.screening.state === 'string') push(`screening-${p.screening.state}`)
  if (isObject(p.attention) && p.attention.level === 'caution') push('caution')
  if (isObject(p.manifest) && Array.isArray(p.manifest.lifecycleScripts) && p.manifest.lifecycleScripts.length) {
    push('lifecycle-scripts')
  }
  return labels
}

/** One row → `{ offering }` or `{ error }`. */
function readRow(p, sourceId) {
  if (!looksLikeRow(p)) return { error: SKIP.entry }
  if (!REPO.test(p.repo) || /^\.+$/.test(p.repo.split('/')[1])) return { error: SKIP.source }
  if (p.screening.state === 'blocked') return { error: LANSHU_SKIP.blocked }
  if (p.screenedCommit === null || p.screenedCommit === undefined) return { error: LANSHU_SKIP.unpinned }
  const repo = p.repo.toLowerCase()
  // A monorepo row names its package directory only in `url` (…/tree/<ref>/<dir>); it must be the same repo.
  let directory = null
  if (typeof p.url === 'string' && /\/tree\//.test(p.url)) {
    const fromUrl = repoFromUrl(p.url)
    if (fromUrl.repo !== repo || fromUrl.directory === null) return { error: SKIP.source }
    directory = fromUrl.directory
  }
  const name = rowName(p, repo)
  if (name === null) return { error: SKIP.name }
  const target = gitInstall(`https://github.com/${p.repo}.git`, p.screenedCommit, directory)
  if (target.error) return { error: target.error }
  // offer only what the site itself issued: the same repo, commit (validated by gitInstall above) and directory
  const expected = `github:${p.repo}#${p.screenedCommit}${directory === null ? '' : `&path:/${directory}`}`
  if (issuedSpec(p.installCommand)?.toLowerCase() !== expected.toLowerCase()) return { error: LANSHU_SKIP.notIssued }
  const version = typeof p.manifest.version === 'string' && parse(p.manifest.version) ? p.manifest.version : null
  return {
    offering: makeOffering({
      sourceId,
      name,
      title: cleanText(p.name, TITLE_MAX),
      description: cleanText(p.description, DESCRIPTION_MAX),
      category: cleanCategory(p.category),
      version,
      versionCount: version ? 1 : 0,
      repo,
      directory,
      homepage: httpUrl(p.homepage) ?? `https://github.com/${p.repo}`,
      install: target.install,
      stars: cleanCount(p.stars),
      labels: rowLabels(p, sourceId),
    }),
  }
}

/**
 * Offerings from a lanshuagent directory document (schemaVersion 4): one pinned git offering per screened,
 * unblocked repo (+ directory). `hostVersion` is accepted for interface symmetry: rows declare no engines.
 * @returns `{ offerings, skipped, skippedBy, warnings }`
 * @throws TypeError when `detect(doc)` is false, for another schemaVersion, or without a sourceId.
 */
export function read(doc, { sourceId } = {}) {
  if (!detect(doc)) throw new TypeError('not a lanshuagent plugin directory document')
  if (doc.schemaVersion !== SCHEMA_VERSION) throw new TypeError('unsupported lanshuagent schemaVersion')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const seen = new Set()
  doc.plugins.forEach((p, i) => {
    const where = `plugins[${i}]${isObject(p) && typeof p.repo === 'string' ? ` ${p.repo.slice(0, 120)}` : ''}`
    const { offering, error } = readRow(p, sourceId)
    if (error) {
      tally.count(error, where)
      return
    }
    const identity = `${offering.repo}|${offering.directory ?? ''}`
    if (seen.has(identity)) {
      tally.count(SKIP.duplicate, where)
      return
    }
    seen.add(identity)
    offerings.push(offering)
  })
  return { offerings, ...tally.result() }
}
