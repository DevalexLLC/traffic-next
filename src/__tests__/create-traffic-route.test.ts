import { beforeEach, describe, expect, it, vi } from "vitest";

import { TrafficEvent } from "../models.js";
import {
  createTrafficRoute,
  type TrafficIdentity,
  type TrafficPayload,
} from "../server/create-traffic-route.js";

// `after()` schedules work outside the response. In tests we want it to run
// inline so assertions can see the forwarded payloads.
vi.mock("next/server", () => ({
  after: (callback: () => Promise<void> | void): void => {
    void callback();
  },
}));

const forward = vi.fn<(body: TrafficPayload) => Promise<void>>();

function build(identity: TrafficIdentity = { username: "jdoe" }) {
  return createTrafficRoute({
    application: "TestApp",
    staticState: { application_version: "1.2.3" },
    getIdentity: async () => Promise.resolve(identity),
    forward,
  });
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/traffic", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const batch = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "session-abcdef",
  events: [
    {
      date: new Date().toISOString(),
      event: TrafficEvent.OnRouteChanged,
      uri: "dashboard",
      ...overrides,
    },
  ],
});

/** The body handed to `forward` on its nth call, with a clear failure if absent. */
function forwarded(index = 0) {
  const call = forward.mock.calls[index];
  if (!call) throw new Error(`forward was not called ${index + 1} time(s)`);

  return call[0];
}

beforeEach(() => {
  forward.mockReset();
  forward.mockResolvedValue(undefined);
});

describe("createTrafficRoute", () => {
  it("401s an unauthenticated caller and forwards nothing", async () => {
    const { POST } = build({ username: undefined });
    const response = await POST(request(batch()));
    expect(response.status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });

  it("403s an authenticated but unentitled caller", async () => {
    const { POST } = build({ username: "jdoe", authorized: false });
    expect((await POST(request(batch()))).status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it("400s a malformed body without throwing", async () => {
    const { POST } = build();
    expect((await POST(request("{not json"))).status).toBe(400);
  });

  it("400s a body that fails the schema", async () => {
    const { POST } = build();
    expect((await POST(request({ sessionId: "short", events: [] }))).status).toBe(400);
  });

  it("stamps identity server-side, overwriting anything the client sent", async () => {
    const { POST } = build();
    const response = await POST(
      request(
        {
          ...batch({
            username: "admin",
            application: "Spoofed",
            ip_address: "198.51.100.9",
          }),
        },
        { "x-forwarded-for": "203.0.113.7, 198.51.100.1" },
      ),
    );

    expect(response.status).toBe(204);
    expect(forward).toHaveBeenCalledTimes(1);
    const body = forwarded();
    expect(body.username).toBe("jdoe");
    expect(body.application).toBe("TestApp");
    // Left-most x-forwarded-for entry is the client; the rest are our proxies.
    expect(body.ip_address).toBe("203.0.113.7");
  });

  it("merges staticState under per-event state and pins sessionId", async () => {
    const { POST } = build();
    await POST(request(batch({ state: { from: "sla" } })));

    expect(forwarded().state).toEqual({
      application_version: "1.2.3",
      from: "sla",
      sessionId: "session-abcdef",
    });
  });

  it("clamps a client clock that is wildly wrong", async () => {
    const { POST } = build();
    const skewed = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    await POST(request(batch({ date: skewed })));

    const date = Date.parse(forwarded().date);
    expect(Math.abs(date - Date.now())).toBeLessThan(60_000);
  });

  it("keeps a plausible client date as sent", async () => {
    const { POST } = build();
    const recent = new Date(Date.now() - 30_000).toISOString();
    await POST(request(batch({ date: recent })));

    expect(forwarded().date).toBe(recent);
  });

  it("still returns 204 when the sink is down", async () => {
    forward.mockRejectedValue(new Error("infralytics unreachable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = build();

    // Analytics failure must never surface to the user's browser.
    expect((await POST(request(batch()))).status).toBe(204);
    consoleError.mockRestore();
  });
});
