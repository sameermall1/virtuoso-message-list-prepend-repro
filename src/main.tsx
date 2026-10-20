import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  VirtuosoMessageList,
  VirtuosoMessageListLicense,
  type DataWithScrollModifier,
  type ItemContent,
  type VirtuosoMessageListMethods,
} from '@virtuoso.dev/message-list';

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
} as const;

type Mode = keyof typeof MODES;

interface Row {
  id: string;
  seq: number;
  height: number;
  tall?: boolean;
}

interface ListContext {
  notify: () => void;
  clampWithAnchor: (id: string) => void;
}

type List = VirtuosoMessageListMethods<Row, ListContext>;

interface RowTrace {
  id: string;
  estimate: number | null;
  first: number | null;
  firstAt: number | null;
  h150: number | null;
  h500: number | null;
}

interface Frame {
  t: number;
  st: number;
  anchorTop: number | null;
}

interface Trace {
  mode: Mode;
  anchorId: string;
  anchorTop0: number;
  finalDrift: number | null;
  maxDrift: number;
  frames: Frame[];
  rows: RowTrace[];
}

declare global {
  interface Window {
    __list?: List | null;
    __traces?: Trace[];
  }
}

const isMode = (value: string | null): value is Mode => value !== null && Object.hasOwn(MODES, value);

const params = new URLSearchParams(window.location.search);
const modeParam = params.get('mode');
const MODE: Mode = isMode(modeParam) ? modeParam : 'shrink-effect';
const PAGE_SIZE = 20;
const MAX_PAGES = 8;
const FETCH_MS = 400;
const TRACE_MS = 1500;
const CLAMP_HEIGHT = 240;
const FIRST_SEQ = 1000;
// ?delay=100 postpones effect-based clamps, like a passive effect that runs late on a busy main thread.
const CLAMP_DELAY_MS = Number(params.get('delay') ?? 0);
const afterDelay = (callback: () => void): (() => void) | undefined => {
  if (!CLAMP_DELAY_MS) {
    callback();
    return undefined;
  }
  const timeout = setTimeout(callback, CLAMP_DELAY_MS);
  return () => clearTimeout(timeout);
};

const clampedIds = new Set<string>();
// The row at the top of the viewport when the current prepend started, while its trace runs.
let readerId: string | null = null;

const makeRow = (seq: number): Row => {
  const id = `row-${seq}`;
  if (MODE === 'uniform') return { id, seq, height: 300 };
  if (MODE === 'late-measure') {
    if (seq >= FIRST_SEQ) return { id, seq, height: 1000 };
    const fromEnd = PAGE_SIZE - 1 - (seq % PAGE_SIZE);
    return { id, seq, height: fromEnd === 0 ? 150 : fromEnd === 1 ? 250 : 600 };
  }
  return { id, seq, height: seq % 3 === 0 ? 1200 : 300, tall: seq % 3 === 0 };
};

const rowsBetween = (start: number, end: number): Row[] =>
  Array.from({ length: end - start }, (_, i) => makeRow(start + i));

interface BoxProps {
  height: number;
  label: string;
}

