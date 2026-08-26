// src/models.ts
//
// The event vocabulary is deliberately identical to
// infralytics-cfe/packages/traffic/src/models/traffic.model.ts so that traffic
// from the SPAs and from the Next apps aggregates into one dataset. If this
// list and that one ever drift, the Infralytics dashboards silently split.
//
// Longer term this file (and only this file) is the thing to extract into a
// `traffic-core` package that both the SPA provider and this one depend on.

import { z } from "zod";

export enum TrafficType {
  Error = "Error",
  Info = "Info",
  Warn = "Warn",
  Debug = "Debug",
}

export enum TrafficEvent {
  // Shared with the SPA packages — do not rename.
  OnApplicationLoad = "OnApplicationLoad",
  OnLogin = "OnLogin",
  OnLogout = "OnLogout",
  OnRouteChanged = "OnRouteChanged",
  OnSilentLogin = "OnSilentLogin",
  OnSilentRenew = "OnSilentRenew",
  OnNewApplicationUser = "OnNewApplicationUser",
  // Next-only: server-side events the browser never sees.
  OnServerAction = "OnServerAction",
  OnReportDownloaded = "OnReportDownloaded",
}

// ---------------------------------------------------------------------------
// The wire contract: browser -> /api/traffic
// ---------------------------------------------------------------------------
//
// This schema describes ONLY what the client is allowed to assert. Identity
// (`username`), origin (`ip_address`) and provenance (`application`) are
// stamped server-side and are absent here on purpose: anything the browser can
// set, the browser can lie about, and this endpoint is authenticated but not
// trusted. Same posture as `toSiteAlternation()` on the query side.

/** Free-form per-event detail. Bounded so a loop in a client cannot flood Mongo. */
const stateSchema = z
  .record(z.string().max(64), z.unknown())
  .refine((s) => Object.keys(s).length <= 32, {
    message: "state has too many keys",
  });

/**
 * Filter/context dimensions the host app wants grouped in reporting.
 *
 * Deliberately generic. This package is published to public npm, so it must not
 * carry any consumer's domain vocabulary — the column names live in the
 * consuming repo's forwarder, not here. It is also simply more correct: each app
 * filters on different things.
 */
const filters = z
  .record(z.string().max(64), z.union([z.string().max(128), z.array(z.string().max(128)).max(64)]))
  .refine((f) => Object.keys(f).length <= 24, {
    message: "too many filter dimensions",
  });

export const trafficEventSchema = z.object({
  /**
   * When the event happened, not when it was flushed. The queue can hold events
   * across a backoff window, so the client must stamp this at creation time.
   * The route handler clamps it — see `create-traffic-route.ts`.
   */
  date: z.iso.datetime(),
  type: z.enum(TrafficType).default(TrafficType.Info),
  event: z.enum(TrafficEvent),
  /** Path only, no origin, no query string. Normalised client-side. */
  uri: z.string().max(512),
  title: z.string().max(256).optional(),
  browser: z.string().max(128).optional(),
  loadtime_ms: z.number().int().nonnegative().max(600_000).optional(),
  state: stateSchema.optional(),

  filters: filters.optional(),
});

export type TrafficEventInput = z.infer<typeof trafficEventSchema>;

/**
 * A flush is always a batch, even of one. `sendBeacon` gets exactly one shot on
 * `pagehide`, so the queue has to be drainable in a single request.
 */
export const trafficBatchSchema = z.object({
  /** Stable per browser tab. Correlates events into a session. */
  sessionId: z.string().min(8).max(64),
  events: z.array(trafficEventSchema).min(1).max(50),
});

export type TrafficBatch = z.infer<typeof trafficBatchSchema>;
