import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodexSession, assertMcpIsolation } from '../bridge/codex.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function* messages(...items) {
  for (const content of items) {
    yield { type: 'user', message: { role: 'user', content } }
  }
}
class FakeCodex {
  static options
  static inputs = []
  startThread(opts) {
    FakeCodex.options = opts
    return {
      async runStreamed(input, { signal }) {
        FakeCodex.inputs.push(input)
        return {
          events: (async function* () {
            yield { type: 'item.started', item: { id: 'a', type: 'agent_message', text: 'Hello' } }
            yield { type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Hello, sir' } }
            yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Hello, sir.' } }
            yield { type: 'item.started', item: { id: 't1', type: 'web_search', query: 'news' } }
            yield { type: 'item.completed', item: { id: 't1', type: 'web_search', query: 'news' } }
            if (signal.aborted) throw new Error('aborted')
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 3 } }
          })(),
        }
      },
    }
  }
}

test('converts partial Codex messages into incremental speech', async () => {
  FakeCodex.inputs = []
  const session = createCodexSession({
    prompt: messages('test question'),
    options: { cwd: '/tmp/jarvis', systemPrompt: 'Be concise.', effort: 'high' },
    codexFactory: FakeCodex,
  })
  const events = []
  for await (const event of session) events.push(event)
  const chunks = events.filter((e) => e.event?.type === 'content_block_delta')
    .map((e) => e.event.delta.text).join('')
  assert.equal(chunks, 'Hello, sir.')
  assert.equal(events.at(-1).result, 'Hello, sir.')
  assert.equal(FakeCodex.options.sandboxMode, 'read-only')
  assert.equal(FakeCodex.options.approvalPolicy, 'never')
  assert.match(FakeCodex.inputs[0], /Be concise\./)
})

test('reports tool use via the original bridge event protocol', async () => {
  const session = createCodexSession({
    prompt: messages('news'),
    options: { cwd: '/tmp/jarvis', systemPrompt: '' },
    codexFactory: FakeCodex,
  })
  const events = []
  for await (const event of session) events.push(event)
  assert.equal(events.find((e) => e.event?.type === 'content_block_start')
    .event.content_block.name, 'web_search')
  assert.equal(events.find((e) => e.type === 'user')
    .message.content[0].tool_use_id, 't1')
})

test('rejects write-enabled mode', () => {
  assert.throws(() => createCodexSession({
    prompt: messages('test'),
    options: { allowWrites: true },
    codexFactory: FakeCodex,
  }), /read-only/)
})

test('cancels an active turn and supports a subsequent question', async () => {
  let turn = 0
  class SlowCodex {
    startThread() {
      return {
        async runStreamed(_input, { signal }) {
          turn++
          const current = turn
          return {
            events: (async function* () {
              if (current === 1) {
                yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Partial' } }
                await new Promise((resolve) => {
                  if (signal.aborted) return resolve()
                  signal.addEventListener('abort', resolve, { once: true })
                })
                throw new Error('aborted')
              }
              yield { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'Next' } }
              yield { type: 'turn.completed', usage: {} }
            })(),
          }
        },
      }
    }
  }
  const session = createCodexSession({
    prompt: messages('first', 'second'),
    options: { cwd: '/tmp/jarvis', systemPrompt: 'Short.' },
    codexFactory: SlowCodex,
  })
  const output = session[Symbol.asyncIterator]()
  assert.equal((await output.next()).value.event.delta.text, 'Partial')
  await session.interrupt()
  assert.equal((await output.next()).value.subtype, 'error_during_execution')
  assert.equal((await output.next()).value.event.delta.text, 'Next')
  assert.equal((await output.next()).value.subtype, 'success')
})


test('rejects inherited Codex MCP servers unless the user explicitly trusts them', () => {
  const folder = mkdtempSync(join(tmpdir(), 'jarvis-mcp-isolation-'))
  try {
    writeFileSync(join(folder, 'config.toml'),
      '[mcp_servers.github]\ncommand = "dangerous-agent"\n')
    assert.throws(() => assertMcpIsolation({ home: folder, trusted: false }), /bypass the JARVIS approval gate/)
    assert.doesNotThrow(() => assertMcpIsolation({ home: folder, trusted: true }))
    const other = join(folder, 'empty')
    mkdirSync(other)
    assert.doesNotThrow(() => assertMcpIsolation({ home: other, trusted: false }))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
