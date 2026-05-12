# Integration Tests

This directory holds end-to-end style tests for the **stability hardening**
feature (`specs/001-stability-hardening`). They are still picked up by
`npm run test` (the test runner globs `build/tests/**/*.test.js`), but each
case is named `*.it.test.ts` so they can be filtered out from quick local
loops:

```bash
# Run only one integration test (after build):
npm run test:no-build tests/integration/longSession.it.test.ts

# Run all integration tests:
npm run test:no-build "tests/integration/**/*.it.test.ts"
```

## Conventions

- Each file owns one user-story SC scenario (e.g. `longSession.it.test.ts`
  exercises SC-001).
- Long-running scenarios are scaled down for CI but still asserted on the
  same shape (e.g. SC-001's 1-hour session is replayed as a 5-minute run).
- Tests SHOULD use `node:test` `describe` / `it` (no extra deps).
- Real Chrome usage is allowed only when the underlying capability cannot
  be mocked (browser crash recovery, full-page screenshot). Keep the
  amortised wall time of the suite below 5 minutes.
- The 8-hour soak workload (SC-006) lives in `scripts/soak-8h.ts` and is
  **not** run by the default test runner.

## Status

| Suite                      | Task | Status |
| -------------------------- | ---- | ------ |
| `longSession.it.test.ts`   | T015 | TODO   |
| `largeArtifact.it.test.ts` | T030 | TODO   |
| `browserCrash.it.test.ts`  | T048 | TODO   |
| `oomGuard.it.test.ts`      | T064 | TODO   |
