// services/billing.js — RoftX Billing_Service (optional, gated by BILLING_ENABLED)
//
// Implements the optional plans/billing capability described in the design's
// "Billing_Service" section and Requirement 14:
//   • createCheckoutSession(...)        -> creates a provider checkout session and
//                                          returns its redirect target (14.1)
//   • verifyWebhookSignature(...)       -> verifies a payment-provider callback
//                                          signature (boolean) (14.4)
//   • handleWebhook(event)              -> on verified success upgrades the user's
//                                          plan to paid and updates allowance (14.2);
//                                          on cancel/expire schedules a downgrade to
//                                          free at the end of the paid period (14.3);
//                                          on an unverifiable signature rejects with a
//                                          400-style result and makes NO plan change
//                                          of any kind (14.4)
//   • resolvePlan(user)                 -> when billing is disabled every user resolves
//                                          to Free (14.5)
//
// Design notes
// ------------
// The module is intentionally provider-agnostic and dependency-injected so that
// property/unit tests can run without any external network calls:
//   • `provider`    — the payment provider adapter (mockable). Only two methods are
//                     used: `createCheckoutSession(args)` and (optionally)
//                     `verifySignature(payload, signature, secret)`.
//   • `persistence` — the plan-update dependency (mockable). Used to apply plan
//                     changes; the DB is never wired directly here.
//
// When BILLING_ENABLED is false, checkout/webhook operations are disabled no-ops and
// every user is treated as being on the Free plan.

import crypto from 'crypto';
import { BILLING_ENABLED as CONFIG_BILLING_ENABLED, PLANS } from '../config.js';

// ─── Plan identifiers ─────────────────────────────────────────────────────────
export const FREE_PLAN = PLANS.free.id; // 'free'
export const PAID_PLAN = PLANS.paid.id; // 'paid'

// ─── Webhook event classification ─────────────────────────────────────────────
// Provider-agnostic event types. Adapters normalize their native event names into
// one of these before handing the event to the service.
const SUCCESS_EVENTS = new Set([
  'checkout.completed',
  'checkout.session.completed',
  'subscription.active',
  'subscription.created',
  'invoice.paid',
]);

const CANCEL_EVENTS = new Set([
  'subscription.canceled',
  'subscription.cancelled',
  'subscription.expired',
  'subscription.deleted',
]);

function classifyEventType(type) {
  if (SUCCESS_EVENTS.has(type)) return 'success';
  if (CANCEL_EVENTS.has(type)) return 'cancel';
  return 'ignored';
}

// ─── Rejection helper ─────────────────────────────────────────────────────────
// A 400-style rejection that makes NO plan change. Returned (not thrown) so callers
// can map it directly onto an HTTP response; `WebhookRejection` is also exported for
// callers that prefer to throw/catch.
export class WebhookRejection extends Error {
  constructor(message = 'Invalid or unverifiable webhook signature.') {
    super(message);
    this.name = 'WebhookRejection';
    this.status = 400;
  }
}

function rejection(message) {
  return {
    ok: false,
    status: 400,
    planChanged: false,
    error: message || 'Invalid or unverifiable webhook signature.',
  };
}

// ─── Period-end resolution for downgrades ─────────────────────────────────────
// Quota_Period is the calendar-month key (YYYY-MM). A cancel/expire downgrades to
// Free at the END of the current paid period, i.e. the first instant of the next
// calendar month (UTC). Returns an ISO timestamp string.
export function periodEnd(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  // First instant of the next month, in UTC, so period boundaries are stable.
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
}

