import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import db from '../db';
import { authenticateToken, hashToken } from '../middleware/auth';

const router = Router();

// Rate limit auth endpoints to prevent brute force
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: { success: false, error: 'Too many requests, please try again later.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

const TOKEN_EXPIRY_SECONDS = 3 * 24 * 60 * 60; // 3 days

function generateToken(user: { id: string; email: string; username: string; role: string }): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not set');

    return jwt.sign(
        {
            sub: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
        },
        secret,
        { expiresIn: TOKEN_EXPIRY_SECONDS }
    );
}

async function storeSession(
    userId: string,
    token: string,
    req: Request
): Promise<void> {
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_SECONDS * 1000);

    await db('sessions').insert({
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        is_revoked: false,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'] || null,
    });
}

// POST /api/auth/signup — registrations closed
router.post('/signup', authLimiter, (_req: Request, res: Response): void => {
    res.status(403).json({ success: false, error: 'Registrations are closed. The prediction league has ended.', code: 'REGISTRATION_CLOSED' });
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;

    if (!email || !password) {
        res.status(400).json({ success: false, error: 'Email and password are required', code: 'VALIDATION_ERROR' });
        return;
    }

    try {
        const user = await db('users')
            .where({ email: email.toLowerCase(), is_active: true })
            .first();

        if (!user) {
            res.status(404).json({ success: false, error: 'No account found with this email', code: 'NOT_FOUND' });
            return;
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            res.status(400).json({ success: false, error: 'Invalid password', code: 'VALIDATION_ERROR' });
            return;
        }

        // Update last_login
        await db('users').where({ id: user.id }).update({ last_login: new Date() });

        const token = generateToken(user);
        await storeSession(user.id, token, req);

        res.json({
            success: true,
            data: {
                id: user.id,
                email: user.email,
                username: user.username,
                role: user.role,
                token,
                expiresIn: TOKEN_EXPIRY_SECONDS,
            },
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, error: 'Login failed', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/auth/logout
router.post('/logout', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers.authorization;
    const token = authHeader!.substring(7);
    const tokenHash = hashToken(token);

    try {
        await db('sessions').where({ token_hash: tokenHash }).update({ is_revoked: true });
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        console.error('Logout error:', err);
        res.status(500).json({ success: false, error: 'Logout failed', code: 'INTERNAL_ERROR' });
    }
});

// POST /api/auth/refresh
router.post('/refresh', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    try {
        // Revoke old token
        const authHeader = req.headers.authorization!;
        const oldToken = authHeader.substring(7);
        const oldHash = hashToken(oldToken);
        await db('sessions').where({ token_hash: oldHash }).update({ is_revoked: true });

        // Issue new token
        const user = req.user!;
        const newToken = generateToken({ id: user.sub, email: user.email, username: user.username, role: user.role });
        await storeSession(user.sub, newToken, req);

        res.json({
            success: true,
            data: { token: newToken, expiresIn: TOKEN_EXPIRY_SECONDS },
        });
    } catch (err) {
        console.error('Refresh error:', err);
        res.status(500).json({ success: false, error: 'Token refresh failed', code: 'INTERNAL_ERROR' });
    }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = await db('users')
            .where({ id: req.user!.sub, is_active: true })
            .select('id', 'email', 'username', 'role', 'created_at', 'last_login')
            .first();

        if (!user) {
            res.status(404).json({ success: false, error: 'User not found', code: 'NOT_FOUND' });
            return;
        }

        res.json({ success: true, data: user });
    } catch (err) {
        console.error('Me error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch user', code: 'INTERNAL_ERROR' });
    }
});

export default router;
