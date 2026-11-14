/**
 * Tiny SemVer 2.0.0 helper for catalog readers: parse, compare, prerelease, satisfies.
 *
 * Why not the `semver` package: the plugin has zero dependencies. The range grammar and its desugaring
 * (hyphen, x-range, tilde, caret, `||`, partial versions, the prerelease rule, `includePrerelease`) follow
 * node-semver 7.8 in strict (non-loose) mode, which is what DSH evaluates `engines.dsh` with, so a catalog
 * makes the same compatibility call DSH will make at install time. test/sources-semver.test.mjs cross-checks
 * against the semver copy that ships inside DSH when it is installed.
 *
 * `parse`/`valid`/`compare`/`prerelease` take exact versions in the strict SemVer grammar (no leading `v`, no
 * surrounding whitespace), like the format-1 validator. `satisfies` accepts what node-semver accepts for the
 * version argument (a leading `v`, surrounding whitespace) so the two agree.
 *
 * Ranges come from untrusted catalogs, so range parsing is bounded the way node-semver bounds it: the whitespace
 * quantifiers of the range regexes are made safe (`\s*` → `\s{0,1}`, `\s+` → `\s{1,1}`, as node-semver's
 * makeSafeRegex does; ranges are whitespace-normalized first, so the same texts match), and a range longer than
 * RANGE_MAX (256) characters is invalid. node-semver has no range length cap; real `engines.dsh` ranges are a few
 * dozen characters, and without the cap a hostile index could make each range test cost quadratic time.
 */

const MAX_LENGTH = 256
/** Longest range text `satisfies`/`validRange` accept; longer ranges are invalid (see the header). */
export const RANGE_MAX = 256
const NUM = '0|[1-9]\\d*'
const LDN = '[a-zA-Z0-9-]'
const NONNUM = `\\d*[a-zA-Z-]${LDN}*`
const PREID = `(?:${NONNUM}|${NUM})`
const PREIDLOOSE = `(?:${NONNUM}|\\d+)`
const PRE = `(?:-(${PREID}(?:\\.${PREID})*))`
const PRELOOSE = `(?:-?(${PREIDLOOSE}(?:\\.${PREIDLOOSE})*))`
const BUILD = `(?:\\+(${LDN}+(?:\\.${LDN}+)*))`
const MAIN = `(${NUM})\\.(${NUM})\\.(${NUM})`
const FULLPLAIN = `v?${MAIN}${PRE}?${BUILD}?`
const LOOSEPLAIN = `[v=\\s]*(\\d+)\\.(\\d+)\\.(\\d+)${PRELOOSE}?${BUILD}?`
const XR = `${NUM}|x|X|\\*`
const XRANGEPLAIN = `[v=\\s]*(${XR})(?:\\.(${XR})(?:\\.(${XR})(?:${PRE})?${BUILD}?)?)?`
const GTLT = '((?:<|>)?=?)'

/** node-semver's makeSafeRegex for whitespace: bounded quantifiers, so a hostile range cannot backtrack far. */
const safe = (src) => src.split('\\s*').join('\\s{0,1}').split('\\s+').join('\\s{1,1}')

const STRICT_RE = new RegExp(`^${MAIN}${PRE}?${BUILD}?$`)
const FULL_RE = new RegExp(`^${FULLPLAIN}$`)
const COMPARATOR_RE = new RegExp(safe(`^${GTLT}\\s*(${FULLPLAIN})$|^$`))
const XRANGE_RE = new RegExp(safe(`^${GTLT}\\s*${XRANGEPLAIN}$`))
const TILDE_RE = new RegExp(`^(?:~>?)${XRANGEPLAIN}$`)
const CARET_RE = new RegExp(`^\\^${XRANGEPLAIN}$`)
const HYPHEN_RE = new RegExp(safe(`^\\s*(${XRANGEPLAIN})\\s+-\\s+(${XRANGEPLAIN})\\s*$`))
const COMPARATOR_TRIM_RE = new RegExp(safe(`(\\s*)${GTLT}\\s*(${LOOSEPLAIN}|${XRANGEPLAIN})`), 'g')
const TILDE_TRIM_RE = /(\s{0,1})(?:~>?)\s{1,1}/g
const CARET_TRIM_RE = /(\s{0,1})\^\s{1,1}/g
const BUILD_RE = new RegExp(BUILD)
const BUILD_STRIP_RE = new RegExp(BUILD, 'g')
const STAR_RE = /(<|>)?=?\s{0,1}\*/
const GTE0_RE = /^\s{0,1}>=\s{0,1}0\.0\.0\s{0,1}$/
const GTE0PRE_RE = /^\s{0,1}>=\s{0,1}0\.0\.0-0\s{0,1}$/
const NUMERIC_ID = /^[0-9]+$/
const ANY = ''
const NULL_SET = '<0.0.0-0'