// ─── Signature verification (provider-agnostic default) ───────────────────────
// Default verification uses an HMAC-SHA256 over the raw payload compared in
// constant time against the provided signature. A provider adapter may override
// this by exposing its own `verifySignature(payload, signature, secret)`.
export function verifyWebhookSignature(payload, signature, secret) {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  if (typeof secret !== 'string' || secret.length === 0) return false;

  const data =
    typeof payload === 'string'
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString('utf8')
        : JSON.stringify(payload ?? '');

  const expected = crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');

  // Normalize provider prefixes like "sha256=..." commonly seen on webhooks.
  const provided = signature.includes('=') ? signature.slice(signature.indexOf('=') + 1) : signature;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// ─── Service factory ──────────────────────────────────────────────────────────
/**
 * Create a Billing_Service instance with injected dependencies.
 *
 * @param {object}  [deps]
 * @param {boolean} [deps.billingEnabled]  Feature flag; defaults to config BILLING_ENABLED.
 * @param {object}  [deps.provider]        Payment provider adapter (mockable):
 *                                           - createCheckoutSession(args) -> { url } | string
 *                                           - verifySignature?(payload, signature, secret) -> boolean
 * @param {object}  [deps.persistence]     Plan-update dependency (mockable):
 *                                           - updateUserPlan(userId, plan, allowance) -> Promise|void
 *                                           - scheduleDowngrade?(userId, plan, effectiveAt) -> Promise|void
 * @param {string}  [deps.webhookSecret]   Secret used to verify webhook signatures.
 * @param {() => Date} [deps.now]          Clock injection for deterministic tests.
 * @returns Billing_Service API
 */
export function createBillingService(deps = {}) {
  const {
    billingEnabled = CONFIG_BILLING_ENABLED,
    provider = null,
    persistence = null,
    webhookSecret = process.env.BILLING_WEBHOOK_SECRET || '',
    now = () => new Date(),
  } = deps;

  const enabled = billingEnabled === true;

  function verifySignature(payload, signature, secret = webhookSecret) {
    // Prefer a provider-supplied verifier when available; otherwise use the
    // default HMAC-SHA256 verification.
    if (provider && typeof provider.verifySignature === 'function') {
      try {
        return provider.verifySignature(payload, signature, secret) === true;
      } catch {
        return false;
      }
    }
    return verifyWebhookSignature(payload, signature, secret);
  }

  /**
   * Create a checkout session and return its redirect target (14.1).
   * When billing is disabled this is a no-op returning null.
   *
   * @returns {Promise<{ url: string }|null>} the redirect target, or null when disabled.
   */
  async function createCheckoutSession({ userId, plan = PAID_PLAN, ...rest } = {}) {
    if (!enabled) return null; // disabled: no-op (14.5)
    if (!provider || typeof provider.createCheckoutSession !== 'function') {
      throw new Error('Billing provider is not configured.');
    }

    const session = await provider.createCheckoutSession({ userId, plan, ...rest });

    // Normalize the provider response to a redirect target.
    const url =
      typeof session === 'string'
        ? session
        : session && (session.url || session.redirectUrl || session.redirect_target);

    if (!url) {
      throw new Error('Checkout session did not return a redirect target.');
    }
    return { url };
  }

  /**
   * Apply the verified-success plan upgrade (14.2): set the user's plan to paid and
   * update the allowance applied by the Quota_Service via the persistence dependency.
   */
  async function applyUpgrade(userId, plan = PAID_PLAN) {
    const planDef = PLANS[plan] || PLANS.paid;
    if (persistence && typeof persistence.updateUserPlan === 'function') {
      await persistence.updateUserPlan(userId, planDef.id, planDef.allowance);
    }
    return { plan: planDef.id, allowance: planDef.allowance };
  }

  /**
   * Schedule/apply the cancel/expire downgrade to Free at the end of the paid
   * period (14.3). If the persistence layer supports scheduling we record the
   * effective time; otherwise we fall back to a plan update flagged for period end.
   */
  async function applyDowngrade(userId) {
    const effectiveAt = periodEnd(now());
    const free = PLANS.free;
    if (persistence && typeof persistence.scheduleDowngrade === 'function') {
      await persistence.scheduleDowngrade(userId, free.id, effectiveAt);
    } else if (persistence && typeof persistence.updateUserPlan === 'function') {
      await persistence.updateUserPlan(userId, free.id, free.allowance, { effectiveAt });
    }
    return { plan: free.id, allowance: free.allowance, effectiveAt };
  }

  /**
   * Handle an inbound payment-provider webhook (14.2/14.3/14.4).
   *
   * The event may be supplied as a raw envelope `{ payload, signature, secret? }`
   * (the payload being the raw body string the provider signed) or as a
   * pre-parsed object that still carries `signature`/`payload` for verification.
   *
   * On an unverifiable signature this returns a 400-style rejection and makes NO
   * plan change of any kind. When billing is disabled it is a disabled no-op.
   *
   * @returns {Promise<{ ok: boolean, status: number, planChanged: boolean, ... }>}
   */
  async function handleWebhook(event = {}) {
    if (!enabled) {
      // Disabled: never registered in practice; defensively no-op (14.5).
      return { ok: true, status: 200, planChanged: false, disabled: true };
    }

    const { payload, signature, secret = webhookSecret } = event;

    // Signature gate FIRST — no plan change happens unless verification passes (14.4).
    if (!verifySignature(payload, signature, secret)) {
      return rejection('Webhook signature could not be verified.');
    }

    // Parse the verified payload into a normalized event.
    let parsed;
    try {
      parsed =
        typeof payload === 'string'
          ? JSON.parse(payload)
          : payload && typeof payload === 'object'
            ? payload
            : event;
    } catch {
      // Verified transport but unparseable body: treat as a bad request, no change.
      return rejection('Webhook payload could not be parsed.');
    }

    const type = parsed.type || event.type;
    const userId = parsed.userId ?? parsed.user_id ?? event.userId;
    const plan = parsed.plan || parsed.targetPlan;

    const kind = classifyEventType(type);

    if (kind === 'success') {
      const result = await applyUpgrade(userId, plan || PAID_PLAN);
      return { ok: true, status: 200, planChanged: true, action: 'upgrade', userId, ...result };
    }

    if (kind === 'cancel') {
      const result = await applyDowngrade(userId);
      return { ok: true, status: 200, planChanged: true, action: 'downgrade', userId, ...result };
    }

    // Recognized-but-irrelevant event: acknowledge without changing any plan.
    return { ok: true, status: 200, planChanged: false, action: 'ignored', type };
  }

  /**
   * Resolve the effective plan for a user (14.5). When billing is disabled every
   * user is treated as being on the Free plan regardless of stored value.
   *
   * @param {{ plan?: string }} [user]
   * @returns {string} the effective plan id.
   */
  function resolvePlan(user = {}) {
    if (!enabled) return FREE_PLAN;
    const stored = user && typeof user.plan === 'string' ? user.plan : FREE_PLAN;
    return PLANS[stored] ? stored : FREE_PLAN;
  }

  return {
    get enabled() {
      return enabled;
    },
    createCheckoutSession,
    verifyWebhookSignature: verifySignature,
    handleWebhook,
    resolvePlan,
    periodEnd,
  };
}

// ─── Default instance bound to config ─────────────────────────────────────────
// A ready-to-use service using the config feature flag. Provider/persistence are
// null until wired by the composition root (task 9.2); checkout/webhook throw or
// no-op accordingly. Tests should prefer `createBillingService(...)` with mocks.
export const billingService = createBillingService();

export default createBillingService;
