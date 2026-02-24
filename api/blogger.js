/**
 * Blogger Video URL Extractor — Puppeteer Edition
 * Uses headless Chromium to load Blogger page & intercept video network requests
 * 
 * Endpoint: /api/v1/blogger/:token
 * Returns:  { success, data: { status, sources, image } }
 */

const https = require('https');

const QUALITY = {
    '18': '360p', '22': '720p', '37': '1080p', '59': '480p', '5': '240p',
    '17': '144p', '34': '360p', '35': '480p', '36': '240p', '38': 'Original',
    '43': '360p', '44': '480p', '45': '720p', '46': '1080p', '132': '144p',
    '133': '240p', '134': '360p', '135': '480p', '136': '720p', '137': '1080p',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

function httpRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

// ─── Method 1: Old VIDEO_CONFIG scraping (fast, pre-2025) ─────────────────
async function tryVideoConfig(token) {
    const resp = await httpRequest({
        hostname: 'www.blogger.com',
        path: `/video.g?token=${encodeURIComponent(token)}`,
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity',
        },
    });
    const html = resp.body;
    if (!html.includes('VIDEO_CONFIG')) return null;

    const vcParts = html.split('VIDEO_CONFIG =');
    if (vcParts.length < 2) return null;

    const raw = vcParts[1].split('</script>')[0].trim()
        .replace(/\\u0026/g, '&').replace(/\\u003d/g, '=');
    try {
        const vc = JSON.parse(raw);
        if (!vc?.streams?.length) return null;
        return {
            sources: vc.streams.map(s => ({
                file: s.play_url,
                label: QUALITY[s.format_id] || 'Auto',
                type: 'video/mp4',
            })),
            image: vc.thumbnail || '',
        };
    } catch (_) { return null; }
}

// ─── Method 2: Puppeteer — load page, intercept video requests ────────────
async function tryPuppeteer(token) {
    let chromium, puppeteer;
    try {
        chromium = require('@sparticuz/chromium');
        puppeteer = require('puppeteer-core');
    } catch (_) {
        return null; // Not installed
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setUserAgent(UA);

        // Intercept network requests looking for googlevideo.com URLs
        const videoUrls = new Set();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            // Capture video stream URLs (googlevideo.com serves Blogger/YouTube videos)
            if (url.includes('googlevideo.com') && url.includes('itag=')) {
                videoUrls.add(url);
            }
            try { req.continue(); } catch (_) { }
        });

        // Also capture via response interception (for XHR calls)
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('/_/BloggerVideoPlayerUi/data')) {
                try {
                    const text = await response.text();
                    const clean = text.replace(/^\)\]\}'\n?/, '').trimStart();
                    // Try to extract googlevideo URLs from the response text
                    const matches = text.matchAll(/https:\/\/[^"'\s\\]+googlevideo\.com[^"'\s\\]+/g);
                    for (const m of matches) videoUrls.add(m[0]);
                } catch (_) { }
            }
        });

        const pageUrl = `https://www.blogger.com/video.g?token=${token}`;
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait for video sources to appear (max 12 seconds)
        let waited = 0;
        while (videoUrls.size === 0 && waited < 12000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }

        await browser.close();

        if (videoUrls.size === 0) return null;

        // Deduplicate by itag quality
        const seen = new Set();
        const sources = [];
        for (const url of videoUrls) {
            const itagM = url.match(/[?&]itag=(\d+)/);
            const itag = itagM ? itagM[1] : 'unknown';
            if (seen.has(itag)) continue;
            seen.add(itag);
            sources.push({
                file: url,
                label: QUALITY[itag] || `itag-${itag}`,
                type: 'video/mp4',
            });
        }

        // Sort by quality descending (higher itag number = higher quality, roughly)
        sources.sort((a, b) => {
            const qa = parseInt(a.label) || 0;
            const qb = parseInt(b.label) || 0;
            return qb - qa;
        });

        return sources.length ? { sources, image: '' } : null;

    } catch (err) {
        if (browser) try { await browser.close(); } catch (_) { }
        console.error('Puppeteer error:', err.message);
        return null;
    }
}

// ─── Main handler ──────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    // Extract token from URL
    const parts = (req.url || '').split('/');
    let token = decodeURIComponent(parts[parts.length - 1].split('?')[0]);
    token = token.replace('https://www.blogger.com/video.g?token=', '').trim();

    if (!token) {
        return res.status(400).json({ success: false, data: { status: 'fail', error: 'No token' } });
    }

    try {
        // Method 1: Fast — try old VIDEO_CONFIG scraping
        const fromConfig = await tryVideoConfig(token);
        if (fromConfig) {
            return res.json({ success: true, data: { status: 'ok', ...fromConfig } });
        }

        // Method 2: Puppeteer — headless browser (2025 new format)
        const fromPuppeteer = await tryPuppeteer(token);
        if (fromPuppeteer) {
            return res.json({ success: true, data: { status: 'ok', ...fromPuppeteer } });
        }

        // All failed
        return res.json({ success: true, data: { status: 'fail', error: 'Video config not found' } });

    } catch (err) {
        return res.status(500).json({ success: false, data: { status: 'fail', error: err.message } });
    }
};
