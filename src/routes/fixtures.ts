import { Router, Request, Response } from 'express';
import { DateTime } from 'luxon';
import db from '../db';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// GET /api/fixtures - All fixtures (public)
router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const { status, stage } = req.query;

        let query = db('fixtures').orderBy('kickoff_time', 'asc');

        if (status) {
            const statuses = String(status).split(',');
            query = query.whereIn('status', statuses);
        }
        if (stage) {
            query = query.where('stage', stage as string);
        }

        const fixtures = await query.select('*');
        res.json({ success: true, data: fixtures });
    } catch (err) {
        console.error('Get fixtures error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch fixtures', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/fixtures/available - Upcoming fixtures for next 2 days with user predictions (protected)
router.get('/available', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.sub;
        const now = DateTime.now().setZone('Asia/Kolkata');
        const twoDaysLater = now.plus({ days: 2 });

        const fixtures = await db('fixtures')
            .whereBetween('kickoff_time', [now.toJSDate(), twoDaysLater.toJSDate()])
            .whereIn('status', ['scheduled', 'live'])
            .orderBy('kickoff_time', 'asc')
            .select('*');

        // Get user's predictions for these fixtures
        const fixtureIds = fixtures.map((f) => f.id);
        const predictions = fixtureIds.length
            ? await db('predictions')
                .whereIn('fixture_id', fixtureIds)
                .where('user_id', userId)
                .select('*')
            : [];

        const predictionMap = new Map(predictions.map((p) => [p.fixture_id, p]));

        const enriched = fixtures.map((f) => {
            const closeAt = DateTime.fromJSDate(f.prediction_closes_at).setZone('Asia/Kolkata');
            const minutesRemaining = closeAt.diff(now, 'minutes').minutes;
            const isOpen = minutesRemaining > 0;
            const userPred = predictionMap.get(f.id);

            return {
                ...f,
                prediction_window: {
                    is_open: isOpen,
                    closes_at: closeAt.toISO(),
                    minutes_remaining: Math.max(0, Math.round(minutesRemaining)),
                },
                user_prediction: userPred
                    ? {
                        id: userPred.id,
                        predicted_home_goals: userPred.predicted_home_goals,
                        predicted_away_goals: userPred.predicted_away_goals,
                        penalty_home_goals: userPred.penalty_home_goals ?? null,
                        penalty_away_goals: userPred.penalty_away_goals ?? null,
                        predicted_at: userPred.predicted_at,
                    }
                    : null,
            };
        });

        res.json({ success: true, data: enriched });
    } catch (err) {
        console.error('Get available fixtures error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch fixtures', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/fixtures/:id - Single fixture
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const fixture = await db('fixtures').where({ id: req.params.id }).first();

        if (!fixture) {
            res.status(404).json({ success: false, error: 'Fixture not found', code: 'NOT_FOUND' });
            return;
        }

        res.json({ success: true, data: fixture });
    } catch (err) {
        console.error('Get fixture error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch fixture', code: 'INTERNAL_ERROR' });
    }
});

export default router;
