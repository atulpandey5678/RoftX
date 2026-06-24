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
import {
  buildTopicSuggestionsPrompt,
  buildVoiceAnalysisPrompt,
  buildHookGeneratorPrompt,
  buildFullPostPrompt,
  buildRefinementPrompt,
  buildRegenerationPrompt,
} from './prompts.js';
import cors from 'cors';
import pg from 'pg';
import { OAuth2Client } from 'google-auth-library';
import fetch from 'node-fetch';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const { Pool } = pg;

// ─── Environment Variables ────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
const CLAUDE_API_KEY      = process.env.CLAUDE_API_KEY;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const DATABASE_URL        = process.env.DATABASE_URL?.trim();
const DATABASE_PASSWORD   = process.env.DATABASE_PASSWORD?.trim();
const NODE_ENV            = process.env.NODE_ENV || 'development';
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
const ALLOWED_ORIGINS = [
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
    .then(() => { isDatabaseAvailable = true; console.log('✅ Database connected'); })
    .catch(err => { console.warn('⚠️  DB unavailable:', err.message); isDatabaseAvailable = false; });
} catch (err) {
  console.warn('⚠️  DB pool init failed:', err.message);
}

// ─── Input Sanitisation Helper ────────────────────────────────────────────────
function sanitise(str, maxLen = 5000) {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLen).trim();
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
  fast:    'claude-3-5-haiku-20241022',
  quality: 'claude-3-5-sonnet-20241022',
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

