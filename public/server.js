const express = require('express');
const ytdl = require('ytdl-core');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
let ytDlp;
try { ytDlp = require('yt-dlp-exec'); } catch (_) { ytDlp = null; }

// Optional ffmpeg merging
let ffmpeg; let ffmpegPath;
try {
	ffmpeg = require('fluent-ffmpeg');
	ffmpegPath = require('ffmpeg-static');
	if (ffmpegPath) {
		ffmpeg.setFfmpegPath(ffmpegPath);
	}
} catch (_) {
	ffmpeg = null;
	ffmpegPath = null;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

// CORS allowlist via env var CORS_ORIGINS (comma-separated). Falls back to open CORS for dev.
const corsOrigins = (process.env.CORS_ORIGINS || '')
	.split(',')
	.map(s => s.trim())
	.filter(Boolean);
if (corsOrigins.length > 0) {
	app.use(cors({ origin: corsOrigins }));
} else {
	app.use(cors());
}

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/health', (req, res) => { res.json({ ok: true }); });

function buildYtDlpFormat(q) {
	const height = Number.isFinite(parseInt(q, 10)) ? parseInt(q, 10) : null;
	if (!height || q === 'auto') return 'bv*+ba/b';
	return `bv*[height<=${height}]+ba/b[height<=${height}]`;
}

function tempBase(baseName) {
	const safe = (baseName || 'video').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'video';
	const uniq = Math.random().toString(36).slice(2, 8);
	return path.join(os.tmpdir(), `${safe}-${uniq}`);
}

function findFinalOutputFromBase(outBase) {
	const dir = path.dirname(outBase);
	const base = path.basename(outBase);
	const entries = fs.readdirSync(dir).map((name) => ({ name, full: path.join(dir, name) }));
	const mp4 = entries.find(e => e.name === `${base}.mp4`);
	if (mp4 && fs.existsSync(mp4.full) && fs.statSync(mp4.full).size > 0) return mp4.full;
	const candidates = entries.filter(e => e.name.startsWith(`${base}.`));
	let best = null; let bestSize = 0;
	for (const c of candidates) {
		try { const s = fs.statSync(c.full); if (s.size > bestSize) { best = c.full; bestSize = s.size; } } catch (_) {}
	}
	return best;
}

function ytDlpToFileSystem(videoUrl, q, titleHint) {
	return new Promise((resolve, reject) => {
		const outBase = tempBase(titleHint);
		const ytDlpCmd = process.env.YTDLP_PATH || 'yt-dlp';

		const runOnce = (format) => new Promise((resolveRun, rejectRun) => {
			const args = [ videoUrl ];
			if (ffmpegPath) { args.push('--ffmpeg-location', ffmpegPath); }
			args.push(
				'-f', format,
				'--quiet', '--no-progress', '--no-playlist', '--no-cache-dir', '--no-part',
				'--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
				'--merge-output-format', 'mp4',
				'--force-overwrites',
				'-o', `${outBase}.%(ext)s`
			);
			let stderrBuf = '';
			const proc = spawn(ytDlpCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
			proc.stderr.on('data', (d) => { const s = d.toString(); stderrBuf += s; console.error('[yt-dlp]', s.trim()); });
			proc.on('error', (err) => { rejectRun(err); });
			proc.on('close', (code) => {
				if (code !== 0) return rejectRun(new Error(`yt-dlp exited with code ${code}: ${stderrBuf.split('\n').slice(-20).join('\n')}`));
				try {
					const finalPath = findFinalOutputFromBase(outBase);
					if (!finalPath) return rejectRun(new Error(`Output file not found for base ${outBase}`));
					const stat = fs.statSync(finalPath);
					if (!stat || stat.size <= 0) return rejectRun(new Error(`Output file is empty: ${finalPath}`));
					resolveRun(finalPath);
				} catch (e) { rejectRun(e); }
			});
		});

		const primaryFormat = buildYtDlpFormat(q);
		runOnce(primaryFormat)
			.then(resolve)
			.catch((err) => {
				const msg = (err && err.message) || '';
				if (msg.includes('Requested format is not available') || msg.includes('is not a valid URL')) {
					// Retry with a very permissive best format
					runOnce('b').then(resolve).catch(reject);
					return;
				}
				reject(err);
			});
	});
}

function pickVideoOnlyByHeight(formats, q) {
	const height = (!q || q === 'auto') ? Infinity : parseInt(q, 10);
	const videoOnly = formats
		.filter((f) => f.hasVideo && !f.hasAudio)
		.filter((f) => (f.height || 0) <= (Number.isFinite(height) ? height : Infinity))
		.sort((a, b) => (b.height || 0) - (a.height || 0));
	const mp4First = videoOnly.filter((f) => f.container === 'mp4');
	return (mp4First[0] || videoOnly[0]) || null;
}

function getBestAudioOnly(formats) {
	const audios = formats.filter((f) => f.hasAudio && !f.hasVideo);
	const m4a = audios.filter((f) => (f.codecs || '').includes('mp4a') || f.container === 'm4a');
	return (m4a.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0])
		|| audios.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0]
		|| null;
}

function isH264(format) { return (format.codecs || '').toLowerCase().includes('avc1') || (format.codec || '').toLowerCase().includes('h264'); }

