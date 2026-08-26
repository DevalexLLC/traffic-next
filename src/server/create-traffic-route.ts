// src/server/create-traffic-route.ts
//
// The whole point of this factory is that the two things which legitimately
// differ between Illumina, impulse and any future Next app — where the session
// comes from, and how the Infralytics client is configured — are injected, and
// nothing else is. Each app's route file is then three lines.

import { after } from "next/server";

import { trafficBatchSchema, type TrafficEventInput } from "../models.js";

/** What the host app must tell us about the caller. */
export interface TrafficIdentity {
  /** Stamped onto every event. `undefined` means "not signed in" -> 401. */
  username: string | undefined;
  /** Optional: reject events from users entitled to nothing. */
  authorized?: boolean;
}

export interface TrafficRouteOptions {
  /** Usually `async () => { const s = await auth(); ... }`. */
  getIdentity: (request: Request) => Promise<TrafficIdentity>;
  /**
   * Ship one event to Infralytics. Receives the fully-stamped body, already
   * shaped like the API's `TrafficDto`. Must not throw for the caller's sake —
   * but if it does, we swallow it (see below).
   */
  forward: (body: TrafficPayload) => Promise<unknown>;
  /** Goes into `application`. Source this from the deployment overlay, not env. */
  application: string;
  /** Merged into `state` on every event: version, deployment, etc. */
  staticState?: Record<string, unknown>;
}

/**
 * The shape handed to the consumer's `forward`. Intentionally NOT the Infralytics
 * `TrafficDto`: this package is public, so it knows nothing about any particular
 * API's column names. Mapping `filters` onto real columns is the consumer's job.
 */
export interface TrafficPayload {
  date: string;
  application: string;
  username: string;
  ip_address?: string;
  type: string;
  event: string;
  uri?: string;
  title?: string;
  browser?: string;
  loadtime_ms?: number;
  state?: Record<string, unknown>;
  filters?: Record<string, string | string[]>;
}

const CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_EVENT_AGE_MS = 60 * 60 * 1000;

/**
 * Client clocks are wrong, sometimes wildly, and a bad `date` poisons every
 * time-bucketed query on the Infralytics side. Trust the client's ordering but
 * not its absolute value: clamp into a window around server time.
 */
function clampDate(clientDate: string, now: number): string {
  const t = Date.parse(clientDate);
  if (Number.isNaN(t) || t > now + CLIENT_CLOCK_SKEW_MS || t < now - MAX_EVENT_AGE_MS) {
    return new Date(now).toISOString();
  }
  return new Date(t).toISOString();
}

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  // Left-most entry is the original client; the rest are proxies. Only
  // meaningful because the app always sits behind a proxy we control.
  return forwarded?.split(",")[0]?.trim() || undefined;
}

export function createTrafficRoute({
  getIdentity,
  forward,
  application,
  staticState,
}: TrafficRouteOptions) {
  async function POST(request: Request): Promise<Response> {
    // 1. Authenticate. Unlike the SPA ingest path, this endpoint is never
    //    anonymous: it is same-origin and rides the session cookie, so there is
    //    no reason to accept an unidentified event.
    const identity = await getIdentity(request);
    const { username } = identity;
    if (!username) {
      return new Response(null, { status: 401 });
    }
    if (identity.authorized === false) {
      return new Response(null, { status: 403 });
    }

    // 2. Validate. `request.json()` throws on a malformed body, and an
    //    unhandled throw here would be a 500 on a path users hit constantly.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }

    const parsed = trafficBatchSchema.safeParse(raw);
    if (!parsed.success) {
      // Deliberately no error detail in the response: the client cannot act on
      // it, and echoing parse output back is free reconnaissance.
      return new Response(null, { status: 400 });
    }

    // 3. Stamp. Everything below overwrites whatever the client sent.
    const now = Date.now();
    const ip = clientIp(request);
    const { sessionId, events } = parsed.data;

    const bodies = events.map((event) =>
      toDto(event, {
        application,
        sessionId,
        username,
        ip,
        now,
        staticState,
      }),
    );

    // 4. Forward out-of-band. The user's browser gets its 204 immediately; an
    //    Infralytics outage degrades to dropped analytics, never to a slow or
    //    failing page. Nothing downstream of this point can affect the response.
    after(async () => {
      // Sequential on purpose. `Promise.all` would fire a whole batch — up to
      // 50 requests — at the sink at once, from every client, for data nobody
      // is waiting on. This runs outside the response, so the added latency
      // costs the user nothing.
      for (const body of bodies) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await forward(body);
        } catch (error) {
          console.error("traffic: forward failed", error);
        }
      }
    });

    return new Response(null, { status: 204 });
  }

  return { POST };
}

function toDto(
  event: TrafficEventInput,
  ctx: {
    application: string;
    sessionId: string;
    username: string;
    ip: string | undefined;
    now: number;
    staticState?: Record<string, unknown>;
  },
): TrafficPayload {
  const { state, date, type, event: name, filters, ...rest } = event;

  return {
    ...rest,
    filters,
    date: clampDate(date, ctx.now),
    type,
    event: name,
    application: ctx.application,
    username: ctx.username,
    ip_address: ctx.ip,
    state: {
      ...ctx.staticState,
      ...state,
      sessionId: ctx.sessionId,
    },
  };
}
