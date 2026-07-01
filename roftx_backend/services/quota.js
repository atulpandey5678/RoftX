// services/quota.js — RoftX Quota_Service
//
// Server-enforced, per-Plan generation limits (Requirement 9). The Quota_Service
// is the single authority that decides — BEFORE any AI call — whether a User has
// reached their Plan's Generation_Allowance for the current Quota_Period. The
// route layer translates an `exceeded` result into HTTP 429 with NO AI call
// performed (Property 16).
//
// Design choices (see .kiro/specs/roftx-platform/design.md → "Quota_Service"):
//   - Factory `createQuotaService({ persistence, plans, now })` so the service is
//     fully injectable and unit/property-testable with mocks:
//       • `persistence` — exposes `getUsage(userId, period) → count`; this is the
//         authoritative per-period event count derived from the `generations`
//         table by the Persistence_Service (task 5.1).
//       • `plans`       — the Plan definitions map (defaults to PLANS from config).
//       • `now`         — a clock function returning the current Date (defaults to
//         `() => new Date()`), injectable so period resolution is deterministic
//         in tests.
//   - Period resolution is DELEGATED to `periodKey`, the exact same helper the
//     Persistence_Service uses to STAMP each Generation_Event's period at insert
//     time. Reusing it (rather than re-deriving the month) guarantees the read
//     side and write side agree on `YYYY-MM` boundaries — no off-by-one at month
//     edges or timezone drift.
//
// Allowance lookup fail-safe (Requirement 9.5): an unknown / unrecognized Plan
// resolves to the Free Plan's allowance, so a User is never granted more than the
// Free allowance by accident.

import { PLANS } from '../config.js';
import { periodKey } from '../db/persistence.js';

// The Plan identifier every unknown/unset plan falls back to (Requirement 9.5).
const FREE_PLAN_ID = 'free';

/**
 * Normalize a `plan` argument to its Plan identifier string. Callers may pass
 * either a plain id (`'free'`, `'paid'`) or a Plan-like object (`{ id }`), so the
 * service accepts both and works off the id.
 *
 * @param {string | { id?: string } | null | undefined} plan
 * @returns {string | undefined} the plan id, or undefined when not resolvable
 */
function planId(plan) {
  if (typeof plan === 'string') return plan;
  if (plan && typeof plan === 'object' && typeof plan.id === 'string') return plan.id;
  return undefined;
}

/**
 * Create a Quota_Service.
 *
 * @param {object} [deps]
 * @param {{ getUsage: (userId: number, period: string) => Promise<number> }} deps.persistence
 *        Persistence service exposing the authoritative per-period usage count.
 * @param {Record<string, { id: string, allowance: number }>} [deps.plans]
 *        Plan definitions map (defaults to the configured PLANS).
 * @param {() => Date} [deps.now] Clock function (defaults to `() => new Date()`).
 * @returns Quota service with period/allowance/usage/enforce/report methods.
 */
export function createQuotaService({ persistence, plans = PLANS, now = () => new Date() } = {}) {
  if (!persistence || typeof persistence.getUsage !== 'function') {
    throw new Error('createQuotaService requires a persistence service exposing getUsage()');
  }

  /**
   * Resolve the Quota_Period key (`'YYYY-MM'`) for a given timestamp, delegating
   * to the same `periodKey` helper the Persistence_Service uses to stamp events
   * so read-side and write-side period boundaries always match (Requirement 9.3).
   *
   * @param {Date | string | number} [date] defaults to the current time via `now()`.
   * @returns {string} the period key in `YYYY-MM` form.
   */
  function getPeriod(date = now()) {
    return periodKey(date);
  }

  /**
   * Look up the Generation_Allowance for a Plan (Requirement 9.4/9.5). An unknown
   * or unset Plan falls back to the Free Plan's allowance, so a User is never
   * accidentally granted more than the Free allowance.
   *
   * @param {string | { id?: string }} plan a Plan id or Plan-like object.
   * @returns {number} the configured allowance for the Plan (or the Free allowance).
   */
  function getAllowance(plan) {
    const id = planId(plan);
    const definition = (id && plans[id]) || plans[FREE_PLAN_ID];
    return definition.allowance;
  }

  /**
   * Delegate the authoritative per-period usage count to the Persistence_Service.
   *
   * @param {number} userId owning User (from the verified Session_Token).
   * @param {string} period the `'YYYY-MM'` Quota_Period key.
   * @returns {Promise<number>} the count of that User's events in the period.
   */
  function getUsage(userId, period) {
    return persistence.getUsage(userId, period);
  }

  /**
   * Enforce the Plan's Generation_Allowance for the current Quota_Period BEFORE
   * any AI call (Requirements 9.1, 9.2 / Property 16). The current period is
   * resolved via `getPeriod(now())` so usage resets to zero at each new period
   * (Requirement 9.3).
   *
   * Returns `exceeded: true` if and only if the current-period usage count has
   * REACHED (>=) the Plan's allowance; otherwise the request is allowed to
   * proceed to the AI call. The result always carries `{ used, allowance, period }`
   * so the caller can report context without a second query.
   *
   * @param {number} userId owning User (from the verified Session_Token).
   * @param {string | { id?: string }} plan the User's Plan id or Plan-like object.
   * @returns {Promise<{ exceeded: boolean, ok: boolean, used: number, allowance: number, period: string }>}
   */
  async function enforce(userId, plan) {
    const period = getPeriod();
    const allowance = getAllowance(plan);
    const used = await getUsage(userId, period);
    const exceeded = used >= allowance;
    return { exceeded, ok: !exceeded, used, allowance, period };
  }

  /**
   * Report the User's current-period usage against their Plan allowance
   * (Requirements 9.4/9.5, 14.5). Returns the shape consumed by `GET /api/usage`
   * and the account/usage UI.
   *
   * @param {number} userId owning User (from the verified Session_Token).
   * @param {string | { id?: string }} plan the User's Plan id or Plan-like object.
   * @returns {Promise<{ used: number, allowance: number, period: string }>}
   */
  async function report(userId, plan) {
    const period = getPeriod();
    const allowance = getAllowance(plan);
    const used = await getUsage(userId, period);
    return { used, allowance, period };
  }

  return {
    getPeriod,
    getAllowance,
    getUsage,
    enforce,
    report,
  };
}

export default createQuotaService;
