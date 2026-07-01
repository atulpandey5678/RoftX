// server.js - Production Ready | RoftX Backend
// Supports: OpenAI (primary) + Claude (fallback) | Google Auth | Security Hardened
// Elite Prompt System — 6 prompts via prompts.js

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

// Load .env from this file's directory (roftx_backend/) regardless of CWD
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { OAuth2Client } from 'google-auth-library';
import fetch from 'node-fetch';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import {
  validateStartupSecret,
  JWT_SECRET,
  ALLOWED_ORIGINS,
  PLANS,
  NODE_ENV,
  DEFAULT_JWT_SECRET,
  BILLING_ENABLED,
} from './config.js';
import { ensureSchema } from './db/schema.js';
// Authentication & ownership resolution (single source of truth) and the
// platform service modules wired in below (task 9.2).
import { authenticateToken, resolveOwnerUserId } from './middleware/auth.js';
import { createPersistence } from './db/persistence.js';
import { createQuotaService } from './services/quota.js';
import { createGenerationService } from './services/generation.js';
import { createBillingService } from './services/billing.js';

const { Pool } = pg;

// ─── Environment Variables ────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
const CLAUDE_API_KEY      = process.env.CLAUDE_API_KEY;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const DATABASE_URL        = process.env.DATABASE_URL?.trim();
const DATABASE_PASSWORD   = process.env.DATABASE_PASSWORD?.trim();
const PORT                = process.env.PORT || 3000;

// Determine which AI providers are available
const hasOpenAI = !!OPENAI_API_KEY;
const hasClaude = !!CLAUDE_API_KEY;
const AI_PROVIDER = hasOpenAI ? 'openai' : hasClaude ? 'claude' : null;

// ─── Startup Validation ───────────────────────────────────────────────────────
if (!GOOGLE_CLIENT_ID) {
  console.error('❌ FATAL: Missing GOOGLE_CLIENT_ID');
  process.exit(1);
}
if (!AI_PROVIDER) {
  console.error('❌ FATAL: No AI API key found. Set OPENAI_API_KEY or CLAUDE_API_KEY in .env');
  process.exit(1);
}
if (!DATABASE_URL && !DATABASE_PASSWORD) {
  console.warn('⚠️  No database credentials found — running in no-DB mode.');
}

