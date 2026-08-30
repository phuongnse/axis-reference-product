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

For non-trivial delivery work, enter through the managed run-change skill and follow
the processctl lifecycle: start, plan, implement, verify, independent review, finish.

This repository owns product decisions, domain rules, exact argument-array commands,
merge policy, and release authority. The process owns only lifecycle transitions,
managed skills, evidence freshness, and rejection of self-review.

Do not edit .agents/skills or .process/adopt-process.py by hand. They are replaced by
the hash-locked engineering-process adoption in a dependency pull request.
<!-- engineering-process:end -->
