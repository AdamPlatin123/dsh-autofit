/**
 * Repair agent: when no deterministic rule fixes a plugin, let the user's own DSH model read and edit an unpacked
 * copy of the plugin and trial it, until a trial passes.
 *
 * Containment: the agent gets six tools and nothing else — list/read/write/replace confined to the copy's
 * directory (paths resolved and checked; no `..` escape, no absolute paths), `run_trial`, and `finish`. No shell.
 * A repair counts only when the latest `run_trial` passed; `finish` cannot claim success on its own. `run_trial` is
 * refused while the edits break a guardrail (see guard.js): the agent is told which and has to revert first.
 *
 * Model access goes through the host's `llm` service with the user's default model, so no extra key or setup.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_READ = 40_000
const MAX_RESULT = 12_000

const KNOWN_BREAKS = `Known DSH breaking changes (found in the lab; most are not in official upgrade guides):
- peerDependencies / engines.dsh that exclude the running DSH make the install fail ("is incompatible with dsh"): widen the range by appending " || ^<host version>" — do not remove the original range.
- A bundle patch (cordis.patch.yml) must be a top-level YAML list ("- insert:"), not a mapping ("insert:").
- @deepseek-ai/dsh-tools (0.2+) requires every JSON-Schema object to state additionalProperties explicitly (true or false).
- ctx.tools.register({...}) must declare output: { schema, render(args, value) => [{ type: 'text', text }] }.
- Client services renamed: settingsScope → configForms (0.1.7); a client entry "pending (waiting for service: X)" means X no longer exists or was renamed — read the host's API instead of guessing.
- Client modules no longer run from their own URL: assets built with new URL('./x', document.currentScript) 404; use the route the host half registers (e.g. /plugins/<package>/...).
- Accessing a host service without listing it in "inject" throws "cannot get property ... without inject".
- 0.2.2 removed the TOOL_RUNTIME_SCHEDULER export from @deepseek-ai/dsh-tools.`

const TOOLS = [
  { name: 'list_files', description: 'List files under a directory of the plugin copy (relative path, default "."). Skips node_modules and .git.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } } },
  { name: 'read_file', description: 'Read a text file of the plugin copy. Optional 1-based line offset and line limit for large files.', parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } } } },
  { name: 'write_file', description: 'Overwrite (or create) a text file of the plugin copy with the full new content.', parameters: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'replace_in_file', description: 'Replace one exact, unique occurrence of old_text with new_text in a file of the plugin copy.', parameters: { type: 'object', additionalProperties: false, required: ['path', 'old_text', 'new_text'], properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } } } },
  { name: 'run_trial', description: 'Pack the current plugin copy and really install + load it in a throwaway DSH profile. Returns the verdict and the failure details. Takes 20–60 s.', parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'finish', description: 'End the repair. Call after run_trial passed, or when you are sure the plugin cannot be fixed here (explain why).', parameters: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } } },
]

function inside(root, rel) {
  if (rel === undefined || rel === null || rel === '') throw new Error('missing "path": pass a file path relative to the plugin copy, e.g. "index.js"')
  if (typeof rel !== 'string' || path.isAbsolute(rel)) throw new Error('path must be relative to the plugin copy')
  const full = path.resolve(root, rel || '.')
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path escapes the plugin copy')
  return full
}

function listFiles(root, rel) {
  const base = inside(root, rel || '.')  // list_files defaults to the root
  const out = []
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (depth < 6) walk(full, depth + 1) } else out.push(`${path.relative(root, full)} (${statSync(full).size} B)`)
      if (out.length >= 400) return
    }
  }
  walk(base, 0)
  return out.join('\n') || '(empty)'
}

const clip = (s, n = MAX_RESULT) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s)

/**
 * @param {object} o
 * @param {string} o.dir           unpacked plugin copy (the only place the agent may touch)
 * @param {string} o.spec          what the user asked to install (for the prompt)
 * @param {object} o.initial       probe result of the failing original
 * @param {(dir: string) => Promise<object>} o.trial  pack + probe the copy; resolves to a probe result
 * @param {(dir: string) => string[]} [o.guard]      reasons the current edits may not be trialled (empty: go ahead)
 * @param {{ stream: Function }} o.llm               the host's llm service
 * @param {{ provider: string, model: string, reasoningEffort?: string }} o.model
 * @param {(event: object) => void} [o.onEvent]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.maxSteps=30]
 */
