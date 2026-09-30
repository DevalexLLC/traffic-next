import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  TrafficProvider,
  useTraffic,
  type TrafficProviderProps,
} from "../client/traffic-provider.js";
import { TrafficEvent, TrafficType, type TrafficEventInput } from "../models.js";

// The provider's whole contract is "what reaches the network, and when", so the
// tests drive it through `track` and read the transport rather than reaching
// into the queue ref.

interface Batch {
  sessionId: string;
  events: TrafficEventInput[];
}

type FetchMock = Mock<(input: string, init: RequestInit) => Promise<Response>>;
type BeaconMock = Mock<(url: string, body: Blob) => boolean>;

let fetchMock: FetchMock;
let beaconMock: BeaconMock;
let track: (draft: Parameters<ReturnType<typeof useTraffic>["track"]>[0]) => void;

/** A response good enough for the provider, which only reads `ok` and `status`. */
function reply(status = 204): Response {
  return { ok: status < 400, status } as Response;
}

function Probe() {
  track = useTraffic().track;
  return null;
}

function renderProvider(props: Omit<TrafficProviderProps, "children"> = {}) {
  return render(
    <TrafficProvider {...props}>
      <Probe />
    </TrafficProvider>,
  );
}

/**
 * Pin the draw `random()` takes from the CSPRNG, so a retry delay is an exact
 * number rather than a range and lands on an exact virtual timestamp.
 *
 * `backoff` is `ceiling / 2 + random() * (ceiling / 2)`: a draw of 0 puts the
 * delay on the floor of its window, and 0xffffffff just under the ceiling.
 */
function jitter(u32: number) {
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    if (array) new Uint32Array(array.buffer)[0] = u32;
    return array;
  });
}

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Run pending timers inside `act` so React sees the state the flush produces. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function sent(call = 0): Batch {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Batch;
}

/** An event of roughly `kb` kilobytes, all of it in `state`. */
function heavy(kb: number, title?: string) {
  return {
    event: TrafficEvent.OnRouteChanged,
    title,
    state: { blob: "x".repeat(kb * 1024) },
  };
}

function bytes(body: BodyInit | null | undefined): number {
  return new TextEncoder().encode(body as string).length;
}

