import { Router, Request, Response } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { DateTime } from 'luxon';
import bcrypt from 'bcryptjs';
import db from '../db';
import { calculatePoints } from '../services/scoring';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const VALID_STAGES = ['group', 'round32', 'round16', 'qf', 'sf', 'third_place', 'final'];

function calcPredictionCloseTime(kickoffTime: string): Date {
    return DateTime.fromISO(kickoffTime).minus({ minutes: 15 }).toJSDate();
}

async function logAdminAction(adminId: string, action: string, details: Record<string, unknown>): Promise<void> {
    await db('admin_logs').insert({ admin_id: adminId, action, details: JSON.stringify(details) });
}

// All admin routes require authentication + admin role
router.use(authenticateToken, requireAdmin);

// POST /api/admin/fixtures/bulk-upload
router.post('/fixtures/bulk-upload', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
        res.status(400).json({ success: false, error: 'No CSV file uploaded', code: 'VALIDATION_ERROR' });
        return;
    }

    let records: Record<string, string>[];
    try {
        records = parse(req.file.buffer.toString('utf-8'), {
            columns: true,
            skip_empty_lines: true,
            trim: true,
        });
    } catch {
        res.status(400).json({ success: false, error: 'Invalid CSV format', code: 'VALIDATION_ERROR' });
        return;
    }

    let uploaded = 0;
    const errors: string[] = [];

    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNum = i + 2; // 1-indexed + header row

        // Validate
        const matchNumber = parseInt(row.match_number, 10);
        if (!matchNumber || matchNumber < 1 || matchNumber > 64) {
            errors.push(`Row ${rowNum}: Invalid match_number (must be 1-64)`);
            continue;
        }

        if (!row.home_team?.trim() || !row.away_team?.trim()) {
            errors.push(`Row ${rowNum}: home_team and away_team are required`);
            continue;
        }

        if (!row.kickoff_time || !DateTime.fromISO(row.kickoff_time).isValid) {
            errors.push(`Row ${rowNum}: Invalid kickoff_time format (must be ISO 8601)`);
            continue;
        }

        if (!VALID_STAGES.includes(row.stage)) {
            errors.push(`Row ${rowNum}: Invalid stage (must be one of ${VALID_STAGES.join(', ')})`);
            continue;
        }

        const kickoffDate = DateTime.fromISO(row.kickoff_time).toJSDate();
        const predictionClosesAt = calcPredictionCloseTime(row.kickoff_time);

        try {
            // Upsert by match_number
            const existing = await db('fixtures').where({ match_number: matchNumber }).first();

            if (existing) {
                await db('fixtures').where({ match_number: matchNumber }).update({
                    home_team: row.home_team.trim(),
                    away_team: row.away_team.trim(),
                    kickoff_time: kickoffDate,
                    stage: row.stage,
                    prediction_closes_at: predictionClosesAt,
                    updated_at: new Date(),
                });
            } else {
                await db('fixtures').insert({
                    match_number: matchNumber,
                    home_team: row.home_team.trim(),
                    away_team: row.away_team.trim(),
                    kickoff_time: kickoffDate,
                    stage: row.stage,
                    status: 'scheduled',
                    prediction_closes_at: predictionClosesAt,
                });
            }

            uploaded++;
        } catch (err) {
            errors.push(`Row ${rowNum}: Database error - ${(err as Error).message}`);
        }
    }

    await logAdminAction(req.user!.sub, 'bulk_upload', { uploaded, total: records.length, errors });

    res.json({
        success: true,
        data: { uploaded, total: records.length, errors },
        message:
            errors.length > 0
                ? `Uploaded ${uploaded} of ${records.length} fixtures. ${errors.length} errors encountered.`
                : `Successfully uploaded ${uploaded} fixtures`,
    });
});

