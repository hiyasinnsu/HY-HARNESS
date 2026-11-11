import { test } from 'node:test'
import assert from 'node:assert/strict'
import { announcesNextStep, hasCallsAfterFirstObject, looksLikeBrokenToolCall, recoverMalformedCall, recoverTemplateCall, recoverUnwrappedBatch, recoverXmlToolCall } from './reply-guard.js'

test('a truncated tool call is a broken tool call', () => {
  assert.equal(looksLikeBrokenToolCall('{"tool":"read_file","args":{"path":"a.txt"'), true)
})

test('a leaked chat-template closing tag is a broken tool call', () => {
  assert.equal(looksLikeBrokenToolCall('{"tool":"shell","args":{"command":"ls"}}</｜parameter>'), true)
})

test('mixed DSML parameters recover their types; leaked tool or result markup requires a retry', () => {
  const typed = '{"tool":"read_file">\n<parameter name="path">test.md</｜DSML｜ parameter>\n<｜DSML｜ parameter name="startLine" string="false">12</｜DSML｜ parameter>\n</｜DSML｜ invoke>'
  assert.deepEqual(JSON.parse(recoverTemplateCall(typed)!), { tool: 'read_file', args: { path: 'test.md', startLine: 12 } })
  const nested = '{"tool":"search_grep">\n<｜DSML｜ parameter name="args" string="false">{"pattern":"test"}</｜DSML｜ parameter>\n</｜DSML｜ invoke>'
  assert.deepEqual(JSON.parse(recoverTemplateCall(nested)!), { tool: 'search_grep', args: { pattern: 'test' } })
  assert.equal(recoverTemplateCall(typed.replace('>12<', '>oops<')), undefined)
  assert.equal(looksLikeBrokenToolCall('<tool calls>\n<tool name="shell" args="{}"></tool>\n</tool>'), true)
  assert.equal(looksLikeBrokenToolCall('<system>Tool ran without output or errors</system>'), true)
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
  // A body made only of `{"` fragments is JSON that never finishes: it was
  // accepted before because nothing named a tool, but a cut-off reply is a
  // broken call now, and the check must stay linear on this input.
  assert.equal(looksLikeBrokenToolCall('{"'.repeat(50_000)), true)
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

test('XML-only tool calls are restored to the JSON protocol (G-15)', () => {
  // Hermes/Qwen: a JSON call wrapped in <tool_call>…</tool_call>.
  assert.deepEqual(
    JSON.parse(recoverXmlToolCall('<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts", "startLine": 3}}\n</tool_call>')!),
    { tool: 'read_file', args: { path: 'a.ts', startLine: 3 } },
  )
  // <function=NAME> and <invoke name="NAME"> with <parameter> tags.
  assert.deepEqual(
    JSON.parse(
      recoverXmlToolCall(
        '<function=edit_file><parameter name="file">a.ts</parameter><parameter name="old">const a = 1</parameter><parameter name="new">const a = 2</parameter></function>',
      )!,
    ),
    { tool: 'edit_file', args: { file: 'a.ts', old: 'const a = 1', new: 'const a = 2' } },
  )
  // string="false" is a typed value, so numbers and booleans arrive as JSON.
  assert.deepEqual(
    JSON.parse(
      recoverXmlToolCall(
        '<invoke name="search_grep"><parameter name="pattern">TODO</parameter><parameter name="ignoreCase" string="false">true</parameter></invoke>',
      )!,
    ),
    { tool: 'search_grep', args: { pattern: 'TODO', ignoreCase: true } },
  )
  // Template decorations and a wrapper around the call block are read too.
  assert.deepEqual(
    JSON.parse(
      recoverXmlToolCall(
        '<tool_call>\n<｜DSML｜ invoke name="shell">\n<｜DSML｜ parameter name="command">Get-ChildItem</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</tool_call>',
      )!,
    ),
    { tool: 'shell', args: { command: 'Get-ChildItem' } },
  )
  // A bare element named after a known tool, with argument tags only.
  assert.deepEqual(
    JSON.parse(recoverXmlToolCall('<search_grep><pattern>TODO</pattern><glob>**/*.ts</glob></search_grep>')!),
    { tool: 'search_grep', args: { pattern: 'TODO', glob: '**/*.ts' } },
  )
  // Anything ambiguous is refused instead of guessed.
  assert.equal(recoverXmlToolCall('<invoke name="shell"><parameter name="ms" string="false">oops</parameter></invoke>'), undefined)
  assert.equal(recoverXmlToolCall('<function=current_time></function>'), undefined)
  assert.equal(recoverXmlToolCall('<read_file><path>a</path><path>b</path></read_file>'), undefined)
  assert.equal(recoverXmlToolCall('<config><path>a.md</path></config>'), undefined)
  assert.equal(
    recoverXmlToolCall('Sure, here it is:\n<function=shell><parameter name="command">ls</parameter></function>'),
    undefined,
    'prose around the element is not an unambiguous call',
  )
  assert.equal(recoverXmlToolCall('{"tool":"shell","args":{"command":"ls"}}'), undefined, 'JSON keeps its own path')
  // recoverTemplateCall tries the XML parser first, then falls back as before.
  assert.deepEqual(
    JSON.parse(recoverTemplateCall('<function=shell><parameter name="command">git status</parameter></function>')!),
    { tool: 'shell', args: { command: 'git status' } },
  )
  assert.equal(recoverTemplateCall('Not a call: <b>bold</b>'), undefined)
  // A standalone XML call counts as a broken call, so the recovered JSON runs
  // instead of the text being shown as the final answer.
  assert.equal(looksLikeBrokenToolCall('<function=shell><parameter name="command">ls</parameter></function>'), true)
  assert.equal(looksLikeBrokenToolCall('<b>a normal answer</b>'), false)
})

test('a final answer that announces its own next step is caught; handing back is not', () => {
  // Real endings of turns that stopped without doing the announced work.
  for (const ending of [
    'ここを確認します。',
    'release フォルダ内のファイル一覧とハッシュを取得します。',
    '正しい形式で送り直します。',
    'これから、壊れた呼び出し風の応答を検出して1回だけ再試行する防御を追加します。',
    '確認を実行しています。',
    '`app.ts` の名前変更関連を確認する。',
    '指定が無ければ 1 で進める。',
    '同じワーカーに積む。',
    "I'll add the regression test now.",
    'Let me check the logs.',
  ]) assert.equal(announcesNextStep(`作業の要約。\n\n${ending}`), true, ending)
  // Real endings that hand the turn back correctly.
  for (const ending of [
    '終わり次第、差分を確認して報告します。',
    '両方の報告がそろったら差分を確認して最終報告します。',
    '必要なら、今回の変更内容を project.md に追記するところまで行います。',
    '直してよければ対応します。',
    '直すかは指示があれば対応する。',
    'core のビルドが通ったら再起動して適用する。',
    '`main.ts` の `serverInfo` は、混入修正ワーカーが終わってから回す。',
    '追加作業は不要と判断する。',
    'どちらを先に進めますか？',
    'これで `formatTable(...)` は期待どおりの文字列を返します。',
    '完了（app.ts 1ファイル、型検査 pass）。',
    'If you want, I can also add a test.',
    'All tests pass and the change is committed.',
  ]) assert.equal(announcesNextStep(`作業の要約。\n\n${ending}`), false, ending)
})

test('recoverTemplateCall handles colon-suffixed tags, raw newlines in strings, and XML parameter blocks', () => {
  // Colon-suffixed template closing tags (session log lines 8682, 9005).
  const colonTail =
    '{"calls":[{"tool":"orchestrator_close","args":{"workerId":"run-1","summary":"ok"}}</arg_value:6124c78e></tool_call:6124c78e></tool_calls:6124c78e>'
  assert.equal(looksLikeBrokenToolCall(colonTail), true)
  const repairedColon = recoverTemplateCall(colonTail)
  assert.ok(repairedColon)
  assert.deepEqual(JSON.parse(repairedColon!), {
    calls: [{ tool: 'orchestrator_close', args: { workerId: 'run-1', summary: 'ok' } }],
  })

  // Raw newlines inside string literal before DSML closing tags (session log line 6116).
  const rawNewlines =
    '{"tool":"write_file","file":"a.py","content":"line1\nline2\n"}</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>'
  const repairedNewlines = recoverTemplateCall(rawNewlines)
  assert.ok(repairedNewlines)
  assert.deepEqual(JSON.parse(repairedNewlines!), {
    tool: 'write_file',
    file: 'a.py',
    content: 'line1\nline2\n',
  })

  // Hybrid JSON/XML <parameter> call (session log lines 6988-7059).
  const xmlCall = [
    '{"tool":"edit_file">',
    '<parameter name="file">tools/chat_ui/static/index.html</parameter>',
    '<parameter name="old">const a = 1;</parameter>',
    '<parameter name="new">const a = 2;</parameter>',
    '</invoke>',
  ].join('\n')
  assert.equal(looksLikeBrokenToolCall(xmlCall), true)
  const repairedXml = recoverTemplateCall(xmlCall)
  assert.ok(repairedXml)
  assert.deepEqual(JSON.parse(repairedXml!), {
    tool: 'edit_file',
    args: {
      file: 'tools/chat_ui/static/index.html',
      old: 'const a = 1;',
      new: 'const a = 2;',
    },
  })
})

test('recoverMalformedCall repairs missing call-entry braces, stray parens, and raw newlines in calls', () => {
  // Missing `}` on first call entry before `,{"tool":` (session log lines 482, 5507, 5853, 5863).
  const missingFirstBrace =
    '{"calls":[{"tool":"shell","args":{"command":"git status"},{"tool":"read_file","args":{"path":"project.md","startLine":1,"endLine":10}}]}'
  const r1 = recoverMalformedCall(missingFirstBrace)
  assert.ok(r1)
  assert.deepEqual((JSON.parse(r1!) as { calls: Array<{ tool: string }> }).calls.map((c) => c.tool), ['shell', 'read_file'])

  // Missing `}` on last call entry before `]}` (session log line 1047).
  const missingLastBrace =
    '{"calls":[{"tool":"read_file","args":{"path":"a.py"}},{"tool":"shell","args":{"command":"pytest","foregroundWaitMs":60000}]}'
  const r2 = recoverMalformedCall(missingLastBrace)
  assert.ok(r2)
  assert.deepEqual((JSON.parse(r2!) as { calls: Array<{ tool: string }> }).calls.map((c) => c.tool), ['read_file', 'shell'])

  // Missing final `}` or `]}` on `{"calls":[...]}` (session log lines 6757, 8646).
  assert.ok(recoverMalformedCall('{"calls":[{"tool":"search_grep","args":{"pattern":"x"}}]'))
  assert.ok(recoverMalformedCall('{"calls":[{"tool":"read_file","args":{"path":"a"}},{"tool":"read_file","args":{"path":"b"}}'))

  // Stray `)` between closing braces (session log line 5895).
  const strayParen = '{"tool":"write_file","args":{"content":"hello","file":"a.txt"})}'
  assert.equal(recoverMalformedCall(strayParen), '{"tool":"write_file","args":{"content":"hello","file":"a.txt"}}')

  // Raw newline in string + stray `]}` after single tool call (session log line 3674).
  const singleWithNewline = '{"tool":"shell","args":{"command":"echo a\necho b","foregroundWaitMs":60000}}]}'
  assert.equal(
    recoverMalformedCall(singleWithNewline),
    '{"tool":"shell","args":{"command":"echo a\\necho b","foregroundWaitMs":60000}}',
  )

  // Must NOT repair truncated calls or unwrapped partial batches.
  assert.equal(recoverMalformedCall('{"calls":[{"tool":"read_file","args":{},'), undefined)
  assert.equal(recoverMalformedCall('{"tool":"read_file","args":{"path":"a.txt"}},{"tool":"read_file","args":{"path":"b.txt"}'), undefined)
})

test('recoverTemplateCall, recoverMalformedCall, and recoverUnwrappedBatch cover 09:47-16:45 session log patterns G-K', () => {
  // Pattern G: single call with trailing `]` or `]}` before template tags (L12017, L12819).
  const trailingBracket =
    '{"tool":"edit_file","file":"scratch/4_diagnosis.md","old":"a","new":"b"}]</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>'
  assert.equal(recoverTemplateCall(trailingBracket), '{"tool":"edit_file","file":"scratch/4_diagnosis.md","old":"a","new":"b"}')

  const trailingBracketBrace =
    '{"tool": "read_file", "arguments": {"path": "scratch/4_experiment_plan.md", "startLine": 70, "endLine": 273}}]}</arg_value:6124c78e></tool_calls:6124c78e>'
  assert.equal(
    recoverTemplateCall(trailingBracketBrace),
    '{"tool": "read_file", "arguments": {"path": "scratch/4_experiment_plan.md", "startLine": 70, "endLine": 273}}',
  )

  // Pattern H: direct XML parameter tags `<new_string>`, `<old_string>`, `<path>` (L11027).
  const directXml = [
    '{"tool":"edit_file">',
    '<new_string>{"step": 10, "action": "sync"}</new_string>',
    '<old_string>{"step": 10, "action": "old"}</old_string>',
    '<path>benchmarks/model_criteria_matrix.json</path>',
    '</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
  ].join('\n')
  assert.deepEqual(JSON.parse(recoverTemplateCall(directXml)!), {
    tool: 'edit_file',
    args: {
      new_string: '{"step": 10, "action": "sync"}',
      old_string: '{"step": 10, "action": "old"}',
      path: 'benchmarks/model_criteria_matrix.json',
    },
  })

  // Pattern I: `"tool":"name":{...}` colon join + missing entry braces in `{"calls":[...]}` (L10210, L10853).
  const colonJoinBatch =
    '{"calls":[{"tool":"read_file","args":{"path":"HANDOVER.md","startLine":2,"endLine":4}},{"tool":"search_grep":{"pattern":"a","glob":"HANDOVER.md"},{"tool":"search_grep":{"pattern":"b","glob":"NEXT_CHAT_PROMPT.md"}]}'
  const repairedColonJoin = recoverMalformedCall(colonJoinBatch)
  assert.ok(repairedColonJoin)
  assert.deepEqual(JSON.parse(repairedColonJoin!), {
    calls: [
      { tool: 'read_file', args: { path: 'HANDOVER.md', startLine: 2, endLine: 4 } },
      { tool: 'search_grep', args: { pattern: 'a', glob: 'HANDOVER.md' } },
      { tool: 'search_grep', args: { pattern: 'b', glob: 'NEXT_CHAT_PROMPT.md' } },
    ],
  })

  // Pattern J: unwrapped batch followed by DSML closing tags (L12344).
  const unwrappedWithDsml =
    '{"tool":"read_file","args":{"path":"project.md","startLine":1,"endLine":10}},{"tool":"search_grep","args":{"pattern":"x","glob":"project.md"}}]}</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>'
  assert.equal(recoverTemplateCall(unwrappedWithDsml), undefined)
  const repairedBatch = recoverUnwrappedBatch(unwrappedWithDsml)
  assert.ok(repairedBatch)
  assert.deepEqual((JSON.parse(repairedBatch!) as { calls: Array<{ tool: string }> }).calls.map((c) => c.tool), ['read_file', 'search_grep'])

  // Pattern K: `<tool_call>\n{"name": "write_file", "arguments": {...}}\n</tool_call>` (L12027).
  const hermesCall =
    '<tool_call>\n{"name": "write_file", "arguments": {"file": "scratch/9_diagnosis.md", "content": "# Title\\nBody"}}\n</tool_call>'
  assert.equal(looksLikeBrokenToolCall(hermesCall), true)
  const repairedHermes = recoverTemplateCall(hermesCall)
  assert.ok(repairedHermes)
  assert.deepEqual(JSON.parse(repairedHermes!), {
    tool: 'write_file',
    args: { file: 'scratch/9_diagnosis.md', content: '# Title\nBody' },
  })
})

// A reply cut off mid-JSON is a tool call, not an answer (the provider's output
// limit or a dropped stream). The old check only looked for a tool key, so a
// truncated body without one ({"content":"abc…) was stored as the final answer
// and the turn stopped mid-task.
test('a JSON body cut short anywhere is a broken tool call, not an answer', () => {
  // (a) cut inside a string value.
  assert.equal(looksLikeBrokenToolCall('{"tool":"shell","args":{"command":"Get-Ch'), true)
  // (b) only the keys arrived.
  assert.equal(looksLikeBrokenToolCall('{"calls":[{"tool":"read_file","args":'), true)
  // (c) no tool key at all, but no JSON either.
  assert.equal(looksLikeBrokenToolCall('{"content":"abc…'), true)
  // A closed object with an ellipsis tail was cut off after it closed.
  assert.equal(looksLikeBrokenToolCall('{"tool":"shell","args":{"command":"ls"}}…'), true)
  // A whole JSON value is an answer, and so is prose that mentions one.
  assert.equal(looksLikeBrokenToolCall('{"final":"done"}'), false)
  assert.equal(looksLikeBrokenToolCall('The fix is in src/a.ts: guard {the parser} before the call.'), false)
  assert.equal(looksLikeBrokenToolCall('I checked the shape {"tool":"read_file","args":{"path":"a"}} in the docs.'), false)
})

test('a tool call cut off inside an unclosed code fence is a broken tool call', () => {
  // The fence never closes, so the reply stopped inside a code block: its
  // content is still judged (stripFences used to drop it to the end).
  const text = ['ファイルを読みます。', '```json', '{"tool":"read_file","args":{"path":"a.txt"'].join('\n')
  assert.equal(looksLikeBrokenToolCall(text), true)
  // An unclosed fence that holds an answer stays an answer, and a closed fence
  // is still an example.
  assert.equal(looksLikeBrokenToolCall(['Here is the plan:', '```', 'read the file, then run the tests'].join('\n')), false)
  assert.equal(
    looksLikeBrokenToolCall(['The model tried this:', '```json', '{"tool":"read_file","args":{"path":"a.txt"', '```'].join('\n')),
    false,
  )
})

test('several XML tool calls in one reply are restored as a call batch', () => {
  // Parallel <function=…> elements at the top level (a second element used to
  // make the whole reply unusable, so every call was lost to a retry).
  const functions = [
    '<function=shell><parameter name="command">ls</parameter></function>',
    '<function=read_file><parameter name="path">a.ts</parameter></function>',
  ].join('\n')
  assert.deepEqual(JSON.parse(recoverXmlToolCall(functions)!), {
    calls: [
      { tool: 'shell', args: { command: 'ls' } },
      { tool: 'read_file', args: { path: 'a.ts' } },
    ],
  })
  // Several calls inside one wrapper.
  const wrapped =
    '<tool_calls><invoke name="read_file"><parameter name="path">a</parameter></invoke>' +
    '<invoke name="read_file"><parameter name="path">b</parameter></invoke></tool_calls>'
  assert.deepEqual(JSON.parse(recoverXmlToolCall(wrapped)!), {
    calls: [
      { tool: 'read_file', args: { path: 'a' } },
      { tool: 'read_file', args: { path: 'b' } },
    ],
  })
  // Prose around them, or one unusable element, still refuses the lot instead
  // of running some of the calls.
  assert.equal(recoverXmlToolCall(`Sure:\n${functions}`), undefined)
  assert.equal(recoverXmlToolCall(`${functions}\n<function=current_time></function>`), undefined)
  // recoverTemplateCall goes through the same parser, and the detector counts a
  // multi-call XML reply as a call rather than an answer.
  assert.deepEqual(JSON.parse(recoverTemplateCall(functions)!), JSON.parse(recoverXmlToolCall(functions)!))
  assert.equal(looksLikeBrokenToolCall(functions), true)
})

test('XML arguments that are JSON literals are typed even without string="false"', () => {
  // A template that omits the marker still gets a real boolean and number, so
  // `args.ignoreCase === true` holds instead of silently staying false.
  const typed =
    '<invoke name="search_grep"><parameter name="pattern">TODO</parameter>' +
    '<parameter name="ignoreCase">true</parameter><parameter name="maxResults">50</parameter></invoke>'
  assert.deepEqual(JSON.parse(recoverXmlToolCall(typed)!), {
    tool: 'search_grep',
    args: { pattern: 'TODO', ignoreCase: true, maxResults: 50 },
  })
  // Objects and arrays too.
  assert.deepEqual(
    JSON.parse(
      recoverXmlToolCall(
        '<tool_call><function=todo_write><parameter name="plan">[{"step":"a","status":"in_progress"}]</parameter></function></tool_call>',
      )!,
    ),
    { tool: 'todo_write', args: { plan: [{ step: 'a', status: 'in_progress' }] } },
  )
  // Ambiguous text stays text: a brace block that is not JSON (a shell command)
  // and a leading zero that is not a JSON number.
  assert.deepEqual(
    JSON.parse(
      recoverXmlToolCall(
        '<invoke name="shell"><parameter name="command">{ echo hi; }</parameter><parameter name="timeoutMs">0500</parameter></invoke>',
      )!,
    ),
    { tool: 'shell', args: { command: '{ echo hi; }', timeoutMs: '0500' } },
  )
  // string="true" keeps the text as written even when it looks like a number.
  assert.deepEqual(
    JSON.parse(
      recoverXmlToolCall('<invoke name="read_file"><parameter name="path">a.txt</parameter><parameter name="startLine" string="true">12</parameter></invoke>')!,
    ),
    { tool: 'read_file', args: { path: 'a.txt', startLine: '12' } },
  )
  // string="false" with a value that is not JSON is still refused.
  assert.equal(recoverXmlToolCall('<invoke name="shell"><parameter name="ms" string="false">oops</parameter></invoke>'), undefined)
})

test('announcesNextStep: the same signal in several languages; hand-backs are not announcements', async () => {
  const { announcesNextStep } = await import('./reply-guard.js')
  for (const announce of [
    "I'll run the tests now.",
    '接下来我将运行测试。',
    '다음으로 테스트를 실행하겠습니다.',
    'Ahora voy a ejecutar las pruebas.',
    'Je vais maintenant lancer les tests.',
    'Ich werde jetzt die Tests ausführen.',
    '次にテストを確認します。',
  ]) assert.equal(announcesNextStep(announce), true, announce)
  for (const handBack of [
    'Let me know.',
    'Let me know if you want changes.',
    '如果需要，我会继续优化。',
    'Si lo necesitas, voy a añadir más pruebas.',
    'テストを追加しました。',
    'Done: all 12 tests pass.',
  ]) assert.equal(announcesNextStep(handBack), false, handBack)
})

test('a bare XML call of a session-offered (plugin / MCP) tool is recovered once its name is known', async () => {
  const { recoverXmlToolCall, rememberToolNames } = await import('./reply-guard.js')
  const text = '<mcp_browser_open><url>https://example.test</url></mcp_browser_open>'
  assert.equal(recoverXmlToolCall(text), undefined, 'an unknown bare tag is not a call')
  rememberToolNames(['mcp_browser_open'])
  assert.deepEqual(JSON.parse(recoverXmlToolCall(text)!), { tool: 'mcp_browser_open', args: { url: 'https://example.test' } })
})
