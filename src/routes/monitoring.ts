import { Router, Request, Response } from 'express';
import db from '../db';
import { requireAdmin } from '../middleware/adminAuth';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// All monitoring routes require admin
router.use(authenticateToken, requireAdmin);

// GET /api/admin/monitoring
router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
        const cutoff24h = db.raw(`NOW() - INTERVAL '24 hours'`);

        // Startup history (last 20)
        const startups = await db('server_events')
            .where({ type: 'startup' })
            .orderBy('created_at', 'desc')
            .limit(20)
            .select('id', 'created_at', 'metadata');

        const history = startups.map((s, i) => {
            const next = startups[i - 1];
            const ranForMs = next
                ? new Date(next.created_at).getTime() - new Date(s.created_at).getTime()
                : null;
            return { startedAt: s.created_at, metadata: s.metadata, ranForMs };
        });

        const latest = startups[0];
        const uptimeMs = latest ? Date.now() - new Date(latest.created_at).getTime() : null;

        // Recent requests from DB (last 100, last 24h)
        const recentRequests = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .orderBy('timestamp', 'desc')
            .limit(100)
            .select('timestamp', 'method', 'path', 'status', 'duration_ms as duration', 'ip', 'username', 'role');

        // 24h stats
        const stats24h = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .select(
                db.raw('COUNT(*) as total'),
                db.raw(`COUNT(*) FILTER (WHERE status >= 400) as errors`),
                db.raw('ROUND(AVG(duration_ms)) as avg_duration'),
            )
            .first();

        const total = parseInt(stats24h?.total ?? '0');
        const errors = parseInt(stats24h?.errors ?? '0');

        // User activity: per-user aggregation (last 24h, authenticated only)
        const userActivity = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .whereNotNull('username')
            .groupBy('username', 'role')
            .orderBy('total_requests', 'desc')
            .select(
                'username',
                'role',
                db.raw('COUNT(*) as total_requests'),
                db.raw('MIN(timestamp) as first_seen'),
                db.raw('MAX(timestamp) as last_seen'),
                db.raw('COUNT(DISTINCT path) as unique_paths'),
            );

        // Top paths per user (last 24h)
        const userPaths = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .whereNotNull('username')
            .groupBy('username', 'path')
            .select(
                'username',
                'path',
                db.raw('COUNT(*) as count'),
            )
            .orderBy('count', 'desc');

        // Group paths by username
        const pathsByUser: Record<string, { path: string; count: number }[]> = {};
        for (const row of userPaths) {
            if (!pathsByUser[row.username]) pathsByUser[row.username] = [];
            if (pathsByUser[row.username].length < 8) { // top 8 paths per user
                pathsByUser[row.username].push({ path: row.path, count: parseInt(row.count) });
            }
        }

        // All-time first visit per user
        const firstVisits = await db('request_logs')
            .whereNotNull('username')
            .groupBy('username')
            .select('username', db.raw('MIN(timestamp) as first_ever'));

        const firstVisitMap: Record<string, string> = {};
        for (const row of firstVisits) firstVisitMap[row.username] = row.first_ever;

        const enrichedUserActivity = userActivity.map((u: any) => ({
            username: u.username,
            role: u.role,
            totalRequests: parseInt(u.total_requests),
            firstSeen24h: u.first_seen,
            lastSeen: u.last_seen,
            uniquePaths: parseInt(u.unique_paths),
            firstEverSeen: firstVisitMap[u.username] ?? null,
            topPaths: pathsByUser[u.username] ?? [],
        }));

        res.json({
            success: true,
            data: {
                uptimeMs,
                startedAt: latest?.created_at ?? null,
                history,
                recentRequests,
                stats: {
                    total24h: total,
                    errors24h: errors,
                    errorRate: total ? Math.round((errors / total) * 100) : 0,
                    avgDurationMs: parseInt(stats24h?.avg_duration ?? '0'),
                },
                userActivity: enrichedUserActivity,
            },
        });
    } catch (err) {
        console.error('Monitoring error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch monitoring data' });
    }
});

export default router;

