import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtuosoMessageList, VirtuosoMessageListLicense } from '@virtuoso.dev/message-list';

const MODES = {
  uniform: 'Control. Every row is 300px from its first render.',
  'shrink-effect':
    'Rows are 300px. Every third row renders at 1200px, then a passive useEffect clamps it to 240px (a "Show more" clamp).',
  'shrink-layout': 'Same rows as shrink-effect, but the clamp runs in useLayoutEffect.',
  'shrink-css': 'Same rows as shrink-effect, clamped with max-height from the first render.',
  'shrink-map-with-anchor':
    'shrink-effect, but the clamp is stored in the data and applied with data.mapWithAnchor(index of the row being read).',
  'shrink-notify': 'shrink-effect, plus notifyItemsChanged({ scrollToBottom: false }) after each clamp.',
  'late-measure':
    'No row ever changes height. The first page is 1000px rows. In each older page the row just above the reader is 150px, the one above it 250px, the rest 600px.',
};

const params = new URLSearchParams(window.location.search);
const MODE = MODES[params.get('mode')] ? params.get('mode') : 'shrink-effect';
const PAGE_SIZE = 20;
const MAX_PAGES = 8;
const FETCH_MS = 400;
const TRACE_MS = 1500;
const CLAMP_HEIGHT = 240;
const FIRST_SEQ = 1000;
// ?delay=100 postpones effect-based clamps, like a passive effect that runs late on a busy main thread.
const CLAMP_DELAY_MS = Number(params.get('delay') ?? 0);
const afterDelay = (callback) => {
  if (!CLAMP_DELAY_MS) {
    callback();
    return undefined;
  }
  const timeout = setTimeout(callback, CLAMP_DELAY_MS);
  return () => clearTimeout(timeout);
};

const clampedIds = new Set();
// The row at the top of the viewport when the current prepend started, while its trace runs.
let readerId = null;

const makeRow = (seq) => {
  const id = `row-${seq}`;
  if (MODE === 'uniform') return { id, seq, height: 300 };
  if (MODE === 'late-measure') {
    if (seq >= FIRST_SEQ) return { id, seq, height: 1000 };
    const fromEnd = PAGE_SIZE - 1 - (seq % PAGE_SIZE);
    return { id, seq, height: fromEnd === 0 ? 150 : fromEnd === 1 ? 250 : 600 };
  }
  return { id, seq, height: seq % 3 === 0 ? 1200 : 300, tall: seq % 3 === 0 };
};

const rowsBetween = (start, end) => Array.from({ length: end - start }, (_, i) => makeRow(start + i));

const Box = ({ height, label }) => (
  <div
    style={{
      height,
      boxSizing: 'border-box',
      padding: 8,
      borderBottom: '1px solid #ccc',
      background: height > 300 ? '#fff4e0' : '#f4f7ff',
    }}
  >
    {label}
  </div>
);

const Clamp = ({ clamped, innerRef, children }) => (
  <div ref={innerRef} style={clamped ? { maxHeight: CLAMP_HEIGHT, overflow: 'hidden' } : undefined}>
    {children}
  </div>
);

const useClamp = (useSomeEffect) => {
  const ref = useRef(null);
  const [clamped, setClamped] = useState(false);
  useSomeEffect(() => {
    if (useSomeEffect === useLayoutEffect) {
      if (ref.current && ref.current.scrollHeight > CLAMP_HEIGHT) setClamped(true);
      return undefined;
    }
    return afterDelay(() => {
      if (ref.current && ref.current.scrollHeight > CLAMP_HEIGHT) setClamped(true);
    });
  }, []);
  return [ref, clamped];
};

const EffectClampRow = ({ row }) => {
  const [ref, clamped] = useClamp(useEffect);
  return (
    <Clamp innerRef={ref} clamped={clamped}>
      <Box height={row.height} label={`${row.id} — 1200px, clamped in useEffect`} />
    </Clamp>
  );
};

const LayoutClampRow = ({ row }) => {
  const [ref, clamped] = useClamp(useLayoutEffect);
  return (
    <Clamp innerRef={ref} clamped={clamped}>
      <Box height={row.height} label={`${row.id} — 1200px, clamped in useLayoutEffect`} />
    </Clamp>
  );
};

const NotifyClampRow = ({ row, context }) => {
  const [ref, clamped] = useClamp(useEffect);
  useEffect(() => {
    if (clamped) context.notify();
  }, [clamped, context]);
  return (
    <Clamp innerRef={ref} clamped={clamped}>
      <Box height={row.height} label={`${row.id} — 1200px, clamped in useEffect + notifyItemsChanged`} />
    </Clamp>
  );
};

