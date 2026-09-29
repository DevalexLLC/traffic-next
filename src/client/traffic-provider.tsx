"use client";

// src/client/traffic-provider.tsx
//
// Differences from infralytics-cfe/packages/traffic's provider, all deliberate:
//
//  - It knows nothing about OIDC. No localStorage token read, no Authorization
//    header. It posts same-origin and the httpOnly session cookie does the work,
//    which is what lets `sendBeacon` work at all (a beacon cannot set headers).
//  - The queue lives in a ref, not in state. The SPA version keeps `logList` in
//    `useState`, so every enqueue re-renders the whole app subtree.
//  - It batches. One request per flush window instead of one per event, and
//    each request is sized in bytes as well as events — see MAX_BATCH_BYTES.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";

import { TrafficType, type TrafficEventInput } from "../models.js";

type EventDraft = Omit<TrafficEventInput, "date" | "uri" | "type" | "browser"> &
  Partial<Pick<TrafficEventInput, "type" | "uri">>;

interface TrafficContextValue {
  /** Record an arbitrary event. Never throws, never awaits the network. */
  track: (draft: EventDraft) => void;
}

const TrafficContext = createContext<TrafficContextValue | null>(null);

export interface TrafficProviderProps {
  /** First-party ingest route. Same origin, always. */
  endpoint?: string;
  /** Merged into `state` on every event. Version, deployment name, etc. */
  staticState?: Record<string, unknown>;
  /** Debounce window before a flush. */
  flushIntervalMs?: number;
  children: React.ReactNode;
}

const MAX_QUEUE = 50;
/**
 * Browsers refuse a `keepalive` fetch or a `sendBeacon` past 64 KiB — and the
 * limit covers every such request *in flight together*, not each one alone.
 * Counting events is not enough: the schema lets fifty of them add up to well
 * over a megabyte, and a batch the browser refuses would otherwise be retried,
 * refused again, and lost with the page. Sixty leaves room for the other
 * requests a page may have in flight against the same quota.
 */
const MAX_BATCH_BYTES = 60 * 1024;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 300_000;

const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** An event with its serialized size, measured once at enqueue. */
interface Queued {
  event: TrafficEventInput;
  bytes: number;
}

