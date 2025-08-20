// server.js

// 1. Load environment variables from the .env file
// This line MUST be at the very top.
require('dotenv').config();

// 2. Import the tools we need
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- 3. Securely Get Keys and Perform Startup Security Check ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD;

// **CRITICAL SECURITY CHECK**
// The server will refuse to start if any of these essential keys are missing.
if (!GOOGLE_CLIENT_ID || !GEMINI_API_KEY) {
    console.error("FATAL ERROR: Missing GOOGLE_CLIENT_ID or GEMINI_API_KEY in your .env file.");
    process.exit(1); // Shuts down the server immediately
}
if (!DATABASE_URL && !DATABASE_PASSWORD) {
    console.error("FATAL ERROR: Missing DATABASE_URL (for Render) or DATABASE_PASSWORD (for local) in your .env file.");
    process.exit(1); // Shuts down the server immediately
}


// 4. Create the server application
const app = express();
const port = process.env.PORT || 3000;

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// 5. Configure the server
app.use(cors());
app.use(express.json());

// 6. Connect to your Database
// This setup works for both Render (live) and your local machine (testing).
const pool = new Pool({
    connectionString: DATABASE_URL, // Render provides this automatically
    // Local connection settings are used if DATABASE_URL is not set
    ...(!DATABASE_URL && {
        user: 'postgres',
        host: 'localhost',
        database: 'roftx_db',
        password: DATABASE_PASSWORD,
        port: 5432,
    }),
    ssl: DATABASE_URL ? { rejectUnauthorized: false } : false, // Enable SSL only for Render
});

// --- API Endpoints ---

// 7. Create the secure Google login endpoint
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token provided.' });

    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID,
        });
        
        const { sub: google_id, name: full_name, email, picture: picture_url, locale, given_name, family_name } = ticket.getPayload();

        let userResult = await pool.query('SELECT * FROM users WHERE google_id = $1', [google_id]);

        if (userResult.rows.length === 0) {
            userResult = await pool.query(
                `INSERT INTO users (google_id, email, full_name, given_name, family_name, picture_url, locale, last_login) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
                [google_id, email, full_name, given_name, family_name, picture_url, locale]
            );
        } else {
            userResult = await pool.query(
                `UPDATE users SET last_login = NOW(), full_name = $2, picture_url = $3 
                 WHERE google_id = $1 RETURNING *`,
                [google_id, full_name, picture_url]
            );
        }
        res.status(200).json({ message: "Login successful!", user: userResult.rows[0] });

    } catch (error) {
        console.error('Error verifying Google token:', error);
        res.status(401).json({ error: 'Invalid token or authentication failed.' });
    }
});

// 8. Create the secure Gemini API endpoint
app.post('/api/gemini', async (req, res) => {
    const payload = req.body;
    if (!payload) return res.status(400).json({ error: 'No payload provided.' });

    try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!geminiResponse.ok) {
            const errorBody = await geminiResponse.text();
            throw new Error(`API request failed: ${errorBody}`);
        }
        const data = await geminiResponse.json();
        res.json(data);

    } catch (error) {
        console.error('Error in server:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


// 9. Start the server
app.listen(port, () => {
    console.log(`RoftX backend server is running on port ${port}`);
});
