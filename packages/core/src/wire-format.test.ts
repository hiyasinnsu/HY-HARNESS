// Tool steps replayed in each API's own call/result shape (not as JSON prose
// the model then imitates), `<think>` tags split out of replies, and the
// credential mask covering the structured parts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { OpenAiProvider, anthropicMessages, openAiMessages, redactMessage, splitThinkTags, type ChatMessage } from './llm.js'
import { resetProviderStates } from './llm-negotiate.js'

const callText = '{"calls":[{"tool":"read_file","args":{"path":"a"}},{"tool":"shell","args":{"command":"ls"}}]}'
const resultA = 'TOOL RESULT (read_file):\nA'
const resultB = 'TOOL RESULT (shell):\nB'
const rendered = `${resultA}\n\n${resultB}`
const step: ChatMessage[] = [
  { role: 'user', content: 'go' },
  {
    role: 'assistant',
    content: callText,
    toolCalls: [
      { id: 'call_1', name: 'read_file', args: { path: 'a' } },
      { id: 'call:2', name: 'shell', args: { command: 'ls' } },
    ],
  },
  {
    role: 'user',
    content: `${rendered}\n\n<hy_session_context>\nctx\n</hy_session_context>`,
    toolResults: { rendered, entries: [{ id: 'call_1', name: 'read_file', text: resultA }, { id: 'call:2', name: 'shell', text: resultB }] },
  },
]

test('OpenAI: a tool step goes back as tool_calls and role:tool messages', () => {
  const wire = openAiMessages(step, false, true) as Array<Record<string, unknown>>
  assert.deepEqual(wire[0], { role: 'user', content: 'go' })
  assert.equal(wire[1]!.role, 'assistant')
  assert.equal(wire[1]!.content, '')
  assert.deepEqual(wire[1]!.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    { id: 'call:2', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
  ])
  assert.deepEqual(wire[2], { role: 'tool', tool_call_id: 'call_1', content: resultA })
  assert.deepEqual(wire[3], { role: 'tool', tool_call_id: 'call:2', content: resultB })
  assert.deepEqual(wire[4], { role: 'user', content: '<hy_session_context>\nctx\n</hy_session_context>' })
  assert.equal(wire.length, 5)
})

test('OpenAI: without tools offered (text protocol) the step stays text', () => {
  const wire = openAiMessages(step, false, false) as Array<Record<string, unknown>>
  assert.deepEqual(wire.map((m) => m.content), step.map((m) => m.content))
  assert.ok(wire.every((m) => !('tool_calls' in m)))
})

test('a pruned result still answers every call, without bringing the text back', () => {
  const pruned: ChatMessage[] = [step[0]!, step[1]!, { role: 'user', content: 'TOOL RESULT (read_file): [pruned]' }]
  const wire = openAiMessages(pruned, false, true) as Array<Record<string, unknown>>
  assert.deepEqual(wire[2], { role: 'tool', tool_call_id: 'call_1', content: 'TOOL RESULT (read_file): [pruned]' })
  assert.equal(wire[3]!.role, 'tool')
  assert.equal(wire[3]!.tool_call_id, 'call:2')
  assert.match(String(wire[3]!.content), /included in the first result/)
  assert.equal(wire.length, 4)
})

test('OpenAI: reasoning rides on the tool_calls message when it is echoed', () => {
  const withReasoning: ChatMessage[] = [step[0]!, { ...step[1]!, reasoning: 'why' }, step[2]!]
  const wire = openAiMessages(withReasoning, true, true) as Array<Record<string, unknown>>
  assert.equal(wire[1]!.reasoning_content, 'why')
})

test('Anthropic: tool_use / tool_result blocks with ids made valid', () => {
  const wire = anthropicMessages(step, true)
  assert.equal(wire.length, 3)
  assert.deepEqual(wire[1]!.content, [
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } },
    { type: 'tool_use', id: 'call_2', name: 'shell', input: { command: 'ls' } },
  ])
  assert.deepEqual(wire[2]!.content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: resultA },
    { type: 'tool_result', tool_use_id: 'call_2', content: resultB },
    { type: 'text', text: '<hy_session_context>\nctx\n</hy_session_context>' },
  ])
})

test('Anthropic: with thinking on, a step without its signed thinking stays text', () => {
  const thinking = { type: 'thinking', thinking: 't', signature: 's' }
  const signed: ChatMessage[] = [step[0]!, { ...step[1]!, thinkingBlocks: [thinking] }, step[2]!]
  const needsThinking = (message: ChatMessage) => Boolean(message.thinkingBlocks?.length)
  assert.deepEqual(anthropicMessages(signed, needsThinking)[1]!.content[0], thinking)
  const unsigned = anthropicMessages(step, needsThinking)
  assert.deepEqual(unsigned[1]!.content, [{ type: 'text', text: callText }])
})

