/**
 * debug.js — Raw RPC response inspector
 * GET /api/debug?token=TOKEN
 * Returns raw Blogger batchexecute response for analysis
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

    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!token) {
        return res.json({ error: 'Pass ?token=YOUR_TOKEN' });
    }

    const debug = { token: token.substring(0, 20) + '...', steps: [] };

    try {
        // STEP 1: GET page
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
            },
        });

        const html = pageResp.body;
        const cookies = extractCookies(pageResp.headers);

        let bl = 'boq_bloggeruiserver_20260218.01_p0';
        const blM = html.match(/"cfb2h"\s*:\s*"([^"]+)"/);
        if (blM) bl = blM[1];

        let at = '';
        const atM = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
        if (atM) at = atM[1];

        debug.steps.push({
            step: 'GET page',
            http_code: pageResp.status,
            cookies_collected: cookies ? cookies.substring(0, 100) + '...' : 'NONE',
            bl_found: bl,
            at_found: at || 'NOT FOUND',
            has_video_config: html.includes('VIDEO_CONFIG'),
            has_c_data: html.includes('c-data'),
            html_length: html.length,
        });

        // STEP 2: RPC POST (only Variant A)
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

        // Check for googlevideo.com URLs
        const videoUrls = [];
        const matches = rawBody.matchAll(/https:\/\/[^"'\s]+googlevideo\.com[^"'\s]+/g);
        for (const m of matches) videoUrls.push(m[0]);

        debug.steps.push({
            step: 'RPC POST',
            http_code: rpcResp.status,
            args_used: args.substring(0, 50),
            body_length: rawBody.length,
            raw_first_200: rawBody.substring(0, 200),
            clean_first_500: cleanBody.substring(0, 500),
            googlevideo_urls_found: videoUrls.length,
            googlevideo_urls: videoUrls.slice(0, 3),
        });

        return res.json({ success: true, debug });

    } catch (err) {
        return res.json({ success: false, error: err.message, debug });
    }
};
