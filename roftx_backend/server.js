/**
 * Production-ready server.js
 *
 * Dependencies (install these):
 *   npm i express helmet cors morgan express-rate-limit pg google-auth-library dotenv
 *
 * Notes:
 * - Uses global fetch when available (Node 18+). Falls back to dynamic import of node-fetch
 *   if not present.
 * - Accepts requests from Generator.html which POST { prompt, expectJson } OR
 *   Gemini-like payloads { contents: [...] }.
 * - Responds with { text: "<model output>" } (used by frontend.makeApiCall)
 *   and also returns a Gemini-compatible `candidates` object for safety.
 * - Validates required env vars and fails fast on startup if missing.
 */

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const port = Number(process.env.PORT || 3000);

// ---------- Ensure fetch is available (Node 18+ friendly) ----------
let fetchFn = globalThis.fetch;
async function ensureFetch() {
  if (!fetchFn) {
    // dynamic import only if needed
    const mod = await import('node-fetch');
    fetchFn = mod.default;
  }
}
ensureFetch().catch(err => {
  console.error('Failed to initialize fetch:', err);
  process.exit(1);
});

// ---------- Environment validation ----------
const requiredEnvs = ['GOOGLE_CLIENT_ID', 'CLAUDE_API_KEY'];
for (const v of requiredEnvs) {
  if (!process.env[v]) {
    console.error(`FATAL: Missing required environment variable: ${v}`);
    process.exit(1);
  }
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL || null;
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD || null;

// For database, require either DATABASE_URL (production) or DATABASE_PASSWORD (local)
if (!DATABASE_URL && !DATABASE_PASSWORD) {
  console.error('FATAL: Missing database config. Provide DATABASE_URL or DATABASE_PASSWORD.');
  process.exit(1);
}

// ---------- Middlewares ----------
app.use(helmet());
app.use(express.json({ limit: '256kb' })); // limit payload size
app.use(express.urlencoded({ extended: false }));

// Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// CORS - allow origins from env or sane defaults for local dev
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const defaultOrigins = [
  'https://www.roftx.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5501',
];

const corsWhitelist = Array.from(new Set([...defaultOrigins, ...allowedOrigins]));

const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser tools like curl/postman (no origin)
    if (!origin) return callback(null, true);
    if (corsWhitelist.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    const msg = `CORS policy: Origin ${origin} is not allowed`;
    return callback(new Error(msg), false);
  },
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// ---------- Database pool ----------
const poolConfig = DATABASE_URL
  ? { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'roftx_db',
      password: DATABASE_PASSWORD,
      port: Number(process.env.DB_PORT || 5432),
    };

const pool = new Pool(poolConfig);

// ---------- Google OAuth client ----------
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---------- Utility: safe extraction of model text ----------
function extractTextFromAnthropicResponse(data) {
  // Try common patterns; return the first found string or null.
  if (!data) return null;

  // 1) v1/messages style: {completion: "..."} or {completion: {content: "..."}}
  if (typeof data.completion === 'string' && data.completion.trim()) return data.completion;
  if (data.completion && typeof data.completion === 'object') {
    if (typeof data.completion.content === 'string' && data.completion.content.trim()) return data.completion.content;
    if (Array.isArray(data.completion.content) && data.completion.content.length > 0) {
      if (typeof data.completion.content[0].text === 'string') return data.completion.content[0].text;
    }
  }

  // 2) content array: [{type: 'output_text'|'message' , text: '...'}]
  if (Array.isArray(data.content) && data.content.length > 0) {
    // common location: data.content[0].text
    if (typeof data.content[0].text === 'string' && data.content[0].text.trim()) return data.content[0].text;
    // nested content arrays
    if (Array.isArray(data.content[0].content) && data.content[0].content.length > 0) {
      if (typeof data.content[0].content[0].text === 'string') return data.content[0].content[0].text;
    }
  }

  // 3) messages style: {messages: [{role:'assistant', content: {text: '...'}}]}
  if (Array.isArray(data.messages) && data.messages.length > 0) {
    const msg = data.messages.find(m => m.role === 'assistant') || data.messages[0];
    if (msg && msg.content) {
      if (typeof msg.content.text === 'string' && msg.content.text.trim()) return msg.content.text;
      if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
    }
  }

  // 4) fallback keys
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  if (typeof data.text === 'string' && data.text.trim()) return data.text;

  // 5) candidates style (Gemini-like): {candidates: [{content:{parts:[{text: '...'}]}}]}
  if (Array.isArray(data.candidates) && data.candidates.length > 0) {
    try {
      const cand = data.candidates[0];
      if (cand && cand.content && Array.isArray(cand.content.parts) && cand.content.parts[0]) {
        return cand.content.parts[0].text;
      }
    } catch (e) {
      // ignore
    }
  }

  return null;
}

// ---------- Routes ----------

app.get('/', (req, res) => {
  res.status(200).send('Welcome to the RoftX backend API! Server running.');
});

// Google OAuth login: verify id token and upsert user
app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token provided.' });

    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: google_id, name: full_name, email, picture: picture_url, locale, given_name, family_name } = payload;

    // Upsert user: try select -> insert or update
    const selectRes = await pool.query('SELECT id FROM users WHERE google_id = $1', [google_id]);
    let user;
    if (selectRes.rows.length === 0) {
      const insertRes = await pool.query(
        `INSERT INTO users (google_id, email, full_name, given_name, family_name, picture_url, locale, last_login)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING *`,
        [google_id, email, full_name, given_name, family_name, picture_url, locale]
      );
      user = insertRes.rows[0];
    } else {
      const updateRes = await pool.query(
        `UPDATE users SET last_login = NOW(), full_name = $2, picture_url = $3 WHERE google_id = $1 RETURNING *`,
        [google_id, full_name, picture_url]
      );
      user = updateRes.rows[0];
    }

    return res.status(200).json({ message: 'Login successful!', user });
  } catch (err) {
    console.error('Google auth error:', err);
    return res.status(500).json({ error: 'Authentication failed due to a server error.' });
  }
});

