---
"@devalexllc/traffic-next": minor
---

`RouteTracker` now sends what `extractFilters` returns as the event's nested
`filters`, which is where the wire schema reads it. Before, it was spread across
the top level of the event, so the route handler stripped every dimension and
`forward` never saw them, and a dimension named `event`, `state`, `title`, `uri`,
`type` or `date` overwrote that field of the event.

**Migration:** if you worked around this by returning `{ filters: { … } }` from
`extractFilters` (and casting to satisfy its type), return the dimensions flat
again. Left in place, the wrapper now nests one level too deep and the schema
rejects the batch.