// ─── DB: Ensure Users Table ───────────────────────────────────────────────────
async function ensureUsersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      google_id    VARCHAR(255) UNIQUE NOT NULL,
      email        VARCHAR(255) UNIQUE NOT NULL,
      full_name    VARCHAR(255),
      given_name   VARCHAR(255),
      family_name  VARCHAR(255),
      picture_url  TEXT,
      locale       VARCHAR(10),
      last_login   TIMESTAMP DEFAULT NOW(),
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
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
      await ensureUsersTable();
      const existing = await pool.query('SELECT id FROM users WHERE google_id = $1', [user.google_id]);
      if (existing.rows.length === 0) {
        const inserted = await pool.query(
          `INSERT INTO users (google_id,email,full_name,given_name,family_name,picture_url,locale,last_login)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
          [user.google_id, user.email, user.full_name, user.given_name, user.family_name, user.picture_url, user.locale]
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

  return res.status(200).json({ success: true, user });
});

// ─── AI Generation ────────────────────────────────────────────────────────────
app.post('/api/gemini', aiLimiter, async (req, res) => {
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

// ─── Response Parsers ────────────────────────────────────────────────────────
function parseTopics(text) {
  const topics = [];
  const blocks = text.split(/TOPIC \d+/i).filter(b => b.trim());
  for (const block of blocks) {
    const triggerMatch = block.match(/Trigger type:\s*(.+)/i);
    const premiseMatch = block.match(/Premise:\s*(.+)/i);
    const whyMatch     = block.match(/Why it works:\s*(.+)/i);
    if (premiseMatch) topics.push({
      triggerType:  (triggerMatch?.[1] || 'INSIGHT').trim().toUpperCase(),
      premise:      premiseMatch[1].trim(),
      whyItWorks:   (whyMatch?.[1] || '').trim(),
    });
  }
  return topics;
}

function parseHooks(text) {
  const hooks  = [];
  const types  = ['CONTRARIAN', 'CURIOSITY GAP', 'DATA / SPECIFICITY'];
  const blocks = text.split(/HOOK \d+ ?[\u2014\u2013-]/i).filter(b => b.trim());
  blocks.forEach((block, i) => {
    const cleaned  = block.replace(/^(CONTRARIAN|CURIOSITY GAP|DATA[^\n]*)\n/i, '').trim();
    const whyMatch = cleaned.match(/Why this works:\s*(.+)/is);
    const hookText = cleaned.replace(/Why this works:[\s\S]*/i, '').trim();
    if (hookText) hooks.push({
      type:        types[i] || `HOOK ${i + 1}`,
      text:        hookText,
      whyItWorks:  (whyMatch?.[1] || '').trim(),
    });
  });
  return hooks;
}

function splitMeta(text, marker) {
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return { post: text.trim(), meta: '' };
  return { post: text.slice(0, idx).trim(), meta: text.slice(idx + marker.length).trim() };
}

// ─── /api/generate — Elite Prompt Route ──────────────────────────────────────
const TIER_MAP = {
  topics:     'fast',
  voice:      'quality',
  hooks:      'fast',
  post:       'quality',
  refine:     'quality',
  regenerate: 'quality',
};

app.post('/api/generate', aiLimiter, async (req, res) => {
  const { type, niche, topic, writingSample, voiceProfile,
          chosenHook, currentPost, instruction } = req.body;

  if (!type) return res.status(400).json({ error: 'Missing type field.' });

  let prompt;
  try {
    switch (type) {
      case 'topics':
        if (!niche) return res.status(400).json({ error: 'niche required.' });
        prompt = buildTopicSuggestionsPrompt(sanitise(niche, 200));
        break;
      case 'voice':
        if (!writingSample) return res.status(400).json({ error: 'writingSample required.' });
        prompt = buildVoiceAnalysisPrompt(sanitise(writingSample, 10000));
        break;
      case 'hooks':
        if (!niche || !topic) return res.status(400).json({ error: 'niche and topic required.' });
        prompt = buildHookGeneratorPrompt(
          sanitise(niche, 200), sanitise(topic, 500),
          sanitise(voiceProfile || '', 5000), sanitise(req.body.extra || '', 500)
        );
        break;
      case 'post':
        if (!niche || !topic || !chosenHook)
          return res.status(400).json({ error: 'niche, topic, chosenHook required.' });
        prompt = buildFullPostPrompt(
          sanitise(niche, 200), sanitise(topic, 500),
          sanitise(chosenHook, 1000), sanitise(voiceProfile || '', 5000)
        );
        break;
      case 'refine':
        if (!currentPost || !instruction)
          return res.status(400).json({ error: 'currentPost and instruction required.' });
        prompt = buildRefinementPrompt(
          sanitise(currentPost, 5000), sanitise(instruction, 500),
          sanitise(voiceProfile || '', 5000)
        );
        break;
      case 'regenerate':
        if (!currentPost || !niche || !topic)
          return res.status(400).json({ error: 'currentPost, niche, topic required.' });
        prompt = buildRegenerationPrompt(
          sanitise(currentPost, 5000), sanitise(niche, 200),
          sanitise(topic, 500), sanitise(voiceProfile || '', 5000)
        );
        break;
      default:
        return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (buildErr) {
    return res.status(400).json({ error: buildErr.message });
  }

  const tier = TIER_MAP[type] || 'fast';
  console.log(`🎯 /api/generate | type:${type} tier:${tier} len:${prompt.length}`);

  try {
    const raw = await callAI(prompt, tier);
    if (!raw) throw new Error('Empty AI response');

    switch (type) {
      case 'topics': {
        const topics = parseTopics(raw);
        if (!topics.length) throw new Error('Could not parse topics from AI response');
        return res.json({ topics });
      }
      case 'voice':
        return res.json({ voiceProfile: raw.trim() });
      case 'hooks': {
        const hooks = parseHooks(raw);
        if (!hooks.length) throw new Error('Could not parse hooks from AI response');
        return res.json({ hooks });
      }
      case 'post':
        return res.json({ post: raw.trim() });
      case 'refine': {
        const { post, meta } = splitMeta(raw, 'CHANGE MADE:');
        return res.json({ post, changeMade: meta });
      }
      case 'regenerate': {
        const { post, meta } = splitMeta(raw, 'NEW ANGLE USED:');
        return res.json({ post, newAngle: meta });
      }
    }
  } catch (err) {
    console.error(`❌ /api/generate [${type}]:`, err.message);
    const status = err.status || 500;
    if (status === 429) return res.status(429).json({ error: 'AI rate limit reached. Try again in a moment.' });
    return res.status(500).json({ error: 'AI generation failed. Please try again.' });
  }
});

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
