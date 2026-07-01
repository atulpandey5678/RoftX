# Implementation Plan: RoftX Platform

## Overview

This plan evolves the existing `roftx_backend/server.js` into a modular multi-user SaaS platform while preserving the AI generation workflow byte-for-byte. Work proceeds bottom-up: test tooling and configuration first, then schema, auth, persistence, quota/logging, the refactored generation service, optional billing, server composition/hardening, and finally the new frontend pages. Each step builds on the previous and ends by wiring everything into `server.js` so no code is orphaned.

Implementation language is **JavaScript (Node.js ESM)**, matching the existing backend. Property-based tests use `fast-check` (minimum 100 generated cases per property), one test per correctness property, each tagged with `// Feature: roftx-platform, Property {n}: {text}`. AI providers, the payment provider, and the database are mocked or run against an isolated transactional test DB so property tests are fast and deterministic.

## Tasks

- [x] 1. Set up test tooling and configuration foundation
  - [x] 1.1 Add property-based test tooling and module skeleton
    - Add `vitest` and `fast-check` as devDependencies and a `test` (single-run) script in `package.json`
    - Create the `roftx_backend/db/`, `roftx_backend/services/`, `roftx_backend/middleware/`, and `roftx_backend/test/` directories with placeholder index files
    - _Requirements: 1.1 (supporting test infrastructure)_

  - [x] 1.2 Implement `config.js`
    - Read env into a single config module exposing `JWT_SECRET`, the production secret validator, `ALLOWED_ORIGINS` sourced from configuration, `PLANS` (`free` allowance 25, `paid` allowance 500), `BILLING_ENABLED`, and the built-in default-secret constant
    - Implement `validateStartupSecret({ nodeEnv, jwtSecret })` that signals halt only when `nodeEnv === 'production'` and the secret is unset or equals the default
    - _Requirements: 2.1, 2.2, 3.3, 9.5, 14.5_

  - [ ]* 1.3 Write property test for startup secret validation
    - **Property 1: Production secret fail-safe**
    - **Validates: Requirements 2.1, 2.2**

- [x] 2. Implement database schema
  - [x] 2.1 Implement `db/schema.js` with idempotent `ensureSchema()`
    - Create `users` (with `plan`, `credits_remaining`, `created_at`, `updated_at` plus existing identity columns), `voice_profiles`, `posts`, `generations`, and `usage_quotas`, each child table holding a `user_id` foreign key referencing `users.id`
    - Make the operation idempotent and surface (not swallow) errors to the caller without corrupting existing data
    - _Requirements: 1.1, 1.2, 1.3, 1.6_

  - [ ]* 2.2 Write smoke test for schema creation and failure surfacing
    - Confirm all five tables, required columns, and foreign keys are created; assert a forced failure surfaces an error without data loss
    - _Requirements: 1.1, 1.2, 1.3, 1.6_

- [x] 3. Implement authentication middleware and token security
  - [x] 3.1 Implement `middleware/auth.js`
    - Implement `signSessionToken(payload)` signing with the configured `JWT_SECRET` and a 7-day expiry, and `authenticateToken` middleware returning 401 when no token, 403 when invalid/expired, and attaching `req.user = { userId, googleId, email }` on success
    - Implement ownership resolution that derives the user from the verified token (resolving by `googleId` when `userId` is null), never from request input
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 15.3, 15.4_

  - [ ]* 3.2 Write property test for token sign/verify round-trip and tamper rejection
    - **Property 2: Session token sign/verify round-trip and tamper rejection**
    - **Validates: Requirements 2.3, 2.4**

  - [ ]* 3.3 Write unit tests for protected-endpoint token handling
    - Assert missing token yields 401 and invalid/expired token yields 403 on a representative protected route
    - _Requirements: 2.5, 2.6_

