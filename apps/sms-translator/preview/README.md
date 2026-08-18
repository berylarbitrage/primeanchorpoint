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
Point it at a specific browser with `PREVIEW_CHROMIUM=/path/to/chrome`, and at a
Playwright installed outside the project with
`PREVIEW_PLAYWRIGHT=/path/to/playwright/index.js`.

`web.mjs` is the same idea for **LAN web sharing**: it starts the real
`WebServer` over the real `dist/`, logs in with a browser, and screenshots the
result at desktop and phone widths — the login round trip, the injected
`web-bridge.js`, and the responsive layout, none of which the unit tests cover.

```sh
node preview/web.mjs               # writes preview/out/web-*.png
```

`?state=error` swaps the mocked status for a connection failure, which is how
the error banner gets checked — the topbar clips long messages, so the banner is
the only place the user can actually read them.
