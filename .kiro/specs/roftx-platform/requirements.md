# Requirements Document

## Introduction

RoftX today is an AI-assisted LinkedIn post generator built from vanilla HTML/CSS/JS pages and a single-file Node.js + Express backend. Authentication is handled through Google OAuth with a 7-day JWT, AI generation runs through a unified dispatcher (OpenAI primary, Claude fallback) over six prompt builders, and the database holds only a `users` table.

This feature evolves RoftX into a multi-user SaaS platform that people sign up for and use regularly. The existing generation workflow (topics → voice analysis → hooks → full post → refine/regenerate) is preserved exactly as it behaves today, but it is wrapped in a proper product experience: a persistent data foundation, a detailed user dashboard, saved drafts and final posts, reusable voice profiles, usage logging, server-enforced quotas, account settings, and optional paid plans. This document also captures hardening concerns the current implementation exposes: insecure default JWT secret, backend URL versus CORS allow-list reconciliation, the fate of the unauthenticated legacy generation endpoint, and tolerance of AI response parsing.

The scope of this document is the platform layer (data, persistence, dashboard, account, quotas, billing, hardening). The internal behavior of the AI generation steps is treated as a fixed, preserved capability and is not redesigned here.

## Glossary

- **RoftX_Platform**: The complete multi-user SaaS system, comprising frontend pages, the Express backend, and the PostgreSQL database.
- **API_Server**: The Node.js + Express backend service that exposes HTTP endpoints.
- **Auth_Service**: The component of the API_Server that verifies Google ID tokens and issues/validates RoftX session tokens (JWTs).
- **Generation_Service**: The component of the API_Server that builds prompts and calls the AI providers via the unified dispatcher, exposing the typed `/api/generate` operations (topics, voice, hooks, post, refine, regenerate).
- **AI_Dispatcher**: The unified `callAI` routine that calls OpenAI first and falls back to Claude.
- **Persistence_Service**: The component of the API_Server that reads from and writes to the database (users, voice profiles, posts, generations, quotas).
- **Quota_Service**: The component of the API_Server that tracks and enforces per-user usage limits.
- **Billing_Service**: The component of the API_Server that integrates with the payment provider to manage plans and subscriptions.
- **Dashboard**: The authenticated frontend page (`dashboard.html`) that presents a user's posts, drafts, voice profiles, and usage.
- **Generator**: The existing multi-step generation frontend page (`generator.html`).
- **Account_Settings**: The authenticated frontend page where a user views and edits account information and plan.
- **User**: An authenticated person identified by a Google account and a row in the `users` table.
- **Session_Token**: The RoftX-issued JWT that authenticates API requests, valid for 7 days.
- **Voice_Profile**: A saved Voice Blueprint produced by the voice analysis step, owned by a User and reusable in the Generator.
- **Post_Record**: A stored unit of generated content owned by a User, holding draft and/or final content plus metadata (niche, topic, chosen hook, status).
- **Draft**: A Post_Record whose status is not finalized.
- **Final_Post**: A Post_Record whose status is marked finalized by the User.
- **Generation_Event**: A logged record of one AI generation request (type, timestamp, owning User) used for analytics and quota accounting.
- **Plan**: A named tier (for example Free or Paid) that determines a User's monthly generation allowance and feature access.
- **Quota_Period**: The recurring calendar interval (one calendar month) over which generation usage is counted against a Plan allowance.
- **Generation_Allowance**: The maximum number of Generation_Events a User on a given Plan may perform within one Quota_Period.

## Requirements

### Requirement 1: Database Schema Foundation

**User Story:** As the platform operator, I want a persistent relational schema beyond a single users table, so that user content, voice profiles, usage, and quotas can be stored reliably.

#### Acceptance Criteria

1. WHEN the API_Server starts AND the database is reachable, THE Persistence_Service SHALL ensure the existence of the `users`, `voice_profiles`, `posts`, `generations`, and `usage_quotas` tables.
2. THE Persistence_Service SHALL define each of the `voice_profiles`, `posts`, `generations`, and `usage_quotas` tables with a foreign key referencing `users.id`.
3. WHEN the `users` table is ensured, THE Persistence_Service SHALL include the columns `plan`, `credits_remaining`, `created_at`, and `updated_at` in addition to the existing identity columns.
4. WHEN a new User row is created, THE Persistence_Service SHALL set `plan` to the Free plan identifier and set `credits_remaining` to the Free plan Generation_Allowance.
5. IF the database is unreachable at startup, THEN THE API_Server SHALL continue to serve health and config endpoints and SHALL report database status as unavailable.
6. WHEN a schema-ensuring operation fails, THE Persistence_Service SHALL log the failure and SHALL return an error to the caller rather than corrupting existing data.

