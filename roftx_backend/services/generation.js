// services/generation.js — RoftX Generation_Service
//
// This module owns the AI generation capability. Task 7.1 relocates the AI
// dispatcher (`callAI`) and the two provider callers (`callOpenAI`,
// `callClaude`) out of server.js, preserving their behavior byte-for-byte.
//
// The only deliberate change is making the provider-config check injectable so
// the fallback condition can be unit/property tested without real network
// calls or environment juggling. The default export bindings read provider
// availability from the environment exactly as server.js did.
//
// Tolerant parsers (task 7.3) and the /api/generate orchestration (task 7.8)
// are intentionally NOT implemented here yet.

import fetch from 'node-fetch';
import {
  buildTopicSuggestionsPrompt,
  buildVoiceAnalysisPrompt,
  buildHookGeneratorPrompt,
  buildFullPostPrompt,
  buildRefinementPrompt,
  buildRegenerationPrompt,
} from '../prompts.js';

// ─── Environment: Provider Keys ───────────────────────────────────────────────
// Read from the environment exactly as server.js did. Used by the provider
// callers below and to derive default provider availability for the dispatcher.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// ─── AI Provider: OpenAI ──────────────────────────────────────────────────────
export const OPENAI_MODELS = {
  fast:    'gpt-4o-mini',   // topic suggestions, hooks
  quality: 'gpt-4o',        // full post generation
};

export async function callOpenAI(prompt, tier = 'fast') {
  const model = OPENAI_MODELS[tier] || OPENAI_MODELS.fast;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: tier === 'quality' ? 1200 : 600,
      temperature: 0.75,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const msg = data.error?.message || 'OpenAI error';
    console.error('❌ OpenAI error:', data.error);
    throw Object.assign(new Error(msg), { status: response.status, provider: 'openai' });
  }
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── AI Provider: Claude ──────────────────────────────────────────────────────
export const CLAUDE_MODELS = {
  fast:    'claude-haiku-4-5-20251001',
  quality: 'claude-sonnet-4-5-20250929',
};

export async function callClaude(prompt, tier = 'fast') {
  const model = CLAUDE_MODELS[tier] || CLAUDE_MODELS.fast;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: tier === 'quality' ? 1200 : 600,
      temperature: 0.75,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const msg = data.error?.message || 'Claude error';
    console.error('❌ Claude error:', data.error);
    throw Object.assign(new Error(msg), { status: response.status, provider: 'claude' });
  }
  return data.content?.[0]?.text?.trim() || '';
}

// ─── Unified AI Dispatcher ────────────────────────────────────────────────────
// Tries OpenAI first if available, falls back to Claude, vice-versa.
//
// Fallback condition (Requirement 4.2): when OpenAI raises an error, fall back
// to Claude IF AND ONLY IF the error status is not 400 AND Claude is configured;
// on a 400 error, or when Claude is not configured, the original error is
// propagated without falling back.
//
// `createCallAI` makes the provider-config check (and the underlying provider
// callers) injectable so the fallback condition is testable in isolation. The
// defaults reproduce server.js behavior byte-for-byte: availability is derived
// from the presence of each provider's API key.
export function createCallAI({
  hasOpenAI = !!OPENAI_API_KEY,
  hasClaude = !!CLAUDE_API_KEY,
  openai = callOpenAI,
  claude = callClaude,
} = {}) {
  return async function callAI(prompt, tier = 'fast') {
    if (hasOpenAI) {
      try { return await openai(prompt, tier); }
      catch (err) {
        if (hasClaude && err.status !== 400) {
          console.warn('⚠️  OpenAI failed, falling back to Claude:', err.message);
          return await claude(prompt, tier);
        }
        throw err;
      }
    } else if (hasClaude) {
      return await claude(prompt, tier);
    }
    throw new Error('No AI provider configured');
  };
}

// Default dispatcher bound to environment-derived provider availability.
export const callAI = createCallAI();

// ─── Tolerant Response Parsers (task 7.3) ─────────────────────────────────────
//
// These generalize the original server.js parsers (which split on
// `CONVERSATION [N]`, `HOOK [N] —`, and `lastIndexOf` for the `CHANGE MADE:` /
// `NEW ANGLE USED:` markers). The tolerance work widens the accepted delimiters
// — arbitrary surrounding whitespace, optional numbering, and bracket variants
// for topics; the supported hook delimiter variants (em dash, en dash, colon,
// hyphen) for hooks — WITHOUT changing the returned shapes. The objects emitted
// here are byte-for-byte identical to the originals (Properties 6/7/8/10):
//   parseTopics → [{ triggerType, premise, whyItWorks }]
//   parseHooks  → [{ type, text, whyItWorks }]
//   splitMeta   → { post, meta }

