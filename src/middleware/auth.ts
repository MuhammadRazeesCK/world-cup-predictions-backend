import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import db from '../db';

export interface JWTPayload {
    sub: string;
    email: string;
    username: string;
    role: 'user' | 'admin';
    iat: number;
    exp: number;
}

// Extend Express Request
declare global {
    namespace Express {
        interface Request {
            user?: JWTPayload;
        }
    }
}

export async function authenticateToken(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ success: false, error: 'No token provided', code: 'AUTH_REQUIRED' });
        return;
    }

    const token = authHeader.substring(7);
    const secret = process.env.JWT_SECRET;

    if (!secret) {
        res.status(500).json({ success: false, error: 'Server configuration error', code: 'INTERNAL_ERROR' });
        return;
    }

    try {
        const decoded = jwt.verify(token, secret) as JWTPayload;

        // Check if token is revoked in DB
        const tokenHash = hashToken(token);
        const session = await db('sessions')
            .where({ token_hash: tokenHash, is_revoked: false })
            .where('expires_at', '>', new Date())
            .first();

        if (!session) {
            res.status(401).json({ success: false, error: 'Token is invalid or expired', code: 'INVALID_TOKEN' });
            return;
        }

        req.user = decoded;
        next();
    } catch {
        res.status(401).json({ success: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
    }
}

// Simple hash for token storage (not bcrypt — just for lookup)
export function hashToken(token: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(token).digest('hex');
}
