import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

test('independent CDP adapter uses loopback Chrome and handles tab read/action', async () => {
  let port
  let evalCalls = 0
  const server = createServer((req, res) => {
    assert.equal(req.url, '/json/list')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify([{
      type: 'page',
      id: 'mock-tab',
      url: 'https://example.test/hello',
      webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/mock-tab',
    }]))
  })
  const sockets = new WebSocketServer({ server, path: '/devtools/page/mock-tab' })
  sockets.on('connection', (socket) => {
    socket.on('message', (input) => {
      const packet = JSON.parse(String(input))
      let response = {}
      if (packet.method === 'Runtime.evaluate') {
        evalCalls++
        response = { result: { value: packet.params.expression.includes('document.querySelector')
          ? true : 'Test page text' } }
      } else if (packet.method === 'Page.captureScreenshot') {
        response = { data: Buffer.from('test').toString('base64') }
      }
      socket.send(JSON.stringify({ id: packet.id, result: response }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  process.env.JARVIS_CODEX_CDP_PORT = String(port)
  const { codexCdpTool } = await import('../bridge/codex-cdp.mjs')

  try {
    const tabs = await codexCdpTool('browser_tabs', {})
    assert.match(tabs.content[0].text, /example\.test/)
    const page = await codexCdpTool('browser_text', {})
    assert.match(page.content[0].text, /Test page text/)
    const clicked = await codexCdpTool('browser_click', { ref: 'ref_1' })
    assert.match(clicked.content[0].text, /Clicked ref_1/)
    const shot = await codexCdpTool('browser_screenshot', {})
    assert.equal(shot.content[1].type, 'image')
    assert.ok(evalCalls >= 2)
    const invalid = await codexCdpTool('browser_click', { ref: 'bogus' })
    assert.equal(invalid.isError, true)
  } finally {
    await new Promise((resolve) => sockets.close(resolve))
    await new Promise((resolve) => server.close(resolve))
    delete process.env.JARVIS_CODEX_CDP_PORT
  }
})
