# @devalexllc/traffic-next

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
