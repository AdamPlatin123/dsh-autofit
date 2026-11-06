import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probe } from '../lib/probe/index.js'

test('probe rejects specs that would reach pnpm as options or carry control characters', async () => {
  for (const bad of ['--global', ' -g', '--config.registry=http://evil', 'a\nb', '', '   ']) {
    await assert.rejects(probe(bad, { bin: '/nonexistent/dsh' }), /invalid plugin spec/)
  }
})