test('splitThinkTags moves leading reasoning out of the answer', () => {
  assert.deepEqual(splitThinkTags('<think>plan {"tool":"x"}</think>\nAnswer'), { content: 'Answer', reasoning: 'plan {"tool":"x"}' })
  assert.deepEqual(splitThinkTags('  <think>cut off while thinking'), { content: '', reasoning: 'cut off while thinking' })
  assert.deepEqual(splitThinkTags('opening tag eaten</think>Answer'), { content: 'Answer', reasoning: 'opening tag eaten' })
  assert.deepEqual(splitThinkTags('Plain answer'), { content: 'Plain answer' })
  // An answer that explains the tag is not reasoning.
  assert.deepEqual(splitThinkTags('Use ```</think>``` to close it.'), { content: 'Use ```</think>``` to close it.' })
})

test('streaming: a <think> block is shown as reasoning and kept out of the answer', async () => {
  resetProviderStates()
  const chunks = ['<thi', 'nk>step one', ' step two</thi', 'nk>\nThe answer']
  const body = chunks.map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`).join('') +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const provider = new OpenAiProvider({ provider: 'openai-compatible', model: 'think-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', contextWindowTokens: 1_000, maxOutputTokens: 100 })
    const deltas: Array<{ content?: string; reasoning?: string }> = []
    const completion = await provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 50, temperature: 0, onDelta: (delta) => deltas.push(delta) })
    assert.equal(completion.content, 'The answer')
    assert.equal(completion.reasoning, 'step one step two')
    assert.equal(deltas.filter((d) => d.content).map((d) => d.content).join('').trim(), 'The answer')
    assert.equal(deltas.filter((d) => d.reasoning).map((d) => d.reasoning).join(''), 'step one step two')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('redactMessage masks the structured parts and keeps the other fields', () => {
  const token = `ghp_${'a'.repeat(36)}`
  const message: ChatMessage = {
    role: 'user',
    content: `TOOL RESULT (shell):\n${token}`,
    toolResults: { rendered: `TOOL RESULT (shell):\n${token}`, entries: [{ id: 'c1', name: 'shell', text: `TOOL RESULT (shell):\n${token}` }] },
    images: [{ mimeType: 'image/png', data: 'AA' }],
  }
  const masked = redactMessage(message)
  assert.ok(!JSON.stringify(masked).includes(token))
  assert.deepEqual(masked.images, message.images)
  assert.ok(masked.content.startsWith(masked.toolResults!.rendered))
  const call: ChatMessage = { role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'shell', args: { command: `echo ${token}` } }], gemini: { id: 'i', prefix: 'p', callIds: ['c1'], content: 'x' } }
  const maskedCall = redactMessage(call)
  assert.ok(!JSON.stringify(maskedCall.toolCalls).includes(token))
  assert.deepEqual(maskedCall.gemini, call.gemini, 'provider continuation is kept')
  const clean: ChatMessage = { role: 'user', content: 'nothing secret' }
  assert.equal(redactMessage(clean), clean)
})

test('model discovery reads limits under the names servers use', async () => {
  const { modelEntryLimits } = await import('./llm.js')
  assert.deepEqual(modelEntryLimits({ id: 'a', context_length: 65536, top_provider: { max_completion_tokens: 8192 } }), { contextWindowTokens: 65536, maxOutputTokens: 8192 })
  assert.deepEqual(modelEntryLimits({ id: 'b', max_model_len: 32768 }), { contextWindowTokens: 32768 })
  assert.deepEqual(modelEntryLimits({ name: 'models/c', inputTokenLimit: 1048576, outputTokenLimit: 65536 }), { contextWindowTokens: 1048576, maxOutputTokens: 65536 })
  assert.deepEqual(modelEntryLimits({ id: 'd' }), {})
})

test('Ollama capabilities decide vision once the server has answered', async () => {
  const { discoverModelLimits } = await import('./llm.js')
  const { roleSupportsImages } = await import('./config.js')
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ capabilities: ['completion', 'vision'], model_info: { 'qwen3.context_length': 40960 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const role = { provider: 'ollama' as const, model: 'my-multimodal:latest', baseUrl: `http://127.0.0.1:${port}`, contextWindowTokens: 8192, maxOutputTokens: 1024 }
    assert.equal(roleSupportsImages(role), false, 'the name says nothing')
    assert.deepEqual(await discoverModelLimits(role), { contextWindowTokens: 40960 })
    assert.equal(roleSupportsImages(role), true, 'the server said vision')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