/**
 * Primary AI proxy endpoint.
 * Accepts:
 *  - Gemini-like payload: { contents: [{ parts: [{ text: "..."}] }] }
 *  - Simple payload from frontend: { prompt: "...", expectJson: true/false }
 *
 * Responds:
 *  { text: "<model output>" , candidates: [ { content: { parts: [{ text: "<model output>" }] } } ] }
 */
app.post('/api/gemini', async (req, res) => {
  try {
    const incoming = req.body || {};
    // Determine incoming prompt
    let prompt = null;
    let expectJson = false;

    // Accept Gemini-style payload first
    if (incoming.contents && Array.isArray(incoming.contents) && incoming.contents.length > 0) {
      // Try to find first textual part
      try {
        const parts = incoming.contents[0].parts || [];
        const textPart = parts.find(p => typeof p.text === 'string' && p.text.trim());
        if (textPart) prompt = textPart.text;
        else {
          // If inlineData used (e.g., file uploads), the frontend won't call this path for generation
          prompt = '';
        }
      } catch (e) {
        prompt = '';
      }
    } else if (typeof incoming.prompt === 'string') {
      prompt = incoming.prompt;
      expectJson = Boolean(incoming.expectJson);
    } else {
      return res.status(400).json({ error: { message: 'Invalid payload. Provide `prompt` or `contents`.' } });
    }

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: { message: 'Prompt is empty.' } });
    }

    // Prepare Claude/Anthropic request payload (generic)
    const claudeApiUrl = 'https://api.anthropic.com/v1/messages';
    const model = process.env.CLAUDE_MODEL || 'claude-3.5-mini'; // choose default model if needed

    // For models expecting `messages` array with role/content
    const claudePayload = {
      model,
      // keeping a reasonable limit and temperature: override with env if desired
      max_tokens: Number(process.env.CLAUDE_MAX_TOKENS || 1024),
      temperature: Number(process.env.CLAUDE_TEMPERATURE || 0.7),
      messages: [
        { role: 'user', content: prompt }
      ],
    };

    // Call Claude
    const claudeResp = await fetchFn(claudeApiUrl, {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(claudePayload),
      // set a timeout at the fetch consumer level if needed in production (outside fetch)
    });

    // Read JSON body safely
    let data;
    try {
      data = await claudeResp.json();
    } catch (err) {
      // if response is not json, try to read text
      const txt = await claudeResp.text();
      console.warn('Non-JSON response from Claude:', txt.slice(0, 500));
      return res.status(502).json({ error: { message: 'Invalid response from model provider.' } });
    }

    if (!claudeResp.ok) {
      // forward the provider's error body where possible
      console.error('Claude returned error:', claudeResp.status, data);
      return res.status(502).json({ error: { message: 'Model provider error', details: data } });
    }

    // Extract text using a robust helper
    const generatedText = extractTextFromAnthropicResponse(data) || '';

    // Build Gemini-compatible wrapper (frontend-safe)
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: generatedText }
            ]
          }
        }
      ],
      // Also include a simple top-level text field which your frontend's makeApiCall expects
      text: generatedText,
      raw: data
    };

    // Return the result
    return res.status(200).json(geminiResponse);
  } catch (err) {
    console.error('Error in /api/gemini:', err);
    return res.status(500).json({ error: { message: 'Internal server error while contacting AI model.' } });
  }
});

// Health-check endpoint that also verifies DB connectivity
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1'); // simple DB ping
    res.status(200).json({ ok: true, db: 'ok' });
  } catch (err) {
    console.error('Health check DB error:', err);
    res.status(500).json({ ok: false, db: 'error' });
  }
});

// Global error handler (JSON)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  res.status(500).json({ error: { message: 'Internal server error' } });
});

// Graceful shutdown
function shutdown(signal) {
  console.info(`Received ${signal}. Closing server...`);
  server.close(() => {
    pool.end().finally(() => {
      console.info('Shutdown complete.');
      process.exit(0);
    });
  });

  // Force exit after 10s
  setTimeout(() => {
    console.warn('Forcing shutdown.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start listening
const server = app.listen(port, () => {
  console.info(`✅ RoftX backend server is running on port ${port}`);
});
