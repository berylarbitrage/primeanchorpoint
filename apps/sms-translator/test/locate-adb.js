/*
 * Tests for adb discovery.
 *
 * "spawn adb ENOENT" is the first thing a user hits if Platform Tools is not on
 * PATH, so the app searches common install locations instead. The search must
 * accept only something that really is adb — pointing the app at an arbitrary
 * executable would produce confusing failures much later.
 *
 * Uses fake binaries in a temp dir so results do not depend on whether the
 * machine running the tests happens to have adb installed.
 *
 * Note: since Node 20.12 / 18.20, `child_process.spawn` refuses to launch a
 * .cmd/.bat file without `shell: true`, and a real .exe cannot be synthesised
 * here. adb itself is a real .exe so production is unaffected, but it means the
 * "this really is adb" assertions can only run on POSIX. The Linux CI job
 * covers them; the Windows job still runs everything else.
 *
 * Run with: npm test
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { findAdb, verifyAdb } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'adb', 'locate.js'),
)

const isWindows = process.platform === 'win32'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-locate-'))

/** Write a fake executable that prints `output` and exits with `code`. */
function fakeBinary(name, output, code = 0) {
  const file = path.join(tmp, isWindows ? `${name}.cmd` : name)
  if (isWindows) {
    fs.writeFileSync(file, `@echo off\r\necho ${output}\r\nexit /b ${code}\r\n`)
  } else {
    fs.writeFileSync(file, `#!/bin/sh\necho "${output}"\nexit ${code}\n`, { mode: 0o755 })
  }
  return file
}

const realAdb = fakeBinary('adb-real', 'Android Debug Bridge version 1.0.41')
const notAdb = fakeBinary('some-other-tool', 'git version 2.43.0')
const brokenAdb = fakeBinary('adb-broken', 'Android Debug Bridge version 1.0.41', 1)
const missing = path.join(tmp, 'does-not-exist', 'adb.exe')

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

async function main() {
  // Negative cases run everywhere: an unlaunchable or wrong binary must be
  // rejected regardless of why it failed to launch.
  check('rejects some other executable', await verifyAdb(notAdb), false)
  check('rejects a path that does not exist', await verifyAdb(missing), false)
  check('returns null when nothing is adb', await findAdb(missing, [notAdb, brokenAdb]), null)
  check('a missing candidate is skipped, not spawned', await findAdb(missing, [missing]), null)

  if (isWindows) {
    console.log('skip 4 positive-path assertions (cannot fake an adb .exe on Windows)')
  } else {
    check('accepts a binary that identifies itself as adb', await verifyAdb(realAdb), true)
    check('rejects adb that exits non-zero', await verifyAdb(brokenAdb), false)
    check('configured path is preferred', await findAdb(realAdb, [notAdb]), realAdb)
    check(
      'falls back to a candidate when the configured path is broken',
      await findAdb(missing, [notAdb, brokenAdb, realAdb]),
      realAdb,
    )
    check('empty configured path is skipped', await findAdb('   ', [realAdb]), realAdb)
  }

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
