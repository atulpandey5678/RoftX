// server.js

// 1. Load environment variables from the .env file
// This line MUST be at the very top.
require('dotenv').config();

// 2. Import the tools we need
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
// Use a dynamic import for node-fetch which is an ESM module
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- 3. Securely Get Keys and Perform Startup Security Check ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL; // This is provided by Render
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD; // This is for your local .env file

// **CRITICAL SECURITY CHECK**
// The server will refuse to start if any of these essential keys are missing.
if (!GOOGLE_CLIENT_ID || !GEMINI_API_KEY) {
    console.error("FATAL ERROR: Missing GOOGLE_CLIENT_ID or GEMINI_API_KEY. Check your Environment Variables.");
    process.exit(1); // Shuts down the server immediately
}
if (!DATABASE_URL && !DATABASE_PASSWORD) {
    console.error("FATAL ERROR: Missing DATABASE_URL (for Render) or DATABASE_PASSWORD (for local). Check your Environment Variables.");
    process.exit(1); // Shuts down the server immediately
}


// 4. Create the server application
const app = express();
const port = process.env.PORT || 3000;

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// 5. Configure the server
app.use(cors()); // Enable Cross-Origin Resource Sharing for your frontend
app.use(express.json()); // Allow the server to understand JSON data

// 6. Connect to your Database
// This setup smartly works for both Render (live) and your local machine (testing).
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
    ssl: DATABASE_URL ? { rejectUnauthorized: false } : false, // Enable SSL only when deployed on Render
});

// --- API Endpoints ---

// 7. Create a simple root route to confirm the server is running
app.get('/', (req, res) => {
    res.send('Welcome to the RoftX backend API! The server is running correctly.');
});

// 8. Create the secure Google login endpoint
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;
    if (!token) {
        return res.status(400).json({ error: 'No token provided.' });
    }

    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID,
        });
        
        const { sub: google_id, name: full_name, email, picture: picture_url, locale, given_name, family_name } = ticket.getPayload();

        let userResult = await pool.query('SELECT * FROM users WHERE google_id = $1', [google_id]);

        if (userResult.rows.length === 0) {
            // If user does not exist, create them
            userResult = await pool.query(
                `INSERT INTO users (google_id, email, full_name, given_name, family_name, picture_url, locale, last_login) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
                [google_id, email, full_name, given_name, family_name, picture_url, locale]
            );
        } else {
            // If user exists, update their last login time
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

// 9. Create the secure Gemini API endpoint
app.post('/api/gemini', async (req, res) => {
    const payload = req.body;
    if (!payload) {
        return res.status(400).json({ error: 'No payload provided.' });
    }

    try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
        
        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!geminiResponse.ok) {
            const errorBody = await geminiResponse.text();
            console.error("Error from Gemini API:", errorBody);
            throw new Error(`API request failed with status: ${geminiResponse.status}`);
        }
        
        const data = await geminiResponse.json();
        res.json(data);

    } catch (error) {
        console.error('Error in Gemini proxy endpoint:', error.message);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


// 10. Start the server
app.listen(port, () => {
    console.log(`✅ RoftX backend server is running on port ${port}`);
});
