import { Router, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import db from '../db';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// Memory storage — no files written to disk (Render has ephemeral FS)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max upload
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    },
});

// GET /api/users/me — current user profile incl. avatar
router.get('/me', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    try {
        const user = await db('users')
            .where({ id: userId })
            .select('id', 'username', 'email', 'role', 'avatar_url')
            .first();
        if (!user) {
            res.status(404).json({ success: false, error: 'User not found' });
            return;
        }
        res.json({ success: true, data: user });
    } catch (err) {
        console.error('Get me error:', err);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// POST /api/users/avatar — upload & compress profile photo
router.post('/avatar', authenticateToken, upload.single('avatar'), async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    if (!req.file) {
        res.status(400).json({ success: false, error: 'No image file provided' });
        return;
    }

    try {
        // Compress with sharp: 200×200 cover crop, WebP quality 72
        const webpBuffer = await sharp(req.file.buffer)
            .resize(200, 200, { fit: 'cover', position: 'centre' })
            .webp({ quality: 72 })
            .toBuffer();

        const base64 = webpBuffer.toString('base64');
        const dataUrl = `data:image/webp;base64,${base64}`;

        await db('users').where({ id: userId }).update({ avatar_url: dataUrl });

        res.json({ success: true, data: { avatar_url: dataUrl } });
    } catch (err) {
        console.error('Avatar upload error:', err);
        res.status(500).json({ success: false, error: 'Failed to process image' });
    }
});

// DELETE /api/users/avatar — remove profile photo
router.delete('/avatar', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    try {
        await db('users').where({ id: userId }).update({ avatar_url: null });
        res.json({ success: true });
    } catch (err) {
        console.error('Avatar delete error:', err);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

export default router;
