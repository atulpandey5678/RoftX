// server.js - Production Ready Version

// 1. Load environment variables from the .env file
import 'dotenv/config';

// 2. Import required dependencies
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { OAuth2Client } from 'google-auth-library';
import fetch from 'node-fetch';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const { Pool } = pg;

// --- 3. Environment Variables & Security Check ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD;
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 3000;

// **CRITICAL SECURITY CHECK**
if (!GOOGLE_CLIENT_ID || !CLAUDE_API_KEY) {
    console.error("❌ FATAL ERROR: Missing GOOGLE_CLIENT_ID or CLAUDE_API_KEY");
    process.exit(1);
}
if (!DATABASE_URL && !DATABASE_PASSWORD) {
    console.error("❌ FATAL ERROR: Missing DATABASE_URL or DATABASE_PASSWORD");
    process.exit(1);
}

// 4. Initialize Express Application
const app = express();
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// 5. Security Middleware
app.use(helmet());

// 6. CORS Configuration
const allowedOrigins = [
    'https://www.roftx.com',
    'https://roftx.com',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501',
    'http://localhost:5500',
    'http://localhost:5501'
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.warn(`⚠️  CORS blocked request from: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    }
};
app.use(cors(corsOptions));
app.use(express.json());

// 7. Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', apiLimiter);

// 8. Database Connection
const pool = new Pool({
    connectionString: DATABASE_URL,
    ...(!DATABASE_URL && {
        user: 'postgres',
        host: 'localhost',
        database: 'roftx_db',
        password: DATABASE_PASSWORD,
        port: 5432,
    }),
    ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
});

pool.query('SELECT NOW()')
    .then(res => console.log('✅ Database connected successfully at', res.rows[0].now))
    .catch(err => console.error('❌ Database connection failed:', err.stack));

// --- API Endpoints ---

// 9. Health Check Route
app.get('/', (req, res) => {
    res.status(200).send('Welcome to the RoftX backend API! The server is running correctly.');
});

// 10. Google Authentication Endpoint
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token provided' });

    let ticket;
    try {
        // Step 1: Verify the token with Google
        ticket = await client.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID,
        });
    } catch (error) {
        // **NEW: Specific error logging for token verification**
        console.error('❌ Google token verification error:', error.message);
        return res.status(401).json({ error: 'Invalid Google token. Please sign in again.' });
    }

    try {
        // Step 2: Interact with the database
        const { sub: google_id, name: full_name, email, picture: picture_url, locale, given_name, family_name } = ticket.getPayload();
        
        let userResult = await pool.query('SELECT * FROM users WHERE google_id = $1', [google_id]);

        if (userResult.rows.length === 0) {
            console.log(`✨ New user signed up: ${email}`);
            userResult = await pool.query(
                `INSERT INTO users (google_id, email, full_name, given_name, family_name, picture_url, locale, last_login) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
                [google_id, email, full_name, given_name, family_name, picture_url, locale]
            );
        } else {
            console.log(`👤 Returning user logged in: ${email}`);
            userResult = await pool.query(
                `UPDATE users SET last_login = NOW(), full_name = $2, picture_url = $3 WHERE google_id = $1 RETURNING *`,
                [google_id, full_name, picture_url]
            );
        }

        res.status(200).json({ success: true, user: userResult.rows[0] });

    } catch (error) {
        // **NEW: Specific error logging for database operations**
        console.error('❌ Database query error during authentication:', error.message);
        res.status(500).json({ error: 'Server error during authentication.' });
    }
});

