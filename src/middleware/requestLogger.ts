import { Request, Response, NextFunction } from 'express';
import db from '../db';

export interface RequestLogEntry {
    timestamp: string;
    method: string;
    path: string;
    status: number;
    duration: number; // ms
    ip: string;
    username: string | null;
    role: string | null;
}

const MAX_ENTRIES = 200;
const requestLog: RequestLogEntry[] = [];

export function getRequestLog(): RequestLogEntry[] {
    return [...requestLog].reverse(); // newest first
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '';

    res.on('finish', () => {
        const entry: RequestLogEntry = {
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: Date.now() - start,
            ip,
            username: req.user?.username ?? null,
            role: req.user?.role ?? null,
        };
        // In-memory buffer for fast live view
        requestLog.push(entry);
        if (requestLog.length > MAX_ENTRIES) requestLog.shift();
        // Persist to DB (fire-and-forget — never blocks the request)
        db('request_logs').insert({
            timestamp: entry.timestamp,
            method: entry.method,
            path: entry.path,
            status: entry.status,
            duration_ms: entry.duration,
            ip: entry.ip,
            username: entry.username,
            role: entry.role,
        }).catch(() => { /* non-fatal */ });
    });

    next();
}

/** Delete request_logs older than 24h — run hourly */
export function startRequestLogCleanup(): void {
    setInterval(async () => {
        try {
            const deleted = await db('request_logs')
                .where('timestamp', '<', db.raw(`NOW() - INTERVAL '24 hours'`))
                .delete();
            if (deleted > 0) console.log(`Request log cleanup: removed ${deleted} old entries`);
        } catch (err) {
            console.error('Request log cleanup error:', err);
        }
    }, 60 * 60 * 1000); // every hour
}
