/**
 * Minimal Chrome DevTools Protocol client on Node's built-in WebSocket (Node ≥22): no puppeteer,
 * no bundled browser. Uses whatever Chrome / Edge / Chromium the machine already has.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { safeRemove } from './cleanup.js'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CANDIDATES = {
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
}

/** Absolute path of a usable browser, or null. `DSH_AUTOFIT_BROWSER` overrides discovery. */
export function findBrowser(env = process.env) {
  if (env.DSH_AUTOFIT_BROWSER) return existsSync(env.DSH_AUTOFIT_BROWSER) ? env.DSH_AUTOFIT_BROWSER : null
  for (const c of CANDIDATES[process.platform] ?? CANDIDATES.linux) {
    if (path.isAbsolute(c)) { if (existsSync(c)) return c; continue }
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
      const full = path.join(dir, c)
      if (dir && existsSync(full)) return full
    }
  }
  return null
}

/**
 * Open `url` headless and collect error-level console output, uncaught exceptions and failed
 * resource loads for `settleMs` after the load event.
 * @returns {Promise<{ messages: string[], evaluated?: unknown }>}
 */
export async function inspectPage(url, { browser, timeoutMs = 45000, settleMs = 8000, evaluate } = {}) {
  const userDir = mkdtempSync(path.join(tmpdir(), 'dsh-autofit-cdp-'))
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', `--user-data-dir=${userDir}`, '--remote-debugging-port=0', 'about:blank']
  if (process.getuid?.() === 0) args.unshift('--no-sandbox')
  const proc = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const messages = []
  let ws
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('browser did not expose DevTools in time')), 20000)
      proc.stderr.on('data', (d) => {
        buf += d
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
        if (m) { clearTimeout(timer); resolve(m[1]) }
      })
      proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`browser exited (${code})`)) })
    })
    ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket error')) })
    let nextId = 1
    const pending = new Map()
    const waiters = []
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
        return
      }
      const p = msg.params ?? {}
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails ?? {}
        messages.push(d.exception?.description ?? d.text ?? 'uncaught exception')
      } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        messages.push((p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
      } else if (msg.method === 'Log.entryAdded' && p.entry?.level === 'error') {
        messages.push(`${p.entry.text}${p.entry.url ? ` ${p.entry.url.replace(/token=[^&]+/, 'token=…')}` : ''}`)
      }
      for (const w of waiters.splice(0)) w(msg)
    }
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await Promise.all(['Runtime.enable', 'Log.enable', 'Page.enable'].map((m) => send(m, {}, sessionId)))
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      const check = (msg) => (msg.method === 'Page.loadEventFired' ? (clearTimeout(timer), resolve()) : waiters.push(check))
      waiters.push(check)
    })
    await send('Page.navigate', { url }, sessionId)
    await loaded
    await new Promise((r) => setTimeout(r, settleMs))
    let evaluated
    if (evaluate) {
      const r = await send('Runtime.evaluate', { expression: evaluate, returnByValue: true, awaitPromise: true }, sessionId).catch(() => null)
      evaluated = r?.result?.value
    }
    return { messages: messages.filter(Boolean), evaluated }
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    proc.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 200))
    safeRemove(userDir)
  }
}
