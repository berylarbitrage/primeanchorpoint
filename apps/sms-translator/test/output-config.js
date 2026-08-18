/*
 * Tests for how requests are shaped per model.
 *
 * `effort` keeps the cheap calls cheap, but Haiku 4.5 and Sonnet 4.5 reject it
 * outright — a 400 the user saw as a raw API blob in the composer when the
 * fast-model default moved to Haiku. The parameter has to be omitted for those
 * models, not sent and hoped for.
 *
 * Run with: npm test
 */
const path = require('node:path')
const claude = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'translate', 'claude.js'),
)

let failures = 0
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`ok   ${label}`)
    return
  }
  failures++
  console.log(
    `FAIL ${label}\n  got:      ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
  )
}

const { supportsEffort, outputConfig } = claude.__testing

check('opus takes effort', supportsEffort('claude-opus-5'), true)
check('sonnet 5 takes effort', supportsEffort('claude-sonnet-5'), true)
check('haiku 4.5 does not', supportsEffort('claude-haiku-4-5'), false)
check('nor the dated haiku id', supportsEffort('claude-haiku-4-5-20251001'), false)
check('nor sonnet 4.5', supportsEffort('claude-sonnet-4-5'), false)

const schema = { type: 'object' }
check(
  'a model that takes effort gets both',
  outputConfig('claude-opus-5', schema),
  { effort: 'low', format: { type: 'json_schema', schema } },
)
check(
  'a model that does not gets only the schema',
  outputConfig('claude-haiku-4-5', schema),
  { format: { type: 'json_schema', schema } },
)
check(
  'the schema is never dropped',
  'format' in outputConfig('claude-haiku-4-5', schema),
  true,
)

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
