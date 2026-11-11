/**
 * Permission-enforcing connection between the local MCP stdio process and a
 * single JARVIS WebSocket. The MCP process never receives the browser socket.
 */
import { randomBytes } from 'node:crypto'
import { getTool, validateArgs } from './codex-tool-list.mjs'

const fail = (message) => ({
  isError: true, content: [{ type: 'text', text: message }],
})
const ok = (message) => ({ content: [{ type: 'text', text: message }] })
const colour = (value) => typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)
const webUrl = (value) => {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username && !parsed.password
  } catch { return false }
}
const clip = (value, n) => String(value ?? '').slice(0, n)
const canRespond = (session) => !session.closed

export function createCodexGateway({ chrome, idFactory = () => randomBytes(32).toString('hex') }) {
  const sessions = new Map()
  let seq = 0

  function register({ send, ask, flags }) {
    const token = idFactory()
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      throw new Error('Invalid token generated')
    }
    if (sessions.has(token)) throw new Error('Duplicate session token')
    sessions.set(token, { send, ask, flags: { ...flags }, closed: false })
    return token
  }

  function revoke(token) {
    const session = sessions.get(token)
    if (session) session.closed = true
    sessions.delete(token)
  }

  async function execute(token, name, args = {}) {
    const session = sessions.get(token)
    if (!session || session.closed) return fail('Session expired or unauthorized.')
    const tool = getTool(name, session.flags)
    const issue = validateArgs(tool, args)
    if (issue) return fail(issue)

    const askApproval = async (summary) => {
      if (!canRespond(session)) return false
      try {
        const response = await session.ask('approval', { summary: clip(summary, 220) }, 35000)
        return canRespond(session) && response?.approved === true
      } catch { return false }
    }

    if (tool.category === 'display') {
      if (name === 'display') {
        const html = args.html.trim()
        if (!html || (!html.replace(/<[^>]*>/g, '').trim() &&
            !/<(img|video|iframe|source)\b/i.test(html))) {
          return fail('Display needs visible HTML content.')
        }
        session.send({
          type: 'blade',
          blade: { id: 'cd' + (++seq), title: clip(args.title || 'DISPLAY', 120),
            kind: 'markup', html, size: 'wide', hold: 'turn' },
        })
        return ok('Displayed on screen.')
      }
      if (name === 'blade') {
        const kind = args.kind
        if (['article', 'image', 'video', 'embed'].includes(kind) &&
            !webUrl(args.url)) {
          return fail('This blade needs an absolute HTTP(S) URL.')
        }
        if (kind === 'gallery' &&
            (!Array.isArray(args.images) || !args.images.length ||
             !args.images.every(webUrl))) {
          return fail('Gallery requires valid HTTP(S) image URLs.')
        }
        if (kind === 'markup' && !String(args.html ?? '').trim()) {
          return fail('Markup blade requires HTML.')
        }
        session.send({
          type: 'blade',
          blade: {
            id: 'cb' + (++seq), title: clip(args.title || 'DISPLAY', 120),
            kind, url: args.url, html: args.html, images: args.images,
            size: kind === 'article' ? 'tall' : 'wide', hold: 'turn', mode: 'reader',
          },
        })
        return ok('Blade opened.')
      }
      if (name === 'ui_reset') {
        session.send({ type: 'ui', op: 'reset', args: {} })
        return ok('Interface reset.')
      }
      if (name === 'ui_effect') {
        session.send({ type: 'ui', op: 'effect', args: { kind: args.kind } })
        return ok('Effect shown.')
      }
      if (name === 'ui_theme') {
        if ((args.accent && !colour(args.accent)) ||
            (args.background && !colour(args.background))) {
          return fail('Theme accepts hex colours only.')
        }
        session.send({ type: 'ui', op: 'patch', args: {
          ...(args.accent ? { accent: args.accent } : {}),
          ...(args.background ? { background: args.background } : {}),
        } })
        return ok('Theme updated.')
      }
      if (name === 'ui_reactor') {
        if (args.color && !colour(args.color)) return fail('Reactor colour must be hex.')
        session.send({ type: 'ui', op: 'patch', args: { reactor: {
          ...(args.color ? { color: args.color } : {}),
          ...(args.scale !== undefined ? { scale: Math.min(3, Math.max(0.2, args.scale)) } : {}),
          ...(args.visible !== undefined ? { visible: args.visible } : {}),
        } } })
        return ok('Reactor updated.')
      }
    }

    if (tool.category === 'camera') {
      if (!await askApproval(name === 'camera_look'
        ? 'Allow JARVIS to take one camera photo?'
        : 'Allow JARVIS to observe the camera for ' + (args.seconds ?? 6) + ' seconds?')) {
        return fail('Camera permission denied in the JARVIS window.')
      }
      try {
        const result = await session.ask('capture', {
          mode: name === 'camera_watch' ? 'watch' : 'look',
          reason: clip(args.reason, 80),
          seconds: args.seconds ?? 6,
          when: args.when ?? 'now',
        }, 48000)
        if (result?.error) return fail(clip(result.error, 300))
        if (typeof result?.data !== 'string' ||
            result.data.length < 10 || result.data.length > 13000000) {
          return fail('Camera returned no usable image.')
        }
        const mimeType = ['image/jpeg', 'image/png', 'image/webp'].includes(result.mimeType)
          ? result.mimeType : 'image/jpeg'
        return { content: [
          { type: 'text', text: 'Camera image captured with permission.' },
          { type: 'image', data: result.data, mimeType },
        ] }
      } catch {
        return fail('Camera capture failed or timed out.')
      }
    }

    if (tool.category === 'browser' || tool.category === 'action') {
      if (tool.category === 'action' &&
          name === 'browser_navigate' && !webUrl(args.url)) {
        return fail('Navigation requires an HTTP(S) URL.')
      }
      const publicRead = ['browser_status', 'browser_tabs'].includes(name)
      if (!publicRead) {
        const summary = name === 'browser_type'
          ? 'Allow Jarvis to type text into the selected browser tab?'
          : name === 'browser_key'
            ? 'Allow Jarvis to press a keyboard shortcut in your browser?'
            : name === 'browser_navigate'
              ? 'Allow Jarvis to open ' + clip(args.url, 130) + ' in your browser?'
              : 'Allow JARVIS to ' + name.replace('browser_', '').replace(/_/g, ' ') +
                ' the selected browser tab?'
        if (!await askApproval(summary)) return fail('Browser permission denied.')
      }
      if (!canRespond(session)) return fail('Session expired.')
      try {
        const result = await chrome(name, args)
        return result?.content && Array.isArray(result.content)
          ? result : fail('Browser returned an invalid result.')
      } catch {
        return fail('Browser connector failed to complete the operation.')
      }
    }
    return fail('Unsupported tool.')
  }

  return { register, revoke, execute }
}