### Requirement 2: Session Token Security Hardening

**User Story:** As the platform operator, I want session tokens signed with a strong configured secret, so that user sessions cannot be forged in production.

#### Acceptance Criteria

1. IF the API_Server starts WHILE `NODE_ENV` equals `production` AND `JWT_SECRET` is unset or equal to the built-in default value, THEN THE API_Server SHALL halt startup and log a configuration error.
2. WHILE `NODE_ENV` does not equal `production`, THE Auth_Service SHALL be permitted to use a development fallback secret AND SHALL log a warning that a fallback secret is in use.
3. WHEN the Auth_Service issues a Session_Token, THE Auth_Service SHALL sign it with the configured `JWT_SECRET` and set expiration to 7 days.
4. WHEN a request presents a Session_Token, THE Auth_Service SHALL grant access only if the token signature is valid and the token is not expired.
5. IF a request to a protected endpoint omits a Session_Token, THEN THE Auth_Service SHALL respond with HTTP 401.
6. IF a request to a protected endpoint presents an invalid or expired Session_Token, THEN THE Auth_Service SHALL respond with HTTP 403.

### Requirement 3: Cross-Origin and Endpoint Reconciliation

**User Story:** As the platform operator, I want a correct CORS allow-list and a defined policy for the legacy generation endpoint, so that the deployed frontend works and no unauthenticated AI usage path remains exposed.

#### Acceptance Criteria

1. WHEN the API_Server receives a request whose `Origin` is present in the configured allow-list, THE API_Server SHALL include the matching CORS response headers.
2. IF the API_Server receives a cross-origin request whose `Origin` is not in the allow-list WHILE `NODE_ENV` equals `production`, THEN THE API_Server SHALL reject the request with a CORS error and log the blocked origin.
3. THE API_Server SHALL source the set of allowed production origins from configuration so that the deployed frontend origin and the deployed backend origin remain consistent without code changes.
4. WHEN the AI generation capability is exposed, THE Generation_Service SHALL require a valid Session_Token for every generation request.
5. WHERE the legacy `/api/gemini` endpoint remains available, THE Generation_Service SHALL require a valid Session_Token before performing any AI call.

### Requirement 4: Generation Workflow Preservation

**User Story:** As a User, I want the generation steps to behave exactly as they do today, so that my established workflow is not disrupted by the platform changes.

#### Acceptance Criteria

1. WHEN a User submits a generation request of type `topics`, `voice`, `hooks`, `post`, `refine`, or `regenerate`, THE Generation_Service SHALL build the prompt using the corresponding existing prompt builder.
2. WHEN a generation request is processed, THE AI_Dispatcher SHALL attempt the OpenAI provider first and SHALL fall back to the Claude provider when OpenAI fails with a non-400 error and Claude is configured.
3. WHEN a generation request of a given type is processed, THE Generation_Service SHALL select the model tier currently mapped to that type (fast or quality).
4. IF a generation request omits a required field for its type, THEN THE Generation_Service SHALL respond with HTTP 400 naming the missing field and SHALL NOT perform any AI call or return partial generation results.
5. THE Generation_Service SHALL return generation results in the same response shapes currently produced for each type (`topics`, `voiceProfile`, `hooks`, `post`, `refine` with change summary, `regenerate` with new angle).

### Requirement 5: AI Response Parsing Tolerance

**User Story:** As a User, I want generation to succeed even when the AI formats its output with minor variation, so that I rarely hit avoidable parse failures.

#### Acceptance Criteria

1. WHEN the Generation_Service parses a `topics` response, THE Generation_Service SHALL extract each conversation block whose premise is present regardless of surrounding whitespace and optional numbering variations.
2. WHEN the Generation_Service parses a `hooks` response, THE Generation_Service SHALL extract each hook block and its rationale across the supported hook delimiter variations.
3. IF the Generation_Service cannot extract any structured item from an AI response for a structured type, THEN THE Generation_Service SHALL respond with HTTP 500 and an error indicating a parsing failure.
4. WHEN the Generation_Service parses a `refine` or `regenerate` response, THE Generation_Service SHALL separate the post body from its trailing metadata marker and SHALL return the full text as the post body when the marker is absent.

### Requirement 6: Voice Profile Persistence

**User Story:** As a User, I want to save the Voice Blueprints I generate, so that I can reuse them across future posts without re-running voice analysis.

#### Acceptance Criteria