const AnchoredClampRow = ({ row, context }) => {
  const ref = useRef(null);
  const clamped = clampedIds.has(row.id);
  useEffect(() => {
    if (clamped) return undefined;
    return afterDelay(() => {
      if (ref.current && ref.current.scrollHeight > CLAMP_HEIGHT) context.clampWithAnchor(row.id);
    });
  }, [clamped, context, row.id]);
  return (
    <Clamp innerRef={ref} clamped={clamped}>
      <Box height={row.height} label={`${row.id} — 1200px, clamped via mapWithAnchor`} />
    </Clamp>
  );
};

const RowBody = ({ row, context }) => {
  if (!row.tall) return <Box height={row.height} label={`${row.id} — ${row.height}px`} />;
  if (MODE === 'shrink-effect') return <EffectClampRow row={row} />;
  if (MODE === 'shrink-layout') return <LayoutClampRow row={row} />;
  if (MODE === 'shrink-notify') return <NotifyClampRow row={row} context={context} />;
  if (MODE === 'shrink-map-with-anchor') return <AnchoredClampRow row={row} context={context} />;
  return (
    <Clamp clamped>
      <Box height={row.height} label={`${row.id} — 1200px, clamped from the first render`} />
    </Clamp>
  );
};

const ItemContent = ({ data, context }) => (
  <div data-row-id={data.id} style={{ padding: '0 16px' }}>
    <RowBody row={data} context={context} />
  </div>
);

// Where the list places a row relative to the viewport top: its offset in the list's size cache minus scrollTop.
// Unlike a DOM read, this still works after the row unmounts because it moved out of the rendered window.
const rowTop = (list, id) => {
  const rows = list.data.get();
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return null;
  let offset = 0;
  for (let i = 0; i < index; i++) offset += list.height(rows[i]);
  return offset - list.scrollerElement().scrollTop;
};

const firstVisibleIndex = (scroller) => {
  const top = scroller.getBoundingClientRect().top;
  const visible = [...scroller.querySelectorAll('[data-index]')]
    .filter((element) => element.getBoundingClientRect().bottom > top + 1)
    .map((element) => Number(element.dataset.index));
  return visible.length ? Math.min(...visible) : 0;
};

// Records where the row at the top of the viewport sits before the prepend and for TRACE_MS after it, plus each
// prepended row's estimate (list.height) and its rendered height at first measurement, +150ms and +500ms.
const startTrace = (list, page, onDone) => {
  const scroller = list.scrollerElement();
  const scrollerTop = scroller.getBoundingClientRect().top;
  const anchorElement = [...scroller.querySelectorAll('[data-row-id]')].find(
    (element) => element.getBoundingClientRect().bottom > scrollerTop + 1
  );
  if (!anchorElement) return;
  const anchorId = anchorElement.dataset.rowId;
  readerId = anchorId;
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const anchorTop0 = Math.round(rowTop(list, anchorId));
  const frames = [];
  const rows = new Map(
    page.map((row) => [row.id, { id: row.id, estimate: null, first: null, firstAt: null, h150: null, h500: null }])
  );

  const heightOf = (id) => {
    const element = scroller.querySelector(`[data-row-id="${id}"]`);
    return element ? Math.round(element.parentElement.getBoundingClientRect().height) : null;
  };
  // A row can unmount before the next ResizeObserver callback (when the jump moves it out of the rendered window), so
  // its first height is read when it is inserted.
  const recordFirst = (row, height) => {
    if (row.first !== null || height <= 0) return;
    row.first = height;
    row.firstAt = at();
    setTimeout(() => (row.h150 = heightOf(row.id)), 150);
    setTimeout(() => (row.h500 = heightOf(row.id)), 500);
  };
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const row = rows.get(entry.target.querySelector('[data-row-id]')?.dataset.rowId);
      if (row) recordFirst(row, Math.round(entry.borderBoxSize[0].blockSize));
    }
  });
  const observeNew = () => {
    for (const wrapper of scroller.querySelectorAll('[data-index]')) {
      const id = wrapper.querySelector('[data-row-id]')?.dataset.rowId;
      if (rows.has(id) && !wrapper.dataset.traced) {
        wrapper.dataset.traced = '1';
        recordFirst(rows.get(id), Math.round(wrapper.getBoundingClientRect().height));
        resizeObserver.observe(wrapper, { box: 'border-box' });
      }
    }
  };
  const mutationObserver = new MutationObserver(observeNew);
  mutationObserver.observe(scroller, { childList: true, subtree: true });

  let estimatesRead = false;
  const frame = () => {
    const t = at();
    if (!estimatesRead && list.data.find((row) => row.id === page[0].id)) {
      estimatesRead = true;
      const current = list.data.get();
      for (const row of current) if (rows.has(row.id)) rows.get(row.id).estimate = list.height(row);
    }
    const top = rowTop(list, anchorId);
    frames.push({ t, st: Math.round(scroller.scrollTop), anchorTop: top === null ? null : Math.round(top) });
    if (t < TRACE_MS) {
      requestAnimationFrame(frame);
      return;
    }
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    readerId = null;
    // Until the list applies its 'prepend' scroll correction, the cache offsets already include the new rows while
    // scrollTop does not, so only frames from the correction onwards are compared.
    const correction = frames.findIndex((f) => Math.abs(f.st - frames[0].st) > 1);
    const drifts = (correction < 0 ? [] : frames.slice(correction))
      .filter((f) => f.anchorTop !== null)
      .map((f) => f.anchorTop - anchorTop0);
    const maxDrift = drifts.reduce((max, drift) => (Math.abs(drift) > Math.abs(max) ? drift : max), 0);
    onDone({
      mode: MODE,
      anchorId,
      anchorTop0,
      finalDrift: drifts.at(-1) ?? null,
      maxDrift,
      frames,
      rows: [...rows.values()],
    });
  };
  requestAnimationFrame(frame);
};

