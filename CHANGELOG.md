# @devalexllc/traffic-next

## 0.2.0

### Minor Changes

- 8dd27d9: `RouteTracker` now sends what `extractFilters` returns as the event's nested
  `filters`, which is where the wire schema reads it. Before, it was spread across
  the top level of the event, so the route handler stripped every dimension and
  `forward` never saw them, and a dimension named `event`, `state`, `title`, `uri`,
  `type` or `date` overwrote that field of the event.

  **Migration:** if you worked around this by returning `{ filters: { … } }` from
  `extractFilters` (and casting to satisfy its type), return the dimensions flat
  again. Left in place, the wrapper now nests one level too deep and the schema
  rejects the batch.

### Patch Changes

- fb52921: Size client batches in bytes as well as events. A batch is now capped at 60 KiB
  serialized, below the 64 KiB browsers allow a `keepalive` fetch or `sendBeacon`,
  and a larger queue is sent as consecutive requests, one in flight at a time. Before,
  a batch within the schema's limits could exceed that size; the browser refused it,
  the provider retried the identical payload, and the queue was lost on unload.

  Also: a beacon the browser refuses is put back on the queue instead of being
  silently discarded, a `400`, `401`, or `403` no longer holds back the events queued behind the
  rejected batch, and an event too large for any request is dropped with a warning.
  `track` no longer throws on a `state` that cannot be serialized, such as a BigInt
  or a circular reference; the event is dropped with a warning. Each event is sent
  as it was when tracked, so mutating nested `state` afterwards changes neither the
  payload nor its size.

  New events preserve the scheduled retry deadline, even when the queue reaches a
  batch limit. System-clock changes cannot extend the backoff, and a successful
  beacon drain clears the retry deadline so later events batch normally. Unload
  still gets a final send attempt during backoff.

## 0.1.2

### Patch Changes

- 586db4a: Document the release process in the README: publishing now uses npm trusted
  publishing rather than a stored token, and every release carries a provenance
  attestation. No runtime changes.

## ~~0.1.1~~ (unpublished)

Unpublished from npm on 2026-08-26 and never carried a runtime change; its
`dist` output was identical to 0.1.0. The version number is retired — npm does
not allow republishing an unpublished version — so nothing will occupy 0.1.1.

### Patch Changes

- ~~cb166cc: Publish with npm provenance. No runtime changes; `dist` output is
  identical to 0.1.0.~~

## 0.1.0

### Minor Changes

- Initial release: client `TrafficProvider` with a batching queue and beacon
  drain, `RouteTracker` for App Router navigations, and a `createTrafficRoute`
  factory for the first-party ingest handler.