1. WHEN a User requests to save a generated Voice_Profile WHILE authenticated, THE Persistence_Service SHALL store the Voice_Profile associated with that User and return its identifier.
2. WHEN a User requests their saved Voice_Profiles WHILE authenticated, THE Persistence_Service SHALL return only the Voice_Profiles owned by that User.
3. IF a User requests a Voice_Profile that is not owned by that User, THEN THE Persistence_Service SHALL respond with HTTP 404.
4. WHEN a User requests deletion of a Voice_Profile they own, THE Persistence_Service SHALL remove that Voice_Profile and return a success status.
5. WHEN a User saves a Voice_Profile, THE Persistence_Service SHALL record a creation timestamp and a User-supplied label.

### Requirement 7: Post and Draft Persistence

**User Story:** As a User, I want my drafts and final posts stored automatically and on demand, so that I can resume, edit, copy, or delete them later.

#### Acceptance Criteria

1. WHEN a User generates a full post WHILE authenticated, THE Persistence_Service SHALL create or update a Post_Record owned by that User with the post content and its niche, topic, and chosen hook metadata.
2. WHEN a User marks a Post_Record as finalized, THE Persistence_Service SHALL set its status to Final_Post and record an updated timestamp.
3. WHEN a User requests their Post_Records WHILE authenticated, THE Persistence_Service SHALL return only the Post_Records owned by that User, ordered from most recently updated to least recently updated.
4. WHEN a User requests deletion of a Post_Record they own, THE Persistence_Service SHALL remove that Post_Record and return a success status.
5. IF a User requests or modifies a Post_Record that is not owned by that User, THEN THE Persistence_Service SHALL respond with HTTP 404.
6. WHEN a Post_Record is created or updated, THE Persistence_Service SHALL preserve the post content exactly as supplied (round-trip property): reading the stored Post_Record SHALL return the same content that was written.

### Requirement 8: Generation Event Logging

**User Story:** As the platform operator, I want every generation logged, so that usage can be analyzed and counted against quotas.

#### Acceptance Criteria

1. WHEN the Generation_Service completes a generation request for an authenticated User, THE Persistence_Service SHALL append a Generation_Event recording the owning User, the generation type, and a timestamp.
2. WHEN a Generation_Event is recorded, THE Persistence_Service SHALL associate it with the Quota_Period in which its timestamp falls.
3. WHEN the operator requests aggregate usage for a User over a Quota_Period, THE Persistence_Service SHALL return the count of Generation_Events for that User within that Quota_Period.
4. IF logging a Generation_Event fails, THEN THE Persistence_Service SHALL log the failure without failing the already-completed generation response.

### Requirement 9: Usage Quota Enforcement

**User Story:** As the platform operator, I want server-side enforcement of generation limits per plan, so that free-tier usage stays within defined bounds and paid usage is honored.

#### Acceptance Criteria

1. WHEN a User submits a generation request, THE Quota_Service SHALL compare the User's Generation_Event count in the current Quota_Period against the Generation_Allowance of the User's Plan before performing the AI call.
2. IF a User's Generation_Event count in the current Quota_Period has reached the Generation_Allowance of the User's Plan, THEN THE Quota_Service SHALL respond with HTTP 429 and SHALL NOT perform the AI call.
3. WHEN a new Quota_Period begins, THE Quota_Service SHALL count usage for that User starting from zero for the new Quota_Period.
4. WHEN a User requests their current usage, THE Quota_Service SHALL return the Generation_Event count for the current Quota_Period and the Generation_Allowance of the User's Plan.
5. WHILE a User's Plan is the Free plan, THE Quota_Service SHALL apply the Free plan Generation_Allowance.

### Requirement 10: User Dashboard

**User Story:** As a User, I want a detailed dashboard, so that I can see my recent posts, saved drafts, voice profiles, and usage, and quickly start a new post.

#### Acceptance Criteria

1. WHILE a User is authenticated, THE Dashboard SHALL display the User's Post_Records with their status, niche, and topic.
2. WHEN a User selects a Draft on the Dashboard, THE Dashboard SHALL open that Draft in the Generator for resuming or editing.
3. WHEN a User selects copy on a Post_Record, THE Dashboard SHALL place that Post_Record's content on the clipboard.
4. WHEN a User selects delete on a Post_Record, THE Dashboard SHALL request its deletion and remove it from the displayed list upon success.
5. WHILE a User is authenticated, THE Dashboard SHALL display the User's saved Voice_Profiles.
6. WHILE a User is authenticated, THE Dashboard SHALL display the User's Generation_Event count for the current Quota_Period alongside the Plan Generation_Allowance.
7. WHEN a User selects the New Post action on the Dashboard, THE Dashboard SHALL open the Generator at the first step of the existing workflow.
8. IF an unauthenticated visitor requests the Dashboard, THEN THE RoftX_Platform SHALL redirect that visitor to the sign-in page.
9. IF the redirect to the sign-in page cannot be performed, THEN THE Dashboard SHALL render no User data and SHALL display a sign-in prompt in place of the dashboard content.

