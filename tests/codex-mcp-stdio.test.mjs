import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../bridge/codex-mcp.mjs', import.meta.url))
const TOKEN = 'f'.repeat(64)

test('MCP stdio initialization, tool filtering and loopback forwarding', async () => {
  let requests = 0
  const server = createServer(async (req, res) => {
    requests++
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/codex/tool')
    assert.equal(req.headers.authorization, 'Bearer ' + TOKEN)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(body.name, 'ui_reset')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'Reset.' }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      JARVIS_CODEX_TOKEN: TOKEN,
      JARVIS_CODEX_PORT: String(port),
      JARVIS_CODEX_BROWSER: '0',
      JARVIS_CODEX_CAMERA: '0',
      JARVIS_CODEX_ACTIONS: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = createInterface({ input: child.stdout })
  const queue = []
  let waiter
  reader.on('line', (line) => {
    const value = JSON.parse(line)
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve(value)
    } else queue.push(value)
  })
  const next = () => queue.length
    ? Promise.resolve(queue.shift())
    : new Promise((resolve) => { waiter = resolve })
  const ask = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return Promise.race([
      next(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('MCP response timed out')), 6000)),
    ])
  }

  try {
    const init = await ask(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    assert.equal(init.result.serverInfo.name, 'jarvis-codex')
    const listed = await ask(2, 'tools/list', {})
    assert.ok(listed.result.tools.some((tool) => tool.name === 'display'))
    assert.equal(listed.result.tools.some((tool) => tool.name.startsWith('browser_')), false)
    const denied = await ask(3, 'tools/call', { name: 'camera_look', arguments: {} })
    assert.equal(denied.result.isError, true)
    assert.equal(requests, 0)
    const allowed = await ask(4, 'tools/call', { name: 'ui_reset', arguments: {} })
    assert.equal(allowed.result.content[0].text, 'Reset.')
    assert.equal(requests, 1)
  } finally {
    child.kill()
    reader.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
