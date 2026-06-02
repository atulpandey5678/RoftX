# RoftX — AI LinkedIn Post Generator

RoftX is a premium AI-powered LinkedIn personal branding tool. Generate scroll-stopping posts in 60 seconds using the E.N.G.A.G.E framework.

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS — no framework needed
- **Backend**: Node.js + Express
- **AI**: OpenAI GPT-4o (primary) + Claude (fallback)
- **Auth**: Google OAuth 2.0
- **Database**: Supabase (PostgreSQL)

## Local Development

### 1. Clone the repo
```bash
git clone https://github.com/atulpandey5678/RoftX.git
cd RoftX
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up environment variables
```bash
cp roftx_backend/.env.example roftx_backend/.env
# Fill in your values in .env
```

### 4. Run locally
```bash
npm run dev
```

- Frontend: http://127.0.0.1:5500
- Backend API: http://127.0.0.1:3000

## Deployment

### Backend (Render / Railway)
1. Deploy `roftx_backend/server.js` as a Node.js service
2. Set all environment variables from `.env.example` in your hosting dashboard
3. Update `PROD_API` in `generator.html` and `signup.html` with your deployed backend URL

### Frontend
Host the root HTML files on any static host (Netlify, Vercel, GitHub Pages).

## Environment Variables

See `roftx_backend/.env.example` for all required variables.

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `NODE_ENV` | `development` or `production` |
| `PORT` | Backend port (default: 3000) |

## License
MIT
