/**
 * Fetch a published plugin's tarball over HTTP with Node's built-in fetch — no `npm` executable needed (a DSH
 * started from a GUI launcher or DSH Desktop often has no npm on PATH: "spawnSync npm ENOENT").
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { dshPackageDir } from '../describe.js'

/** Split `name[@version|tag|range]`, scoped names included. */
export function parseNpmSpec(spec) {
  const s = String(spec).replace(/^npm:/, '')
  const at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@')
  return at > 0 ? { name: s.slice(0, at), want: s.slice(at + 1) } : { name: s, want: '' }
}

function registries(env) {
  const list = [env.npm_config_registry, env.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org', 'https://registry.npmmirror.com']
  return [...new Set(list.filter(Boolean).map((r) => r.replace(/\/+$/, '')))]
}

function semverFor(env) {
  try {
    const dir = dshPackageDir(env.DSH_AUTOFIT_DSH_BIN || 'dsh', env)
    return dir ? createRequire(path.join(dir, 'package.json'))('semver') : null
  } catch { return null }
}

/** Pick the version `want` names: exact version, dist-tag, range (needs DSH's semver), or latest. */
export function pickVersion(meta, want, semver) {
  const versions = Object.keys(meta.versions ?? {})
  if (!want) return meta['dist-tags']?.latest
  if (meta.versions?.[want]) return want
  if (meta['dist-tags']?.[want]) return meta['dist-tags'][want]
  if (semver) return semver.maxSatisfying(versions, want, { includePrerelease: true }) ?? null
  return null
}

/**
 * Download `spec`'s tarball into `dir`.
 * @returns {Promise<{ file: string, name: string, version: string, registry: string }>}
 */
export async function fetchTarball(spec, dir, env = process.env) {
  const { name, want } = parseNpmSpec(spec)
  const errors = []
  for (const reg of registries(env)) {
    try {
      const url = `${reg}/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
      if (res.status === 404) { errors.push(`${reg}: not found`); continue }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const meta = await res.json()
      const version = pickVersion(meta, want, semverFor(env))
      const tarballUrl = version && meta.versions?.[version]?.dist?.tarball
      if (!tarballUrl) { errors.push(`${reg}: no version matches ${JSON.stringify(want || 'latest')}`); continue }
      const tgz = await fetch(tarballUrl, { signal: AbortSignal.timeout(180000) })
      if (!tgz.ok) throw new Error(`tarball HTTP ${tgz.status}`)
      const file = path.join(dir, `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`)
      writeFileSync(file, Buffer.from(await tgz.arrayBuffer()))
      return { file, name, version, registry: reg }
    } catch (err) {
      errors.push(`${reg}: ${err.message ?? err}`)
    }
  }
  throw new Error(`could not download ${spec}: ${errors.join('; ')}`)
}