// POST /api/admin/fixtures - Create single fixture
router.post('/fixtures', async (req: Request, res: Response): Promise<void> => {
    const { match_number, home_team, away_team, kickoff_time, stage, penalty_enabled, api_fixture_id } = req.body;

    if (!match_number || !home_team || !away_team || !kickoff_time || !stage) {
        res.status(400).json({ success: false, error: 'All fields are required', code: 'VALIDATION_ERROR' });
        return;
    }

    const matchNum = parseInt(String(match_number), 10);
    if (isNaN(matchNum) || matchNum < 1) {
        res.status(400).json({ success: false, error: 'match_number must be a positive integer', code: 'VALIDATION_ERROR' });
        return;
    }

    if (!DateTime.fromISO(kickoff_time).isValid) {
        res.status(400).json({ success: false, error: 'Invalid kickoff_time format', code: 'VALIDATION_ERROR' });
        return;
    }

    if (!VALID_STAGES.includes(stage)) {
        res.status(400).json({ success: false, error: `stage must be one of: ${VALID_STAGES.join(', ')}`, code: 'VALIDATION_ERROR' });
        return;
    }

    try {
        const existing = await db('fixtures').where({ match_number: matchNum }).first();
        if (existing) {
            res.status(409).json({ success: false, error: 'Match number already exists', code: 'CONFLICT' });
            return;
        }

        const [fixture] = await db('fixtures')
            .insert({
                match_number: matchNum,
                home_team: home_team.trim(),
                away_team: away_team.trim(),
                kickoff_time: DateTime.fromISO(kickoff_time).toJSDate(),
                stage,
                status: 'scheduled',
                penalty_enabled: penalty_enabled === true || penalty_enabled === 'true',
                prediction_closes_at: calcPredictionCloseTime(kickoff_time),
                ...(api_fixture_id != null && api_fixture_id !== '' && { api_fixture_id: parseInt(String(api_fixture_id), 10) }),
            })
            .returning('*');

        await logAdminAction(req.user!.sub, 'fixture_created', { fixture_id: fixture.id, match_number: matchNum });

        res.status(201).json({ success: true, data: fixture });
    } catch (err) {
        console.error('Create fixture error:', err);
        res.status(500).json({ success: false, error: 'Failed to create fixture', code: 'INTERNAL_ERROR' });
    }
});

