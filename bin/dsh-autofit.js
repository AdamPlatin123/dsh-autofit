#!/usr/bin/env node
/**
 * dsh-autofit CLI.
 *   dsh-autofit probe <spec> [--allow-builds a,b] [--exempt] [--no-browser] [--bin <dsh>] [--keep] [--json]
 *                   [--home <dir> --phase install|boot]   (split: install with network, boot offline)
 *   dsh-autofit host [--bin <dsh>]
 * Exit codes for probe: 0 pass, 1 fail, 2 incompatible, 3 infra-fail/inconclusive/not-published.
 */
import { detectHost, probe } from '../lib/probe/index.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--allow-builds', '--bin', '--home', '--phase'].includes(argv[i - 1]))
const [cmd, spec] = positional

const ICON = { clean: '✅', failed: '❌', unverified: '◻️', 'not-executed': '◻️', timeout: '⏱', 'infra-fail': '⚠️' }

if (cmd === 'host') {
  console.log(JSON.stringify(detectHost({ bin: value('bin') ?? 'dsh' }), null, 2))
} else if (cmd === 'probe' && spec) {
  const r = await probe(spec, {
    bin: value('bin'),
    allowBuilds: value('allow-builds')?.split(',').filter(Boolean),
    exempt: flag('exempt'),
    browser: flag('no-browser') ? false : undefined,
    keep: flag('keep'),
    home: value('home'),
    phase: value('phase'),
  })
  if (flag('json')) console.log(JSON.stringify(r, null, 2))
  else {
    const { L1, L2 } = r.layers
    console.log(`DSH ${r.host.version} (${r.host.tier})  ${spec}`)
    console.log(`  L1 install : ${L1.status}${L1.exempted ? ' (exempted)' : ''}${L1.blockedBuilds?.length ? `  blocked builds: ${L1.blockedBuilds.join(', ')}` : ''}`)
    if (L1.status === 'incompatible' && L1.requirements) console.log(`               requires ${JSON.stringify(L1.requirements)}`)
    if (r.verdict === 'installed') console.log('  (install phase only — run again with --phase boot)')
    if (L2.host) {
      console.log(`  L2 host    : ${ICON[L2.host.status] ?? ''} ${L2.host.status}`)
      for (const f of L2.host.failures) console.log(`               ${f.entry}: ${f.error.slice(0, 160)}`)
    }
    if (L2.client) {
      console.log(`  L2 client  : ${ICON[L2.client.status] ?? ''} ${L2.client.status}${L2.client.reason ? ` — ${L2.client.reason}` : ''}`)
      for (const f of L2.client.failures ?? []) console.log(`               ${f.error.slice(0, 160)}`)
    }
    console.log(`  verdict    : ${r.verdict}${r.codes.length ? `  [${r.codes.join(', ')}]` : ''}  (${Math.round(r.durationMs / 1000)}s)`)
    if (r.home) console.log(`  home kept  : ${r.home}`)
  }
  process.exit({ pass: 0, installed: 0, fail: 1, incompatible: 2 }[r.verdict] ?? 3)
} else {
  console.error('usage: dsh-autofit probe <spec> [--allow-builds a,b] [--exempt] [--no-browser] [--bin <dsh>] [--keep] [--json]\n       dsh-autofit host [--bin <dsh>]')
  process.exit(64)
}
