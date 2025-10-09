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
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501'
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
    if (!req.body || !req.body.contents) {
        return res.status(400).json({ error: 'Invalid request payload' });
    }

    try {
        const prompt = req.body.contents[0].parts[0].text;
        const apiUrl = 'https://api.anthropic.com/v1/messages';
        const model = "claude-3-haiku-20240307";

        const claudePayload = {
            model: model,
            max_tokens: 1024,
            temperature: 0.7,
            messages: [{ role: "user", content: prompt }]
        };

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
            console.error('❌ Claude API error:', data);
            return res.status(claudeResponse.status).json({ error: data.error?.message || 'AI service error' });
        }

        const generatedText = data.content[0].text;

        const responseToFrontend = {
            candidates: [{
                content: {
                    parts: [{ text: generatedText }]
                }
            }]
        };

        res.status(200).json(responseToFrontend);

    } catch (error) {
        console.error(`❌ AI endpoint error:`, error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// 12. Start the Server
app.listen(PORT, () => {
    console.log(`🚀 RoftX backend server is running and listening on port ${PORT}`);
});

