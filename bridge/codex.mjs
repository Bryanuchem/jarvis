/**
 * Codex SDK adapter for the JARVIS WebSocket bridge (experimental).
 * Native Claude-only MCP tools are not exposed through this adapter.
 */
function toolName(item) {
  if (!item) return null
  if (item.type === 'command_execution') return 'Bash'
  if (item.type === 'file_change') return 'FileChange'
  if (item.type === 'web_search') return 'web_search'
  if (item.type === 'mcp_tool_call') return 'mcp__' + item.server + '__' + item.tool
  return null
}

function userText(message) {
  const content = message?.message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
    : ''
}

/** A small compatibility layer for one Codex thread per browser connection. */
export function createCodexSession({ prompt, options = {}, codexFactory } = {}) {
  if (!prompt?.[Symbol.asyncIterator]) {
    throw new TypeError('Codex session requires an async input iterator')
  }
  if (options.allowWrites) {
    throw new Error('Codex beta is read-only. Do not use --writes.')
  }

  let controller = null
  let closed = false
  let started = false
  const input = prompt[Symbol.asyncIterator]()

  return {
    async *[Symbol.asyncIterator]() {
      if (started) throw new Error('Codex session output may only be consumed once')
      started = true
      const CodexClass = codexFactory ?? (await import('@openai/codex-sdk')).Codex
      const codex = new CodexClass()
      const thread = codex.startThread({
        workingDirectory: options.cwd,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        webSearchMode: 'cached',
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { modelReasoningEffort: options.effort } : {}),
      })

      while (!closed) {
        const next = await input.next()
        if (next.done || closed) break
        const question = userText(next.value)
        if (!question.trim()) continue

        // SDK does not accept a system prompt in ThreadOptions. The voice
        // persona is prepended to each turn until app-server integration exists.
        const promptText = (options.systemPrompt || '') + '\n\nUSER REQUEST:\n' + question
        controller = new AbortController()
        const rendered = new Map()
        const announced = new Set()
        let spoken = ''
        let resultSent = false

        try {
          const { events } = await thread.runStreamed(promptText, {
            signal: controller.signal,
          })
          for await (const event of events) {
            if (closed) break
            if (event.type === 'item.started' ||
                event.type === 'item.updated' ||
                event.type === 'item.completed') {
              const item = event.item
              if (item?.type === 'agent_message' && typeof item.text === 'string') {
                const previous = rendered.get(item.id) ?? ''
                let delta = ''
                if (item.text.startsWith(previous)) {
                  delta = item.text.slice(previous.length)
                } else {
                  let overlap = 0
                  while (overlap < previous.length &&
                         overlap < item.text.length &&
                         previous[overlap] === item.text[overlap]) overlap++
                  delta = item.text.slice(overlap)
                }
                rendered.set(item.id, item.text)
                if (delta) {
                  spoken += delta
                  yield {
                    type: 'stream_event',
                    event: {
                      type: 'content_block_delta',
                      delta: { type: 'text_delta', text: delta },
                    },
                  }
                }
              }
              const name = toolName(item)
              if (name && !announced.has(item.id)) {
                announced.add(item.id)
                yield {
                  type: 'stream_event',
                  event: {
                    type: 'content_block_start',
                    content_block: { type: 'tool_use', id: item.id, name },
                  },
                }
              }
              if (name && event.type === 'item.completed') {
                yield {
                  type: 'user',
                  message: {
                    content: [{
                      type: 'tool_result',
                      tool_use_id: item.id,
                      is_error: item.status === 'failed' || Boolean(item.error),
                    }],
                  },
                }
              }
            }
            if (event.type === 'turn.completed') {
              resultSent = true
              yield { type: 'result', subtype: 'success', result: spoken.trim() }
            } else if (event.type === 'turn.failed' || event.type === 'error') {
              resultSent = true
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                errors: [event.error?.message ?? event.message ?? 'Codex turn failed'],
              }
            }
          }
          if (!closed && !resultSent) {
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              errors: ['Codex stream ended without a result'],
            }
          }
        } catch (error) {
          if (!closed) {
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              errors: controller.signal.aborted ? [] : [String(error?.message ?? error)],
            }
          }
        } finally {
          controller = null
        }
      }
    },
    async interrupt() { controller?.abort() },
    close() {
      closed = true
      controller?.abort()
      // The parent bridge resolves any pending input iterator when closed.
    },
  }
}