- [x] 4. Implement persistence service (voice profiles, posts, search, account)
  - [x] 4.1 Implement core ownership-scoped CRUD in `db/persistence.js`
    - Implement voice profile save/list/delete and post create-or-update/finalize/list/delete, all scoped to the authenticated `userId`, using parameterized queries; preserve post content exactly and record/bump timestamps; cross-owner access yields 404; post listings ordered by `updated_at` desc
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 13.2, 15.1, 15.2_

  - [ ]* 4.2 Write property test for ownership-scoped reads
    - **Property 11: Ownership-scoped reads**
    - **Validates: Requirements 6.2, 7.3, 13.3, 15.1**

  - [ ]* 4.3 Write property test for cross-owner access isolation
    - **Property 12: Cross-owner access isolation**
    - **Validates: Requirements 6.3, 6.4, 7.4, 7.5, 15.2**

  - [ ]* 4.4 Write property test for persisted content round-trip
    - **Property 13: Persisted content round-trip and field preservation**
    - **Validates: Requirements 6.5, 7.1, 7.6, 13.2**

  - [ ]* 4.5 Write property test for the finalize transition
    - **Property 14: Finalize transition**
    - **Validates: Requirements 7.2**

  - [x] 4.6 Implement post-history search and status filter in `db/persistence.js`
    - Extend post listing to accept a search term (matching niche, topic, or content) and a status filter, combining both conjunctively and returning an empty list when nothing matches
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [ ]* 4.7 Write property test for combined search and status filter
    - **Property 18: Combined search and status filter**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4**

  - [x] 4.8 Implement account export, cascade delete, and field update in `db/persistence.js`
    - Implement export (profile + voice profiles + posts), account deletion that removes all rows owned by the user across `users`, `voice_profiles`, `posts`, and `generations`, and editable-field update bumping `updated_at`
    - _Requirements: 13.2, 13.3, 13.4_

  - [ ]* 4.9 Write property test for account deletion cascade completeness
    - **Property 19: Account deletion cascade completeness**
    - **Validates: Requirements 13.4**

  - [ ]* 4.10 Write property test for token-derived ownership at the service layer
    - **Property 21: Token-derived ownership**
    - **Validates: Requirements 15.3, 15.4**

- [x] 5. Implement generation event logging and quota enforcement
  - [x] 5.1 Implement generation event logging in `db/persistence.js`
    - Implement `appendGenerationEvent(userId, genType, timestamp)` stamping the `YYYY-MM` period from the timestamp (best-effort: log and swallow failures) and `getUsage(userId, period)` returning the count of that user's events in the period
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 5.2 Implement `services/quota.js`
    - Implement `getPeriod(date)`, `getAllowance(plan)`, `getUsage` delegation, and `enforce(userId, plan)` that reports exceeded when the current-period count has reached the plan allowance; expose a current-usage reporter returning `{ used, allowance, period }`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 5.3 Write property test for event counting and period stamping
    - **Property 15: Generation event counting and period stamping**
    - **Validates: Requirements 8.1, 8.2, 8.3, 9.3**

  - [ ]* 5.4 Write property test for quota enforcement before the AI call
    - **Property 16: Quota enforcement before AI call**
    - **Validates: Requirements 9.1, 9.2**

  - [ ]* 5.5 Write property test for allowance lookup and usage reporting
    - **Property 17: Allowance lookup and usage reporting**
    - **Validates: Requirements 9.4, 9.5, 14.5**

  - [ ]* 5.6 Write unit test for best-effort logging
    - Force a log-insert failure and assert the already-completed generation response still returns 200
    - _Requirements: 8.4_

- [x] 6. Checkpoint - core backend modules
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement generation service (dispatcher, parsers, orchestration)
  - [x] 7.1 Move the AI dispatcher into `services/generation.js` and implement the fallback condition
    - Relocate `callAI`/`callOpenAI`/`callClaude` unchanged; fall back to Claude if and only if the OpenAI error status is not 400 and Claude is configured, otherwise propagate the original error
    - _Requirements: 4.2_

  - [ ]* 7.2 Write property test for the provider fallback condition
    - **Property 4: Provider fallback condition**
    - **Validates: Requirements 4.2**

  - [x] 7.3 Implement tolerant parsers in `services/generation.js`
    - Implement `parseTopics` (whitespace/numbering/bracket tolerant), `parseHooks` (delimiter-variant tolerant), and `splitMeta` (marker split with full-text fallback when the marker is absent)
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 7.4 Write property test for topics parsing tolerance
    - **Property 7: Topics parsing tolerance**
    - **Validates: Requirements 5.1**

  - [ ]* 7.5 Write property test for hooks parsing tolerance
    - **Property 8: Hooks parsing tolerance**
    - **Validates: Requirements 5.2**

  - [ ]* 7.6 Write property test for structured parse failure signaling
    - **Property 9: Structured parse failure signals an error**
    - **Validates: Requirements 5.3**

  - [ ]* 7.7 Write property test for the metadata marker split round-trip
    - **Property 10: Metadata marker split round-trip**
    - **Validates: Requirements 5.4**

  - [x] 7.8 Implement `/api/generate` orchestration in `services/generation.js`
    - Map each type to its prompt builder and tier, validate required fields (400 naming the field with no AI call), enforce quota before the AI call (429 with no AI call), call the dispatcher, parse by type, append a best-effort generation event, optionally persist a `post` result, and return the preserved response shapes
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 7.1, 8.1, 9.1, 9.2_

  - [ ]* 7.9 Write property test for generation dispatch mapping
    - **Property 3: Generation dispatch maps type to builder and tier**
    - **Validates: Requirements 4.1, 4.3**

  - [ ]* 7.10 Write property test for missing-field rejection before any AI call
    - **Property 5: Missing required field is rejected before any AI call**
    - **Validates: Requirements 4.4**

  - [ ]* 7.11 Write property test for preserved response shapes
    - **Property 6: Preserved response shapes**
    - **Validates: Requirements 4.5**

