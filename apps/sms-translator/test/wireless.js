/*
 * Tests for wireless-debugging output parsing.
 *
 * The important trap: `adb connect` exits 0 even when the connection failed.
 * Trusting the exit code would report a phantom connection and then fail
 * confusingly later, so success/failure must come from the text.
 *
 * Run with: npm test
 */
const path = require('node:path')
const { parseConnectOutput, parsePairOutput, normaliseAddress } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'adb', 'wireless.js'),
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

// --- address normalisation ---
check('accepts host:port', normaliseAddress(' 192.168.1.5:41234 '), '192.168.1.5:41234')
check('accepts a hostname', normaliseAddress('pixel.local:5555'), 'pixel.local:5555')
check('accepts a bracketed IPv6 literal', normaliseAddress('[fe80::1]:5555'), '[fe80::1]:5555')
check('strips a pasted "adb connect" prefix', normaliseAddress('adb connect 10.0.0.2:5555'), '10.0.0.2:5555')
check('rejects a missing port', normaliseAddress('192.168.1.5'), null)
check('rejects a non-numeric port', normaliseAddress('192.168.1.5:abcd'), null)
check('rejects an out-of-range port', normaliseAddress('192.168.1.5:70000'), null)
check('rejects empty input', normaliseAddress('   '), null)

// --- connect output ---
check(
  'a successful connect is recognised',
  parseConnectOutput('connected to 192.168.1.5:41234').ok,
  true,
)
check(
  'the connected address is extracted',
  parseConnectOutput('connected to 192.168.1.5:41234').address,
  '192.168.1.5:41234',
)
check(
  'an already-connected device counts as connected',
  parseConnectOutput('already connected to 192.168.1.5:41234').ok,
  true,
)
check(
  'a failed connect is NOT reported as success',
  parseConnectOutput('failed to connect to 192.168.1.5:41234').ok,
  false,
)
check(
  'a refused connect is NOT reported as success',
  parseConnectOutput(
    'cannot connect to 192.168.1.5:5555: No connection could be made because the target machine actively refused it. (10061)',
  ).ok,
  false,
)
check('empty output is a failure, not a success', parseConnectOutput('').ok, false)

// --- pair output ---
check(
  'a successful pair is recognised',
  parsePairOutput('Successfully paired to 192.168.1.5:37419 [guid=adb-ABC123]').ok,
  true,
)
check(
  'a protocol fault is a failure',
  parsePairOutput('Failed: protocol fault (no status)').ok,
  false,
)
check(
  'the pairing failure explains the port confusion',
  /端口和主界面的不一样/.test(parsePairOutput('Failed to pair to 192.168.1.5:37419').message),
  true,
)


// --- mDNS discovery: the phone advertises the connect address itself ---
const { parseMdnsServices, pickConnectAddress, sameSubnet } = require(
  require('node:path').join(__dirname, '..', 'dist-electron', 'electron', 'adb', 'wireless.js'),
)

const MDNS = [
  'List of discovered mdns services',
  'adb-R5CX90ABCDE-Ab3xYz\t_adb-tls-connect._tcp\t192.168.1.42:41235',
  'adb-R5CX90ABCDE-Ab3xYz\t_adb-tls-pairing._tcp\t192.168.1.42:37419',
  'adb-OTHERPHONE-Zz9\t_adb-tls-connect._tcp\t10.0.0.9:44100',
].join('\n')

const services = parseMdnsServices(MDNS)
check('the header line is not a service', services.length, 3)
check('pairing and connect are told apart', services.map((s) => s.type), ['connect', 'pairing', 'connect'])
check(
  'the connect address is the one to use',
  pickConnectAddress(services, '192.168.1.7:5555'),
  '192.168.1.42:41235',
)
check(
  'a phone on another subnet is not preferred',
  pickConnectAddress(services, '10.0.0.5:5555'),
  '10.0.0.9:44100',
)
check('nothing advertised yields nothing', pickConnectAddress(parseMdnsServices('')), null)
check('garbage output does not throw', parseMdnsServices('adb: unknown command'), [])

check('same /24 counts as same network', sameSubnet('192.168.1.7', '192.168.1.42:41235'), true)
check('different /24 does not', sameSubnet('192.168.1.7', '10.0.0.9:41235'), false)
check('an empty address is never "same"', sameSubnet('', '192.168.1.42:41235'), false)

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
