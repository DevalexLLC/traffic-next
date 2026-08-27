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
//  - It batches. One request per flush window instead of one per event.

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
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 300_000;

export function TrafficProvider({
  endpoint = "/api/traffic",
  staticState,
  flushIntervalMs = 5_000,
  children,
}: Readonly<TrafficProviderProps>) {
  const queue = useRef<TrafficEventInput[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);
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

  const flush = useCallback(
    (useBeacon = false) => {
      if (queue.current.length === 0) return;

      const events = queue.current.splice(0, MAX_QUEUE);
      const payload = JSON.stringify({ sessionId: sessionId.current, events });

      // Page is going away: one shot, fire-and-forget, no retry possible.
      if (useBeacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
        return;
      }

      void fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        // Survives a navigation started moments after the call.
        keepalive: true,
      })
        .then((response) => {
          if (response.ok) {
            retries.current = 0;
            return;
          }
          // 401/403 mean the session is gone or un-entitled. Retrying cannot fix
          // that and would hammer the auth path on every event; drop instead.
          if (response.status === 401 || response.status === 403) return;
          // 400 means we built something the schema rejects — a bug on this
          // side. Retrying sends the same bad payload forever. Drop and log.
          if (response.status === 400) {
            console.warn("traffic: rejected batch dropped");
            return;
          }
          requeue(events);
        })
        .catch(() => {
          requeue(events);
        });

      function requeue(failed: TrafficEventInput[]) {
        // Newest events matter most; drop the oldest on overflow.
        queue.current = [...failed, ...queue.current].slice(-MAX_QUEUE);
        retries.current += 1;
        schedule(backoff(retries.current));
      }
    },
    [endpoint, schedule],
  );

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const track = useCallback(
    (draft: EventDraft) => {
      queue.current.push({
        type: TrafficType.Info,
        uri: normalizeUri(window.location.pathname),
        ...draft,
        date: new Date().toISOString(),
        browser: navigator.userAgent.slice(0, 128),
        state: { ...staticState, ...draft.state },
      });

      if (queue.current.length >= MAX_QUEUE) flush();
      else schedule(retries.current > 0 ? backoff(retries.current) : flushIntervalMs);
    },
    [flush, flushIntervalMs, schedule, staticState],
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
