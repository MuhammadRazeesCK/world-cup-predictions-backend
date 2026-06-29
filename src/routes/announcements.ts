import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

// GET /api/announcements/current — public, returns the active announcement or null
router.get('/current', async (_req: Request, res: Response): Promise<void> => {
    try {
        const row = await db('announcements').orderBy('created_at', 'desc').first();
        res.json({ success: true, data: row ?? null });
    } catch (err) {
        console.error('Get announcement error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch announcement', code: 'INTERNAL_ERROR' });
    }
});

export default router;