const Box = ({ height, label }: BoxProps) => (
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

interface ClampProps {
  clamped: boolean;
  innerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

const Clamp = ({ clamped, innerRef, children }: ClampProps) => (
  <div ref={innerRef} style={clamped ? { maxHeight: CLAMP_HEIGHT, overflow: 'hidden' } : undefined}>
    {children}
  </div>
);

const useClamp = (useSomeEffect: typeof useEffect): [RefObject<HTMLDivElement | null>, boolean] => {
  const ref = useRef<HTMLDivElement>(null);
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

interface RowProps {
  row: Row;
}

interface RowWithContextProps extends RowProps {
  context: ListContext;
}

const EffectClampRow = ({ row }: RowProps) => {
  const [ref, clamped] = useClamp(useEffect);
  return (
    <Clamp innerRef={ref} clamped={clamped}>
      <Box height={row.height} label={`${row.id} — 1200px, clamped in useEffect`} />
    </Clamp>
  );
};

const LayoutClampRow = ({ row }: RowProps) => {
  const [ref, clamped] = useClamp(useLayoutEffect);
  return (
    <Clamp innerRef={ref} clamped={clamped}>
      <Box height={row.height} label={`${row.id} — 1200px, clamped in useLayoutEffect`} />
    </Clamp>
  );
};

const NotifyClampRow = ({ row, context }: RowWithContextProps) => {
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

const AnchoredClampRow = ({ row, context }: RowWithContextProps) => {
  const ref = useRef<HTMLDivElement>(null);
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

const RowBody = ({ row, context }: RowWithContextProps) => {
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

const RowContent: ItemContent<Row, ListContext> = ({ data, context }) => (
  <div data-row-id={data.id} style={{ padding: '0 16px' }}>
    <RowBody row={data} context={context} />
  </div>
);

// Where the list places a row relative to the viewport top: its offset in the list's size cache minus scrollTop.
// Unlike a DOM read, this still works after the row unmounts because it moved out of the rendered window.
const rowTop = (list: List, scroller: HTMLElement, id: string): number | null => {
  const rows = list.data.get();
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return null;
  let offset = 0;
  for (const row of rows.slice(0, index)) offset += list.height(row);
  return offset - scroller.scrollTop;
};

const firstVisibleIndex = (scroller: HTMLElement): number => {
  const top = scroller.getBoundingClientRect().top;
  const visible = [...scroller.querySelectorAll<HTMLElement>('[data-index]')]
    .filter((element) => element.getBoundingClientRect().bottom > top + 1)
    .map((element) => Number(element.dataset.index));
  return visible.length ? Math.min(...visible) : 0;
};

// Records where the row at the top of the viewport sits before the prepend and for TRACE_MS after it, plus each
// prepended row's estimate (list.height) and its rendered height at first measurement, +150ms and +500ms.
const startTrace = (list: List, page: Row[], onDone: (trace: Trace) => void) => {
  const scroller = list.scrollerElement();
  if (!scroller) return;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const anchorId = [...scroller.querySelectorAll<HTMLElement>('[data-row-id]')].find(
    (element) => element.getBoundingClientRect().bottom > scrollerTop + 1
  )?.dataset.rowId;
  if (!anchorId) return;
  const anchorTop = rowTop(list, scroller, anchorId);
  if (anchorTop === null) return;
  readerId = anchorId;
  const anchorTop0 = Math.round(anchorTop);
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const frames: Frame[] = [];
  const rows = new Map<string, RowTrace>(
    page.map((row) => [row.id, { id: row.id, estimate: null, first: null, firstAt: null, h150: null, h500: null }])
  );

  const heightOf = (id: string): number | null => {
    const wrapper = scroller.querySelector(`[data-row-id="${id}"]`)?.parentElement;
    return wrapper ? Math.round(wrapper.getBoundingClientRect().height) : null;
  };
  // A row can unmount before the next ResizeObserver callback (when the jump moves it out of the rendered window), so
  // its first height is read when it is inserted.
  const recordFirst = (row: RowTrace, height: number) => {
    if (row.first !== null || height <= 0) return;
    row.first = height;
    row.firstAt = at();
    setTimeout(() => (row.h150 = heightOf(row.id)), 150);
    setTimeout(() => (row.h500 = heightOf(row.id)), 500);
  };
  const traceFor = (wrapper: Element): RowTrace | undefined => {
    const id = wrapper.querySelector<HTMLElement>('[data-row-id]')?.dataset.rowId;
    return id === undefined ? undefined : rows.get(id);
  };
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const row = traceFor(entry.target);
      const size = entry.borderBoxSize[0];
      if (row && size) recordFirst(row, Math.round(size.blockSize));
    }
  });
  const observeNew = () => {
    for (const wrapper of scroller.querySelectorAll<HTMLElement>('[data-index]')) {
      const row = traceFor(wrapper);
      if (row && !wrapper.dataset.traced) {
        wrapper.dataset.traced = '1';
        recordFirst(row, Math.round(wrapper.getBoundingClientRect().height));
        resizeObserver.observe(wrapper, { box: 'border-box' });
      }
    }
  };
  const mutationObserver = new MutationObserver(observeNew);
  mutationObserver.observe(scroller, { childList: true, subtree: true });

  let estimatesRead = false;
  const frame = () => {
    const t = at();
    if (!estimatesRead && list.data.find((row) => row.id === page[0]?.id)) {
      estimatesRead = true;
      for (const row of list.data.get()) {
        const trace = rows.get(row.id);
        if (trace) trace.estimate = list.height(row);
      }
    }
    const top = rowTop(list, scroller, anchorId);
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
    const startSt = frames[0]?.st ?? 0;
    const correction = frames.findIndex((f) => Math.abs(f.st - startSt) > 1);
    const drifts = (correction < 0 ? [] : frames.slice(correction)).flatMap((f) =>
      f.anchorTop === null ? [] : [f.anchorTop - anchorTop0]
    );
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
  const listRef = useRef<List>(null);
  const loadingRef = useRef(false);
  const oldestSeqRef = useRef(FIRST_SEQ);
  const [traces, setTraces] = useState<Trace[]>([]);
  useEffect(() => {
    window.__list = listRef.current;
  });
  const [listData, setListData] = useState<DataWithScrollModifier<Row>>(() => ({
    data: rowsBetween(FIRST_SEQ, FIRST_SEQ + PAGE_SIZE),
    scrollModifier: { type: 'item-location', location: { index: 'LAST', align: 'end' } },
  }));

  const loadOlder = useCallback(() => {
    if (loadingRef.current || oldestSeqRef.current <= FIRST_SEQ - PAGE_SIZE * MAX_PAGES) return;
    loadingRef.current = true;
    setTimeout(() => {
      const list = listRef.current;
      if (!list) {
        loadingRef.current = false;
        return;
      }
      const end = oldestSeqRef.current;
      oldestSeqRef.current = end - PAGE_SIZE;
      const page = rowsBetween(end - PAGE_SIZE, end);
      startTrace(list, page, (trace) => {
        window.__traces = [...(window.__traces ?? []), trace];
        setTraces((previous) => [...previous, trace]);
        loadingRef.current = false;
      });
      setListData((previous) => ({ data: [...page, ...(previous.data ?? [])], scrollModifier: 'prepend' }));
    }, FETCH_MS);
  }, []);

  const context = useMemo<ListContext>(
    () => ({
      notify: () => listRef.current?.notifyItemsChanged({ scrollToBottom: false }),
      clampWithAnchor: (id) => {
        const list = listRef.current;
        const scroller = list?.scrollerElement();
        if (!list || !scroller) return;
        clampedIds.add(id);
        // Mid-prepend, the first row in the DOM can be a new row, so anchor on the row the user was reading.
        const readerIndex = readerId === null ? -1 : list.data.findIndex((row) => row.id === readerId);
        const anchorIndex = readerIndex >= 0 ? readerIndex : firstVisibleIndex(scroller);
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
      <VirtuosoMessageListLicense licenseKey={import.meta.env.VITE_VIRTUOSO_LICENSE_KEY ?? ''}>
        <VirtuosoMessageList<Row, ListContext>
          ref={listRef}
          style={{ flex: 1 }}
          data={listData}
          context={context}
          itemIdentity={(row) => row.id}
          computeItemKey={({ data }) => data.id}
          ItemContent={RowContent}
          increaseViewportBy={200}
          onScroll={({ listOffset }) => {
            if (listOffset > -100) loadOlder();
          }}
        />
      </VirtuosoMessageListLicense>
    </div>
  );
};

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(<App />);