export async function repairWithAgent(o) {
  const root = path.resolve(o.dir)
  const emit = o.onEvent ?? (() => {})
  const maxSteps = o.maxSteps ?? 30
  let lastTrial = null
  let finished = null
  const failure = summarizeTrial(o.initial)
  const system = `You repair a DeepSeek Harness (DSH) plugin so that it installs and loads on DSH ${o.initial?.host?.version ?? '(unknown)'}.
You work on an unpacked copy of the plugin in a sandbox; your tools only reach that copy. You cannot run shell commands.
Rules: make the smallest change that fixes the failure; do not remove features or rename the package; keep the original
code style; never invent APIs — if unsure, read the plugin's own code to see what it expects. run_trial refuses edits
that change package.json name/scripts/bin/dependencies/dsh.bundle, edit the bundle patch file, remove .register(...)
calls, empty a file, narrow a DSH requirement, or change more than 8 files or 200 lines. After editing, call
run_trial. Repeat until run_trial passes, then call finish. If you are sure it cannot be fixed (missing external runtime,
needs a newer DSH, …) call finish and explain.

${KNOWN_BREAKS}`
  const messages = [{ role: 'user', content: [{ type: 'text', text: `Plugin: ${o.spec}\n\nThe original failed the trial:\n${failure}\n\nStart by listing the files.` }] }]

  for (let step = 1; step <= maxSteps && !finished; step++) {
    if (o.signal?.aborted) throw new Error('cancelled')
    emit({ type: 'step', step })
    const blocks = []
    let replayState
    for await (const chunk of o.llm.stream({ provider: o.model.provider, model: o.model.model, reasoningEffort: o.model.reasoningEffort, system, messages, tools: TOOLS, maxTokens: 16000, signal: o.signal })) {
      if (chunk.type === 'block-end') {
        blocks.push(chunk.block)
        if (chunk.block.type === 'text' && chunk.block.text.trim()) emit({ type: 'say', text: chunk.block.text })
        if (chunk.block.type === 'reasoning' && chunk.block.text.trim()) emit({ type: 'think', text: chunk.block.text.slice(0, 600) })
      } else if (chunk.type === 'finish') replayState = chunk.replayState
    }
    messages.push({ id: randomUUID(), role: 'assistant', content: blocks, source: { kind: 'model', provider: o.model.provider, model: o.model.model, ...(replayState ? { replayState } : {}) } })
    const calls = blocks.filter((b) => b.type === 'tool-call')
    if (!calls.length) break
    for (const call of calls) {
      let args = {}
      let result
      let isError = false
      try {
        args = normalizeArgs(call.arguments ? JSON.parse(call.arguments) : {})
        emit({ type: 'tool', name: call.name, args: describeArgs(call.name, args) })
        result = await runTool(call.name, args)
      } catch (err) {
        isError = true
        result = `Error: ${err.message ?? err}`
      }
      emit({ type: 'tool-result', name: call.name, ok: !isError, text: clip(String(result), 600) })
      messages.push({ id: randomUUID(), role: 'tool', toolCallId: call.id, isError, content: [{ type: 'text', text: clip(String(result)) }], source: { kind: 'tool', callId: call.id } })
    }
  }
  const passed = lastTrial?.verdict === 'pass'
  return { passed, lastTrial, summary: finished ?? (passed ? 'run_trial passed' : 'stopped without a passing trial') }

  async function runTool(name, args) {
    switch (name) {
      case 'list_files': return listFiles(root, args.path)
      case 'read_file': {
        if (!args.path) throw new Error(`missing "path" (got arguments: ${JSON.stringify(Object.keys(args))}); call read_file with {"path": "index.js"}`)
        const full = inside(root, args.path)
        if (statSync(full).isDirectory()) return `${args.path} is a directory:\n${listFiles(root, args.path)}`
        const text = readFileSync(full, 'utf8')
        if (!args.offset && !args.limit) return clip(text, MAX_READ)
        const lines = text.split('\n')
        const from = Math.max(1, args.offset ?? 1)
        return lines.slice(from - 1, from - 1 + (args.limit ?? 400)).map((l, i) => `${from + i}\t${l}`).join('\n')
      }
      case 'write_file': {
        const full = inside(root, args.path)
        mkdirSync(path.dirname(full), { recursive: true })
        writeFileSync(full, String(args.content))
        return `wrote ${args.path} (${String(args.content).length} characters)`
      }
      case 'replace_in_file': {
        const full = inside(root, args.path)
        if (!existsSync(full)) throw new Error(`${args.path} does not exist`)
        const src = readFileSync(full, 'utf8')
        const n = src.split(args.old_text).length - 1
        if (n !== 1) throw new Error(`old_text occurs ${n} times in ${args.path}; it must occur exactly once`)
        writeFileSync(full, src.replace(args.old_text, () => args.new_text))
        return `replaced 1 occurrence in ${args.path}`
      }
      case 'run_trial': {
        const refused = o.guard?.(root) ?? []
        if (refused.length) {
          emit({ type: 'trial-refused', reasons: refused })
          throw new Error(`run_trial refused; these edits are not allowed in a repair:\n- ${refused.join('\n- ')}\nRevert or narrow them, then call run_trial again.`)
        }
        emit({ type: 'trial-start' })
        lastTrial = await o.trial(root)
        emit({ type: 'trial', verdict: lastTrial.verdict, codes: lastTrial.codes })
        return summarizeTrial(lastTrial)
      }
      case 'finish':
        finished = String(args.summary ?? '')
        return 'ok'
      default: throw new Error(`unknown tool ${name}`)
    }
  }
}