/** Make the next fetch stay pending until the returned function settles it. */
function pending() {
  const { promise, resolve } = Promise.withResolvers<Response>();
  fetchMock.mockImplementationOnce(async () => promise);
  return (status = 204) => resolve(reply(status));
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => reply());
  beaconMock = vi.fn<(url: string, body: Blob) => boolean>(() => true);
  vi.stubGlobal("fetch", fetchMock);
  // jsdom implements no `sendBeacon` at all, so the provider's `typeof` guard
  // would take the fetch path forever without this.
  Object.defineProperty(navigator, "sendBeacon", { value: beaconMock, configurable: true });
  window.history.pushState({}, "", "/reports/usage");
  // Deterministic by default; the tests that care about the jitter itself set
  // their own draw.
  jitter(0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TrafficProvider", () => {
  it("batches events into one request per flush window", async () => {
    renderProvider({ flushIntervalMs: 5_000 });

    act(() => {
      track({ event: TrafficEvent.OnLogin });
      track({ event: TrafficEvent.OnRouteChanged });
    });
    // Still queued: the flush is debounced, not immediate.
    expect(fetchMock).not.toHaveBeenCalled();

    await advance(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().events).toHaveLength(2);
  });

  it("fills in the fields the caller does not supply", async () => {
    renderProvider({ staticState: { application_version: "1.2.3" } });

    act(() => {
      track({ event: TrafficEvent.OnApplicationLoad, state: { cold: true } });
    });
    await advance(5_000);

    const [event] = sent().events;
    expect(event).toMatchObject({
      type: TrafficType.Info,
      event: TrafficEvent.OnApplicationLoad,
      // Leading and trailing slashes stripped by `normalizeUri`.
      uri: "reports/usage",
      // `staticState` underneath, the caller's own `state` on top.
      state: { application_version: "1.2.3", cold: true },
    });
    expect(event?.browser).toBe(navigator.userAgent.slice(0, 128));
    expect(Date.parse(event?.date ?? "")).not.toBeNaN();
  });

  it("truncates a very long user agent to the schema's limit", async () => {
    const long = "Mozilla/5.0 ".repeat(40);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(long);
    renderProvider();

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(5_000);

    expect(sent().events[0]?.browser).toHaveLength(128);
  });

  it("lets the caller override the defaulted type and uri", async () => {
    renderProvider();

    act(() => {
      track({ event: TrafficEvent.OnLogout, type: TrafficType.Warn, uri: "explicit" });
    });
    await advance(5_000);

    expect(sent().events[0]).toMatchObject({ type: TrafficType.Warn, uri: "explicit" });
  });

  it("stamps one session id across separate flushes", async () => {
    renderProvider();

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(5_000);
    act(() => track({ event: TrafficEvent.OnLogout }));
    await advance(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(0).sessionId).toBe(sent(1).sessionId);
    expect(sent(0).sessionId).not.toBe("");
  });

  it("flushes immediately once the queue reaches its cap", () => {
    renderProvider({ flushIntervalMs: 60_000 });

    act(() => {
      for (let i = 0; i < 50; i += 1) track({ event: TrafficEvent.OnRouteChanged });
    });

    // No timer advance: hitting MAX_QUEUE flushes on the spot.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().events).toHaveLength(50);
  });

  it("sends nothing when the timer fires on an empty queue", async () => {
    renderProvider();
    await advance(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the endpoint it was last given, not the one it started with", async () => {
    const { rerender } = render(
      <TrafficProvider endpoint="/api/first">
        <Probe />
      </TrafficProvider>,
    );
    rerender(
      <TrafficProvider endpoint="/api/second">
        <Probe />
      </TrafficProvider>,
    );

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(5_000);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/second");
  });
});

