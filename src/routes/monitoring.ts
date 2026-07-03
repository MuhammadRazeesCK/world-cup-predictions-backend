import { Router, Request, Response } from 'express';
import db from '../db';
import { requireAdmin } from '../middleware/adminAuth';
import { authenticateToken } from '../middleware/auth';
import { getRequestLog } from '../middleware/requestLogger';

const router = Router();

// All monitoring routes require admin
router.use(authenticateToken, requireAdmin);

// GET /api/admin/monitoring
router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
        // Startup history (last 20)
        const startups = await db('server_events')
            .where({ type: 'startup' })
            .orderBy('created_at', 'desc')
            .limit(20)
            .select('id', 'created_at', 'metadata');

        // Enrich with inferred downtime between restarts
        const history = startups.map((s, i) => {
            const prev = startups[i + 1]; // older entry
            const downtimeMs = prev
                ? new Date(s.created_at).getTime() - new Date(prev.created_at).getTime() - (prev.metadata?.uptimeMs ?? 0)
                : null;
            return {
                startedAt: s.created_at,
                metadata: s.metadata,
                inferredDowntimeMs: downtimeMs !== null && downtimeMs > 0 ? downtimeMs : null,
            };
        });

        // Current uptime from most recent startup
        const latest = startups[0];
        const uptimeMs = latest
            ? Date.now() - new Date(latest.created_at).getTime()
            : null;

        // Recent requests
        const recentRequests = getRequestLog();

        // Last 24h stats from in-memory log
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const last24h = recentRequests.filter((r) => new Date(r.timestamp).getTime() > cutoff);
        const errorCount = last24h.filter((r) => r.status >= 400).length;

        res.json({
            success: true,
            data: {
                uptimeMs,
                startedAt: latest?.created_at ?? null,
                history,
                recentRequests: recentRequests.slice(0, 50),
                stats: {
                    total24h: last24h.length,
                    errors24h: errorCount,
                    errorRate: last24h.length ? Math.round((errorCount / last24h.length) * 100) : 0,
                    avgDurationMs: last24h.length
                        ? Math.round(last24h.reduce((sum, r) => sum + r.duration, 0) / last24h.length)
                        : 0,
                },
            },
        });
    } catch (err) {
        console.error('Monitoring error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch monitoring data' });
    }
});

export default router;
