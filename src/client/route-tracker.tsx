"use client";

// src/client/route-tracker.tsx
//
// Separate component, not folded into the provider, for one reason:
// `useSearchParams()` opts the whole subtree into client-side rendering unless
// it sits under its own <Suspense>. Keeping it in a leaf means the provider can
// wrap the app without forcing every page out of static rendering.
//
// Mount it as:
//
//     <Suspense fallback={null}>
//       <RouteTracker />
//     </Suspense>

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { TrafficEvent } from "../models.js";
import { useTraffic } from "./traffic-provider.js";

export interface RouteTrackerProps {
  /**
   * Map the current search params onto the API's `*_filter` columns. Each app
   * decides — Illumina reads `site`, `enclave`, etc. from `searchParams`;
   * impulse's are different. Return `{}` to record no filter context.
   */
  extractFilters?: (params: URLSearchParams) => Record<string, string[] | string>;
  /** Page title for the event, if the app tracks one. */
  title?: string;
}

export function RouteTracker({ extractFilters, title }: RouteTrackerProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { track } = useTraffic();

  const previous = useRef<{ uri: string; enteredAt: number } | null>(null);
  const isFirst = useRef(true);

  useEffect(() => {
    const filters = extractFilters?.(searchParams) ?? {};
    const now = Date.now();

    if (isFirst.current) {
      isFirst.current = false;
      // Real load time, not a guess: navigation timing is already populated by
      // the time an effect runs.
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;

      track({
        event: TrafficEvent.OnApplicationLoad,
        title,
        loadtime_ms: nav ? Math.round(nav.duration) : undefined,
        ...filters,
      });
    } else {
      track({
        event: TrafficEvent.OnRouteChanged,
        title,
        state: {
          from: previous.current?.uri,
          timeOnPage_ms: previous.current ? now - previous.current.enteredAt : undefined,
        },
        ...filters,
      });
    }

    previous.current = { uri: pathname, enteredAt: now };
    // Search-param changes are real navigations here: the report pages re-query
    // on them, so a filter change is a distinct thing the user did.
  }, [pathname, searchParams, extractFilters, title, track]);

  useEffect(() => {
    // Close out the final page on unload so the last visit has a duration.
    const closeOut = () => {
      if (!previous.current) return;
      track({
        event: TrafficEvent.OnRouteChanged,
        state: {
          from: previous.current.uri,
          timeOnPage_ms: Date.now() - previous.current.enteredAt,
          final: true,
        },
      });
    };
    window.addEventListener("pagehide", closeOut);
    return () => window.removeEventListener("pagehide", closeOut);
  }, [track]);

  return null;
}
