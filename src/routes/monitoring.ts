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
        const cutoff7d  = db.raw(`NOW() - INTERVAL '7 days'`);

        // ── Startup history (last 20) ────────────────────────────────────────
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

        // ── Request logs ─────────────────────────────────────────────────────
        const recentRequests = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .orderBy('timestamp', 'desc')
            .limit(100)
            .select('timestamp', 'method', 'path', 'status', 'duration_ms as duration', 'ip', 'username', 'role');

        const stats24h = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .select(
                db.raw('COUNT(*) as total'),
                db.raw(`COUNT(*) FILTER (WHERE status >= 400) as errors`),
                db.raw('ROUND(AVG(duration_ms)) as avg_duration'),
                db.raw(`ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)) as p95_duration`),
            )
            .first();

        const total = parseInt(stats24h?.total ?? '0');
        const errors = parseInt(stats24h?.errors ?? '0');

        // ── Top endpoints (24h, exclude /health) ────────────────────────────
        const topEndpoints = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .whereNot('path', 'like', '/health%')
            .groupBy('method', 'path')
            .select(
                'method',
                'path',
                db.raw('COUNT(*) as count'),
                db.raw('ROUND(AVG(duration_ms)) as avg_ms'),
                db.raw('MAX(duration_ms) as max_ms'),
                db.raw(`COUNT(*) FILTER (WHERE status >= 400) as errors`),
            )
            .orderBy('count', 'desc')
            .limit(12);

        // ── User activity (24h) ──────────────────────────────────────────────
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

        const userPaths = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .whereNotNull('username')
            .groupBy('username', 'path')
            .select('username', 'path', db.raw('COUNT(*) as count'))
            .orderBy('count', 'desc');

        const pathsByUser: Record<string, { path: string; count: number }[]> = {};
        for (const row of userPaths) {
            if (!pathsByUser[row.username]) pathsByUser[row.username] = [];
            if (pathsByUser[row.username].length < 8) {
                pathsByUser[row.username].push({ path: row.path, count: parseInt(row.count) });
            }
        }

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

        // ── User funnel ──────────────────────────────────────────────────────
        const userCounts = await db('users')
            .select(
                db.raw('COUNT(*) as total'),
                db.raw(`COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as joined_today`),
                db.raw(`COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as joined_week`),
                db.raw(`COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '24 hours') as logged_in_today`),
                db.raw(`COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '7 days') as logged_in_7d`),
            )
            .first();

        const totalUsers = parseInt(userCounts?.total ?? '0');

        // Unique authenticated users in request_logs (DAU / WAU by actual API usage)
        const [dauRow] = await db('request_logs')
            .where('timestamp', '>=', cutoff24h)
            .whereNotNull('username')
            .countDistinct('username as count');

        const [wauRow] = await db('request_logs')
            .where('timestamp', '>=', cutoff7d)
            .whereNotNull('username')
            .countDistinct('username as count');

        // Users who have never made a prediction
        const [neverPredictedRow] = await db('users')
            .leftJoin('predictions', 'users.id', 'predictions.user_id')
            .whereNull('predictions.id')
            .where('users.role', 'user')
            .count('users.id as count');

        // ── Prediction activity ──────────────────────────────────────────────
        const predStats = await db('predictions')
            .select(
                db.raw('COUNT(*) as total'),
                db.raw(`COUNT(*) FILTER (WHERE predicted_at >= NOW() - INTERVAL '24 hours') as today`),
                db.raw(`COUNT(*) FILTER (WHERE predicted_at >= NOW() - INTERVAL '7 days') as this_week`),
                db.raw('COUNT(DISTINCT user_id) as unique_predictors'),
            )
            .first();

        // Upcoming fixture coverage (prediction_closes_at in future)
        const upcomingFixtures = await db('fixtures')
            .where('prediction_closes_at', '>', db.raw('NOW()'))
            .orderBy('kickoff_time', 'asc')
            .limit(8)
            .select('id', 'match_number', 'home_team', 'away_team', 'kickoff_time', 'stage');

        let upcomingCoverage: any[] = [];
        if (upcomingFixtures.length > 0) {
            const coverageCounts = await db('predictions')
                .whereIn('fixture_id', upcomingFixtures.map((f) => f.id))
                .groupBy('fixture_id')
                .select('fixture_id', db.raw('COUNT(DISTINCT user_id) as count'));

            const countMap: Record<string, number> = {};
            for (const row of coverageCounts) countMap[row.fixture_id] = parseInt(row.count);

            upcomingCoverage = upcomingFixtures.map((f) => ({
                fixture_id: f.id,
                match_number: f.match_number,
                home_team: f.home_team,
                away_team: f.away_team,
                kickoff_time: f.kickoff_time,
                stage: f.stage,
                predicted_count: countMap[f.id] ?? 0,
                coverage_pct: totalUsers > 0 ? Math.round(((countMap[f.id] ?? 0) / totalUsers) * 100) : 0,
            }));
        }

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
                    p95DurationMs: parseInt(stats24h?.p95_duration ?? '0'),
                },
                topEndpoints: topEndpoints.map((e: any) => ({
                    method: e.method,
                    path: e.path,
                    count: parseInt(e.count),
                    avgMs: parseInt(e.avg_ms),
                    maxMs: parseInt(e.max_ms),
                    errors: parseInt(e.errors),
                })),
                userFunnel: {
                    totalUsers,
                    joinedToday: parseInt(userCounts?.joined_today ?? '0'),
                    joinedThisWeek: parseInt(userCounts?.joined_week ?? '0'),
                    loggedInToday: parseInt(userCounts?.logged_in_today ?? '0'),
                    loggedIn7d: parseInt(userCounts?.logged_in_7d ?? '0'),
                    dau: parseInt((dauRow as any)?.count ?? '0'),
                    wau: parseInt((wauRow as any)?.count ?? '0'),
                    neverPredicted: parseInt((neverPredictedRow as any)?.count ?? '0'),
                },
                predictionActivity: {
                    total: parseInt(predStats?.total ?? '0'),
                    today: parseInt(predStats?.today ?? '0'),
                    thisWeek: parseInt(predStats?.this_week ?? '0'),
                    uniquePredictors: parseInt(predStats?.unique_predictors ?? '0'),
                    avgPerUser: totalUsers > 0
                        ? Math.round((parseInt(predStats?.total ?? '0') / totalUsers) * 10) / 10
                        : 0,
                },
                upcomingCoverage,
                userActivity: enrichedUserActivity,
            },
        });
    } catch (err) {
        console.error('Monitoring error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch monitoring data' });
    }
});

export default router;

