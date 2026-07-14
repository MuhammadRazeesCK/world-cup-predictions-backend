import { Router, Request, Response } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';

const router = Router();

// Simple token check via query param (iframes can't send headers)
function isAuthenticated(req: Request): boolean {
    const token = req.query.token as string;
    if (!token) return false;
    try {
        jwt.verify(token, process.env.JWT_SECRET!);
        return true;
    } catch { return false; }
}

// Allowed domains — only proxy known streaming sites to prevent abuse
const ALLOWED_HOSTS = [
    'go4score.app',
    'streamed.su',
    'embedme.top',
    'viprow.nu',
    'sportsurge.net',
    'SportsBay.org',
    'sportsbay.org',
    'mpd26wc37.blogspot.com',
];

function isAllowed(url: string): boolean {
    try {
        const { hostname } = new URL(url);
        return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith(`.${h}`));
    } catch { return false; }
}

/**
 * GET /api/proxy?url=https://go4score.app/
 *
 * Reverse-proxy a streaming page:
 *   1. Fetch it server-side (no X-Frame-Options applies there)
 *   2. Strip X-Frame-Options + CSP from the response headers
 *   3. Inject <base href="..."> so all relative URLs still resolve correctly
 *   4. Send the modified HTML — browser loads it from OUR domain → no iframe block
 *
 * Non-HTML resources (JS, CSS, images) are proxied as-is (no header stripping needed
 * for them since X-Frame-Options only matters on the top-level document).
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
    if (!isAuthenticated(req)) {
        res.status(401).send('<h3>Not authorised</h3>');
        return;
    }

    const targetUrl = req.query.url as string;

    if (!targetUrl) {
        res.status(400).json({ error: 'Missing url parameter' });
        return;
    }

    if (!isAllowed(targetUrl)) {
        res.status(403).json({ error: 'This domain is not in the allowed proxy list' });
        return;
    }

    try {
        const upstream = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            timeout: 10_000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': targetUrl,
            },
            maxRedirects: 5,
        });

        const contentType: string = (upstream.headers['content-type'] as string) || 'application/octet-stream';

        // Strip headers that would block embedding
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');

        // Forward safe headers
        res.setHeader('Content-Type', contentType);
        if (upstream.headers['cache-control']) res.setHeader('Cache-Control', upstream.headers['cache-control'] as string);

        // For HTML: inject <base> tag so all relative resources still load from original domain
        if (contentType.includes('text/html')) {
            let html = Buffer.from(upstream.data).toString('utf-8');

            // Build base URL (origin of the target)
            const { origin } = new URL(targetUrl);

            // Inject <base> right after <head> (or at the very top if no <head>)
            const baseTag = `<base href="${origin}/">`;
            if (html.includes('<head>')) {
                html = html.replace('<head>', `<head>${baseTag}`);
            } else if (html.includes('<head ')) {
                html = html.replace(/<head([^>]*)>/, `<head$1>${baseTag}`);
            } else {
                html = baseTag + html;
            }

            // Remove any meta X-Frame-Options or CSP the page might inject
            html = html.replace(/<meta[^>]+http-equiv=["']?[Xx]-[Ff]rame-[Oo]ptions["']?[^>]*>/gi, '');
            html = html.replace(/<meta[^>]+http-equiv=["']?[Cc]ontent-[Ss]ecurity-[Pp]olicy["']?[^>]*>/gi, '');

            res.send(html);
        } else {
            // CSS, JS, images — pass straight through
            res.send(Buffer.from(upstream.data));
        }
    } catch (err: any) {
        const status = err.response?.status ?? 502;
        res.status(status).json({ error: 'Proxy fetch failed', detail: err.message });
    }
});

export default router;
