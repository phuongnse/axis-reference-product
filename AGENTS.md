# Axis Reference Product Agent Contract

This repository is an independent enterprise consumer of the committed Axis public
contract. Keep product behavior and verification owned here; do not depend on Axis
implementation projects, internal types, repository skills, or uncommitted state.

## Source order

1. The user request and committed product behavior in README.md.
2. This file.
3. The committed openapi.json and solution release contract.
4. Same-module source and tests.
5. Agent judgment.

Surface conflicts instead of inventing endpoints, credentials, compatibility, release
identity, or product behavior.

## Critical rules

- The browser talks only to the product origin and never receives Axis access tokens,
  refresh tokens, authorization codes, or the confidential client secret.
- Preserve mandatory PAR, Authorization Code with PKCE, opaque Redis-backed sessions,
  refresh concurrency, antiforgery, and the finite forwarding allowlist.
- Production code and release artifacts depend only on committed Axis public contracts.
  Cross-repository work uses immutable checkpoints or versions, never sibling internal
  source. The explicitly documented local-development adapter may invoke an exact Axis
  checkout through `AXIS_PLATFORM_ROOT`; that checkout is not a build or release input.
- Keep solution release identity immutable. Version changes are intentional publication
  decisions; development snapshots and destructive data reset are separate actions.
- Never run reset-all, replace signing identity, change credentials, or mutate persisted
  topology without explicit user approval.
- Keep dependency installation locked and fail closed on applicable vulnerability gates.
- Missing, stale, indirect, or blocked evidence is not a pass.

## Verification

- Development: processctl verify --project-root . --profile development
- Review: processctl verify --project-root . --profile review

The review profile does not replace required runtime E2E evidence. Use the repository
wrappers documented in README.md when the affected acceptance boundary requires it.

<!-- engineering-process:start -->
## Engineering process

Use the portable skills pinned by `.process/process.lock` for every non-trivial
change. Enter through `run-change` and use `processctl change ...` for specification,
planning, implementation registration, checkpoint verification, independent review,
finding resolution, and completion.

The project owns product decisions, domain contracts, exact verification commands,
and publication authority. The process distribution owns lifecycle semantics and
managed skills. Do not edit managed skills in this repository; update the pinned
distribution and synchronize them instead.

Independent review requires an attested read-only actor and context that did not
implement the current cycle. No particular agent host is required. Missing or stale
evidence, self-review, and publication without separate authorization are blocking.
<!-- engineering-process:end -->
