import { Router, Request, Response } from 'express';
import { DateTime } from 'luxon';
import axios from 'axios';
import db from '../db';
import { authenticateToken } from '../middleware/auth';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

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
        const twelveHoursAgo = now.minus({ hours: 12 });

        const fixtures = await db('fixtures')
            .where(function () {
                // Upcoming scheduled fixtures in next 2 days
                this.where(function () {
                    this.whereBetween('kickoff_time', [now.toJSDate(), twoDaysLater.toJSDate()])
                        .whereIn('status', ['scheduled', 'live']);
                })
                // Currently live
                .orWhere('status', 'live')
                // Completed within last 12 hours (keep on dashboard for result display)
                .orWhere(function () {
                    this.where('status', 'completed')
                        .where('updated_at', '>=', twelveHoursAgo.toJSDate());
                });
            })
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

// GET /api/fixtures/:id/live-data - ESPN live clock + goal scorers (public)
router.get('/:id/live-data', async (req: Request, res: Response): Promise<void> => {
    const empty = { clock: null as string | null, state: 'pre', scorers: [] as any[] };
    try {
        const fixture = await db('fixtures').where({ id: req.params.id }).first();
        if (!fixture || !fixture.api_fixture_id) {
            res.json(empty);
            return;
        }

        const response = await axios.get(`${ESPN_BASE}/summary`, {
            params: { event: fixture.api_fixture_id },
            timeout: 8000,
        });

        const comp = response.data?.header?.competitions?.[0];
        if (!comp) { res.json(empty); return; }

        const state: string = comp.status?.type?.state ?? 'pre';
        const clock: string | null = state === 'pre' ? null : (comp.status?.type?.shortDetail ?? null);

        const competitors: any[] = comp.competitors ?? [];
        const homeId = competitors.find((c: any) => c.homeAway === 'home')?.id;

        // ESPN uses keyEvents (not plays) for soccer
        const keyEvents: any[] = response.data?.keyEvents ?? [];
        const scorers = keyEvents
            .filter((e: any) => e.scoringPlay === true && e.type?.text === 'Goal')
            .map((e: any) => {
                // Text format: "Goal! Home 0, Away 1. Scorer Name (Team) description..."
                const text: string = e.text ?? '';
                const m = text.match(/\.\s*(.+?)\s*\((.+?)\)/);
                const scorerName = m?.[1]?.trim() ?? 'Unknown';
                const teamInParens = (m?.[2] ?? '').toLowerCase();

                // Match team against fixture home/away names
                const homeMatch = fixture.home_team.toLowerCase().includes(teamInParens)
                    || teamInParens.includes(fixture.home_team.toLowerCase());

                return {
                    name: scorerName,
                    minute: e.clock?.displayValue ?? '',
                    team: homeMatch ? 'home' : 'away',
                    isOwnGoal: /own goal/i.test(text),
                    isPenalty: /penalty/i.test(text),
                };
            });

        res.json({ clock, state, scorers });
    } catch (err) {
        console.error('Live data error:', err);
        res.json(empty);
    }
});

export default router;