const App = () => {
  const listRef = useRef(null);
  const loadingRef = useRef(false);
  const oldestSeqRef = useRef(FIRST_SEQ);
  const [traces, setTraces] = useState([]);
  useEffect(() => {
    window.__list = listRef.current;
  });
  const [listData, setListData] = useState(() => ({
    data: rowsBetween(FIRST_SEQ, FIRST_SEQ + PAGE_SIZE),
    scrollModifier: { type: 'item-location', location: { index: 'LAST', align: 'end' } },
  }));

  const loadOlder = useCallback(() => {
    if (loadingRef.current || oldestSeqRef.current <= FIRST_SEQ - PAGE_SIZE * MAX_PAGES) return;
    loadingRef.current = true;
    setTimeout(() => {
      const end = oldestSeqRef.current;
      oldestSeqRef.current = end - PAGE_SIZE;
      const page = rowsBetween(end - PAGE_SIZE, end);
      startTrace(listRef.current, page, (trace) => {
        window.__traces = [...(window.__traces ?? []), trace];
        setTraces((previous) => [...previous, trace]);
        loadingRef.current = false;
      });
      setListData((previous) => ({ data: [...page, ...previous.data], scrollModifier: 'prepend' }));
    }, FETCH_MS);
  }, []);

  const context = useMemo(
    () => ({
      notify: () => listRef.current?.notifyItemsChanged({ scrollToBottom: false }),
      clampWithAnchor: (id) => {
        const list = listRef.current;
        if (!list) return;
        clampedIds.add(id);
        // Mid-prepend, the first row in the DOM can be a new row, so anchor on the row the user was reading.
        const readerIndex = readerId === null ? -1 : list.data.findIndex((row) => row.id === readerId);
        const anchorIndex = readerIndex >= 0 ? readerIndex : firstVisibleIndex(list.scrollerElement());
        list.data.mapWithAnchor((row) => (row.id === id ? { ...row } : row), anchorIndex);
      },
    }),
    []
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '8px 16px', borderBottom: '1px solid #ccc', fontSize: 12 }}>
        <div>
          <strong>mode={MODE}</strong>: {MODES[MODE]} Scroll to the top to load {PAGE_SIZE} older rows ({FETCH_MS}ms
          fake fetch, then a <code>&apos;prepend&apos;</code> scroll modifier).
        </div>
        <div>
          {Object.keys(MODES).map((mode) => (
            <a key={mode} href={`?mode=${mode}`} style={{ marginRight: 8 }}>
              {mode}
            </a>
          ))}
        </div>
        <div data-testid="results">
          {traces.map((trace, index) => (
            <div key={index}>
              prepend #{index + 1}: the row being read moved {trace.finalDrift}px after the prepend correction
              (largest deviation {trace.maxDrift}px), with no user scroll
            </div>
          ))}
        </div>
      </header>
      <VirtuosoMessageListLicense licenseKey="">
        <VirtuosoMessageList
          ref={listRef}
          style={{ flex: 1 }}
          data={listData}
          context={context}
          itemIdentity={(row) => row.id}
          computeItemKey={({ data }) => data.id}
          ItemContent={ItemContent}
          increaseViewportBy={200}
          onScroll={({ listOffset }) => {
            if (listOffset > -100) loadOlder();
          }}
        />
      </VirtuosoMessageListLicense>
    </div>
  );
};

createRoot(document.getElementById('root')).render(<App />);