### Requirement 11: Voice Profile Reuse in Generator

**User Story:** As a User, I want to apply a saved Voice Profile inside the Generator, so that I do not have to paste a writing sample every time.

#### Acceptance Criteria

1. WHILE a User is authenticated in the Generator, THE Generator SHALL offer the User's saved Voice_Profiles for selection.
2. WHEN a User selects a saved Voice_Profile in the Generator, THE Generator SHALL supply that Voice_Profile to subsequent hook, post, refine, and regenerate generation requests.
3. WHERE no Voice_Profile is selected, THE Generator SHALL continue to support the existing writing-sample voice analysis step unchanged.
4. IF a selected Voice_Profile cannot be supplied to a generation request, THEN THE Generator SHALL fall back to the writing-sample voice analysis step automatically.

### Requirement 12: Post History Search and Filter

**User Story:** As a User, I want to search and filter my saved posts, so that I can find a specific post among many.

#### Acceptance Criteria

1. WHEN a User enters a search term over their post history, THE Persistence_Service SHALL return only the User's Post_Records whose niche, topic, or content contains the search term.
2. WHEN a User filters their post history by status, THE Persistence_Service SHALL return only the User's Post_Records matching the selected status.
3. WHERE a search term and a status filter are applied together, THE Persistence_Service SHALL return only the User's Post_Records that satisfy both conditions.
4. IF a search or filter matches no Post_Records, THEN THE Persistence_Service SHALL return an empty list AND THE Dashboard SHALL display an empty-result indication.

### Requirement 13: Account Settings

**User Story:** As a User, I want an account settings page, so that I can view my profile and plan and manage my account.

#### Acceptance Criteria

1. WHILE a User is authenticated, THE Account_Settings SHALL display the User's name, email, current Plan, and current Quota_Period usage.
2. WHEN a User updates an editable account field, THE Persistence_Service SHALL persist the change and record an updated timestamp.
3. WHEN a User requests account data export WHILE authenticated, THE Persistence_Service SHALL return the User's profile, Voice_Profiles, and Post_Records owned by that User.
4. WHEN a User confirms account deletion, THE Persistence_Service SHALL remove the User's profile, Voice_Profiles, Post_Records, and Generation_Events.
5. IF an unauthenticated visitor requests Account_Settings, THEN THE RoftX_Platform SHALL redirect that visitor to the sign-in page.

### Requirement 14: Plans and Billing (Optional Feature)

**User Story:** As a User, I want to upgrade to a paid plan, so that I can increase my generation allowance.

#### Acceptance Criteria

1. WHERE billing is enabled, WHEN a User initiates an upgrade, THE Billing_Service SHALL create a checkout session with the payment provider and return its redirect target.
2. WHERE billing is enabled, WHEN the payment provider confirms a successful subscription for a User, THE Billing_Service SHALL set that User's Plan to the corresponding Paid plan and update the Generation_Allowance applied by the Quota_Service.
3. WHERE billing is enabled, WHEN the payment provider reports a subscription as canceled or expired for a User, THE Billing_Service SHALL set that User's Plan to the Free plan at the end of the paid Quota_Period.
4. IF the Billing_Service receives a payment-provider callback whose signature cannot be verified, THEN THE Billing_Service SHALL reject the callback with HTTP 400 and SHALL NOT change any Plan.
5. WHERE billing is disabled, THE RoftX_Platform SHALL treat every User as being on the Free plan.

### Requirement 15: Data Isolation and Authorization

**User Story:** As a User, I want my content visible and modifiable only by me, so that my saved work stays private.

#### Acceptance Criteria

1. WHEN the Persistence_Service serves a read of Voice_Profiles, Post_Records, or Generation_Events, THE Persistence_Service SHALL restrict results to records owned by the requesting User.
2. IF a User attempts to read, modify, or delete a record owned by another User, THEN THE Persistence_Service SHALL respond with HTTP 404 and SHALL NOT disclose the record.
3. WHEN any persistence endpoint is invoked, THE Auth_Service SHALL require a valid Session_Token before the Persistence_Service performs the operation.
4. WHEN the Persistence_Service resolves the owning User for an operation, THE Persistence_Service SHALL derive the User identity from the verified Session_Token rather than from a client-supplied identifier.
