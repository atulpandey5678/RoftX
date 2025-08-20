// server.js

// 1. Import the tools we need
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// 2. Create the server application
const app = express();
const port = process.env.PORT || 3000; // Render will set the PORT environment variable

// --- 3. Securely Get Keys from Environment Variables ---
// These will be set in the Render dashboard, not in the code.
const GOOGLE_CLIENT_ID = process.env.225100810623-7v2md7r8r2os44of016c6a3ebk0gseom.apps.googleusercontent.com;
const GEMINI_API_KEY = process.env.AIzaSyCY8CxYANsCjPIqJt4WTDLBpJq_wuCocic;
const DATABASE_URL = process.env.DATABASE_URL; // Render provides this automatically

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// 4. Configure the server
app.use(cors());
app.use(express.json());

// 5. Connect to your Production PostgreSQL Database on Render
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Render's database connections
    }
});

// --- API Endpoints ---

// 6. Create the secure Google login endpoint
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

// 7. Create the secure Gemini API endpoint
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


// 8. Start the server
app.listen(port, () => {
    console.log(`RoftX backend server is running on port ${port}`);
});