// PUT /api/admin/fixtures/:id - Update fixture
router.put('/fixtures/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { home_team, away_team, kickoff_time, stage, home_score, away_score, status, api_fixture_id } = req.body;

    try {
        const fixture = await db('fixtures').where({ id }).first();
        if (!fixture) {
            res.status(404).json({ success: false, error: 'Fixture not found', code: 'NOT_FOUND' });
            return;
        }

        // Cannot update scores on a completed fixture (unless re-completing it with corrected scores)
        if (fixture.status === 'completed' && status !== 'completed' && (home_score !== undefined || away_score !== undefined)) {
            res.status(400).json({ success: false, error: 'Cannot update scores on a completed fixture', code: 'VALIDATION_ERROR' });
            return;
        }

        const updates: Record<string, unknown> = { updated_at: new Date() };

        if (home_team) updates.home_team = home_team.trim();
        if (away_team) updates.away_team = away_team.trim();
        if (stage && VALID_STAGES.includes(stage)) updates.stage = stage;
        if (status && ['scheduled', 'live', 'completed'].includes(status)) updates.status = status;
        if (api_fixture_id !== undefined) {
            updates.api_fixture_id = api_fixture_id === null || api_fixture_id === '' ? null : parseInt(String(api_fixture_id), 10);
        }

        if (kickoff_time) {
            if (!DateTime.fromISO(kickoff_time).isValid) {
                res.status(400).json({ success: false, error: 'Invalid kickoff_time format', code: 'VALIDATION_ERROR' });
                return;
            }
            updates.kickoff_time = DateTime.fromISO(kickoff_time).toJSDate();
            updates.prediction_closes_at = calcPredictionCloseTime(kickoff_time);
        }

        if (home_score !== undefined && away_score !== undefined) {
            const hs = parseInt(String(home_score), 10);
            const as_ = parseInt(String(away_score), 10);
            if (isNaN(hs) || isNaN(as_) || hs < 0 || as_ < 0) {
                res.status(400).json({ success: false, error: 'Invalid scores', code: 'VALIDATION_ERROR' });
                return;
            }
            updates.home_score = hs;
            updates.away_score = as_;
        }

        // Penalty score for completed penalty-enabled fixtures
        if (req.body.penalty_home_score !== undefined || req.body.penalty_away_score !== undefined) {
            const phs = req.body.penalty_home_score === null ? null : parseInt(String(req.body.penalty_home_score), 10);
            const pas = req.body.penalty_away_score === null ? null : parseInt(String(req.body.penalty_away_score), 10);
            if (phs !== null && pas !== null) {
                if (isNaN(phs) || isNaN(pas) || phs < 0 || pas < 0) {
                    res.status(400).json({ success: false, error: 'Invalid penalty scores', code: 'VALIDATION_ERROR' });
                    return;
                }
                if (phs === pas) {
                    res.status(400).json({ success: false, error: 'Penalty score cannot be a draw', code: 'VALIDATION_ERROR' });
                    return;
                }
            }
            updates.penalty_home_score = phs;
            updates.penalty_away_score = pas;
        }

        const [updated] = await db('fixtures').where({ id }).update(updates).returning('*');
        await logAdminAction(req.user!.sub, 'fixture_updated', { fixture_id: id, changes: updates });

        // Auto-rescore ALL predictions when a completed fixture's scores are changed by admin
        const scoresChanged = updates.home_score !== undefined || updates.away_score !== undefined
            || updates.penalty_home_score !== undefined || updates.penalty_away_score !== undefined;

        if (updated.status === 'completed' && updated.home_score !== null && updated.away_score !== null && scoresChanged) {
            const preds = await db('predictions').where({ fixture_id: id }).select('*');
            const actualPenalty = (updated.penalty_enabled && updated.penalty_home_score !== null && updated.penalty_away_score !== null)
                ? { home: updated.penalty_home_score, away: updated.penalty_away_score } : null;
            for (const pred of preds) {
                const predictedPenalty = (pred.penalty_home_goals !== null && pred.penalty_away_goals !== null)
                    ? { home: pred.penalty_home_goals, away: pred.penalty_away_goals } : null;
                const { points, resultType } = calculatePoints(
                    { home: pred.predicted_home_goals, away: pred.predicted_away_goals },
                    { home: updated.home_score, away: updated.away_score },
                    updated.penalty_enabled,
                    predictedPenalty,
                    actualPenalty,
                );
                await db('predictions').where({ id: pred.id }).update({ points, result: resultType, updated_at: new Date() });
            }
            console.log(`Re-scored ${preds.length} predictions for fixture ${updated.match_number} after score correction`);
        }

        res.json({ success: true, data: updated });
    } catch (err) {
        console.error('Update fixture error:', err);
        res.status(500).json({ success: false, error: 'Failed to update fixture', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/admin/fixtures/:id/rescore - Force re-score all predictions using current DB scores
router.post('/fixtures/:id/rescore', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
        const fixture = await db('fixtures').where({ id }).first();
        if (!fixture) {
            res.status(404).json({ success: false, error: 'Fixture not found', code: 'NOT_FOUND' });
            return;
        }
        if (fixture.status !== 'completed' || fixture.home_score === null || fixture.away_score === null) {
            res.status(400).json({ success: false, error: 'Fixture must be completed with scores set', code: 'VALIDATION_ERROR' });
            return;
        }
        const preds = await db('predictions').where({ fixture_id: id }).select('*');
        const actualPenalty = (fixture.penalty_enabled && fixture.penalty_home_score !== null && fixture.penalty_away_score !== null)
            ? { home: fixture.penalty_home_score, away: fixture.penalty_away_score } : null;
        for (const pred of preds) {
            const predictedPenalty = (pred.penalty_home_goals !== null && pred.penalty_away_goals !== null)
                ? { home: pred.penalty_home_goals, away: pred.penalty_away_goals } : null;
            const { points, resultType } = calculatePoints(
                { home: pred.predicted_home_goals, away: pred.predicted_away_goals },
                { home: fixture.home_score, away: fixture.away_score },
                fixture.penalty_enabled,
                predictedPenalty,
                actualPenalty,
            );
            await db('predictions').where({ id: pred.id }).update({ points, result: resultType, updated_at: new Date() });
        }
        await logAdminAction(req.user!.sub, 'fixture_rescored', { fixture_id: id, predictions_rescored: preds.length });
        res.json({ success: true, message: `Re-scored ${preds.length} predictions`, data: { rescored: preds.length } });
    } catch (err) {
        console.error('Rescore error:', err);
        res.status(500).json({ success: false, error: 'Failed to rescore', code: 'INTERNAL_ERROR' });
    }
});

// DELETE /api/admin/fixtures/:id
router.delete('/fixtures/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;

    try {
        const fixture = await db('fixtures').where({ id }).first();
        if (!fixture) {
            res.status(404).json({ success: false, error: 'Fixture not found', code: 'NOT_FOUND' });
            return;
        }

        if (fixture.status === 'live' || fixture.status === 'completed') {
            res.status(400).json({
                success: false,
                error: 'Cannot delete a live or completed fixture',
                code: 'VALIDATION_ERROR',
            });
            return;
        }

        // Cascade delete predictions first
        await db('predictions').where({ fixture_id: id }).delete();
        await db('fixtures').where({ id }).delete();

        await logAdminAction(req.user!.sub, 'fixture_deleted', { fixture_id: id, match_number: fixture.match_number });

        res.json({ success: true, message: 'Fixture deleted successfully' });
    } catch (err) {
        console.error('Delete fixture error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete fixture', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/admin/fixtures/:id/poster - Upload match poster image
router.post('/fixtures/:id/poster', upload.single('poster'), async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!req.file) {
        res.status(400).json({ success: false, error: 'No image uploaded', code: 'VALIDATION_ERROR' });
        return;
    }
    try {
        const sharp = (await import('sharp')).default;
        const compressed = await sharp(req.file.buffer)
            .resize({ width: 900, withoutEnlargement: true })
            .webp({ quality: 78 })
            .toBuffer();
        const poster_url = `data:image/webp;base64,${compressed.toString('base64')}`;
        const [fixture] = await db('fixtures').where({ id }).update({ poster_url }).returning('*');
        if (!fixture) {
            res.status(404).json({ success: false, error: 'Fixture not found', code: 'NOT_FOUND' });
            return;
        }
        await logAdminAction(req.user!.sub, 'fixture_poster_uploaded', { fixture_id: id });
        res.json({ success: true, data: { poster_url } });
    } catch (err) {
        console.error('Poster upload error:', err);
        res.status(500).json({ success: false, error: 'Failed to upload poster', code: 'INTERNAL_ERROR' });
    }
});

// DELETE /api/admin/fixtures/:id/poster - Remove match poster
router.delete('/fixtures/:id/poster', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
        await db('fixtures').where({ id }).update({ poster_url: null });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to remove poster', code: 'INTERNAL_ERROR' });
    }
});

// PUT /api/admin/fixtures/:id/stream — set or clear the live stream URL
router.put('/fixtures/:id/stream', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { stream_url } = req.body;
    try {
        const fixture = await db('fixtures').where({ id }).first();
        if (!fixture) {
            res.status(404).json({ success: false, error: 'Fixture not found', code: 'NOT_FOUND' });
            return;
        }
        const url = typeof stream_url === 'string' && stream_url.trim() ? stream_url.trim() : null;
        await db('fixtures').where({ id }).update({ stream_url: url });
        await logAdminAction(req.user!.sub, 'fixture_stream_url_updated', { fixture_id: id, stream_url: url });
        res.json({ success: true, data: { stream_url: url } });
    } catch (err) {
        console.error('Set stream URL error:', err);
        res.status(500).json({ success: false, error: 'Failed to update stream URL', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/admin/fixtures - List all fixtures with prediction counts
router.get('/fixtures', async (_req: Request, res: Response): Promise<void> => {
    try {
        const fixtures = await db('fixtures as f')
            .leftJoin(db.raw('(SELECT fixture_id, COUNT(*) as prediction_count FROM predictions GROUP BY fixture_id) pc'), 'f.id', 'pc.fixture_id')
            .orderBy('f.kickoff_time', 'asc')
            .select('f.*', db.raw('COALESCE(pc.prediction_count, 0) as prediction_count'));

        res.json({ success: true, data: fixtures });
    } catch (err) {
        console.error('Admin get fixtures error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch fixtures', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/admin/logs
router.get('/logs', async (req: Request, res: Response): Promise<void> => {
    const { action, admin_id, startDate, endDate, limit = '100', offset = '0' } = req.query;
    const limitNum = Math.min(500, parseInt(String(limit), 10) || 100);
    const offsetNum = Math.max(0, parseInt(String(offset), 10) || 0);

    try {
        let query = db('admin_logs as al')
            .join('users as u', 'al.admin_id', 'u.id')
            .orderBy('al.created_at', 'desc')
            .limit(limitNum)
            .offset(offsetNum)
            .select('al.*', 'u.email as admin_email');

        if (action) query = query.where('al.action', action as string);
        if (admin_id) query = query.where('al.admin_id', admin_id as string);
        if (startDate) query = query.where('al.created_at', '>=', new Date(startDate as string));
        if (endDate) query = query.where('al.created_at', '<=', new Date(endDate as string));

        const logs = await query;
        res.json({ success: true, data: logs });
    } catch (err) {
        console.error('Admin logs error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch logs', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/admin/users - List all users
router.get('/users', async (_req: Request, res: Response): Promise<void> => {
    try {
        const users = await db('users')
            .select('id', 'email', 'username', 'role', 'is_active', 'created_at', 'last_login')
            .orderBy('created_at', 'desc');

        res.json({ success: true, data: users });
    } catch (err) {
        console.error('Admin get users error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch users', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/admin/users - Create a user
router.post('/users', async (req: Request, res: Response): Promise<void> => {
    const { email, username, password, role = 'user' } = req.body;

    if (!email || !username || !password) {
        res.status(400).json({ success: false, error: 'email, username and password are required', code: 'VALIDATION_ERROR' });
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ success: false, error: 'Invalid email format', code: 'VALIDATION_ERROR' });
        return;
    }
    if (!/^[a-zA-Z0-9_]{3,50}$/.test(username)) {
        res.status(400).json({ success: false, error: 'Username must be 3-50 alphanumeric/underscore chars', code: 'VALIDATION_ERROR' });
        return;
    }
    if (password.length < 8) {
        res.status(400).json({ success: false, error: 'Password must be at least 8 characters', code: 'VALIDATION_ERROR' });
        return;
    }
    if (!['user', 'admin'].includes(role)) {
        res.status(400).json({ success: false, error: 'Role must be user or admin', code: 'VALIDATION_ERROR' });
        return;
    }

    try {
        const existing = await db('users').where({ email }).orWhere({ username }).first();
        if (existing) {
            res.status(409).json({ success: false, error: 'Email or username already taken', code: 'CONFLICT' });
            return;
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const [user] = await db('users')
            .insert({ email, username, password_hash: passwordHash, role, is_active: true })
            .returning(['id', 'email', 'username', 'role', 'created_at']);

        await db('admin_logs').insert({
            admin_id: (req as any).user!.sub,
            admin_email: (req as any).user!.email,
            action: 'CREATE_USER',
            details: { email, username, role },
        });

        res.status(201).json({ success: true, data: user });
    } catch (err) {
        console.error('Admin create user error:', err);
        res.status(500).json({ success: false, error: 'Failed to create user', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/admin/users/:id/reset-password - Reset a user's password
router.post('/users/:id/reset-password', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
        res.status(400).json({ success: false, error: 'Password must be at least 8 characters', code: 'VALIDATION_ERROR' });
        return;
    }

    try {
        const user = await db('users').where({ id }).first();
        if (!user) {
            res.status(404).json({ success: false, error: 'User not found', code: 'NOT_FOUND' });
            return;
        }

        const passwordHash = await bcrypt.hash(password, 10);
        await db('users').where({ id }).update({ password_hash: passwordHash });

        // Revoke all existing sessions for this user
        await db('sessions').where({ user_id: id }).update({ is_revoked: true });

        await db('admin_logs').insert({
            admin_id: (req as any).user!.sub,
            admin_email: (req as any).user!.email,
            action: 'RESET_PASSWORD',
            details: { target_user_id: id, target_username: user.username },
        });

        res.json({ success: true, data: { message: 'Password reset successfully' } });
    } catch (err) {
        console.error('Admin reset password error:', err);
        res.status(500).json({ success: false, error: 'Failed to reset password', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/admin/fixtures/:id/rescore - Recalculate points for all predictions on a completed fixture
router.post('/fixtures/:id/rescore', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
        const fixture = await db('fixtures').where({ id }).first();
        if (!fixture) { res.status(404).json({ success: false, error: 'Fixture not found' }); return; }
        if (fixture.status !== 'completed' || fixture.home_score === null || fixture.away_score === null) {
            res.status(400).json({ success: false, error: 'Fixture must be completed with scores set' });
            return;
        }
        const preds = await db('predictions').where({ fixture_id: id }).select('*');
        const actualPenalty = (fixture.penalty_enabled && fixture.penalty_home_score !== null && fixture.penalty_away_score !== null)
            ? { home: fixture.penalty_home_score, away: fixture.penalty_away_score } : null;
        for (const pred of preds) {
            const predictedPenalty = (pred.penalty_home_goals !== null && pred.penalty_away_goals !== null)
                ? { home: pred.penalty_home_goals, away: pred.penalty_away_goals } : null;
            const { points, resultType } = calculatePoints(
                { home: pred.predicted_home_goals, away: pred.predicted_away_goals },
                { home: fixture.home_score, away: fixture.away_score },
                fixture.penalty_enabled,
                predictedPenalty,
                actualPenalty,
            );
            await db('predictions').where({ id: pred.id }).update({ points, result: resultType, updated_at: new Date() });
        }
        await logAdminAction(req.user!.sub, 'fixture_rescored', { fixture_id: id, predictions_updated: preds.length });
        res.json({ success: true, data: { updated: preds.length } });
    } catch (err) {
        console.error('Rescore error:', err);
        res.status(500).json({ success: false, error: 'Failed to rescore', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/admin/predictions - All predictions grouped by fixture, with pending users
router.get('/predictions', async (_req: Request, res: Response): Promise<void> => {
    try {
        const [rows, activeUsers] = await Promise.all([
            db('predictions as p')
                .join('users as u', 'p.user_id', 'u.id')
                .join('fixtures as f', 'p.fixture_id', 'f.id')
                .select(
                    'f.id as fixture_id',
                    'f.match_number',
                    'f.home_team',
                    'f.away_team',
                    'f.kickoff_time',
                    'f.stage',
                    'f.status',
                    'f.home_score',
                    'f.away_score',
                    'f.penalty_home_score',
                    'f.penalty_away_score',
                    'p.id as prediction_id',
                    'u.username',
                    'p.predicted_home_goals as home_goals',
                    'p.predicted_away_goals as away_goals',
                    'p.penalty_home_goals as pen_home_goals',
                    'p.penalty_away_goals as pen_away_goals',
                    'p.result',
                    'p.points',
                    'p.predicted_at',
                )
                .orderBy([{ column: 'f.kickoff_time', order: 'asc' }, { column: 'u.username', order: 'asc' }]),
                        db('users').where({ is_active: true, role: 'user' }).select('username'),
        ]);

        const allUsernames: string[] = activeUsers.map((u: { username: string }) => u.username);

        // Group by fixture
        const fixtureMap = new Map<string, { fixture: Record<string, unknown>; predictions: Record<string, unknown>[] }>();
        for (const row of rows) {
            const fid = String(row.fixture_id);
            if (!fixtureMap.has(fid)) {
                fixtureMap.set(fid, {
                    fixture: {
                        id: row.fixture_id,
                        match_number: row.match_number,
                        home_team: row.home_team,
                        away_team: row.away_team,
                        kickoff_time: row.kickoff_time,
                        stage: row.stage,
                        status: row.status,
                        home_score: row.home_score,
                        away_score: row.away_score,
                        penalty_home_score: row.penalty_home_score ?? null,
                        penalty_away_score: row.penalty_away_score ?? null,
                    },
                    predictions: [],
                });
            }
            fixtureMap.get(fid)!.predictions.push({
                id: row.prediction_id,
                username: row.username,
                home_goals: row.home_goals,
                away_goals: row.away_goals,
                pen_home_goals: row.pen_home_goals ?? null,
                pen_away_goals: row.pen_away_goals ?? null,
                result: row.result,
                points: row.points,
                predicted_at: row.predicted_at,
            });
        }

        // Attach pending_users (active users who haven't submitted for each fixture)
        const result = Array.from(fixtureMap.values()).map(({ fixture, predictions }) => ({
            fixture,
            predictions,
            pending_users: allUsernames.filter(
                (u) => !predictions.some((p: any) => p.username === u),
            ),
        }));

        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Admin predictions error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch predictions', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/admin/announcement — create/replace the active announcement (image optional, message optional)
router.post('/announcement', upload.single('image'), async (req: Request, res: Response): Promise<void> => {
    try {
        const { message } = req.body;
        let imageUrl: string | null = null;

        if (req.file) {
            const sharp = (await import('sharp')).default;
            const webp = await sharp(req.file.buffer)
                .resize({ width: 900, withoutEnlargement: true })
                .webp({ quality: 78 })
                .toBuffer();
            imageUrl = `data:image/webp;base64,${webp.toString('base64')}`;
        }

        if (!imageUrl && !message?.trim()) {
            res.status(400).json({ success: false, error: 'Provide an image or message', code: 'VALIDATION_ERROR' });
            return;
        }

        // Replace: delete all previous announcements, insert new one
        await db('announcements').delete();
        const [row] = await db('announcements').insert({
            image_url: imageUrl,
            message: message?.trim() || null,
        }).returning('*');

        await logAdminAction(req.user!.sub, 'announcement_set', { message: message?.trim() || null, has_image: !!imageUrl });
        res.json({ success: true, data: row });
    } catch (err) {
        console.error('Set announcement error:', err);
        res.status(500).json({ success: false, error: 'Failed to set announcement', code: 'INTERNAL_ERROR' });
    }
});

// DELETE /api/admin/announcement — clear the active announcement
router.delete('/announcement', async (req: Request, res: Response): Promise<void> => {
    try {
        await db('announcements').delete();
        await logAdminAction(req.user!.sub, 'announcement_cleared', {});
        res.json({ success: true });
    } catch (err) {
        console.error('Clear announcement error:', err);
        res.status(500).json({ success: false, error: 'Failed to clear announcement', code: 'INTERNAL_ERROR' });
    }
});

// ── Poll management ───────────────────────────────────────────────────────────

// GET /api/admin/polls — all polls (active + inactive)
router.get('/polls', async (_req: Request, res: Response): Promise<void> => {
    try {
        const polls = await db('polls').orderBy('created_at', 'desc').select('*');

        const pollIds = polls.map((p) => p.id);
        const voteCounts = pollIds.length
            ? await db('poll_votes')
                .whereIn('poll_id', pollIds)
                .groupBy('poll_id')
                .select('poll_id', db.raw('COUNT(*) as total'))
            : [];

        const voteMap: Record<string, number> = {};
        for (const v of voteCounts) voteMap[v.poll_id] = parseInt(v.total);

        const data = polls.map((p) => ({
            ...p,
            totalVotes: voteMap[p.id] ?? 0,
        }));

        res.json({ success: true, data });
    } catch (err) {
        console.error('Admin polls error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch polls', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/admin/polls — create a poll
router.post('/polls', async (req: Request, res: Response): Promise<void> => {
    try {
        const { question, options, option_images, emoji, closes_at } = req.body;

        if (!question?.trim()) {
            res.status(400).json({ success: false, error: 'Question is required', code: 'VALIDATION_ERROR' });
            return;
        }
        if (!Array.isArray(options) || options.length < 2 || options.length > 8) {
            res.status(400).json({ success: false, error: 'Provide 2–8 options', code: 'VALIDATION_ERROR' });
            return;
        }
        const cleanOptions = options.map((o: string) => o.trim()).filter(Boolean);
        if (cleanOptions.length < 2) {
            res.status(400).json({ success: false, error: 'At least 2 non-empty options required', code: 'VALIDATION_ERROR' });
            return;
        }
        // option_images: parallel array of image URLs (or null) per option
        const cleanImages: (string | null)[] = Array.isArray(option_images)
            ? cleanOptions.map((_: string, i: number) => (typeof option_images[i] === 'string' && option_images[i].trim() ? option_images[i].trim() : null))
            : cleanOptions.map(() => null);

        const [poll] = await db('polls').insert({
            question: question.trim(),
            options: JSON.stringify(cleanOptions),
            option_images: JSON.stringify(cleanImages),
            emoji: emoji?.trim() || null,
            closes_at: closes_at || null,
            created_by: req.user!.sub,
        }).returning('*');

        await logAdminAction(req.user!.sub, 'poll_created', { poll_id: poll.id, question: poll.question });

        res.status(201).json({ success: true, data: poll });
    } catch (err) {
        console.error('Create poll error:', err);
        res.status(500).json({ success: false, error: 'Failed to create poll', code: 'INTERNAL_ERROR' });
    }
});

// PATCH /api/admin/polls/:id — update active state or close date
router.patch('/polls/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const { is_active, closes_at, option_images } = req.body;

        const poll = await db('polls').where({ id }).first();
        if (!poll) {
            res.status(404).json({ success: false, error: 'Poll not found', code: 'NOT_FOUND' });
            return;
        }

        const updates: Record<string, unknown> = { updated_at: new Date() };
        if (typeof is_active === 'boolean') updates.is_active = is_active;
        if (closes_at !== undefined) updates.closes_at = closes_at || null;
        if (Array.isArray(option_images)) updates.option_images = JSON.stringify(option_images);

        await db('polls').where({ id }).update(updates);
        await logAdminAction(req.user!.sub, 'poll_updated', { poll_id: id, ...updates });

        res.json({ success: true });
    } catch (err) {
        console.error('Update poll error:', err);
        res.status(500).json({ success: false, error: 'Failed to update poll', code: 'INTERNAL_ERROR' });
    }
});

// DELETE /api/admin/polls/:id — delete poll + all votes
router.delete('/polls/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const poll = await db('polls').where({ id }).first();
        if (!poll) {
            res.status(404).json({ success: false, error: 'Poll not found', code: 'NOT_FOUND' });
            return;
        }
        await db('polls').where({ id }).delete(); // votes cascade-deleted
        await logAdminAction(req.user!.sub, 'poll_deleted', { poll_id: id, question: poll.question });
        res.json({ success: true });
    } catch (err) {
        console.error('Delete poll error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete poll', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/admin/polls/:id/votes — who voted for whom
router.get('/polls/:id/votes', async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const poll = await db('polls').where({ id }).first();
        if (!poll) {
            res.status(404).json({ success: false, error: 'Poll not found', code: 'NOT_FOUND' });
            return;
        }

        const votes = await db('poll_votes')
            .join('users', 'poll_votes.user_id', 'users.id')
            .where('poll_votes.poll_id', id)
            .select('poll_votes.option_index', 'users.username')
            .orderBy('poll_votes.option_index')
            .orderBy('users.username');

        const options = poll.options as string[];
        const byOption: { index: number; label: string; voters: string[] }[] = options.map((label, i) => ({
            index: i,
            label,
            voters: votes.filter((v: any) => v.option_index === i).map((v: any) => v.username),
        }));

        res.json({ success: true, data: { poll: { id: poll.id, question: poll.question }, byOption } });
    } catch (err) {
        console.error('Poll votes error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch poll votes', code: 'INTERNAL_ERROR' });
    }
});

export default router;
