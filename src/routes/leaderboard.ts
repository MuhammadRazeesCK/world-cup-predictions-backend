import { Router, Request, Response } from 'express';
import db from '../db';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// GET /api/leaderboard - Public leaderboard
router.get('/', async (req: Request, res: Response): Promise<void> => {
    const { limit = '100', offset = '0', stage_group = 'all' } = req.query;
    const limitNum = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 100));
    const offsetNum = Math.max(0, parseInt(String(offset), 10) || 0);

    // Build the prediction join clause based on stage_group filter
    let predJoin = 'LEFT JOIN predictions p ON u.id = p.user_id';
    if (stage_group === 'group') {
        predJoin = `LEFT JOIN predictions p ON u.id = p.user_id
          AND p.fixture_id IN (SELECT id FROM fixtures WHERE stage LIKE 'group%')`;
    } else if (stage_group === 'knockout') {
        predJoin = `LEFT JOIN predictions p ON u.id = p.user_id
          AND p.fixture_id IN (SELECT id FROM fixtures WHERE stage NOT LIKE 'group%')`;
    }

    try {
        const rows = await db.raw(`
      SELECT
        ROW_NUMBER() OVER (ORDER BY
          COALESCE(SUM(p.points), 0) DESC,
          ROUND(
            COUNT(CASE WHEN p.result IS NOT NULL AND p.points > 0 THEN 1 END)::NUMERIC /
            NULLIF(COUNT(CASE WHEN p.result IS NOT NULL THEN 1 END), 0) * 100,
            1
          ) DESC
        ) AS rank,
        u.id AS user_id,
        u.username,
        COALESCE(SUM(p.points), 0) AS total_points,
        COUNT(p.id) AS total_predictions,
        COUNT(CASE WHEN p.result IS NOT NULL THEN 1 END) AS completed_predictions,
        COUNT(CASE WHEN p.result = 'exact' THEN 1 END) AS exact_predictions,
        COUNT(CASE WHEN p.result = 'winner' THEN 1 END) AS winner_predictions,
        ROUND(
          COUNT(CASE WHEN p.result IS NOT NULL AND p.points > 0 THEN 1 END)::NUMERIC /
          NULLIF(COUNT(CASE WHEN p.result IS NOT NULL THEN 1 END), 0) * 100,
          1
        ) AS accuracy_percentage
      FROM users u
      ${predJoin}
      WHERE u.is_active = TRUE AND u.role = 'user'
      GROUP BY u.id, u.username
      ORDER BY rank ASC
      LIMIT ? OFFSET ?
    `, [limitNum, offsetNum]);

        const totalResult = await db('users').where({ is_active: true, role: 'user' }).count('id as count').first();
        const totalUsers = Number((totalResult as any)?.count || 0);

        res.json({
            success: true,
            data: {
                total_users: totalUsers,
                leaderboard: rows.rows.map((r: any) => ({
                    rank: Number(r.rank),
                    user_id: r.user_id,
                    username: r.username,
                    total_points: Number(r.total_points),
                    total_predictions: Number(r.total_predictions),
                    completed_predictions: Number(r.completed_predictions),
                    exact_predictions: Number(r.exact_predictions),
                    winner_predictions: Number(r.winner_predictions),
                    accuracy_percentage: Number(r.accuracy_percentage) || 0,
                })),
            },
        });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch leaderboard', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/leaderboard/stats - Personal stats (protected)
router.get('/stats', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    try {
        // Get user's stats
        const statsResult = await db.raw(`
      SELECT
        COALESCE(SUM(p.points), 0) AS total_points,
        COUNT(p.id) AS total_predictions,
        COUNT(CASE WHEN p.result IS NOT NULL THEN 1 END) AS completed_predictions,
        COUNT(CASE WHEN p.result = 'exact' THEN 1 END) AS exact_predictions,
        COUNT(CASE WHEN p.result = 'winner' THEN 1 END) AS winner_predictions,
        COUNT(CASE WHEN p.result = 'wrong' THEN 1 END) AS wrong_predictions,
        ROUND(
          COUNT(CASE WHEN p.result IS NOT NULL AND p.points > 0 THEN 1 END)::NUMERIC /
          NULLIF(COUNT(CASE WHEN p.result IS NOT NULL THEN 1 END), 0) * 100,
          1
        ) AS accuracy_percentage
      FROM users u
      LEFT JOIN predictions p ON u.id = p.user_id
      WHERE u.id = ?
      GROUP BY u.id
    `, [userId]);

        const stats = statsResult.rows[0] || {
            total_points: 0,
            total_predictions: 0,
            completed_predictions: 0,
            exact_predictions: 0,
            winner_predictions: 0,
            wrong_predictions: 0,
            accuracy_percentage: 0,
        };

        // Get user's rank
        const rankResult = await db.raw(`
      WITH ranked AS (
        SELECT
          u.id,
          COALESCE(SUM(p.points), 0) AS total_points,
          ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(p.points), 0) DESC) AS rank
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id
        WHERE u.is_active = TRUE AND u.role = 'user'
        GROUP BY u.id
      )
      SELECT rank, total_points FROM ranked WHERE id = ?
    `, [userId]);

        const rankData = rankResult.rows[0];
        const userRank = rankData ? Number(rankData.rank) : null;

        // Total active users for percentile
        const totalUsersResult = await db('users').where({ is_active: true, role: 'user' }).count('id as count').first();
        const totalUsers = Number((totalUsersResult as any)?.count || 1);
        const percentile = userRank ? Math.round((1 - (userRank - 1) / totalUsers) * 100) : 0;

        // Next milestone (user ahead)
        let nextMilestone = null;
        if (userRank && userRank > 1) {
            const nextUser = await db.raw(`
        WITH ranked AS (
          SELECT
            u.id,
            u.username,
            COALESCE(SUM(p.points), 0) AS total_points,
            ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(p.points), 0) DESC) AS rank
          FROM users u
          LEFT JOIN predictions p ON u.id = p.user_id
          WHERE u.is_active = TRUE AND u.role = 'user'
          GROUP BY u.id
        )
        SELECT username, total_points FROM ranked WHERE rank = ?
      `, [userRank - 1]);

            if (nextUser.rows[0]) {
                nextMilestone = {
                    points_needed: Number(nextUser.rows[0].total_points) - Number(stats.total_points),
                    next_rank_position: userRank - 1,
                    next_rank_username: nextUser.rows[0].username,
                };
            }
        }

        res.json({
            success: true,
            data: {
                rank: userRank,
                total_points: Number(stats.total_points),
                total_predictions: Number(stats.total_predictions),
                completed_predictions: Number(stats.completed_predictions),
                accuracy_percentage: Number(stats.accuracy_percentage) || 0,
                exact_predictions: Number(stats.exact_predictions),
                winner_predictions: Number(stats.winner_predictions),
                wrong_predictions: Number(stats.wrong_predictions),
                percentile,
                next_milestone: nextMilestone,
            },
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch stats', code: 'INTERNAL_ERROR' });
    }
});

export default router;
