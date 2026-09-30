---
"@devalexllc/traffic-next": patch
---

Size client batches in bytes as well as events. A batch is now capped at 60 KiB
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
