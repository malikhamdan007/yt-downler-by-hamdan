# YT Downloader

A minimal YouTube video downloader web app using Node.js, Express, and ytdl-core.

## Setup

1. Install dependencies:

```
npm install
```

2. Start the server:

```
npm start
```

Or with hot-reload (if you have nodemon):

```
npm run dev
```

3. Open the app:

Visit `http://localhost:3000` and paste a YouTube URL.

## Deployment

This project has a static frontend (`public/`) and an Express backend (`server.js`). Hosting recommendation:

- Frontend: Vercel (Static)
- Backend: Render / Railway / Koyeb / Fly.io / VPS (Node server)

Why not Vercel functions for backend? The backend spawns `yt-dlp` and uses `ffmpeg`, writes temp files, and can run for a long time. These patterns are not reliable on serverless/edge runtimes.

### Steps

1) Push to GitHub.

2) Backend (Render/Railway):
- Create a new Web Service from this repo.
- Build command: `npm install`
- Start command: `npm start`
- Note the base URL, e.g. `https://your-api.onrender.com`

3) Frontend (Vercel):
- Import the same repo as a Static project.
- No build step needed; Vercel will serve `public/`.
- Configure the frontend to talk to the backend by setting `API_BASE`.

### Configure API_BASE

The frontend uses `window.API_BASE` or `localStorage.API_BASE` if set; otherwise it falls back to same-origin.

- Quick test locally (Chrome DevTools Console):
```
localStorage.setItem('API_BASE', 'https://your-api.onrender.com'); location.reload();
```

- For production on Vercel, add a simple script tag in your project (or via Vercel env injection) to define `window.API_BASE` if you want a hard-coded value:

```
<script>window.API_BASE = 'https://your-api.onrender.com';</script>
```

Or keep it empty and host frontend and backend under the same domain (reverse proxy).

### CORS

If you host frontend and backend on different domains, restrict CORS in `server.js`:

```
app.use(cors({ origin: ['https://your-frontend.vercel.app'] }));
```

## Usage

- Enter a valid YouTube video URL and click Download.
- The browser will start downloading the MP4 stream.

## Legal

This tool is for personal, non-commercial use only. Ensure you comply with YouTube's Terms of Service and local laws. Do not download content you do not have rights to. 