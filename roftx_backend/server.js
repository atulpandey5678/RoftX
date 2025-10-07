// server.js - Production Ready Version

// 1. Load environment variables from the .env file
import 'dotenv/config';

// 2. Import required dependencies
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

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
app.use(helmet({
    contentSecurityPolicy: false, // Disable if frontend needs inline scripts
    crossOriginEmbedderPolicy: false
}));

// 6. CORS Configuration - Environment-based
const allowedOrigins = NODE_ENV === 'production'
    ? [
        'https://www.roftx.com',
        'https://roftx.com'
      ]
    : [
        'https://www.roftx.com',
        'https://roftx.com',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://localhost:5501',
        'http://localhost:8080',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5500',
        'http://127.0.0.1:5501',
        'http://127.0.0.1:8080'
      ];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.warn(`⚠️  CORS blocked request from: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 7. Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // Limit AI requests to 10 per minute per IP
    message: 'Too many AI requests, please slow down.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);

// 8. Database Connection with Pooling
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
    max: 20, // Maximum number of clients in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Database connected successfully at', res.rows[0].now);
    }
});

// Handle pool errors
pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err);
});

// --- API Endpoints ---

// 9. Health Check Route
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'OK',
        message: 'RoftX API is running',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV
    });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// 10. Google Authentication Endpoint
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;
    
    if (!token) {
        return res.status(400).json({ error: 'No token provided' });
    }

    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const {
            sub: google_id,
            name: full_name,
            email,
            picture: picture_url,
            locale,
            given_name,
            family_name
        } = payload;

        // Check if user exists
        let userResult = await pool.query(
            'SELECT * FROM users WHERE google_id = $1',
            [google_id]
        );

        if (userResult.rows.length === 0) {
            // Create new user
            console.log(`✨ New user: ${email}`);
            userResult = await pool.query(
                `INSERT INTO users (google_id, email, full_name, given_name, family_name, picture_url, locale, last_login) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) 
                 RETURNING *`,
                [google_id, email, full_name, given_name, family_name, picture_url, locale]
            );
        } else {
            // Update existing user
            console.log(`👤 Returning user: ${email}`);
            userResult = await pool.query(
                `UPDATE users 
                 SET last_login = NOW(), full_name = $2, picture_url = $3 
                 WHERE google_id = $1 
                 RETURNING *`,
                [google_id, full_name, picture_url]
            );
        }

        res.status(200).json({
            success: true,
            message: "Login successful",
            user: userResult.rows[0]
        });

    } catch (error) {
        console.error('❌ Google auth error:', error.message);
        
        if (error.message.includes('Token used too late')) {
            return res.status(401).json({ error: 'Token expired' });
        }
        
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// 11. AI Generation Endpoint (Claude API)
app.post('/api/gemini', aiLimiter, async (req, res) => {
    const startTime = Date.now();
    
    // Validate request
    if (!req.body || !req.body.contents) {
        return res.status(400).json({ error: 'Invalid request payload' });
    }

    if (!Array.isArray(req.body.contents) || req.body.contents.length === 0) {
        return res.status(400).json({ error: 'Contents array is required' });
    }

    if (!req.body.contents[0]?.parts?.[0]?.text) {
        return res.status(400).json({ error: 'Text content is required' });
    }

    try {
        // Extract prompt from Gemini-format payload
        const prompt = req.body.contents[0].parts[0].text;

        // Validate prompt length
        if (prompt.length > 50000) {
            return res.status(400).json({ error: 'Prompt too long (max 50,000 characters)' });
        }

        // Claude API configuration
        const apiUrl = 'https://api.anthropic.com/v1/messages';
        const model = "claude-3-5-haiku-20241022";

        const claudePayload = {
            model: model,
            max_tokens: 4096,
            temperature: 0.8,
            messages: [
                { role: "user", content: prompt }
            ]
        };

        // Call Claude API
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

        // Handle API errors
        if (!claudeResponse.ok) {
            console.error('❌ Claude API error:', data);
            
            if (claudeResponse.status === 429) {
                return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
            }
            
            if (claudeResponse.status === 401) {
                console.error('❌ CRITICAL: Invalid Claude API key');
                return res.status(500).json({ error: 'API configuration error' });
            }
            
            return res.status(claudeResponse.status).json({
                error: data.error?.message || 'AI service error',
                type: data.error?.type
            });
        }

        // Validate response structure
        if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
            console.error('❌ Invalid Claude response structure:', data);
            return res.status(500).json({ error: 'Invalid AI response format' });
        }

        // Extract generated text
        const generatedText = data.content[0].text;

        // Log success metrics
        const duration = Date.now() - startTime;
        console.log(`✅ AI request completed in ${duration}ms`);

        // Return in Gemini format (for frontend compatibility)
        const responseToFrontend = {
            candidates: [{
                content: {
                    parts: [{
                        text: generatedText
                    }]
                }
            }],
            usage: data.usage // Include token usage info
        };

        res.status(200).json(responseToFrontend);

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ AI endpoint error (${duration}ms):`, error.message);
        
        if (error.code === 'ECONNREFUSED') {
            return res.status(503).json({ error: 'AI service unavailable' });
        }
        
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: 'Request timeout' });
        }
        
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 12. Error Handling Middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'CORS policy violation' });
    }
    
    res.status(500).json({ error: 'Something went wrong' });
});

// 13. 404 Handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// 14. Graceful Shutdown
process.on('SIGTERM', async () => {
    console.log('⚠️  SIGTERM received, shutting down gracefully...');
    
    // Close database pool
    await pool.end();
    
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('⚠️  SIGINT received, shutting down gracefully...');
    
    await pool.end();
    
    process.exit(0);
});

// 15. Start Server
const server = app.listen(PORT, () => {
    console.log('═══════════════════════════════════════');
    console.log(`🚀 RoftX API Server Started`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV}`);
    console.log(`🔒 CORS Origins: ${allowedOrigins.length} configured`);
    console.log('═══════════════════════════════════════');
});

// Handle server errors
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use`);
    } else {
        console.error('❌ Server error:', error);
    }
    process.exit(1);
});