// ─── Production Secret Fail-Safe ──────────────────────────────────────────────
// Halt the boot when running in production with a missing or default JWT secret.
// Outside production, warn that the dev fallback secret is in use.
const secretCheck = validateStartupSecret({ nodeEnv: NODE_ENV, jwtSecret: process.env.JWT_SECRET });
if (secretCheck.halt) {
  console.error(`❌ FATAL: ${secretCheck.reason}`);
  process.exit(1);
}
if (NODE_ENV !== 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET)) {
  console.warn('⚠️  JWT_SECRET unset — using built-in dev fallback. Do NOT use this in production.');
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ─── Trust Proxy (Render / Railway run behind a reverse proxy) ───────────────
app.set('trust proxy', 1);

// ─── Security: Helmet ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'", 'https://accounts.google.com', 'https://apis.google.com'],
      frameSrc:        ["'self'", 'https://accounts.google.com'],
      connectSrc:      ["'self'", 'https://accounts.google.com'],
      imgSrc:          ["'self'", 'https:', 'data:'],
      objectSrc:       ["'none'"],
      upgradeInsecureRequests: NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS is sourced from config.js (the single source of truth) so the
// deployed frontend/backend origins can change without code edits.
app.use(cors({
  origin(origin, cb) {
    // Allow requests with no origin (like Render health checks or direct browser visits)
    if (!origin) return cb(null, true);
    // Allow all localhost in dev
    if (NODE_ENV !== 'production' &&
        (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
      return cb(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    console.warn(`⚠️  CORS blocked: ${origin}`);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

app.use(express.json({ limit: '50kb' })); // Prevent large payload attacks

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: NODE_ENV === 'production' ? 8 : 30,  // stricter in prod
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit exceeded. Please wait a moment.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,              // max 20 auth attempts per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

app.use(globalLimiter);

// ─── Database ─────────────────────────────────────────────────────────────────
let pool = null;
let isDatabaseAvailable = false;

try {
  pool = new Pool({
    connectionString: DATABASE_URL || undefined,
    ...(!DATABASE_URL && DATABASE_PASSWORD ? {
      user: 'postgres', host: 'localhost',
      database: 'roftx_db', password: DATABASE_PASSWORD, port: 5432,
    } : {}),
    ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
    max: 10,
  });
  pool.query('SELECT 1')
    .then(async () => {
      isDatabaseAvailable = true;
      console.log('✅ Database connected');
      // Ensure all platform tables exist (idempotent). Preserve no-DB tolerance:
      // a schema failure logs a warning and marks the DB unavailable so the
      // server still serves / and /api/config reporting database: unavailable.
      try {
        await ensureSchema(pool);
        console.log('✅ Schema ensured');
      } catch (schemaErr) {
        console.warn('⚠️  Schema ensure failed:', schemaErr.message);
        isDatabaseAvailable = false;
      }
    })
    .catch(err => { console.warn('⚠️  DB unavailable:', err.message); isDatabaseAvailable = false; });
} catch (err) {
  console.warn('⚠️  DB pool init failed:', err.message);
}

// ─── Platform Services (instantiated once) ────────────────────────────────────
// The persistence/quota/billing services are bound to the single pg pool created
// above. They are created once at startup (not per request). In no-DB mode the
// pool is null, so these stay null and persistence-dependent routes return a
// 503-style error (see requireDb). When the pool exists they share its
// connection; queries simply fail until the DB connects, which is surfaced as a
// 503 by the availability guard.
let persistence = null;
let quotaService = null;
let billingService = null;

if (pool) {
  persistence = createPersistence(pool);
  quotaService = createQuotaService({ persistence });
  if (BILLING_ENABLED) {
    // Provider/persistence are injectable; the payment-provider adapter is not
    // wired yet, so checkout will report "not configured" until one is supplied.
    billingService = createBillingService({ persistence });
  }
}

// ─── Input Sanitisation Helper ────────────────────────────────────────────────
function sanitise(str, maxLen = 5000) {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLen).trim();
}

// ─── DB Availability Guard ────────────────────────────────────────────────────
// Persistence-dependent routes require a live database. When the DB is
// unavailable we return a 503-style error rather than throwing, preserving the
// no-DB tolerance for the health/config endpoints.
function requireDb(res) {
  if (!isDatabaseAvailable || !persistence) {
    res.status(503).json({ error: 'Database unavailable. Please try again later.' });
    return false;
  }
  return true;
}

// Resolve a user's Plan id from their DB record (defaults to 'free'). Identity is
// always the token-derived owning userId — never a client-supplied value.
async function loadUserPlan(userId) {
  if (!isDatabaseAvailable || !pool || userId == null) return 'free';
  try {
    const result = await pool.query('SELECT plan FROM users WHERE id = $1', [userId]);
    return result.rows.length ? (result.rows[0].plan || 'free') : 'free';
  } catch (err) {
    console.error('loadUserPlan failed (defaulting to free):', err.message);
    return 'free';
  }
}

// Owner-scoped route wrapper. Resolves the owning userId STRICTLY from the
// verified token (never from req.body/req.query), enforces DB availability, and
// translates thrown `{status}` errors (e.g. persistence NotFoundError → 404) into
// HTTP responses with generic bodies so another user's data is never disclosed.
async function withOwner(req, res, handler) {
  if (!requireDb(res)) return;

  let userId;
  try {
    userId = await resolveOwnerUserId(req.user, pool);
  } catch (err) {
    console.error('resolveOwnerUserId failed:', err.message);
    return res.status(500).json({ error: 'Could not resolve account.' });
  }
  if (userId == null) {
    return res.status(404).json({ error: 'Not found.' });
  }

  try {
    await handler(userId);
  } catch (err) {
    const status = err?.status || 500;
    if (status === 404) {
      // Generic not-found — never reveal whether the record exists for another owner.
      return res.status(404).json({ error: 'Not found.' });
    }
    console.error('persistence route error:', err?.message || err);
    return res.status(status).json({ error: 'Request failed. Please try again.' });
  }
}

// ─── AI Provider: OpenAI ──────────────────────────────────────────────────────
const OPENAI_MODELS = {
  fast:    'gpt-4o-mini',   // topic suggestions, hooks
  quality: 'gpt-4o',        // full post generation
};

async function callOpenAI(prompt, tier = 'fast') {
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
const CLAUDE_MODELS = {
  fast:    'claude-haiku-4-5-20251001',
  quality: 'claude-sonnet-4-5-20250929',
};

async function callClaude(prompt, tier = 'fast') {
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
async function callAI(prompt, tier = 'fast') {
  if (hasOpenAI) {
    try { return await callOpenAI(prompt, tier); }
    catch (err) {
      if (hasClaude && err.status !== 400) {
        console.warn('⚠️  OpenAI failed, falling back to Claude:', err.message);
        return await callClaude(prompt, tier);
      }
      throw err;
    }
  } else if (hasClaude) {
    return await callClaude(prompt, tier);
  }
  throw new Error('No AI provider configured');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RoftX API',
    version: '2.0.0',
    ai_provider: AI_PROVIDER,
    database: isDatabaseAvailable ? 'connected' : 'unavailable',
    timestamp: new Date().toISOString(),
  });
});

// ─── Public Config (safe to expose) ──────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// ─── Google Auth ──────────────────────────────────────────────────────────────
app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { token } = req.body;

  if (!token || typeof token !== 'string' || token.length > 8000) {
    return res.status(400).json({ error: 'Invalid token provided.' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    console.warn('⚠️  Token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired Google token. Please sign in again.' });
  }

  // Validate email is verified by Google
  if (!payload.email_verified) {
    return res.status(403).json({ error: 'Google account email is not verified.' });
  }

  const user = {
    google_id:   payload.sub,
    email:       payload.email,
    full_name:   sanitise(payload.name || payload.email, 255),
    given_name:  sanitise(payload.given_name || '', 100),
    family_name: sanitise(payload.family_name || '', 100),
    picture_url: payload.picture || null,
    locale:      payload.locale || 'en',
  };

  console.log(`🔐 Auth: ${user.email}`);

  if (isDatabaseAvailable && pool) {
    try {
      const existing = await pool.query('SELECT id FROM users WHERE google_id = $1', [user.google_id]);
      if (existing.rows.length === 0) {
        // New-user defaults: Free plan and the Free plan's generation allowance.
        const inserted = await pool.query(
          `INSERT INTO users (google_id,email,full_name,given_name,family_name,picture_url,locale,plan,credits_remaining,last_login)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id`,
          [user.google_id, user.email, user.full_name, user.given_name, user.family_name, user.picture_url, user.locale, 'free', PLANS.free.allowance]
        );
        user.id = inserted.rows[0].id;
        console.log(`✨ New user: ${user.email}`);
      } else {
        await pool.query(
          `UPDATE users SET last_login=NOW(), full_name=$2, picture_url=$3 WHERE google_id=$1`,
          [user.google_id, user.full_name, user.picture_url]
        );
        user.id = existing.rows[0].id;
        console.log(`👤 Returning user: ${user.email}`);
      }
    } catch (dbErr) {
      console.error('⚠️  DB error (non-fatal):', dbErr.message);
    }
  }

  // Issue JWT Token
  const tokenPayload = {
    userId: user.id || null,
    googleId: user.google_id,
    email: user.email,
  };
  const sessionToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

  return res.status(200).json({ success: true, user, token: sessionToken });
});

// ─── Authentication Middleware ────────────────────────────────────────────────
// `authenticateToken` is imported from ./middleware/auth.js (the single source of
// truth). Behavior is identical: 401 when the token is missing, 403 when it is
// invalid or expired, and `req.user = { userId, googleId, email }` on success.

// ─── AI Generation ────────────────────────────────────────────────────────────
// Legacy endpoint — now requires a valid Session_Token BEFORE any AI call so no
// generation happens without authentication (Requirements 3.4/3.5). The handler
// body is otherwise unchanged.
app.post('/api/gemini', aiLimiter, authenticateToken, async (req, res) => {
  // Validate request shape
  const body = req.body;
  if (!body || !Array.isArray(body.contents) || !body.contents[0]?.parts?.[0]?.text) {
    return res.status(400).json({ error: 'Invalid request format.' });
  }

  const prompt = sanitise(body.contents[0].parts[0].text, 80000);
  if (prompt.length < 10) {
    return res.status(400).json({ error: 'Prompt too short.' });
  }

  // Derive tier from legacy model field
  const modelHint = body.model || 'haiku';
  const tier = (modelHint === 'sonnet' || modelHint === 'sonnet-oct') ? 'quality' : 'fast';

  console.log(`🤖 AI request | provider:${AI_PROVIDER} tier:${tier} len:${prompt.length}`);

  try {
    const text = await callAI(prompt, tier);
    if (!text) throw new Error('Empty response from AI');
    return res.status(200).json({
      candidates: [{ content: { parts: [{ text }] } }]
    });
  } catch (err) {
    console.error('❌ AI generation error:', err.message);
    const status = err.status || 500;
    if (status === 429) return res.status(429).json({ error: 'AI rate limit reached. Try again in a moment.' });
    if (status === 401) return res.status(500).json({ error: 'AI service authentication error. Contact support.' });
    return res.status(500).json({ error: 'AI generation failed. Please try again.' });
  }
});

// ─── /api/generate — Elite Prompt Route (Generation_Service) ─────────────────
// The generation capability (prompt builders + AI dispatcher + tolerant parsers)
// now lives in ./services/generation.js. We wire it with the local `callAI`
// dispatcher, a quota adapter, and the persistence service. Authentication runs
// FIRST via `authenticateToken`; the fixed, security-relevant order of checks
// (field validation → quota → AI call → parse → persist/log) is enforced inside
// the service. Response shapes are preserved byte-for-byte.

// Quota adapter for generation: fail-open when the DB is unavailable or the owner
// id cannot be resolved, so generation keeps working in no-DB mode (quota is a
// best-effort guard, never a hard dependency for the AI workflow). When the DB is
// available the real Quota_Service enforces the per-plan allowance before any AI
// call (HTTP 429, no AI call, when the allowance is reached).
const quotaForGeneration = {
  enforce: async (userId, plan) => {
    if (!quotaService || !isDatabaseAvailable || userId == null) {
      return { exceeded: false, ok: true };
    }
    try {
      return await quotaService.enforce(userId, plan);
    } catch (err) {
      console.error('quota enforce failed (allowing request):', err.message);
      return { exceeded: false, ok: true };
    }
  },
};

const generationService = createGenerationService({
  callAI,
  quota: quotaForGeneration,
  persistence, // null in no-DB mode; the service guards on this
});

app.post('/api/generate', aiLimiter, authenticateToken, async (req, res) => {
  // Resolve the owning userId and Plan strictly from the verified token identity
  // (never from req.body). The Plan drives the quota allowance; ownership drives
  // event logging and optional post persistence.
  let user = req.user || {};
  try {
    if (isDatabaseAvailable && pool) {
      const userId = await resolveOwnerUserId(req.user, pool);
      const plan = await loadUserPlan(userId);
      user = { ...req.user, userId, plan };
    }
  } catch (err) {
    console.error('generate identity resolution failed (non-fatal):', err.message);
  }

  const body = req.body || {};
  console.log(`🎯 /api/generate | type:${body.type}`);

  try {
    const { status, body: payload } = await generationService.generate(body.type, body, user);
    return res.status(status).json(payload);
  } catch (err) {
    console.error('❌ /api/generate unexpected error:', err?.message || err);
    return res.status(500).json({ error: 'AI generation failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE / QUOTA / ACCOUNT ROUTES (owner-scoped, auth required)
// ═══════════════════════════════════════════════════════════════════════════════
// Every route below runs `authenticateToken` first and resolves the owning userId
// via `resolveOwnerUserId(req.user, pool)` inside `withOwner` — the client can
// never supply or override the owner. Persistence NotFoundError (status 404) is
// translated to a generic 404 so another user's data is never disclosed.

// ─── Voice Profiles ───────────────────────────────────────────────────────────
app.post('/api/voice-profiles', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const { label, content } = req.body || {};
    if (!label || !content) {
      return res.status(400).json({ error: 'label and content required.' });
    }
    const result = await persistence.saveVoiceProfile(userId, {
      label: sanitise(label, 255),
      content: sanitise(content, 20000),
    });
    res.status(201).json(result);
  })
);

app.get('/api/voice-profiles', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const voiceProfiles = await persistence.listVoiceProfiles(userId);
    res.json({ voiceProfiles });
  })
);

app.delete('/api/voice-profiles/:id', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid voice profile id.' });
    }
    const result = await persistence.deleteVoiceProfile(userId, id);
    res.json(result);
  })
);

// ─── Posts ────────────────────────────────────────────────────────────────────
app.post('/api/posts', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const { id, niche, topic, chosenHook, content, status } = req.body || {};
    const post = await persistence.upsertPost(userId, {
      id,
      niche: niche === undefined ? undefined : sanitise(niche, 200),
      topic: topic === undefined ? undefined : sanitise(topic, 500),
      chosenHook: chosenHook === undefined ? undefined : sanitise(chosenHook, 1000),
      content: content === undefined ? undefined : sanitise(content, 20000),
      status,
    });
    res.json({ post });
  })
);

app.post('/api/posts/:id/finalize', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid post id.' });
    }
    const post = await persistence.finalizePost(userId, id);
    res.json({ post });
  })
);