describe("TrafficProvider page-exit drain", () => {
  it("drains through sendBeacon on pagehide", () => {
    renderProvider();

    act(() => track({ event: TrafficEvent.OnLogout }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(beaconMock).toHaveBeenCalledTimes(1);
    const [url, body] = beaconMock.mock.calls[0] ?? [];
    // A beacon cannot set headers, so the type has to ride on the Blob.
    expect(url).toBe("/api/traffic");
    expect(body?.type).toBe("application/json");
    // fetch is skipped entirely: a beacon is one shot with no retry.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drains when the tab is hidden but not when it is shown", () => {
    renderProvider();
    act(() => track({ event: TrafficEvent.OnRouteChanged }));

    setVisibility("visible");
    expect(beaconMock).not.toHaveBeenCalled();

    setVisibility("hidden");
    expect(beaconMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to fetch where sendBeacon is unavailable", () => {
    Object.defineProperty(navigator, "sendBeacon", { value: undefined, configurable: true });
    renderProvider();

    act(() => track({ event: TrafficEvent.OnLogout }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops draining after unmount", () => {
    const { unmount } = renderProvider();
    act(() => track({ event: TrafficEvent.OnLogin }));
    unmount();

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(beaconMock).not.toHaveBeenCalled();
  });

  it("cancels a pending flush on unmount", async () => {
    const { unmount } = renderProvider({ flushIntervalMs: 5_000 });
    act(() => track({ event: TrafficEvent.OnLogin }));
    unmount();

    await advance(60_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TrafficProvider failure handling", () => {
  it("requeues and retries after a server error", async () => {
    fetchMock.mockResolvedValueOnce(reply(500));
    renderProvider();

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Backoff for attempt 1 is [5s, 10s); 10s clears the whole window.
    await advance(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).events).toEqual(sent(0).events);
  });

  it("requeues after a network failure", async () => {
    // `mockImplementationOnce`, not `mockRejectedValueOnce`: the latter builds the
    // rejected promise up front, where nothing has attached a handler yet, and
    // Vitest reports it as an unhandled rejection.
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    renderProvider();

    act(() => track({ event: TrafficEvent.OnRouteChanged }));
    await advance(5_000);
    await advance(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off further on each successive failure", async () => {
    fetchMock.mockResolvedValue(reply(503));
    renderProvider({ flushIntervalMs: 1_000 });

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // With the jitter on its floor each window is exactly half its ceiling, so
    // the delays are 5s, then 10s, then 20s.
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await advance(19_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("stops growing the backoff once it reaches the cap", async () => {
    fetchMock.mockResolvedValue(reply(503));
    renderProvider({ flushIntervalMs: 1_000 });

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(1_000);
    // Each window is half its ceiling, doubling until the cap bites.
    await advance(5_000);
    await advance(10_000);
    await advance(20_000);
    await advance(40_000);
    await advance(80_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // Doubling would ask for 160s here; the 300s cap holds it at 150s.
    await advance(149_999);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it.each(["bytes", "events"])(
    "respects backoff when the queue reaches its %s limit",
    async (limit) => {
      fetchMock.mockResolvedValue(reply(503));
      renderProvider({ flushIntervalMs: 1_000 });

      act(() => {
        for (let i = 0; i < (limit === "bytes" ? 8 : 50); i += 1)
          track(limit === "bytes" ? heavy(8) : { event: TrafficEvent.OnRouteChanged });
      });
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await advance(1_000);
      act(() => track({ event: TrafficEvent.OnLogin }));
      await advance(3_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the retry deadline when new events arrive below the batch limits", async () => {
    fetchMock.mockResolvedValueOnce(reply(503));
    renderProvider({ flushIntervalMs: 1_000 });
    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(1_000);

    await advance(1_000);
    act(() => track({ event: TrafficEvent.OnLogout }));
    await advance(3_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).events.map((event) => event.event)).toEqual([
      TrafficEvent.OnLogin,
      TrafficEvent.OnLogout,
    ]);
  });

  it("keeps the retry delay when the system clock moves backwards", async () => {
    fetchMock.mockResolvedValueOnce(reply(503));
    renderProvider({ flushIntervalMs: 1_000 });
    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(1_000);

    vi.setSystemTime(Date.now() - 60 * 60 * 1_000);
    await advance(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the normal flush interval after a beacon drains a pending retry", async () => {
    fetchMock.mockResolvedValueOnce(reply(503));
    renderProvider({ flushIntervalMs: 1_000 });
    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(1_000);
    setVisibility("hidden");
    expect(beaconMock).toHaveBeenCalledTimes(1);
    await advance(5_000);

    setVisibility("visible");
    act(() => track({ event: TrafficEvent.OnLogout }));
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).events.map((event) => event.event)).toEqual([TrafficEvent.OnLogout]);
  });

  it.each([true, false])(
    "drains during backoff on unload (beacon available: %s)",
    async (hasBeacon) => {
      if (!hasBeacon)
        Object.defineProperty(navigator, "sendBeacon", { value: undefined, configurable: true });
      fetchMock.mockResolvedValueOnce(reply(503));
      renderProvider({ flushIntervalMs: 1_000 });
      act(() => track({ event: TrafficEvent.OnLogout }));
      await advance(1_000);

      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(beaconMock).toHaveBeenCalledTimes(hasBeacon ? 1 : 0);
      expect(fetchMock).toHaveBeenCalledTimes(hasBeacon ? 1 : 2);
    },
  );

  it.each([
    { bound: "floor", draw: 0 },
    { bound: "ceiling", draw: 0xff_ff_ff_ff },
  ])("keeps a first retry inside its window ($bound)", async ({ draw }) => {
    // Attempt 1's ceiling is 10s, so the delay must land in [5s, 10s) whatever
    // the CSPRNG returns.
    jitter(draw);
    fetchMock.mockResolvedValue(reply(500));
    renderProvider({ flushIntervalMs: 1_000 });

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Never sooner than the floor of the window...
    await advance(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ...and never later than its ceiling.
    await advance(5_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resets the backoff once a flush succeeds", async () => {
    fetchMock.mockResolvedValueOnce(reply(500));
    renderProvider({ flushIntervalMs: 1_000 });

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(1_000);
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Back to the configured interval rather than a backoff window.
    act(() => track({ event: TrafficEvent.OnLogout }));
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])("drops the batch on %i without retrying", async (status) => {
    fetchMock.mockResolvedValueOnce(reply(status));
    renderProvider();

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(5_000);
    await advance(300_000);

    // Retrying a dead session would hammer the auth path on every event.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])(
    "sends newer events after a slow %i without retrying the rejected batch",
    async (status) => {
      const finish = pending();
      renderProvider({ flushIntervalMs: 1_000 });
      act(() => track({ event: TrafficEvent.OnApplicationLoad }));
      await advance(1_000);

      act(() => track({ event: TrafficEvent.OnLogin }));
      // This timer fires while the first request is still in flight.
      await advance(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => finish(status));
      await advance(1_000);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sent(1).events.map((event) => event.event)).toEqual([TrafficEvent.OnLogin]);
      await advance(300_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("drops and logs a batch the server rejects as malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(reply(400));
    renderProvider();

    act(() => track({ event: TrafficEvent.OnLogin }));
    await advance(5_000);
    await advance(300_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("traffic: rejected batch dropped");
  });

  it("keeps the newest events when a requeue overflows the cap", async () => {
    fetchMock.mockResolvedValueOnce(reply(500));
    renderProvider({ flushIntervalMs: 1_000 });

    // 50 events fill the queue and flush on the spot; that batch then fails.
    act(() => {
      for (let i = 0; i < 50; i += 1)
        track({ event: TrafficEvent.OnRouteChanged, title: `old-${i}` });
    });
    // Ten newer events arrive while the failed batch is in flight.
    act(() => {
      for (let i = 0; i < 10; i += 1)
        track({ event: TrafficEvent.OnRouteChanged, title: `new-${i}` });
    });
    await advance(10_000);

    const titles = sent(1).events.map((event) => event.title);
    expect(titles).toHaveLength(50);
    // The oldest ten fell off the front; every newer event survived.
    expect(titles.slice(-10)).toEqual(Array.from({ length: 10 }, (_, i) => `new-${i}`));
    expect(titles).not.toContain("old-0");
    expect(titles).toContain("old-10");
  });
});

describe("TrafficProvider batch size", () => {
  // Browsers refuse a keepalive fetch or beacon past 64 KiB.
  const LIMIT = 64 * 1024;

  it("splits a queue too large for one request into requests under the limit", async () => {
    renderProvider({ flushIntervalMs: 1_000 });

    act(() => {
      for (let i = 0; i < 9; i += 1) track(heavy(8, `e${i}`));
    });
    await advance(1_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetchMock.mock.calls) expect(bytes(init.body)).toBeLessThan(LIMIT);

    // Every event arrives, once, in order.
    const titles = fetchMock.mock.calls.flatMap((_, i) => sent(i).events.map((e) => e.title));
    expect(titles).toEqual(Array.from({ length: 9 }, (_, i) => `e${i}`));
  });

  it("flushes as soon as the queue holds a request's worth of bytes", () => {
    renderProvider({ flushIntervalMs: 60_000 });

    // Far short of the 50-event cap, but past the byte budget.
    act(() => {
      for (let i = 0; i < 8; i += 1) track(heavy(8));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never has two requests in flight, since the browser's quota is shared", async () => {
    const finish = pending();
    renderProvider({ flushIntervalMs: 1_000 });

    act(() => {
      for (let i = 0; i < 9; i += 1) track(heavy(8));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // More events and more timer ticks while the first is outstanding.
    act(() => track({ event: TrafficEvent.OnLogout }));
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Once it settles, the rest follows.
    await act(async () => finish());
    await advance(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("carries on with the rest of the queue after a rejected batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(reply(400));
    renderProvider({ flushIntervalMs: 1_000 });

    act(() => {
      for (let i = 0; i < 9; i += 1) track(heavy(8, `e${i}`));
    });
    await advance(1_000);

    // The rejected batch is gone; the events after it were not in it.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(sent(fetchMock.mock.calls.length - 1).events.at(-1)?.title).toBe("e8");
  });

  it("drops an event too large for any request, and keeps the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderProvider();

    act(() => {
      track({ event: TrafficEvent.OnLogin });
      track(heavy(70));
      track({ event: TrafficEvent.OnLogout });
    });
    await advance(5_000);

    expect(warn).toHaveBeenCalledWith("traffic: event too large to send, dropped");
    expect(sent().events.map((e) => e.event)).toEqual([
      TrafficEvent.OnLogin,
      TrafficEvent.OnLogout,
    ]);
  });

  it("drops an event it cannot serialize instead of throwing at the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    renderProvider();

    act(() => {
      track({ event: TrafficEvent.OnLogin });
      expect(() => track({ event: TrafficEvent.OnRouteChanged, state: { id: 1n } })).not.toThrow();
      expect(() => track({ event: TrafficEvent.OnRouteChanged, state: { cycle } })).not.toThrow();
      track({ event: TrafficEvent.OnLogout });
    });
    await advance(5_000);

    expect(warn).toHaveBeenCalledWith("traffic: event cannot be serialized, dropped");
    expect(sent().events.map((e) => e.event)).toEqual([
      TrafficEvent.OnLogin,
      TrafficEvent.OnLogout,
    ]);
  });

  it("sends each event as it was when tracked, not as the caller later mutated it", async () => {
    renderProvider({ flushIntervalMs: 1_000 });
    const nested = Array.from({ length: 7 }, () => ({ blob: "x".repeat(8 * 1024) }));

    act(() => {
      for (const value of nested)
        track({ event: TrafficEvent.OnRouteChanged, state: { nested: value } });
    });
    // `state` is copied shallowly, so what sits below it is still the caller's;
    // growing it must not grow the request past the size it was measured at.
    for (const value of nested) value.blob += "y".repeat(2 * 1024);
    await advance(1_000);

    for (const [, init] of fetchMock.mock.calls) expect(bytes(init.body)).toBeLessThan(LIMIT);
    expect(sent().events[0]?.state).toEqual({ nested: { blob: "x".repeat(8 * 1024) } });
  });

  it("drains a large queue as several beacons, each under the limit", () => {
    // A queue only outgrows one request while a fetch is outstanding; the byte
    // threshold flushes it otherwise. That is also the realistic unload case.
    pending();
    renderProvider({ flushIntervalMs: 60_000 });

    act(() => {
      for (let i = 0; i < 16; i += 1) track(heavy(8));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(beaconMock.mock.calls.length).toBeGreaterThan(1);
    for (const [, blob] of beaconMock.mock.calls) expect(blob.size).toBeLessThan(LIMIT);
  });

  it("keeps what the browser refuses to beacon and sends it once the tab is back", async () => {
    beaconMock.mockReturnValueOnce(true).mockReturnValue(false);
    const finish = pending();
    renderProvider({ flushIntervalMs: 1_000 });

    act(() => {
      for (let i = 0; i < 16; i += 1) track(heavy(8, `e${i}`));
    });
    setVisibility("hidden");
    expect(beaconMock).toHaveBeenCalledTimes(2);

    // Not an unload after all: once the outstanding fetch settles, the ordinary
    // path picks up what the refused beacon left behind.
    await act(async () => finish());
    await advance(1_000);

    const fetched = fetchMock.mock.calls.flatMap((_, i) => sent(i).events.map((e) => e.title));
    expect(fetched.at(-1)).toBe("e15");
  });
});

describe("useTraffic", () => {
  it("returns a no-op outside a provider so a page never fails to render", () => {
    render(<Probe />);
    expect(() => {
      track({ event: TrafficEvent.OnLogin });
    }).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