function streamMuxedWithFfmpeg(info, res, q, title) {
	if (!ffmpeg || !ffmpegPath) {
		return res.status(502).json({ error: 'Audio merge unavailable', detail: 'ffmpeg not available. Install ffmpeg-static and fluent-ffmpeg.' });
	}
	const videoFormat = pickVideoOnlyByHeight(info.formats, q) || info.formats.filter(f => f.hasVideo && (f.height || 0)).sort((a,b)=>(b.height||0)-(a.height||0))[0];
	const audioFormat = getBestAudioOnly(info.formats);
	if (!videoFormat || !audioFormat) {
		return res.status(415).json({ error: 'No suitable video/audio streams found' });
	}
	const filename = `${(title || info.videoDetails.title).replace(/[\\/:*?"<>|]/g, ' ')}.mp4`;
	res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
	res.setHeader('Content-Type', 'video/mp4');

	const commonRequest = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } };
	const vStream = ytdl.downloadFromInfo(info, { format: videoFormat, requestOptions: commonRequest, highWaterMark: 1 << 25 });
	const aStream = ytdl.downloadFromInfo(info, { format: audioFormat, requestOptions: commonRequest, highWaterMark: 1 << 25 });

	const needReencodeVideo = !isH264(videoFormat) || (videoFormat.container && videoFormat.container !== 'mp4');

	const command = ffmpeg()
		.input(vStream)
		.inputOptions(['-thread_queue_size 2048'])
		.input(aStream)
		.inputOptions(['-thread_queue_size 2048'])
		.outputOptions([
			'-map 0:v:0',
			'-map 1:a:0',
			needReencodeVideo ? '-c:v libx264' : '-c:v copy',
			'-preset veryfast',
			'-pix_fmt yuv420p',
			'-c:a aac',
			'-b:a 192k',
			'-movflags +faststart',
			'-shortest'
		])
		.format('mp4')
		.on('error', (err) => {
			console.error('ffmpeg error:', err && (err.stack || err.message || err));
			if (!res.headersSent) res.status(500).json({ error: 'ffmpeg merge failed', detail: String(err && (err.message || err)) });
		})
		.on('start', (cmd) => { console.log('ffmpeg start:', cmd); })
		.on('stderr', (line) => { if (line) console.log('ffmpeg:', String(line)); })
		.on('end', () => { console.log('ffmpeg finished'); });

	command.pipe(res, { end: true });
}

app.get('/formats', async (req, res) => {
	try {
		const videoUrl = req.query.url;
		if (!videoUrl || !ytdl.validateURL(videoUrl)) {
			return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
		}
		const info = await ytdl.getInfo(videoUrl, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } } });
		const combined = info.formats.filter((f) => f.hasAudio && f.hasVideo && f.height);
		const heights = Array.from(new Set(combined.map((f) => f.height))).sort((a, b) => a - b);
		const maxHeight = heights[heights.length - 1] || null;
		res.json({ heights, maxHeight });
	} catch (err) {
		console.error('formats error:', err && (err.stack || err.message || err));
		res.status(500).json({ error: 'Failed to load formats' });
	}
});

app.get('/download', async (req, res) => {
	try {
		const videoUrl = req.query.url;
		const q = (req.query.q || 'auto').toString();
		if (!videoUrl || !ytdl.validateURL(videoUrl)) {
			return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
		}

		let info;
		try {
			info = await ytdl.getInfo(videoUrl, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } } });
		} catch (e) {
			const msg = (e && e.message) || String(e);
			if (msg && msg.toLowerCase().includes('could not extract functions')) {
				console.warn('ytdl-core failed; using yt-dlp to file with q=', q);
				const outPath = await ytDlpToFileSystem(videoUrl, q);
				const stat = fs.statSync(outPath);
				res.setHeader('Content-Type', 'video/mp4');
				res.setHeader('Content-Length', String(stat.size));
				res.setHeader('Content-Disposition', `attachment; filename="video.mp4"`);
				fs.createReadStream(outPath).pipe(res).on('close', () => { fs.unlink(outPath, () => {}); });
				return;
			}
			throw e;
		}

		if (info.videoDetails.isLiveContent) {
			return res.status(400).json({ error: 'Live streams are not supported.' });
		}

		const title = info.videoDetails.title.replace(/[\\/:*?"<>|]/g, ' ');

		try {
			const outPath = await ytDlpToFileSystem(videoUrl, q, title);
			const stat = fs.statSync(outPath);
			res.setHeader('Content-Type', 'video/mp4');
			res.setHeader('Content-Length', String(stat.size));
			res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);
			fs.createReadStream(outPath)
				.on('error', (err) => { console.error('read temp error:', err); })
				.on('close', () => { fs.unlink(outPath, () => {}); })
				.pipe(res);
			return;
		} catch (fileErr) {
			console.warn('yt-dlp file method failed, trying ffmpeg merge:', fileErr && (fileErr.message || fileErr));
		}

		return streamMuxedWithFfmpeg(info, res, q, title);
	} catch (err) {
		console.error('Handler error:', err && (err.stack || err.message || err));
		res.status(500).json({ error: 'Server error', detail: String(err && (err.message || err)) });
	}
});

app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); }); 