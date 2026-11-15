# UI end-to-end tests

Browser regression tests for the UniChat UI. They drive the **mock UI** (`?mock`, `src/mock.ts`) in a headless system
Chromium through the Chrome DevTools Protocol, written for Deno. No npm packages, no real services, nothing outside a
throwaway profile directory.

## Run

```sh
pnpm --filter @unimsg/ui build        # tests serve apps/ui/dist
pnpm e2e                              # all tests (root script), same as: pnpm --filter @unimsg/ui e2e
pnpm e2e -- -j 3                      # 3 parallel workers (each its own Chromium + profile)
pnpm e2e -- -f merge                  # only tests whose "file > name" contains "merge" (repeat / comma list; "!x" excludes)
pnpm e2e -- --build                   # build first
pnpm e2e -- --dist /some/other/dist   # serve another build (useful while others are editing src/)
pnpm e2e -- --retry 2                 # re-run failures; a pass after a retry is reported as FLAKY
pnpm e2e -- --update-shots            # write named reference screenshots to e2e/shots/<file>/ (not diffed)
pnpm e2e -- --list
```

Requirements: `deno`, `chromium` on PATH. The runner starts a static server for the build on a free port, Chromium with
`--remote-debugging-port=0` and a temp profile, and removes everything (also on failure / Ctrl-C).
Exit code is non-zero if any test fails. Failing tests leave a screenshot in `e2e/out/` (git-ignored) plus `out/results.json`.

## Layout

- `run.ts` runner (filter, parallelism, retries, summary).
- `lib/harness.ts` server, browser, CDP `Page` helper. `lib/test.ts` `test()` + init-script presets. `lib/ui.ts` shared UI helpers (merge Anna, move chat, settings...).
- `tests/*.ts` one file per feature area, each `export default [test(...), ...]`.
- `fixtures/` files used for uploads.

Every test gets a **new browser context** (empty localStorage) and must start with `await t.open(...)`, which loads `/?mock...`
and waits until the app rendered. Tests are independent and can run in parallel in any order.

## Writing a test

```ts
import { test } from "../lib/test.ts";
export default [
  test("what it proves", async (t) => {
    await t.open("&chat=wa-1:anna");                       // query is appended to ?mock
    await t.click('button[title="Attach"]');               // waits for the element, then clicks
    await t.ok("popup opens", `document.querySelector('.tools .popmenu')`);   // polls until truthy (5 s)
    await t.eq("badge", `document.querySelectorAll('.pbadge').length`, 3);    // polls until equal
    await t.stays("does not appear", `document.querySelector('.x')`, 400);    // must stay false
  }),
];
```

Assertions are soft: they are recorded, the test continues, and it fails if any failed or an exception/timeout happened.
Never use fixed sleeps to wait for the UI: use `ok/eq/not/waitFor`. Useful helpers on `t`: `contextMenu`, `rowMenu`, `openRow`,
`openChat(id)`, `pill/space`, `typeIn` (composer, native setter), `setInput`, `insertText`/`key` (real input events),
`upload(selector, files)` (DOM.setFileInputFiles), `drag`, `shot(name)`, `ev(js)`. Inside page JS use `__e2e.row(name)`, `__e2e.msg(text)`, `__e2e.rows()`, ... (see `PAGE_HELPERS` in harness.ts).
Test options: `{ init: "script run before the app" }` (e.g. `NOTIFY_INIT`, preset settings), `{ timeout }`.
Mock hooks available in the page: `__mockInject`, `__mockEmit`, `__mockSetCaps`, `__lastSend`, `__lastLogin`, `__jobs`, `__voice`.

The mock's own timers matter: a typing event at 2.5 s and a live WhatsApp message from Anna at 5 s. Tests that count unread /
newest message use `t.open("", { settle: true })`.

## Expectations that changed relative to the old throwaway scripts

- **Merged chats / Send via**: the selector now follows the newest message of the merged chat; an unused manual choice is no longer
  remembered per chat (the old "remembered send-via choice" checks were replaced by: sending via X makes X the default on return).
- **Mock seed**: Favourites folder holds Bea / Carl / Trail friends; single-chat communities are collapsed into Personal; Discord bot + user
  accounts and an Instagram account exist; the merge picker lists Instagram/Discord DMs too, so tests pick the candidate by name
  (the list is alphabetical until the "same person" suggestion arrives).
- Rail pill titles are `"<name> · <network>"`; tests use prefixes. Community channels in Discord categories are alphabetical inside a category.
- Chat rows no longer have an `.origin` element; "moved chats look like groups" now checks avatar-instead-of-`#`.
- Contact panel of a merged chat lists the *account* label per network (`@michi:matrix.org`), not the contact handle.
- The "New chat" button is addressed by `title="New chat"` (a global-search button now sits before it).
- Added since: group description editor (`.chatabout`), "your own name" form (`.nickform`), login form select + help, error boundary.
- `tests/backup.ts` (desktop dialogs, move-login wizard) belongs to the backup feature work; `tests/settings.ts` covers the browser export/import flow.
- `tests/sync.ts` covers Settings > Sync devices on the mock (`mockSync.ts`): approval + 6-digit code on both sides, listener scope, address list, relay URL, media policy, proxy accounts, phone width. Mock hooks: `__mockSyncJoinRequest`, `__mockSyncOffer`, `__mockSyncDrop`, `__mockSyncSnapshot`.

## Phone / tablet emulation and performance tests
* `t.device("phone" | "small" | "tablet", landscape?)` (lib/harness.ts) emulates a Galaxy A33 (412x915), 360x800 or 768x1024: mobile viewport, touch events,
  `(pointer: coarse)`, mobile UA. Call it before `open()`. `t.tap(expr)`, `t.longPress(expr)`, `t.touch(x, y, holdMs)` send real touch events.
* `tests/phone.ts`: phone flows (list/chat/back, composer, long-press menus, selection mode, sheets, info panel, settings tabs, tablet rotation, no element wider than the viewport).
  Screenshots land in `out/phone-*.png`.
* `?mock&big=1` loads the big dataset (src/mockBig.ts); `tests/perf.ts` holds the budgets, numbers are in PERF.md.
