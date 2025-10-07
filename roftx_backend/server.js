// server.js

// 1. Load environment variables from the .env file
require('dotenv').config();

// 2. Import the tools we need
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- 3. Securely Get Keys and Perform Startup Security Check ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
// IMPORTANT: We are now using the Claude API Key
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY; 
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD;

// **CRITICAL SECURITY CHECK**
if (!GOOGLE_CLIENT_ID || !CLAUDE_API_KEY) {
    console.error("FATAL ERROR: Missing GOOGLE_CLIENT_ID or CLAUDE_API_KEY. Please check your Environment Variables.");
    process.exit(1);
}
if (!DATABASE_URL && !DATABASE_PASSWORD) {
    console.error("FATAL ERROR: Missing DATABASE_URL (for Render) or DATABASE_PASSWORD (for local). Please check your Environment Variables.");
    process.exit(1);
}


// 4. Create the server application
const app = express();
const port = process.env.PORT || 3000;

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// 5. Configure CORS - This is the "Guest List" for your server
const allowedOrigins = [
    'https://www.roftx.com',         // Your future production domain
    'http://localhost:8080',         // For local testing with live-server
    'http://127.0.0.1:8080',         // Also for local testing
    'http://127.0.0.1:5501',         // The address from your screenshot
    'http://127.0.0.1:5500'          // Another common live-server port
];
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests if the origin is on our guest list
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            // Block requests from unapproved origins
            console.error(`CORS Error: Request from origin ${origin} blocked.`);
            callback(new Error('Not allowed by CORS'));
        }
    }
};
app.use(cors(corsOptions));
app.use(express.json());

// 6. Connect to your Database
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

// --- API Endpoints ---

// 7. Health check route
app.get('/', (req, res) => {
    res.status(200).send('Welcome to the RoftX backend API! The server is running correctly.');
});

// 8. Secure Google login endpoint
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
            console.log(`New user detected: ${email}. Creating new record.`);
            userResult = await pool.query(
                `INSERT INTO users (google_id, email, full_name, given_name, family_name, picture_url, locale, last_login) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
                [google_id, email, full_name, given_name, family_name, picture_url, locale]
            );
        } else {
            console.log(`Returning user detected: ${email}. Updating last login.`);
            userResult = await pool.query(
                `UPDATE users SET last_login = NOW(), full_name = $2, picture_url = $3 
                 WHERE google_id = $1 RETURNING *`,
                [google_id, full_name, picture_url]
            );
        }
        res.status(200).json({ message: "Login successful!", user: userResult.rows[0] });
    } catch (error) {
        console.error('Error during Google authentication process:', error);
        res.status(500).json({ error: 'Authentication failed due to a server error.' });
    }
});

// 9. The secure AI endpoint, now powered by CLAUDE
app.post('/api/gemini', async (req, res) => {
    const incomingPayload = req.body;
    if (!incomingPayload || !incomingPayload.contents) {
        return res.status(400).json({ error: 'Invalid payload provided.' });
    }

    try {
        const prompt = incomingPayload.contents[0].parts[0].text;
        const apiUrl = 'https://api.anthropic.com/v1/messages';
        const model = "claude-3-5-haiku-latest";

        const claudePayload = {
            model: model,
            max_tokens: 1024,
            temperature: 0.7,
            messages: [
                { role: "user", content: prompt }
            ]
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
            return res.status(claudeResponse.status).json(data);
        }

        const generatedText = data.content[0].text;

        const responseToFrontend = {
            candidates: [{
                content: {
                    parts: [{
                        text: generatedText
                    }]
                }
            }]
        };

        res.status(200).json(responseToFrontend);

    } catch (error) {
        console.error('Error in Claude proxy endpoint:', error.message);
        res.status(500).json({ error: 'An internal server error occurred while contacting the AI model.' });
    }
});


// 10. Start the server
app.listen(port, () => {
    console.log(`✅ RoftX backend server is running and listening on port ${port}`);
});

