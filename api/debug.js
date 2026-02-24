/**
 * debug.js — Raw RPC response inspector v2
 * GET /api/debug?token=TOKEN
 * DELETE after debugging!
 */

const https = require('https');

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

function extractCookies(headers) {
    const raw = headers['set-cookie'];
    if (!raw) return '';
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map(c => c.split(';')[0].trim()).join('; ');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const qs = (req.url || '').split('?')[1] || '';
    const params = Object.fromEntries(new URLSearchParams(qs));
    const token = params.token || '';

    if (!token) return res.json({ error: 'Pass ?token=YOUR_TOKEN' });

    const result = { token: token.substring(0, 20) + '...', steps: [] };

    try {
        // ── STEP 1: GET page ────────────────────────────────────────────────
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

        // XSRF extraction — method 1: SNlM0e
        let at = '';
        const atM1 = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
        if (atM1) { at = atM1[1]; }

        // XSRF extraction — method 2: IJ_values pattern 'NONCE','XSRF','DEFAULT'
        let atMethod2 = '';
        const ijM = html.match(/'([A-Za-z0-9+\/=_-]{20,})'\s*,\s*'([A-Za-z0-9+\/=_-]{20,})'\s*,\s*'DEFAULT'/);
        if (ijM) { atMethod2 = ijM[2]; if (!at) at = atMethod2; }

        // XSRF extraction — method 3: nonce → next IJ_values entry
        let atMethod3 = '';
        if (!at) {
            const nonceM = html.match(/nonce="([^"]+)"/);
            if (nonceM) {
                const escaped = nonceM[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const ijM2 = html.match(new RegExp(`'${escaped}'\\s*,\\s*'([^']+)'`));
                if (ijM2) { atMethod3 = ijM2[1]; at = atMethod3; }
            }
        }

        result.steps.push({
            step: 'GET page',
            http_code: pageResp.status,
            bl_found: bl,
            cookies_found: cookies ? 'YES (' + cookies.substring(0, 80) + '...)' : 'NONE',
            at_method1_SNlM0e: atM1 ? atM1[1] : 'NOT FOUND',
            at_method2_IJ_values: atMethod2 || 'NOT FOUND',
            at_method3_nonce: atMethod3 || 'NOT FOUND',
            at_final: at || 'NONE — will 400!',
            has_video_config: html.includes('VIDEO_CONFIG'),
            has_c_data: html.includes('c-data'),
            html_length: html.length,
        });

        // ── STEP 2: RPC POST ─────────────────────────────────────────────────
        const args = JSON.stringify([token, '', false, false]);
        const freq = JSON.stringify([[['W8PsLe', args, null, 'generic']]]);
        let bodyStr = `f.req=${encodeURIComponent(freq)}`;
        if (at) bodyStr += `&at=${encodeURIComponent(at)}`;

        const rpcPath = `/_/BloggerVideoPlayerUi/data?rpcids=W8PsLe` +
            `&source-path=${encodeURIComponent('/video.g')}` +
            `&bl=${encodeURIComponent(bl)}&hl=en` +
            `&soc-app=1&soc-platform=1&soc-device=1&_reqid=12345&rt=c`;

        const rpcHeaders = {
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
            'Origin': 'https://www.blogger.com',
            'Referer': `https://www.blogger.com/video.g?token=${token}`,
            'X-Same-Domain': '1',
        };
        if (cookies) rpcHeaders['Cookie'] = cookies;

        const rpcResp = await httpRequest({
            hostname: 'www.blogger.com',
            path: rpcPath,
            method: 'POST',
            headers: rpcHeaders,
        }, bodyStr);

        const rawBody = rpcResp.body;
        const cleanBody = rawBody.replace(/^\)\]\}'\n?/, '').trimStart();

        const videoUrls = [...rawBody.matchAll(/https:\/\/[^\s"']+googlevideo\.com[^\s"']+/g)]
            .map(m => m[0]);

        result.steps.push({
            step: 'RPC POST',
            http_code: rpcResp.status,
            at_sent: at ? at.substring(0, 20) + '...' : 'NONE',
            request_body_length: Buffer.byteLength(bodyStr),
            response_length: rawBody.length,
            raw_first_300: rawBody.substring(0, 300),
            clean_first_500: cleanBody.substring(0, 500),
            googlevideo_urls_found: videoUrls.length,
            googlevideo_urls: videoUrls.slice(0, 2),
        });

        return res.json({ success: true, debug: result });

    } catch (err) {
        result.error = err.message;
        return res.json({ success: false, debug: result });
    }
};
