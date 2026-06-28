import { Router, Request, Response } from 'express';
import db from '../db';
import { authenticateToken } from '../middleware/auth';
import { calculatePoints } from '../services/scoring';

const router = Router();

// POST /api/predictions - Submit or update prediction
router.post('/', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { fixture_id, predicted_home_goals, predicted_away_goals, penalty_home_goals, penalty_away_goals } = req.body;

    if (!fixture_id) {
        res.status(400).json({ success: false, error: 'fixture_id is required', code: 'VALIDATION_ERROR' });
        return;
    }

    // Validate goal values
    const home = Number(predicted_home_goals);
    const away = Number(predicted_away_goals);

    if (
        !Number.isInteger(home) ||
        !Number.isInteger(away) ||
        home < 0 || home > 10 ||
        away < 0 || away > 10
    ) {
        res.status(400).json({ success: false, error: 'Goals must be integers between 0 and 10', code: 'VALIDATION_ERROR' });
        return;
    }

    try {
        // Fetch fixture
        const fixture = await db('fixtures').where({ id: fixture_id }).first();
        if (!fixture) {
            res.status(404).json({ success: false, error: 'Fixture not found', code: 'NOT_FOUND' });
            return;
        }

        // Block draws in knockout stages without penalty data
        const KNOCKOUT_STAGES = ['round32', 'round16', 'qf', 'sf', 'third_place', 'final'];
        const isKnockout = KNOCKOUT_STAGES.includes(fixture.stage);
        const isDraw = home === away;

        if (isKnockout && isDraw && !fixture.penalty_enabled) {
            res.status(400).json({
                success: false,
                error: 'Draws are not allowed in this knockout match',
                code: 'VALIDATION_ERROR',
            });
            return;
        }

        // Validate penalty goals when draw in penalty-enabled knockout
        const penHome = penalty_home_goals !== undefined ? Number(penalty_home_goals) : null;
        const penAway = penalty_away_goals !== undefined ? Number(penalty_away_goals) : null;

        if (isKnockout && isDraw && fixture.penalty_enabled) {
            if (penHome === null || penAway === null) {
                res.status(400).json({
                    success: false,
                    error: 'Penalty shootout prediction required for drawn knockout matches',
                    code: 'VALIDATION_ERROR',
                });
                return;
            }
            if (penHome === penAway) {
                res.status(400).json({
                    success: false,
                    error: 'Penalty shootout cannot end in a draw',
                    code: 'VALIDATION_ERROR',
                });
                return;
            }
        }

        // Check prediction window
        if (new Date() > new Date(fixture.prediction_closes_at)) {
            res.status(400).json({
                success: false,
                error: 'Prediction window is closed for this match',
                code: 'PREDICTION_WINDOW_CLOSED',
            });
            return;
        }

        // Upsert prediction
        const existing = await db('predictions')
            .where({ user_id: userId, fixture_id })
            .first();

        let prediction;
        if (existing) {
            // Update existing
            [prediction] = await db('predictions')
                .where({ id: existing.id })
                .update({
                    predicted_home_goals: home,
                    predicted_away_goals: away,
                    penalty_home_goals: isKnockout && isDraw && fixture.penalty_enabled ? penHome : null,
                    penalty_away_goals: isKnockout && isDraw && fixture.penalty_enabled ? penAway : null,
                    updated_at: new Date(),
                })
                .returning('*');

            res.json({
                success: true,
                data: prediction,
                message: 'Prediction updated successfully',
            });
        } else {
            // Insert new
            [prediction] = await db('predictions')
                .insert({
                    user_id: userId,
                    fixture_id,
                    predicted_home_goals: home,
                    predicted_away_goals: away,
                    penalty_home_goals: isKnockout && isDraw && fixture.penalty_enabled ? penHome : null,
                    penalty_away_goals: isKnockout && isDraw && fixture.penalty_enabled ? penAway : null,
                })
                .returning('*');

            res.status(201).json({
                success: true,
                data: prediction,
                message: 'Prediction saved successfully',
            });
        }
    } catch (err) {
        console.error('Prediction error:', err);
        res.status(500).json({ success: false, error: 'Failed to save prediction', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/predictions/history - User's prediction history
router.get('/history', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { result, limit = '50', offset = '0' } = req.query;

    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
    const offsetNum = Math.max(0, parseInt(String(offset), 10) || 0);

    try {
        let query = db('predictions as p')
            .join('fixtures as f', 'p.fixture_id', 'f.id')
            .where('p.user_id', userId);

        if (result) {
            const results = String(result).split(',');
            query = query.whereIn('p.result', results);
        }

        const total = await query.clone().count('p.id as count').first();
        const rows = await query
            .orderBy('f.kickoff_time', 'desc')
            .limit(limitNum)
            .offset(offsetNum)
            .select(
                'p.id',
                'p.predicted_home_goals',
                'p.predicted_away_goals',
                'p.penalty_home_goals',
                'p.penalty_away_goals',
                'p.points',
                'p.result',
                'p.predicted_at',
                'f.id as fixture_id',
                'f.match_number',
                'f.home_team',
                'f.away_team',
                'f.kickoff_time',
                'f.stage',
                'f.status',
                'f.home_score',
                'f.away_score'
            );

        const predictions = rows.map((r) => ({
            id: r.id,
            fixture: {
                id: r.fixture_id,
                match_number: r.match_number,
                home_team: r.home_team,
                away_team: r.away_team,
                kickoff_time: r.kickoff_time,
                stage: r.stage,
                status: r.status,
            },
            prediction: {
                predicted_home_goals: r.predicted_home_goals,
                predicted_away_goals: r.predicted_away_goals,
                penalty_home_goals: r.penalty_home_goals ?? null,
                penalty_away_goals: r.penalty_away_goals ?? null,
                predicted_at: r.predicted_at,
            },
            result:
                r.status === 'completed'
                    ? {
                        home_goals: r.home_score,
                        away_goals: r.away_score,
                        points: r.points,
                        result_type: r.result,
                    }
                    : { result_type: 'pending' },
        }));

        res.json({
            success: true,
            data: {
                total: Number((total as any)?.count || 0),
                predictions,
            },
        });
    } catch (err) {
        console.error('History error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch history', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/predictions/history/user/:username - Get completed predictions for any user (auth required)
router.get('/history/user/:username', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    const { username } = req.params;
    try {
        const targetUser = await db('users').where({ username }).first();
        if (!targetUser) {
            res.status(404).json({ success: false, error: 'User not found', code: 'NOT_FOUND' });
            return;
        }

        const rows = await db('predictions as p')
            .join('fixtures as f', 'p.fixture_id', 'f.id')
            .where('p.user_id', targetUser.id)
            .where('f.status', 'completed')
            .orderBy('f.kickoff_time', 'desc')
            .select(
                'p.id',
                'p.predicted_home_goals',
                'p.predicted_away_goals',
                'p.points',
                'p.result',
                'f.id as fixture_id',
                'f.match_number',
                'f.home_team',
                'f.away_team',
                'f.kickoff_time',
                'f.stage',
                'f.status',
                'f.home_score',
                'f.away_score'
            );

        const predictions = rows.map((r) => ({
            id: r.id,
            fixture: {
                id: r.fixture_id,
                match_number: r.match_number,
                home_team: r.home_team,
                away_team: r.away_team,
                kickoff_time: r.kickoff_time,
                stage: r.stage,
                status: r.status,
            },
            prediction: {
                predicted_home_goals: r.predicted_home_goals,
                predicted_away_goals: r.predicted_away_goals,
                predicted_at: null,
            },
            result: {
                home_goals: r.home_score,
                away_goals: r.away_score,
                points: r.points,
                result_type: r.result,
            },
        }));

        res.json({ success: true, data: { total: predictions.length, predictions } });
    } catch (err) {
        console.error('User history error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch user history', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/predictions/:fixture_id - Get user's prediction for a fixture
router.get('/:fixture_id', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    try {
        const prediction = await db('predictions')
            .where({ user_id: userId, fixture_id: req.params.fixture_id })
            .first();

        if (!prediction) {
            res.status(204).send();
            return;
        }

        res.json({ success: true, data: prediction });
    } catch (err) {
        console.error('Get prediction error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch prediction', code: 'INTERNAL_ERROR' });
    }
});

export default router;
