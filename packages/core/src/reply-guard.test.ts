import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeBrokenToolCall } from './reply-guard.js'

test('a truncated tool call is a broken tool call', () => {
  assert.equal(looksLikeBrokenToolCall('{"tool":"read_file","args":{"path":"a.txt"'), true)
})

test('a leaked chat-template closing tag is a broken tool call', () => {
  assert.equal(looksLikeBrokenToolCall('{"tool":"shell","args":{"command":"ls"}}</｜parameter>'), true)
})

test('a valid final answer is not a broken tool call', () => {
  assert.equal(looksLikeBrokenToolCall('{"final":"done"}'), false)
})

test('ordinary prose is not a broken tool call', () => {
  assert.equal(
    looksLikeBrokenToolCall('I read both files. The tool output shows A and B, so nothing else is needed.'),
    false,
  )
})

test('a long code block is not a broken tool call', () => {
  const code = ['```ts', 'export function tool(name: string): string {', '  return `calls ${name}`', '}', '```'].join('\n')
  assert.equal(looksLikeBrokenToolCall(code), false)
})

test('a broken call after prose is a broken tool call', () => {
  const text = ['ファイルを読みます。', '{"tool":"read_file","args":{"path":"a.txt"'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), true)
})

test('a truncated calls array is a broken tool call', () => {
  const text = '{"calls":[{"tool":"read_file","args":{"path":"a.txt"}},{"tool":"rea'
  assert.equal(looksLikeBrokenToolCall(text), true)
})

test('a broken JSON fragment in the middle of prose is a broken tool call', () => {
  const text = 'Let me look: {"tool":"shell","args":{"command":"ls"} and then report back.'
  assert.equal(looksLikeBrokenToolCall(text), true)
})

test('a broken call followed by prose is a broken tool call', () => {
  const text = ['{"calls":[{"tool":"read_file","args":{"path":"a.txt"}', 'That is all.'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), true)
})

test('valid JSON inside a fence is an explanation, not a call', () => {
  const text = ['Here is the shape of the call:', '```json', '{"tool":"read_file","args":{"path":"a.txt"}}', '```'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('a fenced truncated example is an explanation, not a call', () => {
  const text = ['The model produced this:', '```', '{"tool":"read_file","args":{"path":"a.txt"', '```'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('TypeScript source is not a broken tool call', () => {
  const text = [
    'const calls = []',
    'function tool(name) {',
    '  calls.push({ tool: name, args: {} })',
    '  return `calls ${name}`',
    '}',
  ].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('Japanese prose that mentions tools is not a broken tool call', () => {
  const text = 'ファイルを読みました。結果は {"content":"A"} でした。ツール呼び出しは 1 回だけです。'
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('English prose that mentions calls is not a broken tool call', () => {
  const text =
    'I read both files with the tool and made 3 calls; the results agree, so nothing else is needed. Behavior stays as before.'
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('empty and whitespace-only replies are not broken tool calls', () => {
  assert.equal(looksLikeBrokenToolCall(''), false)
  assert.equal(looksLikeBrokenToolCall('  \n\t \n'), false)
})

test('a long prose answer with an inline JSON example is not a broken tool call', () => {
  const text = [
    'I checked the parser and the reply guard. The input {"tool":"read_file","args":{"path":"a.txt"}} parses, so the guard leaves it alone.',
    'The remaining steps are the same as before: update the test, run the build, and report.',
    'No other change is needed.',
  ].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('a huge broken input is reported without throwing', () => {
  const huge = `{"tool":"read_file","args":{"path":"${'a'.repeat(200_000)}`
  assert.equal(looksLikeBrokenToolCall(huge), true)
  assert.equal(looksLikeBrokenToolCall('{"'.repeat(50_000)), false)
  assert.equal(looksLikeBrokenToolCall('x'.repeat(200_000)), false)
})
test('a broken call after prose that does not start with a brace is a broken tool call', () => {
  const text = ['Sure, calling now.', '{"tool":"shell","args":{"command":"ls"'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), true)
})

test('a calls array missing its closing bracket is a broken tool call', () => {
  assert.equal(looksLikeBrokenToolCall('{"calls":[{"tool":"read_file","args":{},'), true)
})

test('a leaked closing tag other than the template one is a broken tool call', () => {
  assert.equal(looksLikeBrokenToolCall('{"tool":"read_file","args":{"path":"a.txt"}}</tool_call>'), true)
})

test('a JSON fragment pasted after a paragraph is a broken tool call', () => {
  const text = [
    '両方のファイルを読みました。',
    '次に {"calls":[{"tool":"read_file","args":{"path":"b.txt"}},',
    'を実行します。',
  ].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), true)
})

test('a valid fenced JSON call with a language tag is not a broken tool call', () => {
  const text = ['The call shape is:', '```json', '{"tool":"read_file","args":{"path":"a.txt"}}', '```', 'That is all.'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('a TypeScript snippet with tool and calls identifiers is not a broken tool call', () => {
  const text = ['function tool(name: string): string {', '  calls.push(x)', '  return `tool ${name}`', '}'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('Japanese prose with no JSON is not a broken tool call', () => {
  const text = '両方のファイルを読みました。A と B が分かったので追加作業はありません。'
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('English prose with no JSON is not a broken tool call', () => {
  const text = 'I read both files and compared the two results. Nothing else is needed, so I am done.'
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('an empty reply and prose with set braces are not broken tool calls', () => {
  assert.equal(looksLikeBrokenToolCall(''), false)
  assert.equal(looksLikeBrokenToolCall('The set {a, b} is finite.'), false)
})

test('a long explanation that mentions tool names is not a broken tool call', () => {
  const text = [
    'I used the tool read_file twice and the tool shell once; both calls succeeded.',
    'A valid call is JSON, but this paragraph is ordinary prose with no object in it.',
    'The build and the tests pass, so the task is complete.',
  ].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('a leaked function closing tag beside JSON is a broken tool call', () => {
  assert.equal(looksLikeBrokenToolCall('{"tool":"read_file","args":{"path":"a.txt"}}</function>'), true)
})

test('a JSON fragment pasted after an English paragraph is a broken tool call', () => {
  const text = ['I will read the file now.', '{"calls":[{"tool":"read_file","args":{"path":"a.txt"}},'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), true)
})

test('a long prose answer is not a broken tool call', () => {
  const paragraph =
    'I read both files, compared the two results, ran the build, ran the tests, and checked the diff. '
  const text = Array.from({ length: 20 }, (_, i) => `${paragraph}Step ${i + 1} changed nothing.`).join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})

test('a fenced broken call is an example, not a call', () => {
  const text = ['The model tried this:', '```json', '{"calls":[{"tool":"read_file","args":{},', '```'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), false)
})