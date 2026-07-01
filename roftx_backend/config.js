// config.js — RoftX Backend configuration module
// Single source of truth for environment-derived configuration:
//   • JWT secret (with dev fallback) and production secret validation
//   • CORS allow-list sourced from configuration
//   • Plan definitions and per-plan generation allowances
//   • Billing-enabled feature flag
//
// This module is pure with respect to side effects: it reads env once at import
// time and exposes the resolved values. `validateStartupSecret` is a pure
// function returning a halt decision, so it can be unit-tested without touching
// process state (no process.exit here — the caller decides how to halt).

// ─── Built-in Default Secret ──────────────────────────────────────────────────
// Matches the historical fallback used by server.js. A production boot that ends
// up using this value (or no value) is treated as misconfigured.
export const DEFAULT_JWT_SECRET = 'roftx_default_secret_please_change_in_prod';

const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── JWT Secret ───────────────────────────────────────────────────────────────
// Effective secret used for signing/verifying Session_Tokens. Outside production
// the built-in default is used as a development fallback; in production the
// startup validator (below) is responsible for halting when the secret is unset
// or equal to the default.
export const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;

/**
 * Production secret fail-safe.
 *
 * Returns a halt decision rather than calling process.exit, so it is unit
 * testable and the caller controls how startup is aborted.
 *
 * Signals halt if and only if:
 *   - nodeEnv === 'production', AND
 *   - jwtSecret is unset (undefined/null/empty) OR equals DEFAULT_JWT_SECRET
 *
 * In every other case startup is permitted.
 *
 * @param {{ nodeEnv?: string, jwtSecret?: string }} params
 * @returns {{ halt: boolean, reason?: string }}
 */
export function validateStartupSecret({ nodeEnv, jwtSecret } = {}) {
  const isProduction = nodeEnv === 'production';
  const isUnset = jwtSecret === undefined || jwtSecret === null || jwtSecret === '';
  const isDefault = jwtSecret === DEFAULT_JWT_SECRET;

  if (isProduction && (isUnset || isDefault)) {
    return {
      halt: true,
      reason:
        'JWT_SECRET is unset or set to the built-in default in production. ' +
        'Set a strong, unique JWT_SECRET before starting in production.',
    };
  }

  return { halt: false };
}

// ─── CORS Allow-List ────────────────────────────────────────────────────────
// Sourced from the ALLOWED_ORIGINS env var (comma-separated) so the deployed
// frontend and backend origins can change without code edits. Falls back to a
// sensible default list covering the known production and local dev origins.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://www.roftx.com',
  'https://roftx.com',
  'https://roftx-front02.onrender.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5500',
  'http://localhost:5501',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5501',
  'http://localhost:3000',
];

function parseOrigins(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return parsed.length > 0 ? parsed : null;
}

export const ALLOWED_ORIGINS =
  parseOrigins(process.env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS;

// ─── Plan Definitions ─────────────────────────────────────────────────────────
// Per-plan monthly allowances. The metered action is POST CREATION only — the
// `post` generation type. Topics, voice analysis, hooks, refinements, and
// regenerations are NOT counted against the allowance (see Quota_Service and
// the Generation_Service post-only enforcement). Free accounts can create up to
// 10 posts per period.
export const PLANS = {
  free: { id: 'free', allowance: 10 },
  paid: { id: 'paid', allowance: 500 },
};

// ─── Billing Feature Flag ─────────────────────────────────────────────────────
// Billing is opt-in via the BILLING_ENABLED env flag. When disabled, every user
// is treated as Free and billing endpoints are not registered.
function parseBoolean(raw) {
  if (typeof raw !== 'string') return false;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export const BILLING_ENABLED = parseBoolean(process.env.BILLING_ENABLED);

// Re-export the resolved environment for callers that need it for logging.
export { NODE_ENV };
