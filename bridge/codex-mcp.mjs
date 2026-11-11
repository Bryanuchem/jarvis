#!/usr/bin/env node
/**
 * Small, dependency-free MCP stdio adapter for Codex. A token scoped to one
 * JARVIS browser connection authorizes requests to the local bridge only.
 * MCP stdout contains JSON-RPC messages only. Never log credentials.
 */
import { createInterface } from 'node:readline'
import { allowedTools } from './codex-tool-list.mjs'

const token = process.env.JARVIS_CODEX_TOKEN ?? ''
const port = Number(process.env.JARVIS_CODEX_PORT ?? 0)
const flags = {
  browser: process.env.JARVIS_CODEX_BROWSER === '1',
  camera: process.env.JARVIS_CODEX_CAMERA === '1',
  actions: process.env.JARVIS_CODEX_ACTIONS === '1',
}
if (!/^[a-f0-9]{64}$/.test(token) || !Number.isInteger(port) ||
    port < 1 || port > 65535) {
  console.error('[jarvis-mcp] Missing session credentials or invalid bridge port.')
  process.exit(1)
}

const tools = allowedTools(flags)
const known = new Set(tools.map((tool) => tool.name))

const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const toolError = (message) => ({
  isError: true,
  content: [{ type: 'text', text: String(message) }],
})

async function callTool(name, args) {
  if (!known.has(name)) return toolError('Tool is not enabled for this session.')
  try {
    const result = await fetch('http://127.0.0.1:' + port + '/codex/tool', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, args: args ?? {} }),
      signal: AbortSignal.timeout(65000),
    })
    const body = await result.text()
    if (!result.ok) return toolError('Bridge refused tool request (' + result.status + ').')
    const data = JSON.parse(body)
    if (!data || !Array.isArray(data.content)) {
      return toolError('Bridge returned an invalid MCP result.')
    }
    return data
  } catch (err) {
    return toolError('JARVIS bridge tool is unavailable: ' + String(err?.message ?? err))
  }
}

async function request(message) {
  const { method, params } = message
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(params?.protocolVersion)
          ? params.protocolVersion
          : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jarvis-codex', version: '0.1.0' },
        instructions:
          'Only call the tools explicitly listed here. Browser reads, camera access and ' +
          'computer actions require separate local opt-in. Camera and sensitive ' +
          'browser actions require approval in the JARVIS window; denial is final.',
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools }
    case 'tools/call':
      if (typeof params?.name !== 'string') return toolError('Missing tool name.')
      return await callTool(params.name, params.arguments ?? {})
    default:
      throw Object.assign(new Error('Method not found'), { code: -32601 })
  }
}

const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of stdin) {
  if (line.length > 80000) continue
  let message
  try { message = JSON.parse(line) } catch { continue }
  if (!message || typeof message.method !== 'string' || !Object.hasOwn(message, 'id')) continue
  void (async () => {
    try {
      send({ jsonrpc: '2.0', id: message.id, result: await request(message) })
    } catch (error) {
      send({
        jsonrpc: '2.0', id: message.id,
        error: { code: error.code ?? -32603, message: String(error.message ?? error) },
      })
    }
  })()
}
