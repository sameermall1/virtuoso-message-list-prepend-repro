# Message List: the reader's row moves after a `'prepend'`

A minimal repro for [petyosi/react-virtuoso#1523](https://github.com/petyosi/react-virtuoso/issues/1523). It uses `@virtuoso.dev/message-list` 1.18.1 with an empty license key, so run it as a dev build.

```bash
npm install
npm run dev   # http://localhost:5199/?mode=shrink-effect
```

Scroll to the top. After a 400ms fake fetch, the app prepends 20 older rows with the `'prepend'` scroll modifier (declarative `data` prop, `increaseViewportBy={200}`, the list owns the scroller). The header reports how far the row you were reading moved after the list's prepend correction, with no further user scroll.

The drift is measured from the list's own size cache: the sum of `list.height(row)` for every row above the reader, minus `scrollTop`. That way a jump still counts after the reader's row unmounts because it moved out of the rendered window. `window.__traces` holds, for each prepended row that rendered, its estimate (`list.height()` right after the data change), its height when inserted, and its height at +150ms and +500ms (`null` once it has unmounted).

## Modes

| `?mode=`                            | Rows                                                                                                                           | Prepends with a jump (8 each) | Drift                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------- |
| `uniform`                           | Every row is 300px from its first render (control).                                                                            | 0/8                           | 0                                        |
| `shrink-effect`                     | Rows are 300px. Every third row renders at 1200px, then a passive `useEffect` clamps it to 240px ("Show more").                 | 0–3/8 (a race, see below)     | −960px                                   |
| `shrink-effect&delay=100`           | Same, with the clamp landing 100ms after mount (a passive effect on a busy main thread).                                       | 3/8                           | −960px, 83–100ms after the correction    |
| `shrink-layout`                     | Same rows, clamped in `useLayoutEffect`.                                                                                       | 0/8                           | 0                                        |
| `shrink-css`                        | Same rows, clamped with `max-height` from the first render.                                                                    | 0/8                           | 0                                        |
| `shrink-notify&delay=100`           | `shrink-effect`, plus `notifyItemsChanged({ scrollToBottom: false })` after each clamp.                                        | 3/8                           | −960px                                   |
| `shrink-map-with-anchor&delay=100`  | The clamp lives in the data and is applied with `data.mapWithAnchor(row => …, readerIndex)`, 100ms after mount.                | 0/8                           | 0                                        |
| `shrink-map-with-anchor`            | Same, with no delay: the clamp lands while the `'prepend'` correction is still in flight.                                      | 3/8                           | +60px                                    |
| `late-measure`                      | No row ever changes height. The first page is 1000px rows, so unmeasured rows are estimated at 1000px. In each older page the row just above the reader is 150px, the one above it 250px, the rest 600px. | 8/8                           | −750px, one frame after the correction   |

Measured in desktop Chrome 155 on macOS at a 1280×740 viewport (both a visible window and headless). In the `shrink-*` modes, the prepends that jump are exactly the ones where the row just above the reader is a clamp row (`seq % 3 === 0`). Plain `shrink-effect` only jumps when the passive effect runs after the list's first measurement of the row, which varies from run to run; `delay=100` makes it deterministic.

## What the trace shows

**Rows that shrink after their first measurement** (`shrink-effect`): the boundary row is first measured at 1200px against a 300px estimate, and the `'prepend'` correction scrolls by that 1200px. The clamp then makes the row 240px, and nothing compensates, so the reader moves up by 960px. Without a delay, the clamp is already in the size cache by the time the `scrollBy` lands, so the reader is off from the first corrected frame. With `delay=100`, the correction lands exactly and the reader moves 83–100ms later. With `notifyItemsChanged` it is the same, because that path only handles bottom stickiness. `mapWithAnchor` compensates when it runs after the correction. When the clamp lands in the same size-cache update the `'prepend'` correction consumes, it is compensated twice (+60px = 300px estimate − 240px).

**Rows that are measured for the first time after the correction** (`late-measure`): no row changes height after its first render. The 150px boundary row is the only prepended row inside the 200px overscan, so the correction uses 150px for it and the 1000px estimate for the other 19. Once that scroll lands, the row above it comes within the overscan and renders for the first time, one frame later. Its measured 250px replaces the 1000px estimate above the reader, and nothing compensates, so the reader moves up by 750px. This is the case we see in our app, where the estimate is 1016px and the late rows are 90–642px.

## Why (from reading `dist/index.js` 1.18.1, so this may be off)

- On `'prepend'`, the correction is computed from the first size-cache update after the data change, then applied as a `scrollBy` one frame later. Rows that are not rendered yet keep the estimated size.
- After that, size changes above the viewport are only compensated while the scroll direction is `up` (`deviationDelta`). The direction resets to `none` 100ms after the last `scrollTop` change. A user who reached the top and is waiting for the page is not scrolling, so both later changes go uncompensated.
- `mapWithAnchor` scrolls by the anchor's offset change at the next size-cache update. If that update is also the one the `'prepend'` correction consumes, the change is applied twice.

Side note, seen while building this: when a row's final height equals its pre-measure estimate (an earlier version clamped 1200px to the 300px estimate), the shrink back was dropped: `list.height()` kept reporting 1200px for a 300px row, leaving a 900px blank gap above the reader until the row re-rendered. The likely cause is that the ResizeObserver callback skips a size equal to the item's `data-known-size` attribute, and that attribute still held the 300px estimate because the 1200px re-render hadn't happened yet. I didn't verify the attribute's value at that moment.