export function TrafficProvider({
  endpoint = "/api/traffic",
  staticState,
  flushIntervalMs = 5_000,
  children,
}: Readonly<TrafficProviderProps>) {
  const queue = useRef<Queued[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);
  // At most one `keepalive` fetch at a time, for the quota reason given on
  // MAX_BATCH_BYTES: two batches that each fit can still fail together.
  const inFlight = useRef(false);
  // Stable for the life of the tab. `crypto.randomUUID` is available in every
  // browser we support and needs no cuid dependency.
  const sessionId = useRef<string>("");
  if (!sessionId.current && typeof crypto !== "undefined") {
    sessionId.current = crypto.randomUUID();
  }

  // `schedule` and `flush` are mutually recursive: a failed flush schedules a
  // retry, and a scheduled timer flushes. Wiring them directly makes an
  // impossible dependency cycle, and leaving `schedule` out of `flush`'s deps —
  // as this first did — means `flush` keeps calling the *first* `schedule`,
  // which calls the *first* `flush`, which still posts to the old `endpoint`
  // after a change. The ref breaks the cycle: `schedule` reads whichever
  // `flush` is current, so it needs no dependencies of its own.
  const flushRef = useRef<(useBeacon?: boolean) => void>(() => undefined);

  const schedule = useCallback((delayMs: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      flushRef.current();
    }, delayMs);
  }, []);

  /** Size of the `{ sessionId, events: [] }` envelope a batch is sent in. */
  const envelopeBytes = useCallback(
    () => byteLength({ sessionId: sessionId.current, events: [] }),
    [],
  );

  /**
   * Take the longest run from the front of the queue that fits one request:
   * no more than MAX_QUEUE events and no more than MAX_BATCH_BYTES serialized.
   * `track` refuses any event too large to fit on its own, so this always
   * takes at least one from a non-empty queue.
   */
  const takeBatch = useCallback((): Queued[] => {
    let size = envelopeBytes();
    let count = 0;

    for (const { bytes } of queue.current) {
      // One comma between array elements.
      const added = bytes + (count > 0 ? 1 : 0);
      if (count >= MAX_QUEUE || size + added > MAX_BATCH_BYTES) break;
      size += added;
      count += 1;
    }

    return queue.current.splice(0, count);
  }, [envelopeBytes]);

  const serialize = useCallback(
    (batch: Queued[]) =>
      JSON.stringify({ sessionId: sessionId.current, events: batch.map(({ event }) => event) }),
    [],
  );

  const flush = useCallback(
    (useBeacon = false) => {
      if (queue.current.length === 0) return;

      // Page is going away: fire-and-forget, no retry possible. Send batches
      // until the browser stops taking them. Beacons share one quota, so once
      // one is refused the rest would be too; put it back rather than drop it.
      // `visibilitychange` is not always an unload, and a tab that comes back
      // sends what is left through the ordinary path.
      if (useBeacon && typeof navigator.sendBeacon === "function") {
        while (queue.current.length > 0) {
          const batch = takeBatch();
          const blob = new Blob([serialize(batch)], { type: "application/json" });
          if (!navigator.sendBeacon(endpoint, blob)) {
            queue.current = [...batch, ...queue.current];
            return;
          }
        }
        return;
      }

      // The response handler picks the queue back up; see `inFlight`.
      if (inFlight.current) return;

      const batch = takeBatch();
      inFlight.current = true;

      void fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialize(batch),
        // Survives a navigation started moments after the call.
        keepalive: true,
      })
        .then((response) => {
          inFlight.current = false;
          if (response.ok) {
            retries.current = 0;
            sendRest();
            return;
          }
          // 401/403 mean the session is gone or un-entitled. Retrying cannot fix
          // that and would hammer the auth path on every event; drop instead.
          if (response.status === 401 || response.status === 403) return;
          // 400 means we built something the schema rejects — a bug on this
          // side. Retrying sends the same bad payload forever. Drop and log,
          // but carry on with the rest: they were not in this batch.
          if (response.status === 400) {
            console.warn("traffic: rejected batch dropped");
            sendRest();
            return;
          }
          requeue(batch);
        })
        .catch(() => {
          inFlight.current = false;
          requeue(batch);
        });

      // A queue larger than one request goes out as consecutive requests, each
      // started only once the last has finished.
      function sendRest() {
        if (queue.current.length > 0) flushRef.current();
      }

      function requeue(failed: Queued[]) {
        // Newest events matter most; drop the oldest on overflow.
        queue.current = [...failed, ...queue.current].slice(-MAX_QUEUE);
        retries.current += 1;
        schedule(backoff(retries.current));
      }
    },
    [endpoint, schedule, serialize, takeBatch],
  );

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const track = useCallback(
    (draft: EventDraft) => {
      const event: TrafficEventInput = {
        type: TrafficType.Info,
        uri: normalizeUri(window.location.pathname),
        ...draft,
        date: new Date().toISOString(),
        browser: navigator.userAgent.slice(0, 128),
        state: { ...staticState, ...draft.state },
      };
      const bytes = byteLength(event);

      // No request could ever carry it, and queueing it would stall everything
      // behind it. The schema bounds most fields but not `state` values.
      if (envelopeBytes() + bytes > MAX_BATCH_BYTES) {
        console.warn("traffic: event too large to send, dropped");
        return;
      }

      queue.current.push({ event, bytes });
      // Bounded even while a request is in flight: newest events matter most.
      if (queue.current.length > MAX_QUEUE) queue.current.shift();

      const queuedBytes = queue.current.reduce((total, queued) => total + queued.bytes, 0);
      if (queue.current.length >= MAX_QUEUE || queuedBytes >= MAX_BATCH_BYTES) flush();
      else schedule(retries.current > 0 ? backoff(retries.current) : flushIntervalMs);
    },
    [envelopeBytes, flush, flushIntervalMs, schedule, staticState],
  );

  useEffect(() => {
    // `pagehide` fires where `beforeunload` is unreliable (bfcache, mobile);
    // `visibilitychange` catches tab-switching, which on mobile is often the
    // last event we ever get. Both drain via beacon.
    const drain = () => flush(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") drain();
    };

    window.addEventListener("pagehide", drain);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", drain);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush]);

  const value = useMemo(() => ({ track }), [track]);

  return <TrafficContext.Provider value={value}>{children}</TrafficContext.Provider>;
}

export function useTraffic(): TrafficContextValue {
  const context = useContext(TrafficContext);
  // A no-op fallback rather than a throw: analytics must never be the reason a
  // page fails to render, and tests should not need the provider.
  return context ?? { track: () => undefined };
}

/**
 * Uniform value in [0, 1) from the platform CSPRNG.
 *
 * Retry jitter has no security requirement, so `Math.random()` would be
 * perfectly correct here — but it is a standing Sonar hotspot (S2245) that
 * someone has to re-triage on every scan. `crypto` is already a hard dependency
 * of this file for the session id, so this costs nothing and removes the
 * finding rather than suppressing it.
 */
function random(): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return (value ?? 0) / 2 ** 32;
}

function backoff(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return ceiling / 2 + random() * (ceiling / 2);
}

/**
 * Strip leading and trailing slashes.
 *
 * Deliberately not a regex. `/^\/+|\/+$/` backtracks super-linearly (S5852),
 * and `pathname` is not as trusted as it looks — anyone can hand a user a link
 * with a few thousand leading slashes, and hanging the tab on a tracking call
 * would be an absurd way to lose a session.
 */
function normalizeUri(pathname: string): string {
  let start = 0;
  let end = pathname.length;

  while (start < end && pathname[start] === "/") start += 1;
  while (end > start && pathname[end - 1] === "/") end -= 1;

  return pathname.slice(start, end).trim();
}
