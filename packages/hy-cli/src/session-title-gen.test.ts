import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type LlmProvider } from '../../core/dist/index.js'
import {
  MAX_GENERATED_TITLE_BYTES,
  MAX_GENERATED_TITLE_CHARS,
  buildTitleMessages,
  cleanGeneratedTitle,
  titleFromFirstMessage,
} from './session-title.js'
import { generateSessionTitle, titleRequestText } from './session-title-gen.js'

function config(): { config: ReturnType<typeof loadConfig>; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-title-'))
  return {
    config: loadConfig({ cwd: dir, stateDir: path.join(dir, '.state'), mock: true }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

function fakeProvider(content: string | (() => Promise<never>)): LlmProvider {
  return {
    name: 'fake',
    complete: async () => {
      if (typeof content === 'function') return content()
      return { content, usage: { inputTokens: 1, outputTokens: 1 } }
    },
  } as unknown as LlmProvider
}

test('a generated title loses the wrappers models add', () => {
  assert.equal(cleanGeneratedTitle('"Fix the login bug"'), 'Fix the login bug')
  assert.equal(cleanGeneratedTitle('`Fix the login bug`'), 'Fix the login bug')
  assert.equal(cleanGeneratedTitle("'Fix the login bug.'"), 'Fix the login bug')
  assert.equal(cleanGeneratedTitle('Title: Fix the login bug'), 'Fix the login bug')
  assert.equal(cleanGeneratedTitle('タイトル：ログイン不具合の修正。'), 'ログイン不具合の修正')
  assert.equal(cleanGeneratedTitle('```\nFix the build\n```'), 'Fix the build')
  assert.equal(cleanGeneratedTitle('- Fix the build'), 'Fix the build')
  assert.equal(cleanGeneratedTitle('「認証の修正」'), '認証の修正')
  // Only the first line survives.
  assert.equal(cleanGeneratedTitle('Fix the build\n\nExplanation: because'), 'Fix the build')
  assert.equal(cleanGeneratedTitle('   '), '')
  assert.equal(cleanGeneratedTitle(null), '')
  assert.equal(cleanGeneratedTitle(42), '')
})

test('a generated title respects the character and byte caps', () => {
  const long = 'word '.repeat(40)
  const title = cleanGeneratedTitle(long)
  assert.ok([...title].length <= MAX_GENERATED_TITLE_CHARS, title)
  assert.ok(Buffer.byteLength(title, 'utf8') <= MAX_GENERATED_TITLE_BYTES)
  // CJK is cut by bytes: three bytes per character means 40 characters is the most.
  const cjk = cleanGeneratedTitle('認証'.repeat(60))
  assert.ok(Buffer.byteLength(cjk, 'utf8') <= MAX_GENERATED_TITLE_BYTES, `${cjk} ${Buffer.byteLength(cjk, 'utf8')}`)
  assert.ok([...cjk].length <= MAX_GENERATED_TITLE_CHARS)
})

test('the offline fallback is the first sentence of the request', () => {
  assert.equal(titleFromFirstMessage('Fix the flaky login test. Then run the suite.'), 'Fix the flaky login test')
  assert.equal(titleFromFirstMessage('[plan mode: read-only] Add a retry to the uploader'), 'Add a retry to the uploader')
  assert.equal(titleFromFirstMessage('ログインが失敗する。原因を調べて直して。'), 'ログインが失敗する')
  assert.equal(titleFromFirstMessage('   \n  '), 'New chat')
  assert.equal(titleFromFirstMessage('', '無題'), '無題')
  assert.ok([...titleFromFirstMessage('a'.repeat(300))].length <= MAX_GENERATED_TITLE_CHARS)
})

test('the request keeps the opening and the latest messages only', () => {
  const many = Array.from({ length: 20 }, (_, index) => `message ${index + 1}`)
  const text = titleRequestText({ first: 'message 1', userMessages: many })
  assert.match(text, /message 1/)
  assert.match(text, /message 20/)
  assert.ok(text.length <= 4_000)
  assert.equal(titleRequestText({ first: 'only one' }), 'only one')
  assert.equal(
    titleRequestText({ first: 'x', userMessages: ['same', 'same', 'same'] }),
    '#1\nsame',
    'duplicates collapse',
  )
})

test('the model title wins and its language is not translated', async () => {
  const { config: cfg, cleanup } = config()
  try {
    const english = await generateSessionTitle(
      cfg,
      { first: 'fix the login bug' },
      { provider: fakeProvider('"Fix the login bug"') },
    )
    assert.deepEqual(english, { title: 'Fix the login bug', source: 'llm' })
    const japanese = await generateSessionTitle(
      cfg,
      { first: 'ログイン不具合を直して' },
      { provider: fakeProvider('ログイン不具合の修正') },
    )
    assert.equal(japanese.title, 'ログイン不具合の修正')
    assert.equal(japanese.source, 'llm')
  } finally {
    cleanup()
  }
})

test('a failing, empty or slow provider falls back without throwing', async () => {
  const { config: cfg, cleanup } = config()
  try {
    const failed = await generateSessionTitle(
      cfg,
      { first: 'Fix the build. It is broken.' },
      {
        provider: fakeProvider(async () => {
          throw new Error('provider 502')
        }),
      },
    )
    assert.equal(failed.source, 'heuristic')
    assert.equal(failed.title, 'Fix the build')
    assert.match(failed.reason ?? '', /502/)

    const empty = await generateSessionTitle(cfg, { first: 'Fix the build' }, { provider: fakeProvider('   ') })
    assert.equal(empty.source, 'heuristic')
    assert.match(empty.reason ?? '', /no usable title/)

    const slow = await generateSessionTitle(
      cfg,
      { first: 'Fix the build' },
      {
        provider: fakeProvider(() => new Promise<string>(() => {}) as never),
        timeoutMs: 30,
      },
    )
    assert.equal(slow.source, 'heuristic')
    assert.equal(slow.title, 'Fix the build')
  } finally {
    cleanup()
  }
})

test('a mock config never calls the provider and an empty request needs none', async () => {
  const { config: cfg, cleanup } = config()
  try {
    let called = false
    const spy: LlmProvider = {
      name: 'spy',
      complete: async () => {
        called = true
        return { content: 'x', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    } as unknown as LlmProvider
    // Injected providers bypass the mock short-circuit (that is how tests drive
    // the model path); without one the mock config uses the heuristic.
    const mock = await generateSessionTitle(cfg, { first: 'hello there' })
    assert.equal(mock.source, 'heuristic')
    assert.equal(mock.reason, 'mock provider')
    assert.equal(called, false)
    void spy
    const empty = await generateSessionTitle(cfg, { first: '   ' }, { provider: fakeProvider('never') })
    assert.equal(empty.source, 'heuristic')
    assert.equal(empty.reason, 'empty request')
  } finally {
    cleanup()
  }
})

test('the prompt tells the model the language and the shape', () => {
  const messages = buildTitleMessages({ request: 'ログイン不具合を直して' })
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, 'system')
  assert.match(messages[0]?.content ?? '', /same language as the user/i)
  assert.match(messages[0]?.content ?? '', /title only/i)
  assert.equal(messages[1]?.content, 'ログイン不具合を直して')
})
