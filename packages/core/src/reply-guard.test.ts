import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasCallsAfterFirstObject, looksLikeBrokenToolCall, recoverTemplateCall, recoverUnwrappedBatch } from './reply-guard.js'

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
// A real reply (security-holdout re-check, hy-thorough #1): a complete batch
// missing its final brace, then the closing tags of the DSML tool template.
const DSML_REPLY = "{\"calls\":[{\"tool\":\"shell\",\"args\":{\"command\":\"python -c \\\"import json; d=json.load(open('_commit1.json',encoding='utf-8')); print(d['commit']['message']); print('---FILES---'); [print(f['filename'], f['status'], f['additions'], f['deletions']) for f in d['files']]\\\"\"}},{\"tool\":\"shell\",\"args\":{\"command\":\"python -c \\\"import json; d=json.load(open('_issue913.json',encoding='utf-8')); print(d.get('title')); print(d.get('body')); print(d.get('html_url'))\\\"\"}}]</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>"

test('a call batch cut short by leaked template tags is repaired', () => {
  const repaired = recoverTemplateCall(DSML_REPLY)
  assert.ok(repaired, 'recovered')
  const parsed = JSON.parse(repaired!) as { calls: Array<{ tool: string; args: { command: string } }> }
  assert.equal(parsed.calls.length, 2)
  assert.ok(parsed.calls.every((c) => c.tool === 'shell'))
  assert.match(parsed.calls[1]!.args.command, /_issue913.json/)
  assert.equal(recoverTemplateCall('{"tool":"shell","args":{"command":"ls"}</｜DSML｜ parameter>'), '{"tool":"shell","args":{"command":"ls"}}')
})

test('the repair refuses anything but a call followed by template tags', () => {
  // Prose, no tags, or text after the tags: not repaired.
  assert.equal(recoverTemplateCall('Done. The fix is in bottle.py.'), undefined)
  assert.equal(recoverTemplateCall('{"calls":[{"tool":"shell","args":{"command":"ls"}}]'), undefined)
  assert.equal(recoverTemplateCall('{"calls":[{"tool":"shell","args":{}}]</｜DSML｜ parameter> and then more text'), undefined)
  // Inside an unterminated string, or with mismatched brackets.
  assert.equal(recoverTemplateCall('{"tool":"shell","args":{"command":"ls</｜DSML｜ parameter>'), undefined)
  assert.equal(recoverTemplateCall('{"calls":[{"tool":"shell"]}</｜DSML｜ parameter>'), undefined)
  // JSON that names no tool.
  assert.equal(recoverTemplateCall('{"final":"ok"</｜DSML｜ parameter>'), undefined)
  assert.equal(recoverTemplateCall('{"calls":[{"args":{}}]</｜DSML｜ parameter>'), undefined)
})

test('a batch written without its {"calls":[ opener is restored with every call', () => {
  // The shape of the orchestrator reply whose four worker spawns were dropped.
  const reply = '{"tool":"update_plan","args":{"plan":[{"step":"a","status":"in_progress"}]}},{"tool":"orchestrator_spawn","args":{"title":"x","task":"t {1}","scope":["file:a.md"]}},{"tool":"orchestrator_spawn","args":{"title":"y","task":"t","scope":["b"]}}]}'
  const restored = recoverUnwrappedBatch(reply)
  assert.ok(restored)
  assert.deepEqual((JSON.parse(restored!) as { calls: Array<{ tool: string }> }).calls.map((c) => c.tool), ['update_plan', 'orchestrator_spawn', 'orchestrator_spawn'])
  // Not a batch: valid JSON, one call, prose, or anything else after the calls.
  assert.equal(recoverUnwrappedBatch('{"calls":[{"tool":"a","args":{}},{"tool":"b","args":{}}]}'), undefined)
  assert.equal(recoverUnwrappedBatch('{"tool":"a","args":{}}'), undefined)
  assert.equal(recoverUnwrappedBatch('{"tool":"a","args":{}},{"tool":"b","args":{}}]} and then some prose'), undefined)
  assert.equal(recoverUnwrappedBatch('{"tool":"a","args":{}},{"note":"not a call"}]}'), undefined)
})

test('a reply whose first object parses but more calls follow is never run in part', () => {
  const garbled = '{"tool":"read_file","args":{"path":"a"}},{"tool":"shell","args":{"command":"x"}'
  assert.equal(hasCallsAfterFirstObject(garbled), true)
  assert.equal(looksLikeBrokenToolCall(garbled), true)
  assert.equal(hasCallsAfterFirstObject('{"calls":[{"tool":"a","args":{}},{"tool":"b","args":{}}]}'), false, 'valid JSON')
  assert.equal(hasCallsAfterFirstObject('{"tool":"a","args":{}}]'), false, 'one call and a stray bracket: nothing is dropped')
  assert.equal(hasCallsAfterFirstObject('{"tool":"a","args":{}} done.'), false)
})
