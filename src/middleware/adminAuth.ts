import { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
        res.status(401).json({ success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
        return;
    }

    if (req.user.role !== 'admin') {
        res.status(403).json({ success: false, error: 'Admin access required', code: 'UNAUTHORIZED' });
        return;
    }

    next();
}
