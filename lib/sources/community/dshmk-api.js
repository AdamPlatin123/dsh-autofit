/**
 * Community adapter: the dshmk.com plugin list (https://api.dshmk.com/, ZASENJC/dsh-plugins-store), one JSON
 * document `{ schemaVersion: 1, generatedAt, source{topic}, stats{fetched}, repositories: [...] }` built from a
 * GitHub topic scan. Each repository carries `validation.sourceSha`, the commit the site's sandbox validated.
 *
 * Every offering is a git install of `https://github.com/<fullName>.git` pinned to that commit. The site's
 * `install.candidates` (README-mined `github:`/npm/`link:` commands, unpinned and often ambiguous) are not used,
 * and neither is `url`: the repo (identity) is the `fullName` the spec installs. No directory: the validator
 * checks the repository root. Name and title are the repo name part, as for the radar's repo list.
 * Pure functions; fetching lives in store.js.
 */

import {
  DESCRIPTION_MAX, SKIP, cleanCategory, cleanCount, cleanKeywords, cleanText, gitInstall, httpUrl, isPackageName,
  makeOffering, skipTally,
} from '../offer.js'

export const id = 'dshmk-api'
export const title = { zh: 'dshmk.com 插件市场', en: 'dshmk.com plugin market' }

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const DETECT_SAMPLE = 5

function looksLikeRepository(r) {
  return isObject(r) && typeof r.fullName === 'string' && isObject(r.validation) && 'sourceSha' in r.validation
}

/**
 * True only for a dshmk.com API document: schemaVersion 1 with `source.topic`, numeric `stats.fetched` and a
 * `repositories` array where one of the first rows carries `fullName` and a `validation` object with `sourceSha`
 * (so a single junk row does not reject the whole document; read skips it). The older
 * catalog.json of the same repo (no validation) is not this family.
 */
export function detect(doc) {
  if (!isObject(doc) || doc.schemaVersion !== 1 || !Array.isArray(doc.repositories)) return false
  if (!isObject(doc.source) || typeof doc.source.topic !== 'string') return false
  if (!isObject(doc.stats) || typeof doc.stats.fetched !== 'number') return false
  if ('plugins' in doc || 'format' in doc || 'objects' in doc || 'schema' in doc) return false
  if (doc.repositories.length === 0) return isObject(doc.stats.validationStatuses)
  return doc.repositories.slice(0, DETECT_SAMPLE).some(looksLikeRepository)
}

/** One repository row → `{ offering }` or `{ error }`. */
function readEntry(r, sourceId) {
  if (!isObject(r) || typeof r.fullName !== 'string' || !REPO.test(r.fullName)) return { error: SKIP.entry }
  const name = r.fullName.split('/')[1]
  if (!isPackageName(name, { caseInsensitive: true })) return { error: SKIP.name }
  const validation = isObject(r.validation) ? r.validation : {}
  const target = gitInstall(`https://github.com/${r.fullName}.git`, validation.sourceSha)
  if (target.error) return { error: target.error }
  const labels = []
  if (validation.verified === true) labels.push(`${sourceId}:verified`)
  if (r.archived === true) labels.push(`${sourceId}:archived`)
  return {
    offering: makeOffering({
      sourceId,
      name,
      title: name,
      description: cleanText(r.description, DESCRIPTION_MAX),
      category: cleanCategory(r.category),
      keywords: cleanKeywords(r.topics),
      repo: r.fullName.toLowerCase(),
      homepage: httpUrl(r.homepage) ?? `https://github.com/${r.fullName}`,
      install: target.install,
      stars: cleanCount(r.stars),
      labels,
    }),
  }
}

/**
 * Offerings from a dshmk.com API document, one per repository (first row wins on a case-insensitive duplicate).
 * Rows without a 40-hex `validation.sourceSha` are skipped (`invalid-source`). `hostVersion` is accepted for
 * interface symmetry and not used: the site names one commit per repo and no engines range.
 * @returns `{ offerings, skipped, skippedBy, warnings }`
 * @throws TypeError('not a dshmk.com API document') or TypeError for a missing sourceId.
 */
export function read(doc, { sourceId } = {}) {
  if (!detect(doc)) throw new TypeError('not a dshmk.com API document')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const seen = new Set()
  doc.repositories.forEach((r, i) => {
    const { offering, error } = readEntry(r, sourceId)
    const where = `repositories[${i}]${typeof r?.fullName === 'string' ? ` ${r.fullName.slice(0, 100)}` : ''}`
    if (error) {
      tally.count(error, where)
      return
    }
    if (seen.has(offering.repo)) {
      tally.count(SKIP.duplicate, where)
      return
    }
    seen.add(offering.repo)
    offerings.push(offering)
  })
  return { offerings, ...tally.result() }
}