// Models often name the path argument differently (file_path, filename, …); accept those rather than burn steps.
const PATH_ALIASES = ['file_path', 'filePath', 'file', 'filename', 'path_name', 'relative_path', 'dir', 'directory']
export function normalizeArgs(a) {
  if (!a || typeof a !== 'object') return {}
  if (a.path === undefined || a.path === null || a.path === '') {
    const k = PATH_ALIASES.find((x) => typeof a[x] === 'string' && a[x])
    if (k) return { ...a, path: a[k] }
  }
  return a
}

function describeArgs(name, a) {
  if (name === 'write_file') return `${a.path} (${String(a.content ?? '').length} chars)`
  if (name === 'replace_in_file') return a.path
  if (name === 'read_file' || name === 'list_files') return a.path ?? '.'
  return ''
}

/** Compact, model-friendly account of a probe result. */
export function summarizeTrial(r) {
  if (!r) return '(no trial)'
  const L1 = r.layers?.L1 ?? {}
  const host = r.layers?.L2?.host ?? {}
  const client = r.layers?.L2?.client ?? {}
  const lines = [`verdict: ${r.verdict}`, `install: ${L1.status ?? '—'}`]
  if (L1.requirements) lines.push(`unmet DSH requirements: ${JSON.stringify(L1.requirements)}`)
  if (L1.error) lines.push(`install error: ${L1.error}`)
  if (L1.blockedBuilds?.length) lines.push(`blocked build scripts: ${L1.blockedBuilds.join(', ')}`)
  if (host.status) lines.push(`host load: ${host.status}`)
  for (const f of host.failures ?? []) lines.push(`host failure ${f.entry ?? ''}: ${f.error}`)
  if (client.status) lines.push(`client load: ${client.status}${client.reason ? ` (${client.reason})` : ''}`)
  for (const f of client.failures ?? []) lines.push(`client failure ${f.entry ?? ''}: ${f.error}`)
  if (r.codes?.length) lines.push(`diagnosis codes: ${r.codes.join(', ')}`)
  if (L1.status !== 'installed' && L1.logTail) lines.push(`install log tail:\n${L1.logTail}`)
  return clip(lines.join('\n'), 6000)
}
