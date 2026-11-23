/**
 * Community adapter for the awesome-dsh-plugin legacy catalog `plugins.json` (awesome-dsh-plugin.com/plugins.json,
 * also shipped in the npm package dsh-plugin-catalog) and the lists that copy its schema:
 * `{ name, url, source, updated, count, categories, plugins: [{ name, owner, url, npm, version, tarball?, install }] }`.
 *
 * The awesome format-1 index (index.json) already carries every npm entry, so the value of this file is its GitHub
 * entries: release tarballs (pinned) and `github:owner/repo` installs (unpinned, default branch). Install choice:
 * - `npm` + `version` → `name@version` (preferred: repairable);
 * - `tarball`, or an https `.tgz` in `install` → the tarball URL; GitHub URLs that move (`/releases/latest/`, branch
 *   or tag archives) are skipped: only release downloads and commit archives count as pinned;
 * - `install` = `… add github:owner/repo` → github-head, only when `url` is exactly that repo (no subdirectory);
 *   `github:owner/repo#<40-hex>` → git at that commit; `#path:/dir` and other refs → skipped (unpinned subdir/ref).
 * Identity: npm entries take repo/directory from `url`; a tarball takes the repo it is served from (tarballRepo) and
 * the `url` directory only when `url` is that same repo; git and github-head take the repo they install. For
 * those, `url`'s homepage and stars are kept only when `url` is the installed repo.
 * Pure functions, no I/O.
 */

import {
  DESCRIPTION_MAX, SKIP, TITLE_MAX, cleanCategory, cleanCount, cleanIcon, cleanText, gitInstall, githubHeadInstall,
  httpUrl, isPackageName, makeOffering, npmInstall, repoFromUrl, skipTally, tarballInstall, tarballRepo,
} from '../offer.js'
import { parse } from '../semver.js'

export const id = 'awesome-plugins'
export const title = { zh: 'Awesome DSH Plugin 完整目录（plugins.json）', en: 'Awesome DSH Plugin full catalog (plugins.json)' }

/** Skip reasons beyond offer.js SKIP that this adapter counts in `skippedBy`. */
export const REASON = {
  latestTarball: 'unpinned-tarball',
  subdirHead: 'unpinned-subdir',
  ref: 'unpinned-ref',
  ambiguousRepo: 'ambiguous-repo',
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const COMMIT = /^[0-9a-f]{40}$/
const INSTALL = /^(?:npx\s+\S+\s+)?dsh\s+plugin\s+(?:--profile\s+\S+\s+)?add\s+("?)([^\s"]+)\1\s*$/
const KIND_RANK = { npm: 0, tarball: 1, git: 2, 'github-head': 3 }

/**
 * True only for this family: a top-level object with string `name`/`url`, a `categories` object, a `plugins`
 * array and no format-1 / shop / radar / npm-search markers, most of whose first five entries carry `owner`, `url`
 * and an `install` command string (one malformed entry does not hide the document).
 */
export function detect(doc) {
  if (!isObject(doc) || !Array.isArray(doc.plugins) || !isObject(doc.categories)) return false
  if ('format' in doc || 'schemaVersion' in doc || 'schema' in doc || 'objects' in doc) return false
  if (typeof doc.name !== 'string' || typeof doc.url !== 'string') return false
  if (typeof doc.count !== 'number' && typeof doc.updated !== 'string') return false
  if (!doc.plugins.length) return true
  const head = doc.plugins.slice(0, 5)
  const shaped = head.filter((p) => isObject(p) && typeof p.owner === 'string' && typeof p.url === 'string' &&
    typeof p.install === 'string')
  return shaped.length * 2 > head.length
}

/** The spec token of a `dsh plugin [--profile x] add <spec>` command, or null. */
function installToken(install) {
  if (typeof install !== 'string' || install.length > 2000) return null
  const m = INSTALL.exec(install.trim())
  return m ? m[2] : null
}

/**
 * Whether a GitHub-served tarball URL can move: only `/releases/download/<tag>/…`, `/archive/<40-hex>.tar.gz|.tgz`
 * and codeload `/tar.gz/<40-hex>` name fixed content; `/releases/latest/`, branch and tag archives follow a ref.
 * Tarballs from other hosts are taken as listed.
 */
function isMovingGithubTarball(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const rest = /^\/[^/]+\/[^/]+(\/.*)$/.exec(u.pathname)?.[1] ?? ''
  if (u.hostname === 'github.com') {
    return !/^\/releases\/download\/(?!latest\/)[^/]+\/[^/]+$/.test(rest) && !/^\/archive\/[0-9a-f]{40}\.(?:tar\.gz|tgz)$/.test(rest)
  }
  if (u.hostname === 'codeload.github.com') return !/^\/tar\.gz\/[0-9a-f]{40}$/.test(rest)
  return false
}

/** The semver of a GitHub release tag in `/releases/download/<tag>/`, or null. */
function releaseVersion(url) {
  const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v?([^/]+)\//.exec(url)
  if (!m) return null
  let tag
  try {
    tag = decodeURIComponent(m[1])
  } catch {
    return null
  }
  return parse(tag) ? tag : null
}

/**
 * The catalog name of a non-npm entry: `name` when it is a package name; otherwise (display names such as
 * `repo#sub/dir` or `便签墙（x）`) the `<stem>` of a release tarball named `<stem>-<tag version>.tgz` (npm pack's
 * file name), else the last segment after `#`, else the installed repo's name (as the radar names repos).
 */