- [x] 8. Implement optional billing service
  - [x] 8.1 Implement `services/billing.js` (gated by `BILLING_ENABLED`)
    - Implement checkout-session creation returning a redirect target, webhook signature verification, plan upgrade on verified success, downgrade to free at period end on cancel/expire, and rejection (400, no plan change) on unverifiable signatures; treat every user as Free when billing is disabled
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [ ]* 8.2 Write property test for the webhook signature fail-safe
    - **Property 20: Webhook signature fail-safe**
    - **Validates: Requirements 14.4**

  - [ ]* 8.3 Write unit tests for billing plan transitions
    - Assert verified success upgrades the plan and cancel/expire downgrades to free at period end
    - _Requirements: 14.2, 14.3_

- [x] 9. Compose and harden `server.js`
  - [x] 9.1 Wire startup hardening and middleware into `server.js`
    - Run the production secret validator at boot (halt on failure), source the CORS allow-list from `config.js` (block and log disallowed origins in production), preserve no-DB tolerance (serve `/` and `/api/config` with `database: unavailable`), and set new-user defaults (Free plan, Free allowance) in the Google auth upsert
    - _Requirements: 1.4, 1.5, 2.1, 3.1, 3.2, 3.3_

  - [x] 9.2 Register all authenticated routes in `server.js`
    - Mount `authenticateToken` on `/api/generate` and the legacy `/api/gemini` (auth required before any AI call), and register the persistence/quota/account/billing endpoints (voice-profiles, posts, finalize, usage, export, account update/delete, billing checkout/webhook) wired to their service modules
    - _Requirements: 3.4, 3.5, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5, 9.4, 13.1, 13.2, 13.3, 13.4, 15.1, 15.2, 15.3, 15.4_

  - [ ]* 9.3 Write property test for token-derived ownership across registered endpoints
    - **Property 21: Token-derived ownership**
    - **Validates: Requirements 15.3, 15.4**

  - [ ]* 9.4 Write integration tests for boot, CORS, and legacy endpoint auth
    - No-DB boot serves health/config and reports `database: unavailable`; allow-listed origin receives CORS headers while a production disallowed origin is blocked and logged; legacy `/api/gemini` rejects unauthenticated calls before the dispatcher
    - _Requirements: 1.5, 3.1, 3.2, 3.5_

- [x] 10. Checkpoint - full backend
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Build frontend platform pages
  - [x] 11.1 Create `dashboard.html`
    - List posts with status/niche/topic, copy/delete actions, draft resume into `generator.html`, voice profile list, usage vs allowance, New Post action, search + status filter with empty-result indication; redirect unauthenticated visitors to `signup.html` and render a sign-in prompt if the redirect cannot occur
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 12.4_

  - [x] 11.2 Extend `generator.html` with voice profile selection
    - Offer the user's saved voice profiles, supply a selected profile to hook/post/refine/regenerate requests, preserve the writing-sample step when none is selected, and fall back to the writing-sample step automatically when a selected profile cannot be supplied
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 11.3 Create `account.html`
    - Display name/email/plan/current usage, support editable fields, data export, and account deletion; redirect unauthenticated visitors to `signup.html`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

- [x] 12. Final checkpoint - ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints provide incremental validation at natural boundaries.
- Property tests (Properties 1-21) validate the universal correctness properties from the design with `fast-check` (min 100 cases each); unit, integration, smoke, and UI behaviors are covered by example tests per the design's Testing Strategy.
- The check order in `/api/generate` is fixed and security-relevant: auth → field validation → quota → AI call → parse → persist/log.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["1.3", "2.2", "3.1", "4.1", "7.1", "8.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "4.2", "4.3", "4.4", "4.5", "4.6", "7.2", "7.3", "8.2", "8.3"] },
    { "id": 3, "tasks": ["4.7", "4.8", "7.4", "7.5", "7.6", "7.7"] },
    { "id": 4, "tasks": ["4.9", "4.10", "5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "5.6"] },
    { "id": 6, "tasks": ["5.4", "5.5"] },
    { "id": 7, "tasks": ["7.8"] },
    { "id": 8, "tasks": ["7.9", "7.10", "7.11"] },
    { "id": 9, "tasks": ["9.1"] },
    { "id": 10, "tasks": ["9.2"] },
    { "id": 11, "tasks": ["9.3", "9.4", "11.1", "11.2", "11.3"] }
  ]
}
```
