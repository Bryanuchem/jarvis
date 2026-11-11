/**
 * Opt-in Chrome DevTools Protocol adapter. Uses a dedicated Chrome profile
 * launched by the user, not Claude's browser extension or their default profile.
 * All traffic is limited to loopback and goes through JARVIS's approval gateway.
 */
import WebSocket from 'ws'

const PORT = Number(process.env.JARVIS_CODEX_CDP_PORT ?? 9222)
const reply = (text) => ({ content: [{ type: 'text', text: String(text) }] })
const failure = (text) => ({ isError: true, content: [{ type: 'text', text: String(text) }] })

async function targets() {
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
    throw new Error('Invalid JARVIS_CODEX_CDP_PORT')
  }
  const response = await fetch('http://127.0.0.1:' + PORT + '/json/list', {
    signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) throw new Error('Chrome debugging endpoint is unavailable.')
  const list = await response.json()
  if (!Array.isArray(list)) throw new Error('Chrome returned an invalid target list.')
  return list.filter((t) => t?.type === 'page' &&
    typeof t.id === 'string' && typeof t.webSocketDebuggerUrl === 'string')
}

function pickTarget(list, tabId) {
  if (!list.length) throw new Error('Open a tab in the dedicated Chrome profile.')
  if (tabId === undefined) return list[0]
  const match = list.find((t) => t.id === String(tabId))
  if (match) return match
  const index = Number(tabId)
  if (Number.isInteger(index) && index >= 0 && index < list.length) return list[index]
  throw new Error('Tab not found; call browser_tabs again.')
}

async function withTab(tabId, run) {
  const target = pickTarget(await targets(), tabId)
  const url = new URL(target.webSocketDebuggerUrl)
  if (url.protocol !== 'ws:' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('Refusing a non-loopback Chrome debugging socket.')
  }
  const socket = new WebSocket(url.toString(), { handshakeTimeout: 4000 })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const pending = new Map()
  let counter = 0
  socket.on('message', (bytes) => {
    let packet
    try { packet = JSON.parse(String(bytes)) } catch { return }
    const call = pending.get(packet.id)
    if (!call) return
    pending.delete(packet.id)
    clearTimeout(call.timer)
    if (packet.error) call.reject(new Error(packet.error.message ?? 'Chrome tool failed.'))
    else call.resolve(packet.result ?? {})
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++counter
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Chrome request timed out.'))
    }, 12000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }), (err) => {
      if (!err) return
      clearTimeout(timer)
      pending.delete(id)
      reject(err)
    })
  })
  try {
    return await run({ send, target })
  } finally {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('Chrome connection closed.'))
    }
    pending.clear()
    socket.close()
  }
}

async function evaluate(send, expression) {
  const response = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (response.exceptionDetails) throw new Error('Cannot inspect this page.')
  return response.result?.value
}

async function dispatch(name, args = {}) {
  if (name === 'browser_status') {
    return reply('Dedicated Chrome profile connected. Pages: ' + (await targets()).length)
  }
  if (name === 'browser_tabs') {
    const list = await targets()
    return reply(list.map((target, index) => {
      let origin = '(internal page)'
      try { origin = new URL(target.url).origin } catch {}
      return index + ': ' + target.id + ' ' + origin
    }).join('\n') || 'No pages are open.')
  }

  return withTab(args.tabId, async ({ send, target }) => {
    if (name === 'browser_text') {
      const text = await evaluate(send, 'document.body ? document.body.innerText : ""')
      return reply('URL: ' + target.url + '\n' +
        String(text ?? '').slice(0, args.max_chars ?? 10000))
    }
    if (name === 'browser_read') {
      const expression = [
        '(() => {',
        "const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role=\"button\"],[tabindex]')].slice(0,200);",
        'return elements.map((element,i) => {',
        "const ref='ref_'+(i+1); element.setAttribute('data-jarvis-ref',ref);",
        "const label=element.getAttribute('aria-label')||element.innerText||element.getAttribute('placeholder')||element.getAttribute('name')||'';",
        "return '['+ref+'] '+element.tagName.toLowerCase()+' '+String(label).trim().slice(0,90);",
        "}).join('\\n');",
        '})()',
      ].join('')
      const contents = await evaluate(send, expression)
      return reply('URL: ' + target.url + '\n' +
        String(contents ?? '').slice(0, args.max_chars ?? 10000))
    }
    if (name === 'browser_screenshot') {
      await send('Page.enable')
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      if (!shot.data) return failure('Chrome returned no screenshot.')
      return {
        content: [
          { type: 'text', text: 'Screenshot from selected tab.' },
          { type: 'image', data: shot.data, mimeType: 'image/png' },
        ],
      }
    }
    if (name === 'browser_navigate') {
      const address = new URL(args.url)
      if (!['http:', 'https:'].includes(address.protocol)) return failure('HTTP(S) only.')
      await send('Page.enable')
      const outcome = await send('Page.navigate', { url: address.href })
      return outcome.errorText ? failure('Navigation failed: ' + outcome.errorText) :
        reply('Navigation started: ' + address.origin + address.pathname)
    }
    if (name === 'browser_scroll') {
      const amount = Math.min(10, Math.max(1, Number(args.amount) || 3)) * 220
      const direction = args.direction ?? 'down'
      const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0
      const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 400, y: 400, deltaX, deltaY,
      })
      return reply('Scrolled ' + direction)
    }
    if (name === 'browser_click') {
      if (!/^ref_[0-9]{1,4}$/.test(args.ref)) return failure('Invalid element reference.')
      const selector = JSON.stringify('[data-jarvis-ref="' + args.ref + '"]')
      const click = '(() => { const e=document.querySelector(' + selector +
        '); if(!e)return false; e.click();return true; })()'
      const clicked = await evaluate(send, click)
      return clicked ? reply('Clicked ' + args.ref) :
        failure('Element reference expired. Read the page again.')
    }
    if (name === 'browser_type') {
      await send('Input.insertText', { text: args.text })
      return reply('Typed into focused field.')
    }
    if (name === 'browser_key') {
      const keys = {
        Enter: ['Enter', 'Enter', 13], Return: ['Enter', 'Enter', 13],
        Escape: ['Escape', 'Escape', 27], Tab: ['Tab', 'Tab', 9],
        Backspace: ['Backspace', 'Backspace', 8],
      }
      const key = keys[args.text]
      if (!key) return failure('Supported keys: Enter, Escape, Tab, Backspace.')
      const params = { key: key[0], code: key[1], windowsVirtualKeyCode: key[2] }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
      return reply('Pressed ' + key[0])
    }
    return failure('Unsupported browser command.')
  })
}

export async function codexCdpTool(name, args) {
  try { return await dispatch(name, args) }
  catch (error) {
    return failure('Dedicated Chrome profile is unavailable: ' +
      String(error?.message ?? error).slice(0, 240))
  }
}
