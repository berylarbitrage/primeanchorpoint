# UI preview harness

Renders the real renderer bundle against a stubbed `window.sms`, so the
interface can be inspected and screenshotted **without a phone attached**. This
is how the message list, bilingual bubbles, and the filter behaviour get
visually checked — a bug where filtering hid the open conversation and left the
right pane blank was found this way.

`mock.js` only supplies data; no UI code lives here.

```sh
npm run build
node preview/shoot.mjs            # writes preview/out/*.png
```

Needs Playwright with a Chromium browser available. It is deliberately *not* a
project dependency — CI does not run this, and adding Playwright would slow
every install down for a tool used by hand.
Point it at a specific browser with `PREVIEW_CHROMIUM=/path/to/chrome`.
