// Regressions found running 0.3.11 on Windows (2026-11-08): pnpm 9 refusing `add` in the profile workspace,
// DSH 0.2.1 bin.js exiting silently on Node 22.14, npm's sh shim not parsed, GNU tar reading `C:\…` as a host.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { packDir, untar } from '../lib/autofix/index.js'
import { dshPackageDir } from '../lib/describe.js'
import { supportsImportMetaMain } from '../lib/probe/host.js'
import { parseInstall } from '../lib/probe/signals.js'

test('L1: pnpm refusing to add to the workspace root is an environment failure, not the plugin\'s', () => {
  const log = 'dsh: initialized profile web at C:\\t\\profiles\\web\n ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root, which might not be what you want - if you really meant it, make it explicit by running this command again with the -w flag (or --workspace-root).\ndsh: plugin command failed; diagnostics: C:\\t\\pnpm.log\n'
  const r = parseInstall(log, 1)
  assert.equal(r.status, 'infra-fail')
  assert.deepEqual(r.codes, ['package-manager'])
})

test('L1: no pnpm on the trial machine is an environment failure that names the fix (seen on a CI runner)', () => {
  const log = 'dsh: initialized profile web at /tmp/dsh-autofit-probe-eHH7sc/profiles/web\nCommand failed with ENOENT: pnpm add /home/runner/work/dsh-autofit/dsh-autofit/dsh-autofit-0.3.11.tgz\nspawn pnpm ENOENTdsh: pnpm was not found; install pnpm and make it available on PATH.\ndsh: plugin command failed; diagnostics: /tmp/dsh-autofit-probe-eHH7sc/profiles/web/.plugin-manager/logs/operation-se5Acr/pnpm.log\n'
  const r = parseInstall(log, 1)
  assert.equal(r.status, 'infra-fail')
  assert.deepEqual(r.codes, ['package-manager'])
  assert.match(r.error, /install pnpm/)
})

test('import.meta.main support follows the Node release lines that have it', () => {
  for (const v of ['22.18.0', '22.20.1', '24.2.0', '24.11.0', '25.0.0', 'v24.3.0']) assert.equal(supportsImportMetaMain(v), true, v)
  for (const v of ['22.14.0', '22.17.9', '23.11.0', '24.1.0', '20.19.0']) assert.equal(supportsImportMetaMain(v), false, v)
})

function fakeGlobalInstall() {
  const prefix = mkdtempSync(path.join(tmpdir(), 'autofit-shim-'))
  const pkg = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  writeFileSync(path.join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.2"}')
  writeFileSync(path.join(pkg, 'lib', 'bin.js'), '')
  return { prefix, pkg }
}

test('dshPackageDir reads npm\'s sh shim ($basedir) and cmd shim (%dp0%)', () => {
  const { prefix, pkg } = fakeGlobalInstall()
  try {
    const sh = path.join(prefix, 'dsh')
    writeFileSync(sh, '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\nelse \n  exec node  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\nfi\n')
    const cmd = path.join(prefix, 'dsh.cmd')
    writeFileSync(cmd, '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')
    assert.equal(dshPackageDir(sh, {}), pkg)
    // `%dp0%\node_modules\…` is a Windows path; elsewhere the backslashes are file-name characters.
    if (process.platform === 'win32') assert.equal(dshPackageDir(cmd, {}), pkg)
  } finally {
    rmSync(prefix, { recursive: true, force: true })
  }
})

test('tar round-trips through absolute paths (no host:path reading of a drive letter, no -C C:\…)', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'autofit-tar-'))
  try {
    const src = path.join(base, 'src', 'package')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'package.json'), '{"name":"x","version":"1.0.0"}')
    const out = path.join(base, 'out dir')
    mkdirSync(out)
    const archive = path.join(out, 'x-1.0.0+autofit.1.tgz')
    packDir(src, archive)
    const dest = path.join(base, 'dest')
    mkdirSync(dest)
    untar(archive, dest)
    assert.ok(existsSync(path.join(dest, 'package', 'package.json')))
    assert.equal(JSON.parse(readFileSync(path.join(dest, 'package', 'package.json'), 'utf8')).name, 'x')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
