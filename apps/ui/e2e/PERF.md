# UI performance report

Dataset: `?mock&big=1` (src/mockBig.ts): about 600 chats (360 personal, 240 in 8 communities with categories, 20 merged pairs), 100k+ messages,
one chat with 10k messages, reactions and image placeholders. Histories are generated lazily per chat, so the numbers measure the UI.
Measured with `deno run -A e2e/run.ts -f perf -j 1` (headless Chromium on the dev box; CDP `Performance.getMetrics`, PerformanceObserver `longtask`).
Budgets in `tests/perf.ts` are 3-6x looser than the numbers below. `PERF_TARGET=1500` lowers the "loaded messages" target of the scroll test.

| Scenario | Before | After |
|---|---|---|
| First chat row on screen | 224 ms | 343 ms (the fake backend is now a separate chunk that loads first; real builds never load it) |
| Chat rows in the DOM at start (394 in Personal) | 394 rows, 7.7k nodes | 32 rows, 1.0k nodes (windowed list) |
| Heap after start | 14 MB | 10 MB |
| Switch chat (median / worst of 14) | 83 / 211 ms | 83 / 226 ms (dominated by the mock's 30 ms latency + first paint) |
| Page back to 1500 messages with "Load earlier" (30 clicks) | 12.9 s, 74k DOM nodes, 113 MB heap, 1500 `.msg` in the DOM | about 3 s, 20 `.msg` in the DOM |
| Page back to 5000 messages (100 clicks) | did not finish in 180 s (quadratic) | 12.6 s, 2k nodes, 16 MB heap |
| Scroll through the loaded history | 196 ms worst frame at 1500 msgs | no long task, worst frame 44-178 ms at 5000 msgs |
| 600 events at 200/s (open chat + others) | worst frame gap 189 ms, longest task 172 ms, 83 MB | gap 74 ms, longest task 72 ms, 46 MB |
| Main JS bundle (gzip) | 524 kB (169 kB) | 371 kB (119 kB); Panels/Settings 86 kB, GlobalSearch, Video, Voice, MessageInfo, QR code, mock and emoji data are own chunks |

## What changed
* Chat list: `VList` windows the list once it has more than 120 items (fixed row heights from CSS variables, exact offsets). Rows are `memo`ised
  `ChatRow`s that get one stable `api` object, so an incoming message re-renders one row. Shift-select still works on the full id list; drag targets and
  the active row scroll into view.
* Message list: windowed past 300 messages (measured heights, estimated for unmeasured rows, one ResizeObserver). The row at the top of the viewport is the
  scroll anchor, so prepending history and late-loading images never move what you read. Stick-to-bottom, jump-to-message (scrolls to the estimated position,
  then to the real one) and highlight keep working. Rows are `memo`ised with a custom comparator (a chat's unread counter does not re-render the timeline).
* App.tsx: structural sharing of snapshots (`reuse`), one pass for unread / provider-dot / quiet maps instead of one per rail icon, coalesced
  `chats-changed` refreshes (`refreshSoon`), message/receipt/typing/presence events applied in one batch per 40 ms.
* Avatars: one shared IntersectionObserver, bounded LRU cache (800) that revokes blob URLs. Images use `loading=lazy decoding=async`.
* Not done: `content-visibility:auto` on messages (it clips the fixed-position menus that live inside a message), a virtualised message list below 300 messages.
