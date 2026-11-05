import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COEFFICIENTS, calibratedCoefficients, estimateTokens } from './tokens.js'

test('CP-23: the estimate scales with ASCII and non-ASCII characters', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), Math.ceil(4 * DEFAULT_COEFFICIENTS.ascii))
  assert.equal(
    estimateTokens('あい'),
    Math.ceil(2 * DEFAULT_COEFFICIENTS.nonAscii),
    'non-ASCII characters use their own coefficient',
  )
})

test('CP-23: calibration scales by actual/estimated and clamps outliers', () => {
  // Without usable samples the base coefficients come back unchanged.
  assert.deepEqual(calibratedCoefficients([]), DEFAULT_COEFFICIENTS)
  assert.deepEqual(calibratedCoefficients([{ estimated: 0, actual: 10 }]), DEFAULT_COEFFICIENTS)
  assert.deepEqual(calibratedCoefficients([{ estimated: 100, actual: Number.NaN }]), DEFAULT_COEFFICIENTS)

  const underpredict = calibratedCoefficients([{ estimated: 100, actual: 150 }])
  assert.equal(Math.round(underpredict.ascii * 1000) / 1000, Math.round(DEFAULT_COEFFICIENTS.ascii * 1.5 * 1000) / 1000)

  // More samples weigh more; the clamp keeps one bad request bounded.
  const mixed = calibratedCoefficients([
    { estimated: 1_000, actual: 1_000 },
    { estimated: 10, actual: 10_000 },
  ])
  assert.ok(mixed.ascii <= DEFAULT_COEFFICIENTS.ascii * 2 + 1e-9, 'clamped to 2x')
  const overpredict = calibratedCoefficients([{ estimated: 10_000, actual: 1 }])
  assert.ok(overpredict.ascii >= DEFAULT_COEFFICIENTS.ascii * 0.5 - 1e-9, 'clamped to 0.5x')
})
