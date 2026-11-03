/**
 * Radar data helpers shared by the index generator and the bundle's Host half.
 * Pure ESM, no dependencies: the radar publishes static JSON (dsh-radar/v1),
 * see https://github.com/AdamPlatin123/dsh-plugin-radar/blob/main/docs/api.md
 */

export const RADAR_SOURCES = [
  'https://raw.githubusercontent.com/AdamPlatin123/dsh-plugin-radar/main/data/plugins-all.json',
  'https://cdn.jsdelivr.net/gh/AdamPlatin123/dsh-plugin-radar@main/data/plugins-all.json',
]

/** Radar verdict → market label id. `untested` is folded into pending: neither has a runtime result yet. */
const VERDICT_LABEL = {
  ok: 'radar-ok',
  incompatible: 'radar-incompatible',
  pending: 'radar-pending',
  untested: 'radar-pending',
}

export const RADAR_LABELS = {
  'radar-ok': { title: { zh: '雷达实测通过', en: 'Radar: runs' } },
  'radar-incompatible': { title: { zh: '雷达实测不兼容', en: 'Radar: incompatible' } },
  'radar-pending': { title: { zh: '雷达待测', en: 'Radar: not yet tested' } },
}

export const RADAR_SORT_KEYS = {
  stars: { title: { zh: 'GitHub 星数', en: 'GitHub stars' }, order: 'desc' },
}

/**
 * `owner/repo` (lowercase) for a GitHub URL, or undefined for anything else.
 * Accepts web URLs with trailing paths (`/tree/main/packages/x`) and `.git` suffixes.
 */
export function repoKey(url) {
  if (typeof url !== 'string') return undefined
  const m = /^(?:git\+)?https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(url.trim())
  if (!m) return undefined
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`.toLowerCase()
}

/** Map `owner/repo` → `{ verdict, label, stars }` from a parsed plugins-all.json. Throws on a foreign schema. */
export function radarMap(pluginsAll) {
  if (!pluginsAll || pluginsAll.schema !== 'dsh-radar/v1' || !Array.isArray(pluginsAll.plugins)) {
    throw new Error('radar: not a dsh-radar/v1 plugins-all document')
  }
  const map = new Map()
  for (const p of pluginsAll.plugins) {
    const key = repoKey(`https://github.com/${p.repo}`)
    const label = VERDICT_LABEL[p.verdict]
    if (!key || !label) continue
    map.set(key, { verdict: p.verdict, label, stars: Number.isFinite(p.stars) ? p.stars : undefined })
  }
  return map
}

/** Fetch JSON from the first source that answers within `timeoutMs`; local paths are read from disk. */
export async function loadJson(sources, { timeoutMs = 30000, readFile } = {}) {
  const errors = []
  for (const src of [].concat(sources)) {
    try {
      if (!/^https?:\/\//.test(src)) {
        const read = readFile ?? (await import('node:fs/promises')).readFile
        return { url: src, value: JSON.parse(await read(src, 'utf8')) }
      }
      const res = await fetch(src, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { url: src, value: await res.json() }
    } catch (err) {
      errors.push(`${src}: ${err.message}`)
    }
  }
  throw new Error(`all sources failed:\n  ${errors.join('\n  ')}`)
}
