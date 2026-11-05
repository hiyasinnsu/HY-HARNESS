import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanThinkingSummary, instantThinkingSummary } from './summary-text.js'

test('cleanThinkingSummary unwraps JSON and labels from small models', () => {
  assert.equal(cleanThinkingSummary('{"思考":"要約: 認証方式を確認します。"}'), '認証方式を確認します。')
  assert.equal(cleanThinkingSummary('{"summary":"テストを追加する方針です。"}'), 'テストを追加する方針です。')
  assert.equal(cleanThinkingSummary('```json\n{"要約":"構成を確認します。"}\n```'), '構成を確認します。')
  assert.equal(cleanThinkingSummary('要約: 構成を確認します。'), '構成を確認します。')
  assert.equal(cleanThinkingSummary('  構成を確認します。  '), '構成を確認します。')
})

test('cleanThinkingSummary drops hollow JSON instead of showing it as a summary', () => {
  assert.equal(cleanThinkingSummary('{"get source line count":"","check git state":""}'), '')
  assert.equal(cleanThinkingSummary('{"思考":""}'), '')
})

test('cleanThinkingSummary keeps plain Japanese and caps runaway output', () => {
  assert.equal(cleanThinkingSummary('プロジェクト構成を確認し、要約します。'), 'プロジェクト構成を確認し、要約します。')
  assert.equal(cleanThinkingSummary('あ'.repeat(600)).length, 501)
})

test('instantThinkingSummary uses the first Japanese plan immediately', () => {
  assert.equal(
    instantThinkingSummary('ユーザーは構成を知りたい。まずREADMEとpackage.jsonを確認する。次に全体をまとめる。'),
    'ユーザーは構成を知りたい。まずREADMEとpackage.jsonを確認する。',
  )
  assert.equal(instantThinkingSummary('要約: 主要なファイルを確認する。\nあとで読む。'), '主要なファイルを確認する。')
  assert.equal(instantThinkingSummary('{"summary":"認証方式を確認する。"}'), '認証方式を確認する。')
})

test('instantThinkingSummary stays empty for English-only or hollow traces', () => {
  assert.equal(instantThinkingSummary('Let me inspect the files first.'), '')
  assert.equal(instantThinkingSummary('{"get source line count":"","check git state":""}'), '')
})
