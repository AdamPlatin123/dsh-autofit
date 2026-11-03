// Signal parsing against real output captured in the lab (DSH 0.0.1-rc.5 … 0.2.2-alpha.3).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capabilitiesFor, compareVersions } from '../lib/probe/host.js'
import { parseBoot, parseClient, parseInstall } from '../lib/probe/signals.js'

const STACK = '    at new apply (file:///lab/fixtures/bad/index.js:1:33)\n    at Fiber.execute (file:///x/cordis/lib/index.js:1068:24)\n'

test('L1: native version rejection with requirements (0.2.1+)', () => {
  const log = 'dsh: initialized profile web at /h/profiles/web\ndsh: installation rejected: Plugin dsh-period-report@0.2.1 is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-system-prompt":"^0.1.0-rc.6","@deepseek-ai/dsh-tools":"^0.1.0-rc.6"}. Running it may cause crashes or data loss.\ndsh: nothing was installed.\ndsh: to accept the risk, run: dsh plugin --profile web allow-version dsh-period-report@0.2.1 --dsh-version 0.2.1-rc.2 --accept-risk\n'
  const r = parseInstall(log, 1)
  assert.equal(r.status, 'incompatible')
  assert.deepEqual(r.requirements, { '@deepseek-ai/dsh-system-prompt': '^0.1.0-rc.6', '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' })
})

test('L1: blocked build scripts are reported even on success', () => {
  const r = parseInstall('│   Ignored build scripts: node-pty@1.1.0.                                     │\n', 0)
  assert.equal(r.status, 'installed')
  assert.deepEqual(r.blockedBuilds, ['node-pty@1.1.0'])
  assert.ok(r.codes.includes('build-scripts-blocked'))
})

test('L1: transient network retries on a successful install are dropped', () => {
  const r = parseInstall('WARN GET https://registry.npmjs.org/x error (ECONNRESET). Will retry in 10 seconds.\nProgress: done\n', 0)
  assert.equal(r.status, 'installed')
  assert.deepEqual(r.codes, [])
  assert.equal(parseInstall('ERR_PNPM_FETCH ECONNRESET\n', 1).status, 'infra-fail')
})

test('L1: legacy patch dialect', () => {
  const r = parseInstall('dsh: installation rejected: Cannot validate installed package @k/x: Error: dsh: overlay /h/x/cordis.patch.yml must be a top-level YAML array of loader patch entries\n', 1)
  assert.equal(r.status, 'error')
  assert.ok(r.codes.includes('legacy-patch-dialect'))
})

test('L2 host: 0.1.7+ warn-and-continue form', () => {
  const r = parseBoot(`dsh web: http://127.0.0.1:32979/?token=abc\ndsh: warning: 1 entry did not activate\nfx-bad (@lab/fx-bad): Error: fx-bad: deliberate host failure\n${STACK}`)
  assert.equal(r.url, 'http://127.0.0.1:32979/?token=abc')
  assert.equal(r.fatal, false)
  assert.deepEqual(r.hostFailures.map((f) => [f.entry, f.package]), [['fx-bad', '@lab/fx-bad']])
})

test('L2 host: ≤0.1.2 crash-after-url form (also 0.0.1)', () => {
  const r = parseBoot(`dsh web: http://127.0.0.1:32827\nfile:///x/dsh-app-boot/lib/index.js:1186\n\t\tthrow new Error(\`\${binName}: \${stage}\`)\n\nError: dsh: plugin tree failed to load: dsh: 1 entry did not activate\n@lab/fx-bad: Error: fx-bad: deliberate host failure\n${STACK}`)
  assert.equal(r.fatal, true)
  assert.equal(r.hostFailures[0].package, '@lab/fx-bad')
})

test('L2 host: 0.1.5 fatal form names the entry inside one line', () => {
  const r = parseBoot(`file:///x/dsh-app-boot/lib/index.js:1545\n\nError: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry fx-bad (@lab/fx-bad): fx-bad: deliberate host failure\nError: fx-bad: deliberate host failure\n${STACK}`)
  assert.equal(r.url, null)
  assert.equal(r.fatal, true)
  assert.deepEqual(r.hostFailures.map((f) => [f.entry, f.package]), [['fx-bad', '@lab/fx-bad']])
})

test('L2 host: diagnosis codes for known breaks', () => {
  const r = parseBoot('dsh: warning: 1 entry did not activate\nperiod-report (dsh-period-report): JsonSchemaError: unsupported JSON schema: schema.properties.config.additionalProperties must be explicitly true or false\n')
  assert.deepEqual(r.hostFailures[0].codes, ['schema-additional-properties'])
  const n = parseBoot('vscode-workbench (dsh-vscode-workbench): failed to import: Error: Failed to load native module: pty.node, checked: build/Release\n')
  assert.ok(n.hostFailures[0].codes.includes('native-build'))
})

test('L2 client: boot failure, named module failure, network noise', () => {
  const r = parseClient([
    'Failed to load resource: the server responded with a status of 404 (Not Found)',
    'dsh-ccpg-document-preview failed to load TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:1/plugins/client-assets/runtime.js',
    'Error: web boot: 1 entry did not activate',
  ])
  assert.equal(r.clientFailures.length, 2)
  assert.equal(r.clientFailures[0].entry, 'dsh-ccpg-document-preview')
  assert.ok(r.clientFailures[0].codes.includes('client-asset-404'))
  assert.equal(r.netWarnings.length, 1)
})

test('L2 client: 0.1.5 loader-entry form and 0.1.7+ boot form attribute the package', () => {
  const old = parseClient(['Error: failed to import loader entry 677440a1 (@lab/fx-badclient): fx-badclient: deliberate client failure'])
  assert.equal(old.clientFailures[0].entry, '@lab/fx-badclient')
  const cur = parseClient(['Error: web boot: 1 entry did not activate\n@lab/fx-badclient: import failed: fx-badclient: deliberate client failure\n    at eM (http://127.0.0.1:1/assets/index.js:124:62214)'])
  assert.equal(cur.clientFailures[0].entry, '@lab/fx-badclient')
})

test('capabilities follow the measured version matrix', () => {
  assert.ok(compareVersions('0.2.1-rc.2', '0.2.1-rc.10') < 0)
  assert.ok(compareVersions('0.2.1', '0.2.1-rc.5') > 0)
  assert.equal(capabilitiesFor('0.0.1-rc.5').hostFailure, 'crash-after-url')
  assert.equal(capabilitiesFor('0.1.2-rc.1').tier, 'basic')
  assert.equal(capabilitiesFor('0.1.5-rc.3').hostFailure, 'fatal')
  assert.equal(capabilitiesFor('0.1.5-rc.3').tier, 'standard')
  assert.equal(capabilitiesFor('0.2.0-rc.2').nativeCompatGate, false)
  assert.equal(capabilitiesFor('0.2.1-rc.2').tier, 'full')
  assert.equal(capabilitiesFor('0.2.2-alpha.3').versionExemption, true)
})
