#!/usr/bin/env node
/**
 * check-release.mjs — what `npm pack` would ship, checked before it ships.
 *
 *   node scripts/check-release.mjs             package contents only (CI, every PR)
 *   node scripts/check-release.mjs --publish   also the release gate (prepublishOnly)
 *
 * Package: every `bin`, `exports` and `dsh.bundle.patch` target is in the tarball, nothing outside `files`
 * leaks in, no text file has CRLF line endings, and every bin starts with a plain `#!/usr/bin/env node`.
 * Publish: in GitHub Actions the run must come from the tag `v<version>`; anywhere else the working tree
 * must be clean and HEAD must carry that tag (`npm version` makes both), so what is published is a commit.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEXT = /\.(js|mjs|cjs|json|ya?ml|md|svg|txt)$|(^|\/)LICENSE$/i

/** Files `npm pack` would include, as package-relative paths with forward slashes. */
export function packList(cwd = ROOT) {
  // npm is a .cmd on Windows, which Node only spawns through a shell.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  return JSON.parse(out)[0].files.map((f) => f.path.replace(/\\/g, '/'))
}

/** Paths the manifest promises; `*` in an export expands against the packed files. */
export function promised(pkg) {
  const targets = []
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {})
  targets.push(...bins.map((b) => ({ path: b, bin: true })))
  const walk = (v) => { if (typeof v === 'string') targets.push({ path: v }); else if (v && typeof v === 'object') Object.values(v).forEach(walk) }
  walk(pkg.exports)
  if (pkg.dsh?.bundle?.patch) targets.push({ path: pkg.dsh.bundle.patch })
  return targets.map((t) => ({ ...t, path: t.path.replace(/^\.\//, '') }))
}

/** Problems with a package, given its manifest, its pack list and a reader for its files. */
export function checkPackage(pkg, files, read) {
  const problems = []
  const packed = new Set(files)
  for (const t of promised(pkg)) {
    if (t.path.includes('*')) {
      const re = new RegExp(`^${t.path.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`)
      if (!files.some((f) => re.test(f))) problems.push(`${t.path}: matches no packed file`)
    } else if (!packed.has(t.path)) problems.push(`${t.path}: promised by package.json but not packed`)
    else if (t.bin && !read(t.path).startsWith('#!/usr/bin/env node\n')) problems.push(`${t.path}: bin must start with "#!/usr/bin/env node" and LF`)
  }
  const allowed = ['package.json', ...(pkg.files ?? []).map((f) => f.replace(/^\.\//, ''))]
  for (const f of files) {
    if (!allowed.some((a) => f === a || f.startsWith(a.endsWith('/') ? a : `${a}/`))) problems.push(`${f}: packed but not listed in "files"`)
    if (TEXT.test(f) && read(f).includes('\r\n')) problems.push(`${f}: CRLF line endings (check .gitattributes / core.autocrlf)`)
  }
  return problems
}

/** Problems with publishing `version` from here and now. */
export function checkPublish(version, { env = process.env, git = gitOut } = {}) {
  const tag = `v${version}`
  if (env.GITHUB_ACTIONS === 'true') {
    return env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME === tag ? [] : [`CI publishes only from the tag ${tag} (this run: ${env.GITHUB_REF_TYPE ?? '?'} ${env.GITHUB_REF_NAME ?? '?'})`]
  }
  const problems = []
  if (git(['status', '--porcelain']).trim()) problems.push('working tree has uncommitted changes')
  if (!git(['tag', '--points-at', 'HEAD']).split(/\r?\n/).includes(tag)) problems.push(`HEAD is not tagged ${tag} (run \`npm version <patch|minor|prerelease>\`)`)
  return problems
}

function gitOut(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const files = packList()
  const problems = checkPackage(pkg, files, (f) => readFileSync(path.join(ROOT, f), 'utf8'))
  if (process.argv.includes('--publish')) problems.push(...checkPublish(pkg.version))
  if (problems.length) {
    console.error(`check-release: ${pkg.name}@${pkg.version} is not ready:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`check-release: ${pkg.name}@${pkg.version} ok (${files.length} files)`)
}
