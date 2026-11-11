import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodexGateway } from '../bridge/codex-gateway.mjs'
import { allowedTools, getTool, validateArgs } from '../bridge/codex-tool-list.mjs'

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

test('MCP tool catalog exposes no browser, camera or action tools by default', () => {
  assert.deepEqual(allowedTools({}).some((tool) => tool.name.startsWith('browser_')), false)
  assert.equal(getTool('camera_look', {}), null)
  assert.equal(getTool('browser_click', { browser: true, actions: false }), null)
  assert.ok(getTool('browser_click', { browser: true, actions: true }))
})

test('gateway token is scoped to one connection and can be revoked', async () => {
  const messages = []
  const gateway = createCodexGateway({
    chrome: async () => ({ content: [{ type: 'text', text: 'browser response' }] }),
    idFactory: () => TOKEN_A,
  })
  const token = gateway.register({
    flags: {},
    send: (msg) => messages.push(msg),
    ask: async () => ({ approved: true }),
  })
  assert.equal((await gateway.execute(TOKEN_B, 'ui_reset', {})).isError, true)
  assert.equal((await gateway.execute(token, 'ui_reset', {})).isError, undefined)
  assert.equal(messages[0].op, 'reset')
  gateway.revoke(token)
  assert.equal((await gateway.execute(token, 'ui_reset', {})).isError, true)
})

test('schema validation rejects unexpected arguments', () => {
  const tool = getTool('browser_click', { browser: true, actions: true })
  assert.match(validateArgs(tool, { ref: 'ref_1', execute_shell: 'rm -rf /' }), /Unexpected/)
  assert.match(validateArgs(tool, {}), /Missing/)
  assert.equal(validateArgs(tool, { ref: 'ref_1' }), null)
})

test('browser read requires a fresh approval; denial performs no browser call', async () => {
  let called = 0
  let approved = false
  const gateway = createCodexGateway({
    chrome: async () => {
      called++
      return { content: [{ type: 'text', text: 'Page content' }] }
    },
    idFactory: () => TOKEN_A,
  })
  const token = gateway.register({
    flags: { browser: true },
    send: () => {},
    ask: async () => ({ approved }),
  })
  assert.equal((await gateway.execute(token, 'browser_text', {})).isError, true)
  assert.equal(called, 0)
  approved = true
  assert.equal((await gateway.execute(token, 'browser_text', {})).isError, undefined)
  assert.equal(called, 1)
})

test('computer actions require explicit opt-in and approval', async () => {
  let called = 0
  let nextId = 0
  const gateway = createCodexGateway({
    chrome: async () => {
      called++
      return { content: [{ type: 'text', text: 'clicked' }] }
    },
    idFactory: () => (++nextId).toString(16).padStart(64, '0'),
  })
  const disabled = gateway.register({
    flags: { browser: true, actions: false }, send: () => {},
    ask: async () => ({ approved: true }),
  })
  assert.equal((await gateway.execute(disabled, 'browser_click', { ref: 'ref_1' })).isError, true)
  let approve = false
  const enabled = gateway.register({
    flags: { browser: true, actions: true }, send: () => {},
    ask: async () => ({ approved: approve }),
  })
  assert.equal((await gateway.execute(enabled, 'browser_click', { ref: 'ref_1' })).isError, true)
  assert.equal(called, 0)
  approve = true
  assert.equal((await gateway.execute(enabled, 'browser_click', { ref: 'ref_1' })).isError, undefined)
  assert.equal(called, 1)
  assert.equal((await gateway.execute(enabled, 'browser_navigate', { url: 'javascript:alert(1)' })).isError, true)
})

test('camera capture is opt-in and requires consent', async () => {
  let captures = 0
  let approved = false
  const gateway = createCodexGateway({
    chrome: async () => ({ content: [] }),
    idFactory: () => TOKEN_A,
  })
  const token = gateway.register({
    flags: { camera: true },
    send: () => {},
    ask: async (kind) => {
      if (kind === 'approval') return { approved }
      captures++
      return { data: 'abcdefghi0123456789', mimeType: 'image/jpeg' }
    },
  })
  assert.equal((await gateway.execute(token, 'camera_look', {})).isError, true)
  assert.equal(captures, 0)
  approved = true
  const response = await gateway.execute(token, 'camera_look', { reason: 'Read a label' })
  assert.equal(response.content[1].type, 'image')
  assert.equal(captures, 1)
})

test('display functions return errors for invalid content and send safe UI commands', async () => {
  const seen = []
  const gateway = createCodexGateway({ chrome: async () => ({ content: [] }), idFactory: () => TOKEN_A })
  const token = gateway.register({
    flags: {}, send: (message) => seen.push(message),
    ask: async () => ({ approved: false }),
  })
  assert.equal((await gateway.execute(token, 'display', { html: '<div></div>' })).isError, true)
  assert.equal((await gateway.execute(token, 'ui_theme', { accent: 'url(javascript:evil)' })).isError, true)
  assert.equal((await gateway.execute(token, 'display', { html: '<p>Welcome</p>' })).isError, undefined)
  assert.equal(seen[0].type, 'blade')
  assert.equal(seen[0].blade.kind, 'markup')
})
