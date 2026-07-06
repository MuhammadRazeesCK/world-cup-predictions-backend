import { Router, Request, Response } from 'express';
import db from '../db';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// All poll routes require auth
router.use(authenticateToken);

// GET /api/polls — all active polls + recently closed, with results + user's vote
router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = (req as any).user.sub;

        const polls = await db('polls')
            .where('is_active', true)
            .orderBy('created_at', 'desc')
            .select('id', 'question', 'emoji', 'options', 'option_images', 'closes_at', 'created_at');

        if (polls.length === 0) {
            res.json({ success: true, data: [] });
            return;
        }

        const pollIds = polls.map((p) => p.id);

        // Vote counts per option per poll
        const voteCounts = await db('poll_votes')
            .whereIn('poll_id', pollIds)
            .groupBy('poll_id', 'option_index')
            .select('poll_id', 'option_index', db.raw('COUNT(*) as count'));

        // This user's votes
        const userVotes = await db('poll_votes')
            .whereIn('poll_id', pollIds)
            .where('user_id', userId)
            .select('poll_id', 'option_index');

        const userVoteMap: Record<string, number> = {};
        for (const v of userVotes) userVoteMap[v.poll_id] = parseInt(v.option_index);

        const countsByPoll: Record<string, Record<number, number>> = {};
        for (const v of voteCounts) {
            if (!countsByPoll[v.poll_id]) countsByPoll[v.poll_id] = {};
            countsByPoll[v.poll_id][parseInt(v.option_index)] = parseInt(v.count);
        }

        const now = new Date();
        const data = polls.map((p) => {
            const pollCounts = countsByPoll[p.id] ?? {};
            const totalVotes = Object.values(pollCounts).reduce((a, b) => a + b, 0);
            const options = (p.options as string[]).map((label, i) => ({
                index: i,
                label,
                image: (p.option_images as (string | null)[] | null)?.[i] ?? null,
                votes: pollCounts[i] ?? 0,
                pct: totalVotes > 0 ? Math.round(((pollCounts[i] ?? 0) / totalVotes) * 100) : 0,
            }));
            const isClosed = p.closes_at ? new Date(p.closes_at) <= now : false;
            return {
                id: p.id,
                question: p.question,
                emoji: p.emoji,
                options,
                totalVotes,
                userVote: userVoteMap[p.id] ?? null,
                closesAt: p.closes_at,
                isClosed,
                createdAt: p.created_at,
            };
        });

        res.json({ success: true, data });
    } catch (err) {
        console.error('Polls error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch polls', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/polls/:id/vote — cast a vote
router.post('/:id/vote', async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const { option_index } = req.body;
        const userId = (req as any).user.sub;

        if (typeof option_index !== 'number') {
            res.status(400).json({ success: false, error: 'option_index must be a number', code: 'VALIDATION_ERROR' });
            return;
        }

        const poll = await db('polls').where({ id, is_active: true }).first();
        if (!poll) {
            res.status(404).json({ success: false, error: 'Poll not found', code: 'NOT_FOUND' });
            return;
        }

        if (poll.closes_at && new Date(poll.closes_at) <= new Date()) {
            res.status(400).json({ success: false, error: 'This poll is closed', code: 'POLL_CLOSED' });
            return;
        }

        const options = poll.options as string[];
        if (option_index < 0 || option_index >= options.length) {
            res.status(400).json({ success: false, error: 'Invalid option', code: 'VALIDATION_ERROR' });
            return;
        }

        const existing = await db('poll_votes').where({ poll_id: id, user_id: userId }).first();
        if (existing) {
            res.status(400).json({ success: false, error: 'You already voted on this poll', code: 'ALREADY_VOTED' });
            return;
        }

        await db('poll_votes').insert({ poll_id: id, user_id: userId, option_index });

        res.json({ success: true });
    } catch (err) {
        console.error('Vote error:', err);
        res.status(500).json({ success: false, error: 'Failed to submit vote', code: 'INTERNAL_ERROR' });
    }
});

export default router;
