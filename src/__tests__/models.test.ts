import { describe, expect, it } from "vitest";

import { TrafficEvent, TrafficType, trafficBatchSchema, trafficEventSchema } from "../models.js";

const validEvent = {
  date: new Date().toISOString(),
  event: TrafficEvent.OnRouteChanged,
  uri: "dashboard",
};

describe("trafficEventSchema", () => {
  it("defaults type to Info", () => {
    const parsed = trafficEventSchema.parse(validEvent);
    expect(parsed.type).toBe(TrafficType.Info);
  });

  it("rejects an unknown event name", () => {
    // The whole point of the enum: a typo in a consumer splits the dashboards,
    // so it must fail here rather than reach the sink.
    expect(trafficEventSchema.safeParse({ ...validEvent, event: "OnRouteChange" }).success).toBe(
      false,
    );
  });

  it("rejects a non-ISO date", () => {
    expect(trafficEventSchema.safeParse({ ...validEvent, date: "2026-08-26" }).success).toBe(false);
  });

  it("caps state at 32 keys so a render loop cannot flood the sink", () => {
    const state = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1]));
    expect(trafficEventSchema.safeParse({ ...validEvent, state }).success).toBe(false);
  });

  it("accepts both scalar and list filter dimensions", () => {
    const parsed = trafficEventSchema.parse({
      ...validEvent,
      filters: { site: ["A", "B"], start: "2026-08-01T00:00:00.000Z" },
    });
    expect(parsed.filters).toEqual({
      site: ["A", "B"],
      start: "2026-08-01T00:00:00.000Z",
    });
  });

  it("carries no consumer-specific column names", () => {
    // This package is published publicly. Domain vocabulary belongs in the
    // consuming repo's forwarder, never in the wire schema.
    const keys = Object.keys(trafficEventSchema.shape);
    expect(keys).not.toContain("security_class_filter");
    expect(keys).not.toContain("enclave_filter");
  });
});

describe("trafficBatchSchema", () => {
  it("requires at least one event and caps the batch", () => {
    expect(trafficBatchSchema.safeParse({ sessionId: "x".repeat(12), events: [] }).success).toBe(
      false,
    );
    expect(
      trafficBatchSchema.safeParse({
        sessionId: "x".repeat(12),
        events: Array.from({ length: 51 }, () => validEvent),
      }).success,
    ).toBe(false);
  });
});
