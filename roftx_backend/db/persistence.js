// db/persistence.js - RoftX Platform Persistence_Service
//
// Ownership-scoped CRUD for Voice_Profiles and Post_Records. Every operation
// takes the authenticated `userId` (derived from the verified Session_Token by
// the caller, never from client input) as its ownership key, and every query is
// parameterized ($1, $2, ...) to prevent SQL injection — matching the existing
// pg usage pattern in server.js.
//
// Design choices for task 4.1 (see .kiro/specs/roftx-platform/design.md):
//   - The module is a factory: `createPersistence(pool)` accepts any object
//     exposing a `query()` method (a pg Pool or Client), so it is injectable for
//     testing against a transactional/in-memory test database.
//   - All rows are returned as camelCase domain objects (matching the design's
//     Domain Types) so DB column naming never leaks to callers.
//   - Post content is written and read back byte-for-byte (round-trip), and
//     every mutating post operation sets `updated_at = NOW()`.
//
// NOT-FOUND CONVENTION (cross-owner isolation, Requirements 6.3/7.5/15.2):
//   Operations targeting a specific record by id (deleteVoiceProfile,
//   upsertPost-with-id, finalizePost, deletePost) affect ONLY rows that match
//   BOTH the record id AND the owning user_id. When that matches zero rows —
//   whether the record does not exist or is owned by another User — the method
//   throws a `NotFoundError` (HTTP 404 semantics) and discloses no record data.
//   The existence of another User's record is never revealed.
//
// Generation event logging (task 5.1) is implemented below: appendGenerationEvent
// (best-effort, period-stamped) and getUsage (authoritative per-period count).
// Account export/cascade delete/field update (task 4.8) and post-history
// search/status filtering (task 4.6) are also implemented below.

/**
 * Error signaling that a requested record does not exist or is not owned by the
 * requesting User. Carries `status = 404` so route handlers can translate it to
 * an HTTP 404 without disclosing whether the record exists for another owner.
 */
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

// ─── Quota Period Helper ─────────────────────────────────────────────────────

/**
 * Compute the Quota_Period key — the calendar-month bucket a timestamp falls in
 * — as a `'YYYY-MM'` string (Requirement 8.2). The month is derived in **UTC**
 * so period boundaries are stable regardless of server/process timezone and
 * consistent with the billing `periodEnd` UTC convention. This is exported so
 * the Quota_Service (task 5.2) can reuse the exact same period resolution rather
 * than re-deriving it and risking a boundary mismatch.
 *
 * @param {Date | string | number} [date] a Date, ISO string, or epoch ms
 *        (defaults to now)
 * @returns {string} the period key in `YYYY-MM` form (e.g. `'2025-03'`)
 */
export function periodKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  // getUTCMonth() is 0-indexed; pad to a fixed two-digit month.
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// ─── Row Mappers ───────────────────────────────────────────────────────────
// Translate snake_case DB rows into the camelCase domain shapes from the design.

function mapVoiceProfile(row) {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    content: row.content,
    createdAt: row.created_at,
  };
}

