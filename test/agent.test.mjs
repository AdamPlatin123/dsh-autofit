// Repair agent driven by a scripted fake model: message plumbing, path containment, trial-gated success.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { repairWithAgent } from '../lib/autofix/agent.js'

function fakeLlm(script) {
  const requests = []
  let i = 0
  return {
    requests,
    async *stream(opts) {
      requests.push(structuredClone({ ...opts, signal: undefined }))
      const calls = script[i++] ?? []
      if (!calls.length) { yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } }
      for (const [n, c] of calls.entries()) yield { type: 'block-end', index: n + 1, block: { type: 'tool-call', id: `call-${i}-${n}`, name: c[0], arguments: JSON.stringify(c[1]) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
}

test('agent edits only inside the copy, succeeds only after a passing trial', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'autofit-agent-'))
  writeFileSync(path.join(dir, 'index.js'), "export const schema = { config: { type: 'object' } }\n")
  const llm = fakeLlm([
    [['list_files', {}]],
    [['read_file', { path: '../../etc/passwd' }]],
    [['replace_in_file', { path: 'index.js', old_text: "{ type: 'object' }", new_text: "{ type: 'object', additionalProperties: true }" }]],
    [['run_trial', {}]],
    [['finish', { summary: 'added additionalProperties' }]],
  ])
  const events = []
  const trials = []
  const r = await repairWithAgent({
    dir, spec: 'x@1.0.0', initial: { verdict: 'fail', host: { version: '0.2.1-rc.2' }, codes: ['schema-additional-properties'], layers: {} },
    llm, model: { provider: 'p', model: 'm' }, onEvent: (e) => events.push(e),
    trial: async (d) => { trials.push(readFileSync(path.join(d, 'index.js'), 'utf8')); return { verdict: 'pass', codes: [], layers: {} } },
  })
  assert.equal(r.passed, true)
  assert.equal(r.summary, 'added additionalProperties')
  assert.match(trials[0], /additionalProperties: true/)
  const escape = events.find((e) => e.type === 'tool-result' && e.name === 'read_file')
  assert.equal(escape.ok, false, 'reading outside the copy is refused')
  // Message shapes the DSH llm service expects: assistant carries a model source, tool results reference the call.
  const last = llm.requests.at(-1).messages
  const assistant = last.find((m) => m.role === 'assistant')
  assert.equal(assistant.source.kind, 'model')
  assert.ok(assistant.content.some((b) => b.type === 'reasoning'), 'reasoning is replayed')
  const tool = last.find((m) => m.role === 'tool')
  assert.equal(tool.source.kind, 'tool')
  assert.equal(tool.source.callId, tool.toolCallId)
  assert.ok(llm.requests[0].tools.some((t) => t.name === 'run_trial'))
  rmSync(dir, { recursive: true, force: true })
})

test('finish without a passing trial is not a success', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'autofit-agent-'))
  writeFileSync(path.join(dir, 'index.js'), 'x\n')
  const llm = fakeLlm([[['finish', { summary: 'looks fine to me' }]]])
  const r = await repairWithAgent({ dir, spec: 'x', initial: { verdict: 'fail', layers: {} }, llm, model: { provider: 'p', model: 'm' }, trial: async () => ({ verdict: 'pass' }) })
  assert.equal(r.passed, false)
  rmSync(dir, { recursive: true, force: true })
})

test('path aliases are accepted', async () => {
  const { normalizeArgs } = await import('../lib/autofix/agent.js')
  assert.equal(normalizeArgs({ file_path: 'index.js' }).path, 'index.js')
  assert.equal(normalizeArgs({ path: 'a.js', file: 'b.js' }).path, 'a.js')
  assert.deepEqual(normalizeArgs(null), {})
})
