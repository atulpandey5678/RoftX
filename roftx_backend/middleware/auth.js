// middleware/auth.js — RoftX authentication & ownership resolution
//
// Owns Session_Token signing/verification and request authentication, plus the
// ownership resolver that derives the acting User strictly from the verified
// token (never from client-supplied input).
//
// Identity is always sourced from the verified Session_Token:
//   • signSessionToken(payload)  — sign with the configured JWT_SECRET, 7-day expiry
//   • authenticateToken(req,res,next) — 401 (no token) / 403 (invalid|expired);
//                                       attaches req.user = { userId, googleId, email }
//   • resolveOwnerUserId(...)    — derive the owning user id from req.user,
//                                   resolving by googleId when userId is null

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';

// ─── Token Expiry ─────────────────────────────────────────────────────────────
// Session_Tokens live for 7 days (Requirement 2.3).
export const SESSION_TOKEN_EXPIRY = '7d';

// ─── Error Bodies ──────────────────────────────────────────────────────────────
// Kept identical to the historical server.js bodies and the design's Error
// Handling section so existing clients see no behavioral change.
export const MISSING_TOKEN_ERROR = 'Access denied. Missing authentication token.';
export const INVALID_TOKEN_ERROR = 'Invalid or expired session. Please log in again.';

/**
 * Sign a Session_Token for the given payload.
 *
 * Signs with the configured JWT_SECRET and a fixed 7-day expiry (Requirement
 * 2.3). The payload is expected to carry the established shape
 * `{ userId, googleId, email }`, but this function does not mutate or constrain
 * it beyond what `jsonwebtoken` requires.
 *
 * @param {{ userId?: number|null, googleId: string, email: string }} payload
 * @param {object} [options] optional overrides (e.g. for tests); `expiresIn`
 *   defaults to the 7-day session expiry.
 * @returns {string} the signed JWT
 */
export function signSessionToken(payload, options = {}) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: SESSION_TOKEN_EXPIRY, ...options });
}

/**
 * Verify a Session_Token and return its decoded payload.
 *
 * Grants only when the signature is valid and the token is unexpired
 * (Requirement 2.4). Throws the underlying `jsonwebtoken` error otherwise.
 *
 * @param {string} token
 * @returns {{ userId?: number|null, googleId: string, email: string }}
 */
export function verifySessionToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Express middleware enforcing a valid Session_Token on protected endpoints.
 *
 *   • No token            → 401 (Requirement 2.5)
 *   • Invalid or expired  → 403 (Requirement 2.6)
 *   • Valid               → attaches req.user = { userId, googleId, email }
 *                           and calls next() (Requirement 2.4)
 *
 * Identity is derived solely from the verified token; nothing from the request
 * body or query is trusted (Requirement 15.4).
 */
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: MISSING_TOKEN_ERROR });
  }

  let decoded;
  try {
    decoded = verifySessionToken(token);
  } catch (err) {
    return res.status(403).json({ error: INVALID_TOKEN_ERROR });
  }

  // Attach only the established identity fields, sourced from the token.
  req.user = {
    userId: decoded.userId ?? null,
    googleId: decoded.googleId,
    email: decoded.email,
  };

  next();
}

/**
 * Resolve the owning User id for an operation, derived strictly from the
 * verified token identity (Requirements 15.3, 15.4).
 *
 * When the token carries a non-null `userId` (the common case, since the JWT
 * payload includes it), that id is authoritative and no database lookup is
 * performed. When `userId` is null — which happens when the database was
 * unavailable at sign-in and the token only carries `googleId`/`email` — the
 * user row is resolved by `googleId` via the injected db pool.
 *
 * The `db` pool is injected (rather than imported) so this resolver stays pure
 * with respect to module state and is straightforward to unit-test.
 *
 * @param {{ userId?: number|null, googleId?: string }} user the verified token identity (req.user)
 * @param {{ query: (text: string, params: any[]) => Promise<{ rows: any[] }> }} [db]
 *   a pg-style pool/client; required only when `userId` is null
 * @returns {Promise<number|null>} the resolved owning user id, or null if it
 *   cannot be determined (no userId, and no matching row by googleId)
 */
export async function resolveOwnerUserId(user, db) {
  if (!user) return null;

  // Token already carries the owning id — trust it, no lookup needed.
  if (user.userId !== null && user.userId !== undefined) {
    return user.userId;
  }

  // Fall back to resolving by googleId (still token-derived, never client input).
  if (!user.googleId) return null;
  if (!db || typeof db.query !== 'function') return null;

  const result = await db.query('SELECT id FROM users WHERE google_id = $1', [user.googleId]);
  return result.rows.length > 0 ? result.rows[0].id : null;
}
