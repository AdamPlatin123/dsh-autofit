/**
 * Host half of the dsh-autofit bundle.
 *
 * Exposes one authenticated, Client-callable Remote endpoint:
 *   POST /api/autofit/check  body { spec: string }
 *
 * `check` runs the repository's existing L1/L2 trial (`lib/probe`) inside a throwaway DSH_HOME
 * and returns only the facts the Plugins-page UI needs. The probe's own dsh launcher is taken
 * from the running process, never from a hard-coded path.
 *
 * The endpoint is an exact Connection Fetch route rather than a Typert namespace: this package
 * is plain ESM with no generated `/remote` artifact, and the route registry is the documented
 * Client-callable carrier for non-generated Host operations.
 */
import { existsSync } from 'node:fs'
import { probe } from '../lib/probe/index.js'

/** Connection must exist for a browser-callable route; otherwise this row stays inactive. */
export const inject = ['connection']

const CHECK_PATH = '/api/autofit/check'

/**
 * The launcher that started this Host process. `process.argv[1]` is DSH's `lib/bin.js`; it keeps
 * the same version and flags as the running Host, unlike a `dsh` found later on PATH.
 */
function dshLauncher() {
  const configured = process.env.DSH_AUTOFIT_DSH_BIN
  if (configured && existsSync(configured)) return configured
  const entry = process.argv[1]
  if (entry && existsSync(entry) && /(?:^|[\\/])bin\.js$/i.test(entry)) return entry
  // Still the current runtime's launcher name; probe resolves it on PATH.
  return 'dsh'
}

/**
 * Environment for a trial. The Host process carries its own profile pointers; letting them reach
 * `dsh plugin --profile web` would point the "throwaway" install at the live profile, so drop them.
 */
function trialEnv() {
  const env = { ...process.env }
  delete env.DSH_PROFILE
  delete env.DSH_PROFILE_DIR
  delete env.DSH_SESSION_ID
  return env
}

function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

function text(value, limit = 2000) {
  if (value === undefined || value === null) return null
  const out = String(value)
  return out.length > limit ? `${out.slice(0, limit)}…` : out
}

function stringList(value, limit = 40) {
  return (Array.isArray(value) ? value : []).slice(0, limit).map((item) => text(item, 400)).filter(Boolean)
}

function failures(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((item) => ({
    entry: text(item?.entry, 300),
    package: text(item?.package, 300),
    error: text(item?.error ?? item?.message, 1200),
    codes: stringList(item?.codes, 20),
    collateral: item?.collateral === true,
  }))
}

function describeSummary(describe) {
  if (!describe || typeof describe !== 'object') return null
  const impact = describe.profileImpact ?? {}
  const requirements = describe.requirements ?? {}
  return {
    name: text(describe.name, 300),
    version: text(describe.version, 100),
    kind: text(describe.kind, 40),
    targetProfile: text(describe.targetProfile, 80),
    surfaces: stringList(describe.surfaces, 10),
    profileImpact: {
      level: text(impact.level, 20),
      inserts: stringList(impact.inserts, 60),
      disablesCore: stringList(impact.disablesCore, 60),
      reconfiguresCore: stringList(impact.reconfiguresCore, 60),
      replacesImplementation: stringList(impact.replacesImplementation, 60),
      security: stringList(impact.security, 60),
      removes: stringList(impact.removes, 60),
      touchesOther: stringList(impact.touchesOther, 60),
    },
    notes: stringList(describe.notes, 20),
    compat: describe.compat ?? null,
    requirements: {
      nativeModules: stringList(requirements.nativeModules, 30),
      sidecar: requirements.sidecar === true,
      electron: requirements.electron === true,
      embeddedRuntime: text(requirements.embeddedRuntime, 100),
      bins: stringList(requirements.bins, 20),
      env: stringList(requirements.env, 30),
      endpoints: stringList(requirements.endpoints, 30),
    },
  }
}

/** Keep the wire payload small and stable; the UI never needs the raw probe object. */
function summarize(result) {
  const l1 = result?.layers?.L1 ?? {}
  const l2host = result?.layers?.L2?.host ?? null
  const l2client = result?.layers?.L2?.client ?? null
  const describe = l1.describe ?? null
  return {
    spec: text(result?.spec, 2000),
    verdict: text(result?.verdict, 40),
    durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
    host: {
      version: text(result?.host?.version, 100),
      tier: text(result?.host?.tier, 40),
    },
    L1: {
      status: text(l1.status, 40),
      error: text(l1.error, 1200),
      requirements: l1.requirements ?? null,
      blockedBuilds: stringList(l1.blockedBuilds, 30),
      exempted: l1.exempted ?? null,
      codes: stringList(l1.codes, 40),
      logTail: text(l1.logTail, 4000),
      describe: describeSummary(describe),
      describeError: text(l1.describeError, 1200),
    },
    L2: {
      host: {
        status: text(l2host?.status, 40),
        failures: failures(l2host?.failures),
        fatal: l2host?.fatal === true,
        logTail: text(l2host?.logTail, 4000),
      },
      client: {
        status: text(l2client?.status, 40),
        reason: text(l2client?.reason, 1200),
        failures: failures(l2client?.failures),
      },
    },
    codes: stringList(result?.codes, 80),
  }
}

/** One check at a time: a probe starts real pnpm and a real web boot. */
let inFlight = false

async function handleCheck(payload) {
  const raw = payload?.spec
  const spec = typeof raw === 'string' ? raw.trim() : ''
  if (!spec || spec.length > 2000) {
    return failure('autofit/invalid-spec', 'A non-empty plugin spec of at most 2000 characters is required.', { field: 'spec' })
  }
  if (inFlight) {
    return failure('autofit/busy', 'Another Autofit check is already running.', { retryable: true })
  }
  inFlight = true
  try {
    const result = await probe(spec, { bin: dshLauncher(), env: trialEnv() })
    const summary = summarize(result)
    // probe resolves a relative path to an absolute one; keep the caller's exact spec so the UI
    // can compare it with the input and hand the same value to the native install entry point.
    summary.requestedSpec = spec
    return { ok: true, value: summary }
  } catch (error) {
    return failure('autofit/check-failed', text(error?.message ?? error, 1200) ?? 'The trial failed to start.', {
      launcher: dshLauncher(),
    })
  } finally {
    inFlight = false
  }
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: CHECK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let payload
        try {
          payload = await request.json()
        } catch {
          return Response.json(
            failure('autofit/invalid-json', 'The request body must be JSON.', { field: 'body' }),
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }
        const result = await handleCheck(payload)
        return Response.json(result, {
          status: result.ok ? 200 : 400,
          headers: { 'cache-control': 'no-store' },
        })
      },
    }),
    'dsh-autofit: check endpoint',
  )
}
