import { Request, Response, NextFunction } from 'express';

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

const MAX_ENTRIES = 100;
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
        requestLog.push(entry);
        if (requestLog.length > MAX_ENTRIES) requestLog.shift();
    });

    next();
}