function mapPost(row) {
  return {
    id: row.id,
    userId: row.user_id,
    niche: row.niche,
    topic: row.topic,
    chosenHook: row.chosen_hook,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Map a `users` row to the camelCase profile shape (design Domain Type: User).
// Identity/billing columns are exposed read-only; they are never editable via
// updateAccount (see EDITABLE_PROFILE_COLUMNS below).
function mapUser(row) {
  return {
    id: row.id,
    googleId: row.google_id,
    email: row.email,
    fullName: row.full_name,
    givenName: row.given_name,
    familyName: row.family_name,
    pictureUrl: row.picture_url,
    locale: row.locale,
    plan: row.plan,
    creditsRemaining: row.credits_remaining,
    lastLogin: row.last_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The list of columns the SELECT/RETURNING for profile reads must request so
// mapUser receives every field it maps.
const USER_PROFILE_COLUMNS =
  'id, google_id, email, full_name, given_name, family_name, picture_url, locale, plan, credits_remaining, last_login, created_at, updated_at';

// Allow-list of editable account fields: maps the camelCase field name accepted
// from callers to its snake_case DB column. Identity and billing columns
// (google_id, email, plan, credits_remaining, timestamps) are intentionally
// excluded so updateAccount can never change them — unknown/non-editable fields
// in the input are ignored.
const EDITABLE_PROFILE_COLUMNS = {
  fullName: 'full_name',
  givenName: 'given_name',
  familyName: 'family_name',
  pictureUrl: 'picture_url',
  locale: 'locale',
};

// Normalize undefined → null so optional parameters bind predictably and
// COALESCE(...) preserves existing column values on update.
function nz(value) {
  return value === undefined ? null : value;
}

// Escape LIKE/ILIKE pattern metacharacters in user-supplied search terms so
// they match literally. The backslash is the escape character (declared via
// `ESCAPE '\'` at the call site); `%` and `_` are the LIKE wildcards. Escaping
// the backslash first prevents double-escaping.
function escapeLike(term) {
  return String(term).replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
}

/**
 * Create a Persistence_Service bound to a pg Pool/Client.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount: number }> }} pool
 * @returns Persistence service with ownership-scoped CRUD methods.
 */
export function createPersistence(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createPersistence requires a pg Pool or Client with a query() method');
  }

  // ─── Voice Profiles ──────────────────────────────────────────────────────

  /**
   * Save a Voice_Profile owned by `userId`.
   * @param {number} userId
   * @param {{ label: string, content: string }} profile
   * @returns {Promise<{ id: number }>} the new profile's identifier
   */
  async function saveVoiceProfile(userId, { label, content } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO voice_profiles (user_id, label, content)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, label, content]
    );
    return { id: rows[0].id };
  }

  /**
   * List the Voice_Profiles owned by `userId`, newest first.
   * @param {number} userId
   * @returns {Promise<Array>} owner-scoped voice profiles
   */
  async function listVoiceProfiles(userId) {
    const { rows } = await pool.query(
      `SELECT id, user_id, label, content, created_at
         FROM voice_profiles
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC`,
      [userId]
    );
    return rows.map(mapVoiceProfile);
  }

  /**
   * Delete a Voice_Profile owned by `userId`.
   * Throws {@link NotFoundError} when the profile does not exist or is owned by
   * another User (cross-owner access yields 404).
   * @param {number} userId
   * @param {number} id
   * @returns {Promise<{ id: number, deleted: true }>}
   */
  async function deleteVoiceProfile(userId, id) {
    const { rowCount } = await pool.query(
      `DELETE FROM voice_profiles
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (rowCount === 0) {
      throw new NotFoundError('Voice profile not found');
    }
    return { id, deleted: true };
  }

  // ─── Posts ───────────────────────────────────────────────────────────────

  /**
   * Create or update a Post_Record owned by `userId`.
   *
   * Without `id`: inserts a new Post_Record (status defaults to 'draft').
   * With `id`: updates the owned record in place, preserving any field left
   * undefined (COALESCE keeps the existing value) and bumping `updated_at`.
   * Content is stored byte-for-byte. Throws {@link NotFoundError} when an `id`
   * is supplied but matches no record owned by `userId`.
   *
   * @param {number} userId
   * @param {{ id?: number, niche?: string, topic?: string, chosenHook?: string, content?: string, status?: string }} post
   * @returns {Promise<object>} the persisted Post_Record (camelCase)
   */
  async function upsertPost(userId, post = {}) {
    const { id, niche, topic, chosenHook, content, status } = post;

    if (id === undefined || id === null) {
      const { rows } = await pool.query(
        `INSERT INTO posts (user_id, niche, topic, chosen_hook, content, status)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'draft'))
         RETURNING id, user_id, niche, topic, chosen_hook, content, status, created_at, updated_at`,
        [userId, nz(niche), nz(topic), nz(chosenHook), nz(content), nz(status)]
      );
      return mapPost(rows[0]);
    }

    const { rows } = await pool.query(
      `UPDATE posts
          SET niche       = COALESCE($3, niche),
              topic       = COALESCE($4, topic),
              chosen_hook = COALESCE($5, chosen_hook),
              content     = COALESCE($6, content),
              status      = COALESCE($7, status),
              updated_at  = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id, user_id, niche, topic, chosen_hook, content, status, created_at, updated_at`,
      [id, userId, nz(niche), nz(topic), nz(chosenHook), nz(content), nz(status)]
    );
    if (rows.length === 0) {
      throw new NotFoundError('Post not found');
    }
    return mapPost(rows[0]);
  }

  /**
   * Finalize an owned Post_Record: set status to 'final' and bump `updated_at`.
   * Throws {@link NotFoundError} when the post does not exist or is owned by
   * another User.
   * @param {number} userId
   * @param {number} id
   * @returns {Promise<object>} the finalized Post_Record (camelCase)
   */
  async function finalizePost(userId, id) {
    const { rows } = await pool.query(
      `UPDATE posts
          SET status = 'final',
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id, user_id, niche, topic, chosen_hook, content, status, created_at, updated_at`,
      [id, userId]
    );
    if (rows.length === 0) {
      throw new NotFoundError('Post not found');
    }
    return mapPost(rows[0]);
  }

  /**
   * List the Post_Records owned by `userId`, ordered most-recently-updated first.
   *
   * Supports optional, conjunctive post-history search and status filtering
   * (Requirements 12.1–12.4):
   *   - `q` (search term): when a non-empty term is supplied, only posts whose
   *     `niche`, `topic`, OR `content` contains the term (case-insensitive) are
   *     returned. The match is performed with parameterized `ILIKE` and the term
   *     is escaped so LIKE wildcards (`%`, `_`) and the escape char (`\`) in user
   *     input are treated literally rather than as pattern metacharacters.
   *   - `status`: when supplied, only posts with the matching status are returned.
   *   - When both are supplied they combine with AND.
   * Ownership scoping, `updated_at DESC` ordering, and the byte-exact content
   * round-trip are preserved. When nothing matches, an empty array is returned.
   * Calling with no options preserves the original behavior (all owned posts).
   *
   * @param {number} userId
   * @param {{ q?: string, status?: string }} [options]
   * @returns {Promise<Array>} owner-scoped, filtered posts ordered by updated_at desc
   */
  async function listPosts(userId, { q, status } = {}) {
    const conditions = ['user_id = $1'];
    const params = [userId];

    // Search term: match niche OR topic OR content (case-insensitive, contains).
    if (typeof q === 'string' && q.trim() !== '') {
      const pattern = `%${escapeLike(q)}%`;
      params.push(pattern);
      const p = `$${params.length}`;
      conditions.push(
        `(niche ILIKE ${p} ESCAPE '\\' OR topic ILIKE ${p} ESCAPE '\\' OR content ILIKE ${p} ESCAPE '\\')`
      );
    }

    // Status filter: exact match on the selected status.
    if (typeof status === 'string' && status.trim() !== '') {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT id, user_id, niche, topic, chosen_hook, content, status, created_at, updated_at
         FROM posts
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC, id DESC`,
      params
    );
    return rows.map(mapPost);
  }

  /**
   * Delete a Post_Record owned by `userId`.
   * Throws {@link NotFoundError} when the post does not exist or is owned by
   * another User (cross-owner access yields 404).
   * @param {number} userId
   * @param {number} id
   * @returns {Promise<{ id: number, deleted: true }>}
   */
  async function deletePost(userId, id) {
    const { rowCount } = await pool.query(
      `DELETE FROM posts
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (rowCount === 0) {
      throw new NotFoundError('Post not found');
    }
    return { id, deleted: true };
  }

  // ─── Account Management (export / delete / field update) ───────────────────

  /**
   * Export every piece of data owned by `userId`: their profile row plus their
   * Voice_Profiles and Post_Records (Requirement 13.3). All three are
   * owner-scoped — only rows whose `user_id` (or, for the profile, `id`) equals
   * `userId` are returned, so no other User's data can ever be disclosed.
   *
   * @param {number} userId
   * @returns {Promise<{ profile: object | null, voiceProfiles: Array, posts: Array }>}
   */
  async function exportAccount(userId) {
    const { rows } = await pool.query(
      `SELECT ${USER_PROFILE_COLUMNS}
         FROM users
        WHERE id = $1`,
      [userId]
    );
    const profile = rows.length ? mapUser(rows[0]) : null;
    const [voiceProfiles, posts] = await Promise.all([
      listVoiceProfiles(userId),
      listPosts(userId),
    ]);
    return { profile, voiceProfiles, posts };
  }

  /**
   * Delete the account owned by `userId`, removing every row that User owns
   * across `users`, `voice_profiles`, `posts`, and `generations` (Requirement
   * 13.4 / Property 19: zero rows remain for that User in any of the four tables).
   *
   * Approach: the schema declares `ON DELETE CASCADE` from each child table to
   * `users(id)`, so deleting the `users` row alone is sufficient in PostgreSQL.
   * To be explicit and robust — and correct even against test doubles that do
   * not enforce cascades — we delete the child rows first and the `users` row
   * last. When the injected pool exposes a `connect()` method (a real pg Pool),
   * the deletes run inside a single transaction so the account is removed
   * atomically; otherwise they run sequentially on the pool.
   *
   * @param {number} userId
   * @returns {Promise<{ id: number, deleted: true }>}
   */
  async function deleteAccount(userId) {
    const childDeletes = [
      ['DELETE FROM generations WHERE user_id = $1', [userId]],
      ['DELETE FROM voice_profiles WHERE user_id = $1', [userId]],
      ['DELETE FROM posts WHERE user_id = $1', [userId]],
      ['DELETE FROM users WHERE id = $1', [userId]],
    ];

    if (typeof pool.connect === 'function') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [sql, params] of childDeletes) {
          await client.query(sql, params);
        }
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure; surface the original error below
        }
        throw err;
      } finally {
        client.release();
      }
    } else {
      for (const [sql, params] of childDeletes) {
        await pool.query(sql, params);
      }
    }

    return { id: userId, deleted: true };
  }

  /**
   * Update the editable fields of the account owned by `userId` and bump
   * `updated_at = NOW()` (Requirement 13.2). Only fields present in
   * {@link EDITABLE_PROFILE_COLUMNS} are applied; unknown or non-editable fields
   * (e.g. email, plan, credits_remaining) are ignored. When no editable field is
   * supplied, only `updated_at` is bumped. Returns the updated profile, or null
   * if the User does not exist.
   *
   * @param {number} userId
   * @param {object} fields editable account fields (camelCase)
   * @returns {Promise<object | null>} the updated profile (camelCase)
   */
  async function updateAccount(userId, fields = {}) {
    const assignments = [];
    const params = [userId];

    for (const [fieldName, column] of Object.entries(EDITABLE_PROFILE_COLUMNS)) {
      if (Object.prototype.hasOwnProperty.call(fields, fieldName) && fields[fieldName] !== undefined) {
        params.push(fields[fieldName]);
        assignments.push(`${column} = $${params.length}`);
      }
    }

    // Always bump the updated timestamp, even when only non-editable fields were
    // supplied, so an "edit" records an updated timestamp per Requirement 13.2.
    assignments.push('updated_at = NOW()');

    const { rows } = await pool.query(
      `UPDATE users
          SET ${assignments.join(', ')}
        WHERE id = $1
        RETURNING ${USER_PROFILE_COLUMNS}`,
      params
    );
    return rows.length ? mapUser(rows[0]) : null;
  }

  // ─── Generation Event Logging ──────────────────────────────────────────────

  /**
   * Append a Generation_Event for `userId`, stamping the Quota_Period in which
   * the event's timestamp falls (Requirements 8.1, 8.2). The `period` column is
   * the `'YYYY-MM'` key computed from `timestamp` (UTC) at insert time, so the
   * bucket is fixed at write time and never shifts with read-time clocks.
   *
   * This is **best-effort** (Requirement 8.4): the authoritative usage count is
   * derived from the `generations` table, so a dropped log under-counts rather
   * than blocking the user. Any failure is logged and swallowed — this method
   * never throws — returning `{ ok: false }` so the caller's already-completed
   * generation response is never disrupted by a logging failure.
   *
   * @param {number} userId owning User (from the verified Session_Token)
   * @param {string} genType generation type (topics|voice|hooks|post|refine|regenerate)
   * @param {Date | string | number} [timestamp] event time (defaults to now)
   * @returns {Promise<{ ok: true, period: string } | { ok: false }>}
   */
  async function appendGenerationEvent(userId, genType, timestamp = new Date()) {
    const period = periodKey(timestamp);
    try {
      await pool.query(
        `INSERT INTO generations (user_id, gen_type, period)
         VALUES ($1, $2, $3)`,
        [userId, genType, period]
      );
      return { ok: true, period };
    } catch (err) {
      // Best-effort: log and swallow so logging can never block the caller.
      console.error(
        `appendGenerationEvent failed for user ${userId} (type=${genType}, period=${period}):`,
        err
      );
      return { ok: false };
    }
  }

  /**
   * Return the count of `userId`'s POST creations whose stamped `period` matches
   * `period`. Only `gen_type = 'post'` events are counted — post creation is the
   * single metered action. Topics, voice, hooks, refine, and regenerate events
   * are deliberately excluded so they never consume the allowance (regeneration
   * in particular does not count). The query is owner-scoped and parameterized;
   * the COUNT(*) is coerced to a JS integer (pg returns counts as strings). This
   * is the authoritative usage figure the Quota_Service consumes.
   *
   * @param {number} userId owning User (from the verified Session_Token)
   * @param {string} period the `'YYYY-MM'` Quota_Period key
   * @returns {Promise<number>} the number of matching post events (0 when none)
   */
  async function getUsage(userId, period) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count
         FROM generations
        WHERE user_id = $1 AND period = $2 AND gen_type = 'post'`,
      [userId, period]
    );
    return Number.parseInt(rows[0].count, 10) || 0;
  }

  return {
    // voice profiles
    saveVoiceProfile,
    listVoiceProfiles,
    deleteVoiceProfile,
    // posts
    upsertPost,
    finalizePost,
    listPosts,
    deletePost,
    // account management
    exportAccount,
    deleteAccount,
    updateAccount,
    // generation event logging
    appendGenerationEvent,
    getUsage,
  };
}

export default createPersistence;
