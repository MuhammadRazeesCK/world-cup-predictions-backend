import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';

import authRoutes from './routes/auth';
import fixtureRoutes from './routes/fixtures';
import predictionRoutes from './routes/predictions';
import leaderboardRoutes from './routes/leaderboard';
import adminRoutes from './routes/admin';
import userRoutes from './routes/users';
import announcementRoutes from './routes/announcements';
import { startScoreUpdater } from './jobs/scoreUpdater';
import { startPredictionCloseNotifier } from './jobs/predictionCloseNotifier';
import { initWhatsApp } from './services/whatsapp';
import { requestLogger } from './middleware/requestLogger';
import monitoringRoutes from './routes/monitoring';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Parse allowed origins from env (comma-separated)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim());

// Security middleware
app.use(helmet());
app.use(
    cors({
        origin: (origin, callback) => {
            // Allow requests with no origin (e.g., mobile apps, curl)
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        credentials: true,
    })
);

// Logging
if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
}
app.use(requestLogger);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/fixtures', fixtureRoutes);
app.use('/api/predictions', predictionRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/admin/monitoring', monitoringRoutes);

// 404 handler
app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Not found', code: 'NOT_FOUND' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' });
});

import db from './db';

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    try {
        // avatar_url on users
        const hasAvatar = await db.schema.hasColumn('users', 'avatar_url');
        if (!hasAvatar) {
            await db.schema.alterTable('users', (t) => { t.text('avatar_url').nullable().defaultTo(null); });
            console.log('Migrated: added avatar_url to users');
        }
        // penalty_enabled, penalty_home_score, penalty_away_score on fixtures
        const hasPenEnabled = await db.schema.hasColumn('fixtures', 'penalty_enabled');
        if (!hasPenEnabled) {
            await db.schema.alterTable('fixtures', (t) => {
                t.boolean('penalty_enabled').notNullable().defaultTo(false);
                t.integer('penalty_home_score').nullable();
                t.integer('penalty_away_score').nullable();
            });
            console.log('Migrated: added penalty columns to fixtures');
        }
        // penalty_home_goals, penalty_away_goals on predictions
        const hasPenGoals = await db.schema.hasColumn('predictions', 'penalty_home_goals');
        if (!hasPenGoals) {
            await db.schema.alterTable('predictions', (t) => {
                t.integer('penalty_home_goals').nullable();
                t.integer('penalty_away_goals').nullable();
            });
            console.log('Migrated: added penalty columns to predictions');
        }
        // poster_url on fixtures
        const hasPosterUrl = await db.schema.hasColumn('fixtures', 'poster_url');
        if (!hasPosterUrl) {
            await db.schema.alterTable('fixtures', (t) => { t.text('poster_url').nullable().defaultTo(null); });
            console.log('Migrated: added poster_url to fixtures');
        }
        // announcements table
        const hasAnnouncementsTable = await db.schema.hasTable('announcements');
        if (!hasAnnouncementsTable) {
            await db.schema.createTable('announcements', (t) => {
                t.increments('id').primary();
                t.text('image_url').nullable();
                t.text('message').nullable();
                t.timestamp('created_at').defaultTo(db.fn.now());
            });
            console.log('Migrated: created announcements table');
        }
        // Fix constraints: remove match_number <= 64 cap and add round32/third_place to valid_stage
        try {
            await db.raw(`ALTER TABLE fixtures DROP CONSTRAINT IF EXISTS valid_match_number`);
            await db.raw(`ALTER TABLE fixtures ADD CONSTRAINT valid_match_number CHECK (match_number >= 1)`);
            await db.raw(`ALTER TABLE fixtures DROP CONSTRAINT IF EXISTS valid_stage`);
            await db.raw(`ALTER TABLE fixtures ADD CONSTRAINT valid_stage CHECK (stage IN ('group','round32','round16','qf','sf','third_place','final'))`);
            console.log('Migrated: updated match_number and stage constraints');
        } catch (constraintErr) {
            console.error('Constraint migration error (non-fatal):', constraintErr);
        }

        // Add draw_correct to valid_result constraint
        try {
            await db.raw(`ALTER TABLE predictions DROP CONSTRAINT IF EXISTS valid_result`);
            await db.raw(`ALTER TABLE predictions ADD CONSTRAINT valid_result CHECK (result IS NULL OR result IN ('exact', 'winner', 'wrong', 'draw_correct'))`);
            console.log('Migrated: valid_result constraint includes draw_correct');
        } catch (constraintErr) {
            console.error('valid_result constraint migration error (non-fatal):', constraintErr);
        }
        // whatsapp_notified_at on fixtures
        const hasWhatsappNotified = await db.schema.hasColumn('fixtures', 'whatsapp_notified_at');
        if (!hasWhatsappNotified) {
            await db.schema.alterTable('fixtures', (t) => { t.timestamp('whatsapp_notified_at').nullable().defaultTo(null); });
            console.log('Migrated: added whatsapp_notified_at to fixtures');
        }
        // server_events table for monitoring
        const hasServerEvents = await db.schema.hasTable('server_events');
        if (!hasServerEvents) {
            await db.schema.createTable('server_events', (t) => {
                t.increments('id').primary();
                t.string('type', 50).notNullable(); // 'startup'
                t.jsonb('metadata').nullable();
                t.timestamp('created_at').defaultTo(db.fn.now());
            });
            console.log('Migrated: created server_events table');
        }
    } catch (err) {
        console.error('Startup migration error:', err);
    }
    // Log this startup
    try {
        await db('server_events').insert({
            type: 'startup',
            metadata: JSON.stringify({ nodeVersion: process.version, env: process.env.NODE_ENV }),
        });
    } catch (_) { /* non-fatal */ }
    // Start background job for score updates
    startScoreUpdater();
    // Start WhatsApp prediction-close notifier (requires WHATSAPP_ENABLED=true)
    initWhatsApp();
    startPredictionCloseNotifier();
});

export default app;