/** Build the parsed shape from a FULL/STRICT match; undefined when a number is out of the safe range. */
function fromMatch(m) {
  const major = +m[1]
  const minor = +m[2]
  const patch = +m[3]
  if (major > Number.MAX_SAFE_INTEGER || minor > Number.MAX_SAFE_INTEGER || patch > Number.MAX_SAFE_INTEGER) return undefined
  const prerelease = m[4] ? m[4].split('.').map((id) => {
    if (NUMERIC_ID.test(id)) {
      const n = +id
      if (n >= 0 && n < Number.MAX_SAFE_INTEGER) return n
    }
    return id
  }) : []
  const build = m[5] ? m[5].split('.') : []
  const version = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}`
  return { major, minor, patch, prerelease, build, version }
}

/**
 * Parse one exact version in the strict SemVer 2.0.0 grammar.
 * @returns `{ major, minor, patch, prerelease, build, version }` (numeric prerelease ids as numbers, `version`
 *   without build metadata) or null for anything else, including non-strings and a leading `v`.
 */
export function parse(version) {
  if (typeof version !== 'string' || version.length > MAX_LENGTH) return null
  const m = STRICT_RE.exec(version)
  return (m && fromMatch(m)) ?? null
}

/** node-semver's version parser: trims and accepts a leading `v`. Internal, for range tests. */
function parseLenient(version) {
  if (typeof version !== 'string' || version.length > MAX_LENGTH) return null
  const m = FULL_RE.exec(version.trim())
  return (m && fromMatch(m)) ?? null
}

/** The normalized version string (build metadata dropped), or null when `version` is not strict SemVer. */
export function valid(version) {
  return parse(version)?.version ?? null
}

/** Prerelease identifiers of a valid version, or null when it has none or is invalid (like semver.prerelease). */
export function prerelease(version) {
  const v = parse(version)
  return v && v.prerelease.length ? v.prerelease : null
}

function compareIdentifiers(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  const anum = NUMERIC_ID.test(String(a))
  const bnum = NUMERIC_ID.test(String(b))
  if (anum && bnum) {
    a = +a
    b = +b
  }
  if (a === b) return 0
  if (anum && !bnum) return -1
  if (bnum && !anum) return 1
  return a < b ? -1 : 1
}

function compareParsed(a, b) {
  const main = compareIdentifiers(a.major, b.major) || compareIdentifiers(a.minor, b.minor) ||
    compareIdentifiers(a.patch, b.patch)
  if (main) return main
  if (a.prerelease.length && !b.prerelease.length) return -1
  if (!a.prerelease.length && b.prerelease.length) return 1
  for (let i = 0; ; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined && y === undefined) return 0
    if (y === undefined) return 1
    if (x === undefined) return -1
    const c = compareIdentifiers(x, y)
    if (c) return c
  }
}

function parsedOrThrow(version) {
  if (typeof version === 'object' && version !== null && typeof version.major === 'number') return version
  const v = parse(version)
  if (!v) throw new TypeError(`invalid version: ${JSON.stringify(version)}`)
  return v
}

/**
 * Precedence of two versions: -1, 0 or 1. Build metadata is ignored.
 * Accepts version strings or objects from `parse`; throws TypeError for an invalid version.
 */
export function compare(a, b) {
  return compareParsed(parsedOrThrow(a), parsedOrThrow(b))
}

/** `compare` reversed, for descending sorts. */
export function rcompare(a, b) {
  return compare(b, a)
}

// ---- ranges --------------------------------------------------------------------------------------------

const isX = (id) => !id || id.toLowerCase() === 'x' || id === '*'
const invalidXRangeOrder = (M, m, p) => (isX(M) && !isX(m)) || (isX(m) && p && !isX(p))

function replaceCaret(comp, inc) {
  const z = inc ? '-0' : ''
  return comp.replace(CARET_RE, (_, M, m, p, pr) => {
    if (isX(M)) return ''
    if (isX(m)) return `>=${M}.0.0${z} <${+M + 1}.0.0-0`
    if (isX(p)) return M === '0' ? `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0` : `>=${M}.${m}.0${z} <${+M + 1}.0.0-0`
    if (pr) {
      if (M === '0') {
        return m === '0' ? `>=${M}.${m}.${p}-${pr} <${M}.${m}.${+p + 1}-0` : `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`
      }
      return `>=${M}.${m}.${p}-${pr} <${+M + 1}.0.0-0`
    }
    // A full version without prerelease keeps a plain lower bound even with includePrerelease (node-semver 7.8).
    if (M === '0') {
      return m === '0' ? `>=${M}.${m}.${p} <${M}.${m}.${+p + 1}-0` : `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`
    }
    return `>=${M}.${m}.${p} <${+M + 1}.0.0-0`
  })
}

function replaceTilde(comp, inc) {
  const z = inc ? '-0' : ''
  return comp.replace(TILDE_RE, (_, M, m, p, pr) => {
    if (isX(M)) return ''
    if (isX(m)) return `>=${M}.0.0${z} <${+M + 1}.0.0-0`
    if (isX(p)) return `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`
    if (pr) return `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`
    return `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`
  })
}

function replaceXRange(comp, inc) {
  comp = comp.trim()
  return comp.replace(XRANGE_RE, (ret, gtlt, M, m, p) => {
    if (invalidXRangeOrder(M, m, p)) return comp
    const xM = isX(M)
    const xm = xM || isX(m)
    const xp = xm || isX(p)
    if (gtlt === '=' && xp) gtlt = ''
    let pr = inc ? '-0' : ''
    if (xM) return gtlt === '>' || gtlt === '<' ? NULL_SET : '*'
    if (gtlt && xp) {
      if (xm) m = 0
      p = 0
      if (gtlt === '>') {
        gtlt = '>='
        if (xm) {
          M = +M + 1
          m = 0
        } else {
          m = +m + 1
        }
      } else if (gtlt === '<=') {
        gtlt = '<'
        if (xm) M = +M + 1
        else m = +m + 1
      }
      if (gtlt === '<') pr = '-0'
      return `${gtlt}${M}.${m}.${p}${pr}`
    }
    if (xm) return `>=${M}.0.0${pr} <${+M + 1}.0.0-0`
    if (xp) return `>=${M}.${m}.0${pr} <${M}.${+m + 1}.0-0`
    return ret
  })
}

const mapWords = (comp, fn, inc) => comp.trim().split(/\s+/).map((c) => fn(c, inc)).join(' ')

function parseComparatorText(comp, inc) {
  comp = comp.replace(BUILD_RE, '')
  comp = mapWords(comp, replaceCaret, inc)
  comp = mapWords(comp, replaceTilde, inc)
  comp = comp.split(/\s+/).map((c) => replaceXRange(c, inc)).join(' ')
  return comp.trim().replace(STAR_RE, '')
}

function hyphenReplace(inc) {
  return ($0, from, fM, fm, fp, fpr, fb, to, tM, tm, tp, tpr) => {
    if (isX(fM)) from = ''
    else if (isX(fm)) from = `>=${fM}.0.0${inc ? '-0' : ''}`
    else if (isX(fp)) from = `>=${fM}.${fm}.0${inc ? '-0' : ''}`
    else if (fpr) from = `>=${from}`
    else from = `>=${from}${inc ? '-0' : ''}`

    if (isX(tM)) to = ''
    else if (isX(tm)) to = `<${+tM + 1}.0.0-0`
    else if (isX(tp)) to = `<${tM}.${+tm + 1}.0-0`
    else if (tpr) to = `<=${tM}.${tm}.${tp}-${tpr}`
    else if (inc) to = `<${tM}.${tm}.${+tp + 1}-0`
    else to = `<=${to}`
    return `${from} ${to}`.trim()
  }
}

/** One comparator `{ op, v, value }`; `v` is null for "any". Throws for text that is not a comparator. */
function comparator(text) {
  text = text.trim().split(/\s+/).join(' ')
  const m = COMPARATOR_RE.exec(text)
  if (!m) throw new TypeError(`invalid comparator: ${text}`)
  let op = m[1] ?? ''
  if (op === '=') op = ''
  if (!m[2]) return { op, v: null, value: ANY }
  const v = parseLenient(m[2])
  if (!v) throw new TypeError(`invalid comparator: ${text}`)
  return { op, v, value: op + v.version }
}

function parseSet(range, inc) {
  range = range.replace(BUILD_STRIP_RE, '')
  range = range.replace(HYPHEN_RE, hyphenReplace(inc))
  range = range.replace(COMPARATOR_TRIM_RE, '$1$2$3')
  range = range.replace(TILDE_TRIM_RE, '$1~')
  range = range.replace(CARET_TRIM_RE, '$1^')
  const list = range.split(' ').map((c) => parseComparatorText(c, inc)).join(' ').split(/\s+/)
    .map((c) => c.trim().replace(inc ? GTE0PRE_RE : GTE0_RE, ''))
  const byValue = new Map()
  for (const text of list) {
    const c = comparator(text)
    if (c.value === NULL_SET) return [c]
    byValue.set(c.value, c)
  }
  if (byValue.size > 1 && byValue.has(ANY)) byValue.delete(ANY)
  return [...byValue.values()]
}

// Range text → parsed sets, or INVALID. Keys are at most RANGE_MAX + 2 chars, so 2000 entries stay small.
const rangeCache = new Map()
const INVALID = Symbol('invalid range')

/**
 * Range text → array of comparator sets (OR of ANDs). Throws TypeError for an invalid range, including one longer
 * than RANGE_MAX. Memoized, invalid ranges too, so a catalog repeating a bad range pays for it once.
 */
function parseRange(range, inc) {
  if (typeof range !== 'string') throw new TypeError('range must be a string')
  if (range.length > RANGE_MAX) throw new TypeError(`invalid range: longer than ${RANGE_MAX} characters`)
  const key = `${inc ? 1 : 0}:${range}`
  const hit = rangeCache.get(key)
  if (hit === INVALID) throw new TypeError(`invalid range: ${range}`)
  if (hit) return hit
  if (rangeCache.size >= 2000) rangeCache.clear()
  let sets
  try {
    sets = parseSets(range, inc)
  } catch (err) {
    rangeCache.set(key, INVALID)
    throw err
  }
  rangeCache.set(key, sets)
  return sets
}

function parseSets(range, inc) {
  const raw = range.trim().replace(/\s+/g, ' ')
  let sets = raw.split('||').map((r) => parseSet(r.trim(), inc)).filter((s) => s.length)
  if (!sets.length) throw new TypeError(`invalid range: ${raw}`)
  if (sets.length > 1) {
    const first = sets[0]
    sets = sets.filter((s) => s[0].value !== NULL_SET)
    if (!sets.length) sets = [first]
    else if (sets.length > 1) {
      const any = sets.find((s) => s.length === 1 && s[0].value === ANY)
      if (any) sets = [any]
    }
  }
  return sets
}

function testComparator(c, v) {
  if (c.v === null) return true
  const r = compareParsed(v, c.v)
  switch (c.op) {
    case '': return r === 0
    case '>': return r > 0
    case '>=': return r >= 0
    case '<': return r < 0
    case '<=': return r <= 0
    default: return false
  }
}

function testSet(set, v, inc) {
  for (const c of set) if (!testComparator(c, v)) return false
  if (v.prerelease.length && !inc) {
    // A prerelease only matches when some comparator names a prerelease of the same major.minor.patch.
    for (const c of set) {
      if (c.v === null || !c.v.prerelease.length) continue
      if (c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch) return true
    }
    return false
  }
  return true
}

/**
 * Whether `version` is in `range`, with npm semantics: ^ ~ ~> >= > <= < = x X * || `a - b` and partial versions.
 * Prerelease versions only match a comparator set that names a prerelease of the same major.minor.patch, unless
 * `includePrerelease` is true (DSH uses true for engines.dsh). An invalid version or range gives false.
 */
export function satisfies(version, range, { includePrerelease = false } = {}) {
  const v = parseLenient(version)
  if (!v) return false
  let sets
  try {
    sets = parseRange(range, includePrerelease)
  } catch {
    return false
  }
  return sets.some((set) => testSet(set, v, includePrerelease))
}

/**
 * The desugared range (comparator sets joined by `||`, comparators by a space), like semver.validRange,
 * or null when `range` is not a valid range.
 */
export function validRange(range, { includePrerelease = false } = {}) {
  try {
    return parseRange(range, includePrerelease).map((set) => set.map((c) => c.value).join(' ')).join('||') || '*'
  } catch {
    return null
  }
}