// parseTopics — whitespace/numbering/bracket tolerant.
//
// Splits the AI response into conversation blocks on a `CONVERSATION` header
// that tolerates arbitrary surrounding whitespace, optional numbering, and any
// of the bracket variants `[ ]`, `( )`, `{ }`, an optional `#` or `-` lead-in,
// and an optional trailing colon. Each block recovers its premise (required)
// plus the trigger and why-it-works fields when present. Field labels accept
// flexible internal/surrounding whitespace; values are trimmed and the trigger
// is upper-cased exactly as before, defaulting to `INSIGHT`.
export function parseTopics(text) {
  const topics = [];
  if (typeof text !== 'string') return topics;

  const blocks = text
    .split(/^[ \t]*CONVERSATION\b[ \t]*[#-]?[ \t]*[\[\({]?[ \t]*\d*[ \t]*[\]\)}]?[ \t]*:?[ \t]*$/im)
    .filter(b => b.trim());

  for (const block of blocks) {
    const triggerMatch = block.match(/Primary\s+Trigger\s*:\s*([^\n]+)/i);
    const premiseMatch = block.match(
      /Conversation\s+Premise\s*:\s*([\s\S]+?)(?=\n\s*(?:Unique\s+Perspective|Why\s+This\s+Stops\s+The\s+Scroll|Why\s+Professionals\s+Will\s+Comment)\s*:|$)/i
    );
    const whyMatch = block.match(
      /Why\s+This\s+Stops\s+The\s+Scroll\s*:\s*([\s\S]+?)(?=\n\s*Why\s+Professionals\s+Will\s+Comment\s*:|$)/i
    );
    if (premiseMatch) topics.push({
      triggerType: (triggerMatch?.[1] || 'INSIGHT').trim().toUpperCase(),
      premise:     premiseMatch[1].trim(),
      whyItWorks:  (whyMatch?.[1] || '').trim(),
    });
  }
  return topics;
}

// parseHooks — delimiter-variant tolerant.
//
// Splits the AI response into hook blocks on a `HOOK` header followed by one of
// the supported delimiter variants — em dash (—), en dash (–), colon (:), or
// hyphen (-) — tolerating arbitrary surrounding whitespace, optional numbering,
// and bracket variants. Each block's first line is treated as the hook family
// name when it is short and is not the rationale line; the remaining lines form
// the hook text, and the `Why this works:` line (if present) supplies the
// rationale. Returned objects preserve the original `{ type, text, whyItWorks }`
// shape and the family-name defaulting behavior.
export function parseHooks(text) {
  const hooks = [];
  if (typeof text !== 'string') return hooks;

  const types  = ['CONTRARIAN', 'CURIOSITY GAP', 'DATA / SPECIFICITY'];
  const blocks = text
    .split(/^[ \t]*HOOK\b[ \t]*[\[\({]?[ \t]*\d*[ \t]*[\]\)}]?[ \t]*[\u2014\u2013:\-][ \t]*/im)
    .filter(b => b.trim());

  blocks.forEach((block, i) => {
    // The block now starts with " [FAMILY NAME]\n[Hook text]"
    const lines = block.trim().split('\n');
    let familyName = types[i];
    let contentStart = 0;

    // If the first line looks like a family name (all caps or short), extract it
    if (lines[0] && lines[0].trim().length < 50 && !lines[0].includes('Why this works')) {
      familyName = lines[0].trim();
      contentStart = 1;
    }

    const cleaned  = lines.slice(contentStart).join('\n').trim();
    const whyMatch = cleaned.match(/Why this works:\s*(.+)/is);
    const hookText = cleaned.replace(/Why this works:[\s\S]*/i, '').trim();

    if (hookText) hooks.push({
      type:       familyName || `HOOK ${i + 1}`,
      text:       hookText,
      whyItWorks: (whyMatch?.[1] || '').trim(),
    });
  });
  return hooks;
}

// splitMeta — marker split with full-text fallback.
//
// Splits `text` at the LAST occurrence of `marker` (e.g. `CHANGE MADE:` or
// `NEW ANGLE USED:`), returning the text before it as `post` and the text after
// it as `meta`. When the marker is absent, the full text becomes `post` and
// `meta` is empty. Uses `lastIndexOf` semantics per the design.
export function splitMeta(text, marker) {
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return { post: text.trim(), meta: '' };
  return { post: text.slice(0, idx).trim(), meta: text.slice(idx + marker.length).trim() };
}

// ─── /api/generate Orchestration (task 7.8) ──────────────────────────────────
//
// This is the typed orchestration that wraps the fixed generation capability
// (the six prompt builders + the dispatcher + the tolerant parsers) with the
// cross-cutting platform concerns. It enforces the FIXED, security-relevant
// order of checks (the parts owned by this layer; authentication is enforced
// by the route middleware BEFORE control ever reaches here):
//
//     field validation → quota → AI call → parse → persist/log
//
// HTTP outcomes are represented as a plain `{ status, body }` result (never by
// touching Express directly) so the orchestration is fully unit/property
// testable without a server. A thin Express adapter (`createGenerateHandler`)
// is provided for task 9.2 to mount this on the route — this module does NOT
// modify or mount anything in server.js.
//
// Behavior is preserved byte-for-byte from the original server.js handler:
//   - the same `sanitise` truncation/trim is applied to every field,
//   - the same prompt builder and tier are selected per type,
//   - the same tolerant parsers run per type,
//   - the same preserved response shapes are returned (Property 6):
//       topics → { topics }          voice  → { voiceProfile }
//       hooks  → { hooks }           post   → { post }
//       refine → { post, changeMade } regenerate → { post, newAngle }
//
// What this layer ADDS around that capability:
//   - a quota pre-check (HTTP 429 with NO AI call when the allowance is reached),
//   - a best-effort generation-event log (a logging failure never breaks the
//     already-completed response),
//   - optional persistence of a `post` result when the client asks for it
//     (`body.save`), performed as a side effect that never alters the preserved
//     response shape.

// Input sanitiser — identical to server.js: coerce non-strings to '', cap length,
// and trim. Applied to every field before it reaches a prompt builder so prompt
// inputs and persisted content match the original handler exactly.
function sanitise(str, maxLen = 5000) {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLen).trim();
}

// Raised when a structured type (topics/hooks) yields no parseable items. Carries
// `status = 500` so the orchestrator translates it to an HTTP 500 parse-failure
// (Property 9) distinctly from a generic AI failure.
export class ParseFailureError extends Error {
  constructor(message = 'Could not parse AI response') {
    super(message);
    this.name = 'ParseFailureError';
    this.status = 500;
  }
}

// Default prompt-builder map. Injectable via `createGenerationService({ prompts })`
// so Property 3 (dispatch maps type → builder + tier) can assert exactly which
// builder runs by passing spies.
const DEFAULT_PROMPTS = {
  buildTopicSuggestionsPrompt,
  buildVoiceAnalysisPrompt,
  buildHookGeneratorPrompt,
  buildFullPostPrompt,
  buildRefinementPrompt,
  buildRegenerationPrompt,
};

// Per-type specification: the required fields (validated in order, before any AI
// call), the tier mapped to the type, the prompt builder invocation, and the
// type's tolerant parser → preserved response shape. This single table is the
// source of truth for dispatch mapping (type → builder + tier), so there is no
// way for the builder and tier to drift apart.
const TYPE_SPECS = {
  topics: {
    tier: 'fast',
    required: ['niche'],
    build: (b, p) => p.buildTopicSuggestionsPrompt(sanitise(b.niche, 200)),
    parse: (raw) => {
      const topics = parseTopics(raw);
      if (!topics.length) throw new ParseFailureError('Could not parse topics from AI response');
      return { topics };
    },
  },
  voice: {
    tier: 'quality',
    required: ['writingSample'],
    build: (b, p) => p.buildVoiceAnalysisPrompt(sanitise(b.writingSample, 10000)),
    parse: (raw) => ({ voiceProfile: raw.trim() }),
  },
  hooks: {
    tier: 'fast',
    required: ['niche', 'topic'],
    build: (b, p) => p.buildHookGeneratorPrompt(
      sanitise(b.niche, 200),
      sanitise(b.topic, 500),
      sanitise(b.voiceProfile || '', 5000),
      sanitise(b.extra || '', 500),
    ),
    parse: (raw) => {
      const hooks = parseHooks(raw);
      if (!hooks.length) throw new ParseFailureError('Could not parse hooks from AI response');
      return { hooks };
    },
  },
  post: {
    tier: 'quality',
    required: ['niche', 'topic', 'chosenHook'],
    build: (b, p) => p.buildFullPostPrompt(
      sanitise(b.niche, 200),
      sanitise(b.topic, 500),
      sanitise(b.chosenHook, 1000),
      sanitise(b.voiceProfile || '', 5000),
    ),
    parse: (raw) => ({ post: raw.trim() }),
  },
  refine: {
    tier: 'quality',
    required: ['currentPost', 'instruction'],
    build: (b, p) => p.buildRefinementPrompt(
      sanitise(b.currentPost, 5000),
      sanitise(b.instruction, 500),
      sanitise(b.voiceProfile || '', 5000),
    ),
    parse: (raw) => {
      const { post, meta } = splitMeta(raw, 'CHANGE MADE:');
      return { post, changeMade: meta };
    },
  },
  regenerate: {
    tier: 'quality',
    required: ['currentPost', 'niche', 'topic'],
    build: (b, p) => p.buildRegenerationPrompt(
      sanitise(b.currentPost, 5000),
      sanitise(b.niche, 200),
      sanitise(b.topic, 500),
      sanitise(b.voiceProfile || '', 5000),
    ),
    parse: (raw) => {
      const { post, meta } = splitMeta(raw, 'NEW ANGLE USED:');
      return { post, newAngle: meta };
    },
  },
};

// The tier mapped to each generation type, derived from TYPE_SPECS so it cannot
// disagree with the dispatch table. Exported for traceability/tests.
export const TIER_MAP = Object.fromEntries(
  Object.entries(TYPE_SPECS).map(([type, spec]) => [type, spec.tier]),
);

// The set of valid generation types, in declaration order.
export const GENERATION_TYPES = Object.keys(TYPE_SPECS);

/**
 * Create the Generation_Service orchestrator.
 *
 * All collaborators are injected so the orchestration is testable in isolation
 * (Properties 3, 5, 6, 9, 16): pass mock builders to observe dispatch, a mock
 * dispatcher to observe (or assert the absence of) AI calls, a mock quota service
 * to drive the 429 path, and a mock persistence service to observe logging and
 * post persistence.
 *
 * @param {object} [deps]
 * @param {(prompt: string, tier: string) => Promise<string>} [deps.callAI]
 *        AI dispatcher (defaults to the environment-bound `callAI`).
 * @param {{ enforce: (userId: number, plan: any) => Promise<{ exceeded: boolean, used?: number, allowance?: number, period?: string }> }} [deps.quota]
 *        Quota_Service; when provided, `enforce` is called before any AI call.
 * @param {{ appendGenerationEvent: Function, upsertPost: Function }} [deps.persistence]
 *        Persistence_Service for best-effort event logging and optional post save.
 * @param {Record<string, Function>} [deps.prompts] prompt-builder map (defaults to the real builders).
 * @returns {{ generate: (type: string, body?: object, user?: object) => Promise<{ status: number, body: object }> }}
 */
export function createGenerationService({
  callAI: callAIDep = callAI,
  quota = null,
  persistence = null,
  prompts = DEFAULT_PROMPTS,
} = {}) {
  /**
   * Run the full generation pipeline for one request.
   *
   * Returns a structured `{ status, body }` HTTP outcome. The fixed order of the
   * checks owned by this layer is:
   *   1. field validation  → 400 naming the missing field, NO AI call (Property 5)
   *   2. quota pre-check    → 429, NO AI call when allowance reached (Property 16)
   *   3. AI dispatch        → callAI(prompt, tier) (Property 3)
   *   4. parse by type      → 500 parse-failure for structured types (Property 9)
   *   5. persist/log        → best-effort event log + optional post save
   * and on success the body is exactly the preserved shape for the type (Property 6).
   *
   * @param {string} type generation type
   * @param {object} [body] request body (client-supplied fields)
   * @param {object} [user] authenticated user resolved from the verified token
   *                        ({ userId, googleId, email, plan }); ownership/plan are
   *                        taken from here, never from `body`.
   */
  async function generate(type, body = {}, user = {}) {
    // ── Type resolution ──────────────────────────────────────────────────────
    if (!type) {
      return { status: 400, body: { error: 'Missing type field.' } };
    }
    const spec = TYPE_SPECS[type];
    if (!spec) {
      return { status: 400, body: { error: `Unknown type: ${type}` } };
    }

    // ── 1. Field validation (NO AI call, NO partial result) ───────────────────
    // Validate required fields in declaration order; the first missing field is
    // named in the 400 response. A field is "missing" when falsy (matching the
    // original handler's `!field` checks).
    for (const field of spec.required) {
      if (!body[field]) {
        return { status: 400, body: { error: `${field} required.` } };
      }
    }

    // Build the prompt from sanitised inputs. A builder throwing is treated as a
    // 400 (bad input) — still before any AI call.
    let prompt;
    try {
      prompt = spec.build(body, prompts);
    } catch (buildErr) {
      return { status: 400, body: { error: buildErr.message } };
    }

    // Ownership/plan come from the verified token only (never from the body).
    const userId = user?.userId ?? user?.id ?? null;
    const plan = user?.plan;

    // ── 2. Quota pre-check (NO AI call when exceeded) ─────────────────────────
    // Only POST CREATION (`type === 'post'`) is metered against the allowance.
    // Topics, voice, hooks, refine, and regenerate are never quota-blocked, so a
    // user at their post limit can still explore topics/hooks and refine or
    // regenerate existing posts. Regeneration explicitly does NOT consume a post.
    if (type === 'post' && quota && typeof quota.enforce === 'function') {
      const verdict = await quota.enforce(userId, plan);
      if (verdict?.exceeded) {
        return {
          status: 429,
          body: {
            error: 'Post limit reached for the current period.',
            used: verdict.used,
            allowance: verdict.allowance,
            period: verdict.period,
          },
        };
      }
    }

    // ── 3. AI dispatch ────────────────────────────────────────────────────────
    let raw;
    try {
      raw = await callAIDep(prompt, spec.tier);
    } catch (err) {
      const status = err?.status || 500;
      if (status === 429) {
        return { status: 429, body: { error: 'AI rate limit reached. Try again in a moment.' } };
      }
      return { status: 500, body: { error: 'AI generation failed. Please try again.' } };
    }
    if (!raw) {
      return { status: 500, body: { error: 'AI generation failed. Please try again.' } };
    }

    // ── 4. Parse by type (structured types signal a 500 on no items) ──────────
    let payload;
    try {
      payload = spec.parse(raw);
    } catch (parseErr) {
      const status = parseErr?.status || 500;
      return { status, body: { error: parseErr.message || 'Could not parse AI response' } };
    }

    // ── 5. Persist / log (post-success side effects; never alter the response) ─
    // Best-effort generation-event log. appendGenerationEvent already swallows
    // its own failures, but we additionally guard here so logging can never break
    // the already-completed response (Requirement 8.4).
    if (persistence && typeof persistence.appendGenerationEvent === 'function' && userId != null) {
      try {
        await persistence.appendGenerationEvent(userId, type, new Date());
      } catch (logErr) {
        console.error('appendGenerationEvent failed (non-fatal):', logErr?.message || logErr);
      }
    }

    // Optional post persistence when the client requests it. This is a side
    // effect only — the returned body stays exactly `{ post }` (Property 6), so a
    // persistence failure is logged but never changes the response.
    if (
      type === 'post' &&
      body.save &&
      persistence &&
      typeof persistence.upsertPost === 'function' &&
      userId != null
    ) {
      try {
        await persistence.upsertPost(userId, {
          niche: sanitise(body.niche, 200),
          topic: sanitise(body.topic, 500),
          chosenHook: sanitise(body.chosenHook, 1000),
          content: payload.post,
          status: 'draft',
        });
      } catch (persistErr) {
        console.error('post persistence failed (non-fatal):', persistErr?.message || persistErr);
      }
    }

    return { status: 200, body: payload };
  }

  return { generate };
}

/**
 * Express adapter for the Generation_Service. Returns a route handler that reads
 * the authenticated user from `req.user` (populated by `authenticateToken`),
 * runs the orchestration, and writes the structured `{ status, body }` outcome
 * to the response. Provided for task 9.2 route mounting; this module performs no
 * mounting itself.
 *
 * @param {Parameters<typeof createGenerationService>[0]} [deps]
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<void>}
 */
export function createGenerateHandler(deps = {}) {
  const { generate } = createGenerationService(deps);
  return async function generateHandler(req, res) {
    const body = req.body || {};
    try {
      const { status, body: payload } = await generate(body.type, body, req.user || {});
      res.status(status).json(payload);
    } catch (err) {
      // Defensive catch-all: the orchestrator returns structured outcomes for all
      // expected paths, so reaching here indicates an unexpected fault.
      console.error('❌ /api/generate unexpected error:', err?.message || err);
      res.status(500).json({ error: 'AI generation failed. Please try again.' });
    }
  };
}

export default createGenerationService;
