import { Router, Request, Response } from 'express';
import db from '../db';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';

const router = Router();

router.use(authenticateToken, requireAdmin);

function computeStreaks(
    predictions: { result: string | null; points: number | null; match_number: number }[]
): { maxSuccess: number; maxWrong: number } {
    const sorted = [...predictions].sort((a, b) => a.match_number - b.match_number);
    const completed = sorted.filter((p) => p.result !== null);

    let maxSuccess = 0, curSuccess = 0;
    let maxWrong = 0, curWrong = 0;

    for (const p of completed) {
        const correct = (p.points ?? 0) > 0;
        if (correct) {
            curSuccess++;
            curWrong = 0;
        } else {
            curWrong++;
            curSuccess = 0;
        }
        if (curSuccess > maxSuccess) maxSuccess = curSuccess;
        if (curWrong > maxWrong) maxWrong = curWrong;
    }

    return { maxSuccess, maxWrong };
}

// GET /api/admin/wrapup
router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
        // ── 1. Per-player base stats ─────────────────────────────────────────
        const playerRows = await db.raw(`
            SELECT
                u.id AS user_id,
                u.username,
                u.avatar_url,
                COALESCE(SUM(p.points), 0)::int AS total_points,
                COUNT(p.id)::int AS total_predictions,
                COUNT(CASE WHEN p.result IS NOT NULL THEN 1 END)::int AS completed_predictions,
                COUNT(CASE WHEN p.result = 'exact' THEN 1 END)::int AS exact_predictions,
                COUNT(CASE WHEN p.result = 'winner' OR p.result = 'draw_correct' THEN 1 END)::int AS winner_predictions,
                COUNT(CASE WHEN p.result = 'wrong' THEN 1 END)::int AS wrong_predictions,
                ROUND(
                    COUNT(CASE WHEN p.result IS NOT NULL AND p.points > 0 THEN 1 END)::NUMERIC /
                    NULLIF(COUNT(CASE WHEN p.result IS NOT NULL THEN 1 END), 0) * 100,
                    1
                ) AS accuracy_percentage
            FROM users u
            LEFT JOIN predictions p ON u.id = p.user_id
            WHERE u.is_active = TRUE AND u.role = 'user'
            GROUP BY u.id, u.username, u.avatar_url
            ORDER BY total_points DESC
        `);

        // ── 2. All completed predictions for streak calc ────────────────────
        const allPreds = await db('predictions as p')
            .join('fixtures as f', 'p.fixture_id', 'f.id')
            .whereNotNull('p.result')
            .select('p.user_id', 'p.result', 'p.points', 'f.match_number');

        // Group by user
        const predsByUser: Record<string, typeof allPreds> = {};
        for (const pred of allPreds) {
            if (!predsByUser[pred.user_id]) predsByUser[pred.user_id] = [];
            predsByUser[pred.user_id].push(pred);
        }

        // ── 3. Build full leaderboard with streaks ──────────────────────────
        const leaderboard = playerRows.rows.map((r: any, idx: number) => {
            const userPreds = predsByUser[r.user_id] ?? [];
            const { maxSuccess, maxWrong } = computeStreaks(userPreds);
            return {
                rank: idx + 1,
                user_id: r.user_id,
                username: r.username,
                avatar_url: r.avatar_url ?? null,
                total_points: Number(r.total_points),
                total_predictions: Number(r.total_predictions),
                completed_predictions: Number(r.completed_predictions),
                exact_predictions: Number(r.exact_predictions),
                winner_predictions: Number(r.winner_predictions),
                wrong_predictions: Number(r.wrong_predictions),
                accuracy_percentage: Number(r.accuracy_percentage) || 0,
                max_success_streak: maxSuccess,
                max_wrong_streak: maxWrong,
            };
        });

        // ── 4. Overall summary ───────────────────────────────────────────────
        const fixtureCount = await db('fixtures').count('id as count').first();
        const completedCount = await db('fixtures').where({ status: 'completed' }).count('id as count').first();
        const totalPredictions = leaderboard.reduce((s: number, p: any) => s + p.total_predictions, 0);
        const totalExact = leaderboard.reduce((s: number, p: any) => s + p.exact_predictions, 0);
        const totalPoints = leaderboard.reduce((s: number, p: any) => s + p.total_points, 0);
        const activePlayers = leaderboard.filter((p: any) => p.total_predictions > 0).length;

        const summary = {
            total_players: activePlayers,
            total_fixtures: Number(fixtureCount?.count ?? 0),
            completed_fixtures: Number(completedCount?.count ?? 0),
            total_predictions: totalPredictions,
            total_exact_scores: totalExact,
            total_points_awarded: totalPoints,
        };

        // ── 5. Records ───────────────────────────────────────────────────────
        const active = leaderboard.filter((p: any) => p.completed_predictions > 0);

        const mostPredictions   = active.reduce((a: any, b: any) => b.total_predictions > a.total_predictions ? b : a, active[0]);
        const leastPredictions  = active.reduce((a: any, b: any) => b.total_predictions < a.total_predictions ? b : a, active[0]);
        const highestAccuracy   = active.reduce((a: any, b: any) => b.accuracy_percentage > a.accuracy_percentage ? b : a, active[0]);
        const mostExact         = active.reduce((a: any, b: any) => b.exact_predictions > a.exact_predictions ? b : a, active[0]);
        const longestSuccess    = active.reduce((a: any, b: any) => b.max_success_streak > a.max_success_streak ? b : a, active[0]);
        const longestWrong      = active.reduce((a: any, b: any) => b.max_wrong_streak > a.max_wrong_streak ? b : a, active[0]);

        const records = {
            most_predictions:    { username: mostPredictions?.username,  value: mostPredictions?.total_predictions },
            least_predictions:   { username: leastPredictions?.username, value: leastPredictions?.total_predictions },
            highest_accuracy:    { username: highestAccuracy?.username,  value: highestAccuracy?.accuracy_percentage },
            most_exact_scores:   { username: mostExact?.username,        value: mostExact?.exact_predictions },
            longest_success_streak: { username: longestSuccess?.username, value: longestSuccess?.max_success_streak },
            longest_wrong_streak:   { username: longestWrong?.username,   value: longestWrong?.max_wrong_streak },
        };

        // ── 6. Per-fixture prediction stats (hardest / easiest match) ────────
        const fixtureStats = await db.raw(`
            SELECT
                f.match_number,
                f.home_team,
                f.away_team,
                f.stage,
                f.home_score,
                f.away_score,
                f.penalty_home_score,
                f.penalty_away_score,
                COUNT(p.id)::int AS total_predictions,
                COUNT(CASE WHEN p.result = 'exact' THEN 1 END)::int AS exact_count,
                COUNT(CASE WHEN p.result IN ('winner','draw_correct') THEN 1 END)::int AS winner_count,
                COUNT(CASE WHEN p.result = 'wrong' THEN 1 END)::int AS wrong_count,
                ROUND(
                    COUNT(CASE WHEN p.result = 'exact' THEN 1 END)::NUMERIC /
                    NULLIF(COUNT(CASE WHEN p.result IS NOT NULL THEN 1 END), 0) * 100,
                    1
                ) AS exact_percentage
            FROM fixtures f
            LEFT JOIN predictions p ON f.id = p.fixture_id
            WHERE f.status = 'completed'
            GROUP BY f.id, f.match_number, f.home_team, f.away_team, f.stage,
                     f.home_score, f.away_score, f.penalty_home_score, f.penalty_away_score
            ORDER BY f.match_number ASC
        `);

        const fixtures = fixtureStats.rows.map((r: any) => ({
            match_number: r.match_number,
            home_team: r.home_team,
            away_team: r.away_team,
            stage: r.stage,
            home_score: r.home_score,
            away_score: r.away_score,
            penalty_home_score: r.penalty_home_score,
            penalty_away_score: r.penalty_away_score,
            total_predictions: Number(r.total_predictions),
            exact_count: Number(r.exact_count),
            winner_count: Number(r.winner_count),
            wrong_count: Number(r.wrong_count),
            exact_percentage: Number(r.exact_percentage) || 0,
        }));

        // Hardest / easiest (among fixtures with at least 5 predictions)
        const scored = fixtures.filter((f: any) => f.total_predictions >= 5);
        const hardest = scored.reduce((a: any, b: any) => b.exact_percentage < a.exact_percentage ? b : a, scored[0]);
        const easiest = scored.reduce((a: any, b: any) => b.exact_percentage > a.exact_percentage ? b : a, scored[0]);
        const mostPredicted = fixtures.reduce((a: any, b: any) => b.total_predictions > a.total_predictions ? b : a, fixtures[0]);

        // ── 7. Knockout bracket results ──────────────────────────────────────
        const KNOCKOUT_STAGES = ['round32', 'round16', 'qf', 'sf', 'third_place', 'final'];
        const knockoutResults = await db('fixtures')
            .whereIn('stage', KNOCKOUT_STAGES)
            .where({ status: 'completed' })
            .orderBy([{ column: 'stage', order: 'asc' }, { column: 'match_number', order: 'asc' }])
            .select('match_number', 'home_team', 'away_team', 'stage', 'home_score', 'away_score', 'penalty_home_score', 'penalty_away_score');

        const knockoutWithWinner = knockoutResults.map((f: any) => {
            let winner = null;
            if (f.home_score !== null && f.away_score !== null) {
                if (f.home_score > f.away_score) winner = f.home_team;
                else if (f.away_score > f.home_score) winner = f.away_team;
                else if (f.penalty_home_score !== null && f.penalty_away_score !== null) {
                    winner = f.penalty_home_score > f.penalty_away_score ? f.home_team : f.away_team;
                }
            }
            return { ...f, winner };
        });

        // Stage order for display
        const stageOrder: Record<string, number> = { round32: 1, round16: 2, qf: 3, sf: 4, third_place: 5, final: 6 };
        knockoutWithWinner.sort((a: any, b: any) => (stageOrder[a.stage] ?? 9) - (stageOrder[b.stage] ?? 9) || a.match_number - b.match_number);

        res.json({
            success: true,
            data: {
                summary,
                leaderboard,
                records,
                fixture_highlights: {
                    hardest_to_predict: hardest ?? null,
                    easiest_to_predict: easiest ?? null,
                    most_predicted: mostPredicted ?? null,
                },
                knockout_results: knockoutWithWinner,
                fixture_stats: fixtures,
            },
        });
    } catch (err) {
        console.error('Wrapup error:', err);
        res.status(500).json({ success: false, error: 'Failed to generate wrap-up', code: 'INTERNAL_ERROR' });
    }
});

export default router;