function entryName(p, t) {
  const ok = (n) => typeof n === 'string' && isPackageName(n, { caseInsensitive: true })
  if (ok(p.name)) return p.name
  if (t.install.kind === 'tarball' && t.version) {
    const file = t.install.spec.split('/').pop()
    const suffix = `-${t.version}.tgz`
    if (file.endsWith(suffix) && ok(file.slice(0, -suffix.length))) return file.slice(0, -suffix.length)
  }
  const parts = typeof p.name === 'string' ? p.name.split('#') : []
  if (parts.length === 2 && ok(parts[1].split('/').pop())) return parts[1].split('/').pop()
  if (t.repoName && ok(t.repoName)) return t.repoName
  return null
}

function tarballTarget(url, urlRepo) {
  if (isMovingGithubTarball(url)) return { error: REASON.latestTarball }
  const target = tarballInstall(url)
  if (target.error) return target
  const repo = tarballRepo(url)
  const directory = repo !== null && repo === urlRepo.repo ? urlRepo.directory : null
  return { ...target, repo, repoName: repo?.split('/')[1] ?? null, directory, version: releaseVersion(url) }
}

/** One entry → `{ offering }` or `{ error }`. */
function readEntry(p, sourceId) {
  if (!isObject(p)) return { error: SKIP.entry }
  const urlRepo = repoFromUrl(p.url)
  let name
  let t
  if (typeof p.npm === 'string' && p.npm && p.version !== null && p.version !== undefined) {
    name = p.npm
    if (!isPackageName(name)) return { error: SKIP.name }
    if (typeof p.version !== 'string' || !parse(p.version)) return { error: SKIP.version }
    const target = npmInstall(name, p.version, null)
    if (target.error) return target
    t = { ...target, repo: urlRepo.repo, directory: urlRepo.directory, version: p.version }
  } else {
    if (p.tarball !== undefined && p.tarball !== null) {
      t = tarballTarget(p.tarball, urlRepo)
    } else {
      const token = installToken(p.install)
      if (token === null) return { error: SKIP.source }
      if (/^https:\/\//i.test(token) && /\.(?:tgz|tar\.gz)$/i.test(token.split(/[?#]/)[0])) {
        t = tarballTarget(token, urlRepo)
      } else if (token.startsWith('github:')) {
        const [repo, ref, ...rest] = token.slice(7).split('#')
        if (rest.length || !REPO.test(repo)) return { error: SKIP.source }
        const key = repo.toLowerCase()
        if (ref === undefined) {
          if (urlRepo.repo !== key || urlRepo.directory !== null) return { error: REASON.ambiguousRepo }
          const target = githubHeadInstall(repo)
          t = target.error ? target : { ...target, repo: key, repoName: repo.split('/')[1], directory: null, version: null }
        } else if (COMMIT.test(ref)) {
          const target = gitInstall(`https://github.com/${repo}.git`, ref)
          t = target.error ? target : { ...target, repo: key, repoName: repo.split('/')[1], directory: null, version: null }
        } else {
          return { error: ref.startsWith('path:') ? REASON.subdirHead : REASON.ref }
        }
      } else {
        return { error: SKIP.source }
      }
    }
  }
  if (t.error) return { error: t.error }
  if (name === undefined) {
    name = entryName(p, t)
    if (name === null) return { error: SKIP.name }
  }
  // npm takes its repo from `url`; other kinds install t.repo, so `url`'s link and stars count only when they
  // describe that same repo (a list must not show one repo's page and stars over another repo's install)
  const urlIsInstalled = t.install.kind === 'npm' || (t.repo !== null && urlRepo.repo === t.repo)
  const homepage = urlIsInstalled ? httpUrl(p.url) : t.repo === null ? null : `https://github.com/${t.repo}`
  const labels = []
  if (Array.isArray(p.capabilityRedLines) && p.capabilityRedLines.length) labels.push(`${sourceId}:red-lines`)
  return {
    offering: makeOffering({
      sourceId,
      name,
      title: cleanText(p.name, TITLE_MAX),
      description: cleanText(p.description, DESCRIPTION_MAX),
      category: cleanCategory(p.category),
      version: t.version,
      versionCount: t.version ? 1 : 0,
      repo: t.repo,
      directory: t.directory,
      homepage,
      icon: cleanIcon(p.icon),
      install: t.install,
      stars: urlIsInstalled ? cleanCount(p.stars) : null,
      labels,
    }),
  }
}

/**
 * Offerings from an awesome legacy `plugins.json`. One offering per name + repo + directory (npm preferred over
 * tarball over git over github-head). `hostVersion` is accepted for interface symmetry; entries carry no engines.
 * @returns `{ offerings, skipped, skippedBy, warnings }`
 * @throws TypeError when `detect(doc)` is false or `sourceId` is missing.
 */
export function read(doc, { sourceId } = {}) {
  if (!detect(doc)) throw new TypeError('not an awesome-dsh-plugin plugins.json document')
  if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId must be a non-empty string')
  const tally = skipTally()
  const offerings = []
  const byIdentity = new Map()
  doc.plugins.forEach((p, i) => {
    const { offering, error } = readEntry(p, sourceId)
    if (error) {
      tally.count(error, `plugins[${i}]`)
      return
    }
    const identity = `${offering.name.toLowerCase()}|${offering.repo ?? ''}|${offering.directory ?? ''}`
    const at = byIdentity.get(identity)
    if (at === undefined) {
      byIdentity.set(identity, offerings.length)
      offerings.push(offering)
      return
    }
    tally.count(SKIP.duplicate, `plugins[${i}]`)
    if (KIND_RANK[offering.install.kind] < KIND_RANK[offerings[at].install.kind]) offerings[at] = offering
  })
  return { offerings, ...tally.result() }
}
