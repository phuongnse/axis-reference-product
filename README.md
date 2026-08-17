# Axis reference product

Independent enterprise reference consumer of the committed Axis `openapi.json` contract. The React application is served by its own ASP.NET Core .NET 10 BFF; the browser talks only to the product origin and never receives Axis access tokens, refresh tokens, authorization codes, or the confidential client secret.

The BFF owns:

- Authorization Code + PKCE with mandatory PAR and `openid profile email offline_access`;
- opaque Redis-backed `__Host-` browser sessions and a protected shared Data Protection key ring;
- Redis-serialized refresh concurrency across product instances;
- same-origin antiforgery for logout and every unsafe forwarded operation;
- a finite method/path/header forwarding allowlist to Axis using YARP direct forwarding;
- confidential client and certificate inputs supplied only by deployment configuration.

## Local development

Prerequisites are Node `24.18.0`, npm `11.16.0`, .NET SDK `10.0.302`, Docker, and the Axis checkout. Copy `.env.example` to the ignored `.env.local`, set `AXIS_PLATFORM_ROOT`, and replace the example client secret with at least 32 cryptographically random characters. The same secret is injected into the Axis client catalog and the product BFF; it is never committed.

Run `npm run local-dev:up`. The product overlay starts Axis and the BFF at `https://localhost:4173`. Use `local-dev:status`, `local-dev:logs`, `local-dev:recreate`, and `local-dev:down` so the deployment overlay and its confidential registration are always preserved.

When a signed release intentionally requires a clean local-data cutover, run `npm run local-dev:reset-all -- --yes`. This keeps the existing publisher signing identity, prepares the newly versioned immutable artifact from the committed source, destroys the product-owned local volumes, and recreates the recorded topology. The removed local data is not recoverable.

If the Docker deployment still belongs to this product but Axis's `.local/local-dev-topology.json` marker was lost, or the marker still records exactly this product overlay while its containers have drifted, run `npm run local-dev:recover-topology -- --yes`. This recovery reuses the preserved signing key and exact immutable solution artifact, asks Axis to rebuild and wait for only its API through the product overlay, and lets Axis restore the marker on success. It refuses invalid or different recorded topology and missing release state, and never changes the recorded topology; it does not check OpenAPI compatibility, generate release state, start the product, publish or install a solution, or delete volumes. After recovery, return to the normal product-owned commands above.

## Verification

Run `npm ci`, `npm run restore`, `npm run audit:dependencies`, `npm run check`, `npm run test:unit`, and `npm run test:e2e`. E2E runs in the repository-owned Playwright image with the Axis development CA imported into the browser trust store.

When this product owns the recorded Axis deployment topology, run Axis browser evidence through the same trusted wrapper with `npm run test:axis-e2e`. Forward an Axis Playwright selection after the runner separator, for example `npm run test:axis-e2e -- -- e2e/app-frame.pw.ts -g "AT-002"`. Intentional snapshot updates must also name the Axis runner's bounded output directory, for example `npm run test:axis-e2e -- --snapshot-output e2e/app-frame.pw.ts-snapshots -- e2e/app-frame.pw.ts --update-snapshots`. The wrapper preserves the product overlay and supplies its release identity without exposing or reconstructing deployment secrets.

Dependency installation is fail-closed: npm install scripts are restricted to exact reviewed package versions, NuGet restores use committed lock files and fail on published vulnerability advisories, and production/E2E container bases are digest-pinned. Renovate is the only automated version proposer; pull-request CI and the daily dependency-security workflow verify the locked graphs. The direct BFF dependencies use their published license expressions: Duende Access Token Management is Apache-2.0; Microsoft Data Protection Redis, StackExchange.Redis, and YARP are MIT.

When an approved .NET package change intentionally updates the restore graph, run `npm run sync:dotnet-lock` and commit the resulting `packages.lock.json` files with the manifest change. Ordinary restore and CI use locked mode and never rewrite that graph.
