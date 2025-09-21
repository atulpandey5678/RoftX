// server.js

// 1. Load environment variables from the .env file
// This line MUST be at the very top of your file.
require('dotenv').config();

// 2. Import the tools we need
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
// Use a dynamic import for node-fetch, which is required for modern versions
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- 3. Securely Get Keys and Perform Startup Security Check ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL; // This is provided automatically by Render
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD; // This is for your local .env file

// **CRITICAL SECURITY CHECK**
// This code block ensures the server will refuse to start if any essential keys are missing.
// This is the most common reason a server fails to deploy correctly.
if (!GOOGLE_CLIENT_ID || !GEMINI_API_KEY) {
    console.error("FATAL ERROR: Missing GOOGLE_CLIENT_ID or GEMINI_API_KEY. Please check your Environment Variables on Render.");
    process.exit(1); // Shuts down the server immediately
}
// This check is important. On Render, DATABASE_URL must exist. Locally, DATABASE_PASSWORD must exist.
if (!DATABASE_URL && !DATABASE_PASSWORD) {
    console.error("FATAL ERROR: Missing DATABASE_URL (for Render) or DATABASE_PASSWORD (for local). Please check your Environment Variables.");
    process.exit(1); // Shuts down the server immediately
}


// 4. Create the server application
const app = express();
const port = process.env.PORT || 3000;

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// --- CRITICAL: Configure CORS for Prapp.use(cors()); // Enable Cross-Origin Resource Sharing so your frontend can make requests
s
app.use(express.json()); // Allow the server to understand and parse JSON data from requests

// 6. Connect to your Database
// This setup smartly works for both a live deployment on Render and your local machine.
const pool = new Pool({
    // When deployed on Render, it will use the DATABASE_URL environment variable.
    connectionString: DATABASE_URL,
    // If DATABASE_URL is NOT found (i.e., you are running locally), it uses these settings.
    ...(!DATABASE_URL && {
        user: 'postgres',
        host: 'localhost',
        database: 'roftx_db',
        password: DATABASE_PASSWORD,
        port: 5432,
    }),
    // Enable SSL for the secure connection to Render's database. This is required.
    ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- API Endpoints (The Server's Functions) ---

// 7. Create a simple "health check" route to confirm the server is running
app.get('/', (req, res) => {
    res.status(200).send('Welcome to the RoftX backend API! The server is running correctly.');
});

// 8. The secure Google login endpoint
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

        // Check if the user already exists in our database
        let userResult = await pool.query('SELECT * FROM users WHERE google_id = $1', [google_id]);

        if (userResult.rows.length === 0) {
            // If the user does not exist, create a new record for them
            console.log(`New user detected: ${email}. Creating new record.`);
            userResult = await pool.query(
                `INSERT INTO users (google_id, email, full_name, given_name, family_name, picture_url, locale, last_login) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
                [google_id, email, full_name, given_name, family_name, picture_url, locale]
            );
        } else {
            // If the user already exists, just update their last login time and info
            console.log(`Returning user detected: ${email}. Updating last login.`);
            userResult = await pool.query(
                `UPDATE users SET last_login = NOW(), full_name = $2, picture_url = $3 
                 WHERE google_id = $1 RETURNING *`,
                [google_id, full_name, picture_url]
            );
        }
        
        res.status(200).json({ message: "Login successful!", user: userResult.rows[0] });

    } catch (error) {
        // This will catch errors from both Google token verification and the database query
        console.error('Error during Google authentication process:', error);
        res.status(500).json({ error: 'Authentication failed due to a server error.' });
    }
});

// 9. The secure Gemini API endpoint (acting as a proxy)
app.post('/api/gemini', async (req, res) => {
    const payload = req.body;
    if (!payload) {
        return res.status(400).json({ error: 'No payload provided.' });
    }

    try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}Y`;
        
        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const data = await geminiResponse.json();

        // Forward the exact response (or error) from Gemini back to the frontend
        res.status(geminiResponse.status).json(data);

    } catch (error) {
        console.error('Error in Gemini proxy endpoint:', error.message);
        res.status(500).json({ error: 'An internal server error occurred while contacting the AI model.' });
    }
});


// 10. Start the server and listen for incoming requests
app.listen(port, () => {
    console.log(`✅ RoftX backend server is running and listening on port ${port}`);
});
 