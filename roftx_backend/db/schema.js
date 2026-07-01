// db/schema.js - RoftX Platform database schema
// Creates all five tables idempotently (CREATE TABLE IF NOT EXISTS).
// Errors are surfaced to the caller, never swallowed. The operation is
// safe to retry because every statement is idempotent and existing data
// is never dropped or altered destructively.

// ─── DDL Statements ─────────────────────────────────────────────────────────
// users (extended from today's identity table). Existing identity columns
// (google_id, email, full_name, given_name, family_name, picture_url, locale,
// last_login) are preserved; plan, credits_remaining, created_at, and
// updated_at are added for the multi-user SaaS platform.
const USERS_TABLE = `
  CREATE TABLE IF NOT EXISTS users (
    id                SERIAL PRIMARY KEY,
    google_id         VARCHAR(255) UNIQUE NOT NULL,
    email             VARCHAR(255) UNIQUE NOT NULL,
    full_name         VARCHAR(255),
    given_name        VARCHAR(255),
    family_name       VARCHAR(255),
    picture_url       TEXT,
    locale            VARCHAR(10),
    plan              VARCHAR(32)  NOT NULL DEFAULT 'free',
    credits_remaining INTEGER      NOT NULL DEFAULT 10,
    last_login        TIMESTAMP DEFAULT NOW(),
    created_at        TIMESTAMP DEFAULT NOW(),
    updated_at        TIMESTAMP DEFAULT NOW()
  )
`;

// Migrations for a pre-existing `users` table created by an older version of
// the app. CREATE TABLE IF NOT EXISTS never alters an existing table, so the
// platform columns (plan, credits_remaining, created_at, updated_at) — and any
// identity columns that predate the current schema — are added here with
// ADD COLUMN IF NOT EXISTS. Every statement is idempotent and non-destructive,
// so running them repeatedly is safe and existing data is preserved.
const USERS_COLUMN_MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS given_name        VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS family_name       VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS picture_url        TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS locale            VARCHAR(10)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan              VARCHAR(32)  NOT NULL DEFAULT 'free'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_remaining INTEGER      NOT NULL DEFAULT 10`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at        TIMESTAMP DEFAULT NOW()`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMP DEFAULT NOW()`,
];

const VOICE_PROFILES_TABLE = `
  CREATE TABLE IF NOT EXISTS voice_profiles (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label      VARCHAR(255) NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )
`;

const POSTS_TABLE = `
  CREATE TABLE IF NOT EXISTS posts (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    niche       VARCHAR(200),
    topic       VARCHAR(500),
    chosen_hook TEXT,
    content     TEXT NOT NULL,
    status      VARCHAR(16) NOT NULL DEFAULT 'draft',
    created_at  TIMESTAMP DEFAULT NOW(),
    updated_at  TIMESTAMP DEFAULT NOW()
  )
`;

const GENERATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS generations (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gen_type   VARCHAR(32) NOT NULL,
    period     VARCHAR(7)  NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )
`;

const USAGE_QUOTAS_TABLE = `
  CREATE TABLE IF NOT EXISTS usage_quotas (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period     VARCHAR(7) NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, period)
  )
`;

// Order matters: child tables reference users(id), so users must exist first.
const SCHEMA_STATEMENTS = [
  USERS_TABLE,
  VOICE_PROFILES_TABLE,
  POSTS_TABLE,
  GENERATIONS_TABLE,
  USAGE_QUOTAS_TABLE,
];

/**
 * Idempotently ensure all platform tables exist.
 *
 * Runs every CREATE TABLE IF NOT EXISTS statement in dependency order. Any
 * error from the database is allowed to propagate to the caller so failures
 * are surfaced (not swallowed). Because all statements are idempotent and
 * non-destructive, a partial run can safely be retried without corrupting
 * existing data.
 *
 * @param {{ query: (sql: string) => Promise<unknown> }} pool - a `pg` Pool or Client.
 * @returns {Promise<void>}
 */
export async function ensureSchema(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('ensureSchema requires a pg Pool or Client with a query() method');
  }

  for (const statement of SCHEMA_STATEMENTS) {
    // Errors intentionally propagate to the caller.
    await pool.query(statement);
  }

  // Bring a pre-existing `users` table up to the current schema by adding any
  // platform columns it is missing. Runs after the CREATE TABLE statements so
  // the table is guaranteed to exist. Idempotent and non-destructive.
  for (const statement of USERS_COLUMN_MIGRATIONS) {
    await pool.query(statement);
  }
}

export default ensureSchema;
