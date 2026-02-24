/**
 * Blogger Video URL Extractor — Fixed 2025
 * Uses native Node.js https module for reliable cookie handling
 * Endpoint: /api/v1/blogger/:token
 */

const https = require('https');

// Native HTTPS request helper
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
        req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

// Parse Set-Cookie correctly (handles both string and array)
function extractCookies(headers) {
    const raw = headers['set-cookie'];
    if (!raw) return '';
    const arr = Array.isArray(raw) ? raw : raw.split(/,(?=[^ ])/);
    return arr.map(c => c.split(';')[0].trim()).join('; ');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

const QUALITY = {
    '18': '360p', '22': '720p', '37': '1080p', '59': '480p', '5': '240p',
    '17': '144p', '34': '360p', '35': '480p', '36': '240p', '38': 'Original',
    '43': '360p', '44': '480p', '45': '720p', '46': '1080p', '132': '144p',
    '133': '240p', '134': '360p', '135': '480p', '136': '720p', '137': '1080p',
};

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    // Token from URL: /api/v1/blogger/TOKEN
    const parts = (req.url || '').split('/');
    let token = decodeURIComponent(parts[parts.length - 1].split('?')[0]);
    token = token.replace('https://www.blogger.com/video.g?token=', '').trim();

    if (!token) {
        return res.status(400).json({ success: false, data: { status: 'fail', error: 'No token' } });
    }

    const pageUrl = `https://www.blogger.com/video.g?token=${token}`;

    try {
        /* ══════════════════════════════════════════════════════
           STEP 1 — GET Blogger page › collect cookies + bl
           ══════════════════════════════════════════════════════ */
        const pageResp = await httpRequest({
            hostname: 'www.blogger.com',
            path: `/video.g?token=${encodeURIComponent(token)}`,
            method: 'GET',
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Cache-Control': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
            },
        });

        const html = pageResp.body;
        const cookies = extractCookies(pageResp.headers);

        // Build label
        let bl = 'boq_bloggeruiserver_20260218.01_p0';
        const blM = html.match(/"cfb2h"\s*:\s*"([^"]+)"/);
        if (blM) bl = blM[1];

        // XSRF at-token — try multiple locations:
        // 1. Standard WIZ_global_data key (most Google apps)
        let at = '';
        const atM1 = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
        if (atM1) at = atM1[1];

        // 2. IJ_values[9] — Blogger stores it as: 'NONCE','XSRF','DEFAULT'
        //    Pattern: two base64-like strings then 'DEFAULT'
        if (!at) {
            const ijM = html.match(/\'([A-Za-z0-9+/=_-]{20,})\'\s*,\s*\'([A-Za-z0-9+/=_-]{20,})\'\s*,\s*\'DEFAULT\'/);
            if (ijM) at = ijM[2]; // second string is the XSRF token
        }

        // 3. Nonce → next value in IJ_values: 'NONCE_VALUE','XSRF_VALUE'
        if (!at) {
            const nonceM = html.match(/nonce="([^"]+)"/);
            if (nonceM) {
                const escaped = nonceM[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const ijM2 = html.match(new RegExp(`'${escaped}'\\s*,\\s*'([^']+)'`));
                if (ijM2) at = ijM2[1];
            }
        }

        /* ══════════════════════════════════════════════════════
           STEP 2 — Old VIDEO_CONFIG scraping (pre-2025 fallback)
           ══════════════════════════════════════════════════════ */
        if (html.includes('VIDEO_CONFIG')) {
            const vcParts = html.split('VIDEO_CONFIG =');
            if (vcParts.length >= 2) {
                const raw = vcParts[1].split('</script>')[0].trim()
                    .replace(/\\u0026/g, '&').replace(/\\u003d/g, '=');
                try {
                    const vc = JSON.parse(raw);
                    if (vc?.streams?.length) {
                        return res.json({
                            success: true,
                            data: {
                                status: 'ok',
                                image: vc.thumbnail || '',
                                sources: vc.streams.map(s => ({
                                    file: s.play_url,
                                    label: QUALITY[s.format_id] || 'Auto',
                                    type: 'video/mp4',
                                })),
                            },
                        });
                    }
                } catch (_) { }
            }
        }

        /* ══════════════════════════════════════════════════════
           STEP 3 — Blogger batchexecute RPC POST (2025 player)
           Args from data-p: ["TOKEN","",false,false]
           ══════════════════════════════════════════════════════ */
        const argVariants = [
            JSON.stringify([token, '', false, false]),
            JSON.stringify([token, '', [false], [false, 1]]),
            JSON.stringify([null, token, '', false, false]),
            JSON.stringify([token, '', [[false]], [false, 1]]),
        ];

        const rpcPath = `/_/BloggerVideoPlayerUi/data?rpcids=W8PsLe` +
            `&source-path=${encodeURIComponent('/video.g')}` +
            `&bl=${encodeURIComponent(bl)}&hl=en` +
            `&soc-app=1&soc-platform=1&soc-device=1&_reqid=12345&rt=c`;

        for (const args of argVariants) {
            const freq = JSON.stringify([[['W8PsLe', args, null, 'generic']]]);
            let bodyStr = `f.req=${encodeURIComponent(freq)}`;
            if (at) bodyStr += `&at=${encodeURIComponent(at)}`;

            const rpcHeaders = {
                'User-Agent': UA,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(bodyStr).toString(),
                'Origin': 'https://www.blogger.com',
                'Referer': pageUrl,
                'X-Same-Domain': '1',
            };
            if (cookies) rpcHeaders['Cookie'] = cookies;

            let rpcResp;
            try {
                rpcResp = await httpRequest({
                    hostname: 'www.blogger.com',
                    path: rpcPath,
                    method: 'POST',
                    headers: rpcHeaders,
                }, bodyStr);
            } catch (_) { continue; }

            if (rpcResp.status < 200 || rpcResp.status >= 400) continue;

            const clean = rpcResp.body.replace(/^\)\]\}'\n?/, '').trimStart();
            let outer;
            try { outer = JSON.parse(clean); } catch (_) { continue; }
            if (!Array.isArray(outer)) continue;

            for (const item of outer) {
                if (!Array.isArray(item) || item[0] !== 'wrb.fr') continue;
                const innerRaw = item[2];
                if (!innerRaw) continue;
                let inner;
                try { inner = JSON.parse(innerRaw); } catch (_) { continue; }
                if (!Array.isArray(inner)) continue;

                const sources = findSources(inner);
                if (sources?.length) {
                    return res.json({
                        success: true,
                        data: { status: 'ok', image: '', sources },
                    });
                }
            }
        }

        return res.json({ success: true, data: { status: 'fail', error: 'Video config not found' } });

    } catch (err) {
        return res.status(500).json({ success: false, data: { status: 'fail', error: err.message } });
    }
};

function findSources(data, depth = 0) {
    if (depth > 10 || !Array.isArray(data)) return null;
    const sources = [];
    for (const item of data) {
        if (!Array.isArray(item)) continue;
        if (item.play_url) {
            sources.push({ file: item.play_url, label: QUALITY[item.format_id] || 'Auto', type: 'video/mp4' });
        } else if (typeof item[0] === 'string' && item[0].includes('googlevideo.com')) {
            sources.push({ file: item[0], label: typeof item[1] === 'string' ? item[1] : 'Auto', type: 'video/mp4' });
        } else if (typeof item[0] === 'string' && /^https?:\/\/.+\.mp4/.test(item[0])) {
            sources.push({ file: item[0], label: typeof item[1] === 'string' ? item[1] : 'Auto', type: 'video/mp4' });
        }
    }
    if (sources.length) return sources;
    for (const v of data) {
        if (Array.isArray(v)) {
            const r = findSources(v, depth + 1);
            if (r?.length) return r;
        }
    }
    return null;
}