app.get('/api/posts', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const { q, status } = req.query;
    const posts = await persistence.listPosts(userId, {
      q: typeof q === 'string' ? q : undefined,
      status: typeof status === 'string' ? status : undefined,
    });
    res.json({ posts });
  })
);

app.delete('/api/posts/:id', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid post id.' });
    }
    const result = await persistence.deletePost(userId, id);
    res.json(result);
  })
);

// ─── Usage (current-period quota report) ──────────────────────────────────────
app.get('/api/usage', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const plan = await loadUserPlan(userId);
    const report = await quotaService.report(userId, plan);
    res.json(report); // { used, allowance, period }
  })
);

// ─── Account (export / update / delete) ───────────────────────────────────────
app.get('/api/account/export', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const data = await persistence.exportAccount(userId);
    res.json(data);
  })
);

app.patch('/api/account', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const updated = await persistence.updateAccount(userId, req.body || {});
    if (!updated) {
      return res.status(404).json({ error: 'Not found.' });
    }
    res.json({ account: updated });
  })
);

app.delete('/api/account', authenticateToken, (req, res) =>
  withOwner(req, res, async (userId) => {
    const result = await persistence.deleteAccount(userId);
    res.json(result);
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// BILLING ROUTES (registered only when BILLING_ENABLED)
// ═══════════════════════════════════════════════════════════════════════════════
if (BILLING_ENABLED && billingService) {
  // Checkout requires the user's Session_Token; the owning userId is token-derived.
  app.post('/api/billing/checkout', authenticateToken, (req, res) =>
    withOwner(req, res, async (userId) => {
      const session = await billingService.createCheckoutSession({
        userId,
        plan: req.body?.plan,
      });
      if (!session) {
        return res.status(503).json({ error: 'Billing is not available.' });
      }
      res.json(session); // { url }
    })
  );

  // Webhook does NOT require the user JWT — it is authenticated by the payment
  // provider's signature (verified inside the Billing_Service). On an
  // unverifiable signature the service returns a 400 and makes NO plan change.
  //
  // LIMITATION: express.json() has already parsed the body, so the raw bytes the
  // provider signed are not preserved here; the default verifier re-serializes
  // req.body with JSON.stringify. A provider whose signature is computed over the
  // exact raw payload will require a raw-body parser mounted specifically on this
  // route before production use. This is intentionally kept simple per task 9.2
  // and does not affect any other route.
  app.post('/api/billing/webhook', async (req, res) => {
    try {
      const signature =
        req.headers['x-webhook-signature'] ||
        req.headers['stripe-signature'] ||
        req.headers['x-signature'] ||
        '';
      const result = await billingService.handleWebhook({ payload: req.body, signature });
      return res.status(result.status || 200).json(result);
    } catch (err) {
      const status = err?.status || 400;
      console.error('billing webhook error:', err?.message || err);
      return res.status(status).json({ error: err?.message || 'Webhook could not be processed.' });
    }
  });
}

// ─── 404 & Error Handlers ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  const line = '═'.repeat(52);
  console.log(`\n${line}`);
  console.log(`  🚀  RoftX Backend  v2.0.0`);
  console.log(line);
  console.log(`  Env:         ${NODE_ENV}`);
  console.log(`  Port:        ${PORT}`);
  console.log(`  AI Provider: ${AI_PROVIDER?.toUpperCase()}`);
  if (hasOpenAI)  console.log(`  OpenAI:      ✅ gpt-4o-mini / gpt-4o`);
  if (hasClaude)  console.log(`  Claude:      ${hasOpenAI ? '⬇️  Fallback' : '✅ Primary'} (Haiku / Sonnet)`);
  console.log(`  Database:    ${isDatabaseAvailable ? '✅ Connected' : '⚠️  No-DB mode'}`);
  console.log(`  Started:     ${new Date().toLocaleString()}`);
  console.log(`${line}\n`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n⚠️  ${signal} received — shutting down...`);
  server.close(async () => {
    if (pool && isDatabaseAvailable) await pool.end();
    console.log('✅ Clean shutdown complete.');
    process.exit(0);
  });
  setTimeout(() => { console.error('❌ Forced exit after timeout'); process.exit(1); }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err => { console.error('❌ Uncaught:', err); shutdown('uncaughtException'); });
process.on('unhandledRejection', err => { console.error('❌ Unhandled rejection:', err); });
