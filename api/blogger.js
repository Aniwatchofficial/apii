/**
 * Blogger Video URL Extractor API — Vercel Serverless Function
 * 
 * Endpoint: /api/v1/blogger/:token
 * Returns: { success, data: { status, sources, image } }
 * 
 * Strategy:
 *  1. GET https://www.blogger.com/video.g?token=TOKEN  → collect cookies + bl
 *  2. POST /_/BloggerVideoPlayerUi/data (batchexecute) → parse video sources
 *  3. Fallback: scrape VIDEO_CONFIG from HTML (old format)
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Extract token from URL: /api/v1/blogger/TOKEN
  const parts = req.url.split('/');
  let token = decodeURIComponent(parts[parts.length - 1].split('?')[0]);
  token = token.replace('https://www.blogger.com/video.g?token=', '');

  if (!token) {
    return res.status(400).json({ success: false, data: { status: 'fail', error: 'No token' } });
  }

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
  const pageUrl = `https://www.blogger.com/video.g?token=${token}`;

  try {
    /* ─────────────────────────────────────────────────────────────────────
       STEP 1 — GET Blogger page to get cookies + build label
       ───────────────────────────────────────────────────────────────────── */
    const pageResp = await fetch(pageUrl, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });

    const html = await pageResp.text();

    // Collect Set-Cookie headers
    const rawCookies = pageResp.headers.getSetCookie?.() ?? [];
    const cookieString = rawCookies
      .map(c => c.split(';')[0])
      .join('; ');

    // Extract build label
    let bl = 'boq_bloggeruiserver_20260218.01_p0';
    const blMatch = html.match(/"cfb2h"\s*:\s*"([^"]+)"/);
    if (blMatch) bl = blMatch[1];

    // Extract XSRF at-token if present
    let at = '';
    const atMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
    if (atMatch) at = atMatch[1];

    /* ─────────────────────────────────────────────────────────────────────
       STEP 2 — Try old VIDEO_CONFIG scraping (still works for some tokens)
       ───────────────────────────────────────────────────────────────────── */
    if (html.includes('VIDEO_CONFIG')) {
      const vcParts = html.split('VIDEO_CONFIG =');
      if (vcParts.length >= 2) {
        const jsonRaw = vcParts[1].split('</script>')[0].trim();
        try {
          const decoded = JSON.parse(
            jsonRaw
              .replace(/\\u0026/g, '&')
              .replace(/\\u003d/g, '=')
          );
          if (decoded?.streams?.length) {
            const qualityMap = {
              '18':'360p','22':'720p','37':'1080p','59':'480p',
              '5':'240p','17':'144p','34':'360p','35':'480p',
              '36':'240p','38':'Original','43':'360p','44':'480p',
              '45':'720p','46':'1080p','132':'144p','133':'240p',
              '134':'360p','135':'480p','136':'720p','137':'1080p',
            };
            return res.json({
              success: true,
              data: {
                status: 'ok',
                image: decoded.thumbnail || '',
                sources: decoded.streams.map(s => ({
                  file: s.play_url,
                  label: qualityMap[s.format_id] || 'Auto',
                  type: 'video/mp4',
                })),
              },
            });
          }
        } catch (_) {}
      }
    }

    /* ─────────────────────────────────────────────────────────────────────
       STEP 3 — Blogger batchexecute RPC POST
       Correct args format from the page's  data-p  attribute:
           %.@."TOKEN","",false,false]
       ───────────────────────────────────────────────────────────────────── */
    const qualityMap = {
      '18':'360p','22':'720p','37':'1080p','59':'480p',
      '5':'240p','17':'144p','34':'360p','35':'480p',
      '36':'240p','38':'Original','43':'360p','44':'480p',
      '45':'720p','46':'1080p','132':'144p','133':'240p',
      '134':'360p','135':'480p','136':'720p','137':'1080p',
    };

    const argVariants = [
      JSON.stringify([token, '', false, false]),           // A — from data-p (most likely)
      JSON.stringify([token, '', [false], [false, 1]]),    // B
      JSON.stringify([null, token, '', false, false]),     // C
      JSON.stringify([token, '', [[false]], [false, 1]]),  // D
    ];

    const rpcUrl = `https://www.blogger.com/_/BloggerVideoPlayerUi/data` +
      `?rpcids=W8PsLe` +
      `&source-path=${encodeURIComponent('/video.g')}` +
      `&bl=${encodeURIComponent(bl)}` +
      `&hl=en&soc-app=1&soc-platform=1&soc-device=1` +
      `&_reqid=12345&rt=c`;

    for (const args of argVariants) {
      const freq = JSON.stringify([[['W8PsLe', args, null, 'generic']]]);
      let body = `f.req=${encodeURIComponent(freq)}`;
      if (at) body += `&at=${encodeURIComponent(at)}`;

      const rpcResp = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://www.blogger.com',
          'Referer': pageUrl,
          'X-Same-Domain': '1',
          'Cookie': cookieString,
        },
        body,
        redirect: 'follow',
      });

      if (!rpcResp.ok) continue;

      const rpcText = await rpcResp.text();
      // Strip XSSI prefix )]}'\n
      const clean = rpcText.replace(/^\)\]\}'\n?/, '').trimStart();

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

        const sources = extractSources(inner, qualityMap);
        if (sources?.length) {
          return res.json({
            success: true,
            data: { status: 'ok', image: '', sources },
          });
        }
      }
    }

    /* ─────────────────────────────────────────────────────────────────────
       All methods failed
       ───────────────────────────────────────────────────────────────────── */
    return res.json({
      success: true,
      data: { status: 'fail', error: 'Video config not found' },
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      data: { status: 'fail', error: err.message },
    });
  }
}

/**
 * Recursively search nested arrays for video stream entries
 */
function extractSources(data, qualityMap, depth = 0) {
  if (depth > 10 || !Array.isArray(data)) return null;

  const sources = [];
  for (const item of data) {
    if (!Array.isArray(item)) continue;

    // Format A: { play_url, format_id }
    if (item.play_url) {
      sources.push({
        file: item.play_url,
        label: qualityMap[item.format_id] || 'Auto',
        type: 'video/mp4',
      });
    }
    // Format B: [url, quality] with googlevideo.com
    else if (typeof item[0] === 'string' && item[0].includes('googlevideo.com')) {
      sources.push({
        file: item[0],
        label: typeof item[1] === 'string' ? item[1] : 'Auto',
        type: 'video/mp4',
      });
    }
    // Format C: any URL ending in .mp4
    else if (typeof item[0] === 'string' && /^https?:\/\/.+\.mp4/.test(item[0])) {
      sources.push({
        file: item[0],
        label: typeof item[1] === 'string' ? item[1] : 'Auto',
        type: 'video/mp4',
      });
    }
  }
  if (sources.length) return sources;

  // Recurse deeper
  for (const value of data) {
    if (Array.isArray(value)) {
      const res = extractSources(value, qualityMap, depth + 1);
      if (res?.length) return res;
    }
  }
  return null;
}
