import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RouteTracker } from "../client/route-tracker.js";
import { TrafficEvent } from "../models.js";

// `next/navigation`'s hooks need a Next router context that does not exist under
// vitest, so they are mocked and driven directly. `useTraffic` is left real: it
// falls back to a no-op outside a provider, and these tests supply their own
// spy through the mocked module below.
let pathname = "/reports/usage";
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
}));

const track = vi.fn<(draft: Record<string, unknown>) => void>();
vi.mock("../client/traffic-provider.js", () => ({
  useTraffic: () => ({ track }),
}));

/** Stands in for a consumer's own mapping of search params onto filter columns. */
function extractFilters(params: URLSearchParams) {
  return { site: params.getAll("site"), enclave: params.get("enclave") ?? "" };
}

/** The one event `track` was called with, or the nth of several. */
const event = (call = 0) => track.mock.calls[call]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
  track.mockClear();
  pathname = "/reports/usage";
  searchParams = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RouteTracker", () => {
  it("records the first render as an application load, with real navigation timing", () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { duration: 1234.6 } as PerformanceEntry,
    ]);

    render(<RouteTracker title="Usage" />);

    expect(track).toHaveBeenCalledTimes(1);
    expect(event()).toMatchObject({
      event: TrafficEvent.OnApplicationLoad,
      title: "Usage",
      loadtime_ms: 1235,
    });
  });

  it("omits load time when the browser reports no navigation entry", () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);

    render(<RouteTracker />);

    expect(event()).toMatchObject({ event: TrafficEvent.OnApplicationLoad });
    expect(event().loadtime_ms).toBeUndefined();
  });

  it("records later navigations as route changes carrying the previous page", () => {
    const { rerender } = render(<RouteTracker title="Usage" />);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    pathname = "/reports/detail";
    rerender(<RouteTracker title="Detail" />);

    expect(track).toHaveBeenCalledTimes(2);
    expect(event(1)).toMatchObject({
      event: TrafficEvent.OnRouteChanged,
      title: "Detail",
      state: { from: "/reports/usage", timeOnPage_ms: 30_000 },
    });
  });

  it("treats a search-param change as a navigation", () => {
    const { rerender } = render(<RouteTracker />);

    // Same pathname, different filters — the report pages re-query on this, so
    // it is a distinct thing the user did.
    searchParams = new URLSearchParams("site=A");
    rerender(<RouteTracker />);

    expect(track).toHaveBeenCalledTimes(2);
    expect(event(1)).toMatchObject({ event: TrafficEvent.OnRouteChanged });
  });

  it("spreads the caller's extracted filters onto the event", () => {
    searchParams = new URLSearchParams("site=A&site=B&enclave=prod");
    render(<RouteTracker extractFilters={extractFilters} />);

    expect(event()).toMatchObject({ site: ["A", "B"], enclave: "prod" });
  });

  it("records no filter context when the caller extracts none", () => {
    render(<RouteTracker />);

    expect(Object.keys(event())).toEqual(["event", "title", "loadtime_ms"]);
  });

  it("closes out the final page on unload so the last visit has a duration", () => {
    render(<RouteTracker />);
    act(() => {
      vi.advanceTimersByTime(45_000);
    });

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(track).toHaveBeenCalledTimes(2);
    expect(event(1)).toMatchObject({
      event: TrafficEvent.OnRouteChanged,
      state: { from: "/reports/usage", timeOnPage_ms: 45_000, final: true },
    });
  });

  it("stops closing out after unmount", () => {
    const { unmount } = render(<RouteTracker />);
    unmount();
    track.mockClear();

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(track).not.toHaveBeenCalled();
  });

  it("renders nothing, so it is safe to mount anywhere in the tree", () => {
    const { container } = render(<RouteTracker />);
    expect(container.innerHTML).toBe("");
  });
});
