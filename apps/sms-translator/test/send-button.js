/*
 * Tests for send-button detection.
 *
 * Sending an SMS means locating the send button in a live `uiautomator dump`
 * and tapping it. Tapping the wrong control is worse than doing nothing (it can
 * attach a file, discard the draft, or open the camera), so the scoring is
 * covered against realistic hierarchies from the SMS apps people actually use.
 *
 * Run with: npm test
 */
const path = require('node:path')
const { __testing } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'adb', 'send.js'),
)
const { parseNodes, scoreSendCandidate, parseBounds, pickSendButton } = __testing

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

/** Pick the best candidate the same way findSendButton() does. */
function best(xml) {
  let winner = null
  let top = 0
  for (const node of parseNodes(xml)) {
    const score = scoreSendCandidate(node)
    if (score > top) {
      top = score
      winner = node
    }
  }
  return top >= 9 ? winner : null
}

// --- Samsung One UI (com.samsung.android.messaging) -------------------------
// The compose bar carries an attach button and an emoji button next to send.
const samsung = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
 <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.samsung.android.messaging" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2340]">
  <node index="1" text="" resource-id="com.samsung.android.messaging:id/attach_button" class="android.widget.ImageButton" package="com.samsung.android.messaging" content-desc="Attach" clickable="true" enabled="true" bounds="[24,2050][132,2158]" />
  <node index="2" text="" resource-id="com.samsung.android.messaging:id/emoticon_button" class="android.widget.ImageButton" package="com.samsung.android.messaging" content-desc="Emoji" clickable="true" enabled="true" bounds="[140,2050][248,2158]" />
  <node index="3" text="您好" resource-id="com.samsung.android.messaging:id/message_edit_text" class="android.widget.EditText" package="com.samsung.android.messaging" content-desc="" clickable="true" enabled="true" bounds="[256,2050][900,2158]" />
  <node index="4" text="" resource-id="com.samsung.android.messaging:id/send_button" class="android.widget.ImageButton" package="com.samsung.android.messaging" content-desc="Send" clickable="true" enabled="true" bounds="[912,2050][1020,2158]" />
 </node>
</hierarchy>`

check('Samsung: finds the send button', best(samsung)?.resourceId, 'com.samsung.android.messaging:id/send_button')
check('Samsung: taps the button centre', best(samsung)?.center, { x: 966, y: 2104 })

// --- Google Messages --------------------------------------------------------
const google = `<hierarchy rotation="0">
 <node index="0" text="" resource-id="com.google.android.apps.messaging:id/compose_message_text" class="android.widget.EditText" content-desc="" clickable="true" enabled="true" bounds="[100,1900][800,2000]" />
 <node index="1" text="" resource-id="com.google.android.apps.messaging:id/send_message_button_icon" class="android.widget.ImageView" content-desc="Send SMS" clickable="true" enabled="true" bounds="[820,1900][940,2020]" />
</hierarchy>`

check('Google Messages: finds the send button', best(google)?.resourceId, 'com.google.android.apps.messaging:id/send_message_button_icon')

// --- Localised, no useful resource id ---------------------------------------
const localised = `<hierarchy>
 <node index="0" text="" resource-id="" class="android.widget.ImageButton" content-desc="发送" clickable="true" enabled="true" bounds="[900,2000][1000,2100]" />
 <node index="1" text="" resource-id="" class="android.widget.ImageButton" content-desc="添加附件" clickable="true" enabled="true" bounds="[20,2000][120,2100]" />
</hierarchy>`

check('Localised label alone is enough', best(localised)?.center, { x: 950, y: 2050 })

// --- Distractors that must NOT be tapped ------------------------------------
const decoys = `<hierarchy>
 <node index="0" text="" resource-id="com.example.sms:id/resend_button" class="android.widget.Button" content-desc="Resend" clickable="true" enabled="true" bounds="[10,10][110,110]" />
 <node index="1" text="Sender" resource-id="com.example.sms:id/sender_name" class="android.widget.TextView" content-desc="" clickable="false" enabled="true" bounds="[10,200][500,260]" />
 <node index="2" text="" resource-id="com.example.sms:id/send_later_button" class="android.widget.Button" content-desc="Send later" clickable="true" enabled="true" bounds="[10,300][110,400]" />
 <node index="3" text="" resource-id="com.example.sms:id/attach_send_file" class="android.widget.Button" content-desc="" clickable="true" enabled="true" bounds="[10,500][110,600]" />
</hierarchy>`

check('Never taps resend / sender / send-later / attach', best(decoys), null)

// --- Disabled send button (empty draft) -------------------------------------
const disabled = `<hierarchy>
 <node index="0" text="" resource-id="com.samsung.android.messaging:id/send_button" class="android.widget.ImageButton" content-desc="Send" clickable="false" enabled="false" bounds="[912,2050][1020,2158]" />
</hierarchy>`

check('Ignores a disabled send button', best(disabled), null)

// --- Degenerate input -------------------------------------------------------
check('Zero-area nodes are skipped', parseBounds('[100,200][100,200]'), null)
check('Malformed bounds are skipped', parseBounds('nonsense'), null)
check('Empty dump yields nothing', best('<hierarchy></hierarchy>'), null)
check(
  'Self-closing and nested nodes both parse',
  parseNodes(samsung).length,
  5,
)

// --- picking the button out of a whole dump ---
// A compressed dump from Samsung Messages: an attach button, the text box, and
// the send button. Only the last one may ever be tapped.
const DUMP = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.samsung.android.messaging:id/attach_button" class="android.widget.ImageButton" package="com.samsung.android.messaging" content-desc="添加附件" clickable="true" bounds="[24,1800][120,1900]" />
  <node index="1" text="你好" resource-id="com.samsung.android.messaging:id/message_edit_text" class="android.widget.EditText" package="com.samsung.android.messaging" content-desc="" clickable="true" bounds="[130,1800][900,1900]" />
  <node index="2" text="" resource-id="com.samsung.android.messaging:id/send_button1" class="android.widget.Button" package="com.samsung.android.messaging" content-desc="发送" clickable="true" bounds="[920,1800][1040,1900]" />
</hierarchy>`

const picked = pickSendButton(DUMP)
check('the send button is found in a real dump', picked && picked.resourceId, 'com.samsung.android.messaging:id/send_button1')
check('and it is the one that gets tapped', picked && picked.center, { x: 980, y: 1850 })

check('a dump with no send button yields nothing', pickSendButton(`<?xml version='1.0'?>
<hierarchy><node index="0" text="" resource-id="com.android.systemui:id/clock" class="android.widget.TextView" package="com.android.systemui" content-desc="" clickable="false" bounds="[0,0][100,50]" /></hierarchy>`), null)
check('an empty dump yields nothing, not a crash', pickSendButton(''), null)
check('a truncated dump yields nothing', pickSendButton('<?xml version'), null)

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
