#!/usr/bin/env node
/**
 * dsh-autofit CLI.
 *   dsh-autofit probe <spec> [--allow-builds a,b] [--exempt] [--no-browser] [--bin <dsh>] [--keep] [--json]
 *                   [--home <dir> --phase install|boot]   (split: install with network, boot offline)
 *   dsh-autofit fix <spec> [--allow-builds a,b] [--no-browser] [--bin <dsh>] [--json]   trial → repair → re-trial
 *   dsh-autofit host [--bin <dsh>]
 * Exit codes for probe: 0 pass, 1 fail, 2 incompatible, 3 infra-fail/inconclusive/not-published.
 */
import { detectHost, probe } from '../lib/probe/index.js'
import { autofix } from '../lib/autofix/index.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--allow-builds', '--bin', '--home', '--phase', '--out'].includes(argv[i - 1]))
const [cmd, spec] = positional

const ICON = { clean: '✅', failed: '❌', unverified: '◻️', 'not-executed': '◻️', timeout: '⏱', 'infra-fail': '⚠️' }

if (cmd === 'fix' && spec) {
  const r = await autofix(spec, {
    probe: { bin: value('bin'), allowBuilds: value('allow-builds')?.split(',').filter(Boolean), browser: flag('no-browser') ? false : undefined },
    outDir: value('out'),
    onProgress: (e) => { if (!flag('json')) console.error(`  · ${e.stage}${e.round ? ` round ${e.round}` : ''}${e.changes ? `: ${e.changes.map((c) => c.rule).join(', ')}` : ''}`) },
  })
  if (flag('json')) { const { initial, final, ...rest } = r; console.log(JSON.stringify({ ...rest, final: { verdict: final?.verdict, codes: final?.codes, layers: final?.layers } }, null, 2)) } else {
    console.log(`${spec}`)
    for (const rd of r.rounds) console.log(`  round ${rd.round}: ${rd.verdict}${rd.codes?.length ? `  [${rd.codes.join(', ')}]` : ''}`)
    for (const c of r.changes) console.log(`  ${c.tier} ${c.rule}  ${c.file}: ${c.detail}`)
    for (const a of r.needsApproval) console.log(`  needs approval: ${a.kind} ${a.packages?.join(', ') ?? ''} — ${a.why}`)
    for (const u of r.unresolved) console.log(`  unresolved: ${u.code} — ${u.hint}`)
    console.log(`  verdict: ${r.verdict}${r.artifact?.usable ? `  → ${r.artifact.file}` : ''}${r.error ? `  (error: ${r.error})` : ''}`)
  }
  process.exit({ pass: 0, fixed: 0, fail: 1, incompatible: 2 }[r.verdict] ?? 3)
} else if (cmd === 'host') {
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