// 11. AI Generation Endpoint (Claude API)
app.post('/api/gemini', async (req, res) => {
    // Enhanced request validation
    if (!req.body || !req.body.contents) {
        console.warn('❌ Invalid request: Missing payload');
        return res.status(400).json({ error: 'Invalid request payload' });
    }

    if (!req.body.contents[0] || !req.body.contents[0].parts || !req.body.contents[0].parts[0] || !req.body.contents[0].parts[0].text) {
        console.warn('❌ Invalid request: Malformed content structure');
        return res.status(400).json({ error: 'Invalid content structure' });
    }

    try {
        const prompt = req.body.contents[0].parts[0].text;
        const requestedModel = req.body.model || 'haiku'; // Default to haiku for backwards compatibility

        // Validate prompt length (Claude's limit is 200k tokens, roughly ~800k characters)
        if (prompt.length > 100000) {
            console.warn('❌ Prompt too long:', prompt.length, 'characters');
            return res.status(400).json({ error: 'Prompt exceeds maximum length' });
        }

        // Model mapping for different use cases
        const modelMap = {
            'haiku': 'claude-3-5-haiku-20241022',        // Fast, lightweight - for hooks & topics
            'sonnet': 'claude-3-5-sonnet-20241022',      // Best quality - for full posts
            'haiku-legacy': 'claude-3-haiku-20240307'    // Legacy fallback
        };

        // Token limits based on model complexity
        const maxTokensMap = {
            'haiku': 2048,      // Hooks and topics need less tokens
            'sonnet': 4096,     // Full posts need more tokens
            'haiku-legacy': 1024
        };

        const selectedModel = modelMap[requestedModel] || modelMap['haiku'];
        const maxTokens = maxTokensMap[requestedModel] || maxTokensMap['haiku'];

        const apiUrl = 'https://api.anthropic.com/v1/messages';
        const claudePayload = {
            model: selectedModel,
            max_tokens: maxTokens,
            temperature: 0.7,
            messages: [{ role: "user", content: prompt }]
        };

        console.log(`🤖 Using model: ${selectedModel} for ${requestedModel} request`);

        const claudeResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify(claudePayload),
        });

        const data = await claudeResponse.json();

        if (!claudeResponse.ok) {
            // Enhanced error logging with more context
            console.error('❌ Claude API error:', {
                status: claudeResponse.status,
                statusText: claudeResponse.statusText,
                error: data.error,
                model: selectedModel,
                requestedModel: requestedModel
            });

            // Return appropriate error based on status code
            const statusCode = claudeResponse.status;
            if (statusCode === 429) {
                return res.status(429).json({ error: 'Rate limit exceeded. Please try again in a moment.' });
            } else if (statusCode === 401) {
                return res.status(500).json({ error: 'API authentication error. Please contact support.' });
            } else if (statusCode === 400) {
                return res.status(400).json({ error: 'Invalid request format. Please try again.' });
            }

            return res.status(statusCode).json({ error: data.error?.message || 'AI service error' });
        }

        // Validate response structure
        if (!data.content || !data.content[0] || !data.content[0].text) {
            console.error('❌ Invalid Claude API response structure:', data);
            return res.status(500).json({ error: 'Invalid AI response format' });
        }

        const generatedText = data.content[0].text;

        // Log successful generation (without exposing content in production)
        if (NODE_ENV !== 'production') {
            console.log(`✅ Generated ${generatedText.length} characters using ${selectedModel}`);
        } else {
            console.log(`✅ Request completed successfully with ${selectedModel}`);
        }

        const responseToFrontend = {
            candidates: [{
                content: {
                    parts: [{ text: generatedText }]
                }
            }]
        };

        res.status(200).json(responseToFrontend);

    } catch (error) {
        // Enhanced error logging
        console.error(`❌ AI endpoint error:`, {
            message: error.message,
            stack: NODE_ENV !== 'production' ? error.stack : undefined,
            requestedModel: req.body?.model
        });

        // Don't expose internal errors in production
        if (NODE_ENV === 'production') {
            res.status(500).json({ error: 'An error occurred while processing your request. Please try again.' });
        } else {
            res.status(500).json({ error: 'Internal server error', details: error.message });
        }
    }
});


// 12. 404 Handler for undefined routes
app.use((req, res) => {
    console.warn(`⚠️  404 Not Found: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Endpoint not found' });
});

// 13. Global Error Handler
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// 14. Start the Server
const server = app.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 RoftX Backend Server`);
    console.log(`${'='.repeat(50)}`);
    console.log(`Environment: ${NODE_ENV}`);
    console.log(`Port: ${PORT}`);
    console.log(`Status: Running`);
    console.log(`AI Models: Claude 3.5 Haiku & Sonnet`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(50)}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n⚠️  SIGTERM received. Starting graceful shutdown...');
    server.close(() => {
        console.log('✅ Server closed');
        pool.end(() => {
            console.log('✅ Database pool closed');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('\n⚠️  SIGINT received. Starting graceful shutdown...');
    server.close(() => {
        console.log('✅ Server closed');
        pool.end(() => {
            console.log('✅ Database pool closed');
            process.exit(0);
        });
    });
});

