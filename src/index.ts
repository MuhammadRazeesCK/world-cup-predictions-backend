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
import pollRoutes from './routes/polls';
import statsRoutes from './routes/stats';
import proxyRoutes from './routes/proxy';
import { startScoreUpdater } from './jobs/scoreUpdater';
import { startPredictionCloseNotifier } from './jobs/predictionCloseNotifier';
import { initWhatsApp } from './services/whatsapp';
import { requestLogger, startRequestLogCleanup } from './middleware/requestLogger';
import monitoringRoutes from './routes/monitoring';
import wrapupRoutes from './routes/wrapup';

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
app.use('/api/polls', pollRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/admin/monitoring', monitoringRoutes);
app.use('/api/admin/wrapup', wrapupRoutes);

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
        // stream_url on fixtures
        const hasStreamUrl = await db.schema.hasColumn('fixtures', 'stream_url');
        if (!hasStreamUrl) {
            await db.schema.alterTable('fixtures', (t) => { t.text('stream_url').nullable().defaultTo(null); });
            console.log('Migrated: added stream_url to fixtures');
        }
        // stream_views table — tracks who watched which match stream + duration
        const hasStreamViews = await db.schema.hasTable('stream_views');
        if (!hasStreamViews) {
            await db.schema.createTable('stream_views', (t) => {
                t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
                t.uuid('fixture_id').notNullable().references('id').inTable('fixtures').onDelete('CASCADE');
                t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
                t.timestamp('opened_at').notNullable().defaultTo(db.fn.now());
                t.timestamp('closed_at').nullable();
                t.integer('duration_seconds').nullable(); // null = still watching or abandoned
                t.boolean('abandoned').defaultTo(false);  // true = tab closed mid-stream
            });
            await db.raw('CREATE INDEX idx_stream_views_fixture ON stream_views(fixture_id)');
            await db.raw('CREATE INDEX idx_stream_views_user ON stream_views(user_id)');
            await db.raw('CREATE INDEX idx_stream_views_opened ON stream_views(opened_at)');
            console.log('Migrated: created stream_views table');
        }
        // player_photos table — admin-managed photo URLs keyed by player name
        const hasPlayerPhotos = await db.schema.hasTable('player_photos');
        if (!hasPlayerPhotos) {
            await db.schema.createTable('player_photos', (t) => {
                t.increments('id').primary();
                t.string('player_name', 200).notNullable().unique();
                t.text('photo_url').notNullable();
                t.integer('crop_y').notNullable().defaultTo(15); // % from top where face is
                t.timestamp('updated_at').defaultTo(db.fn.now());
            });
            console.log('Migrated: created player_photos table');
        } else {
            // Add crop_y if missing
            const hasCropY = await db.schema.hasColumn('player_photos', 'crop_y');
            if (!hasCropY) {
                await db.schema.alterTable('player_photos', t => t.integer('crop_y').notNullable().defaultTo(15));
                console.log('Migrated: added crop_y to player_photos');
            }
        }
        // server_events table for monitoring
        const hasServerEvents = await db.schema.hasTable('server_events');
        if (!hasServerEvents) {
            await db.schema.createTable('server_events', (t) => {
                t.increments('id').primary();
                t.string('type', 50).notNullable();
                t.jsonb('metadata').nullable();
                t.timestamp('created_at').defaultTo(db.fn.now());
            });
            console.log('Migrated: created server_events table');
        }
        // request_logs table for persistent user activity tracking
        const hasRequestLogs = await db.schema.hasTable('request_logs');
        if (!hasRequestLogs) {
            await db.schema.createTable('request_logs', (t) => {
                t.increments('id').primary();
                t.timestamp('timestamp').notNullable().defaultTo(db.fn.now());
                t.string('method', 10).nullable();
                t.text('path').nullable();
                t.integer('status').nullable();
                t.integer('duration_ms').nullable();
                t.string('ip', 45).nullable();
                t.string('username', 100).nullable();
                t.string('role', 20).nullable();
            });
            await db.raw('CREATE INDEX ON request_logs(timestamp)');
            await db.raw('CREATE INDEX ON request_logs(username)');
            console.log('Migrated: created request_logs table');
        }
        // polls + poll_votes tables
        const hasPollsTable = await db.schema.hasTable('polls');
        if (!hasPollsTable) {
            await db.schema.createTable('polls', (t) => {
                t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
                t.text('question').notNullable();
                t.jsonb('options').notNullable();
                t.jsonb('option_images').nullable();
                t.string('emoji', 10).nullable();
                t.boolean('is_active').defaultTo(true).notNullable();
                t.timestamp('closes_at').nullable();
                t.uuid('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
                t.timestamp('created_at').defaultTo(db.fn.now());
                t.timestamp('updated_at').defaultTo(db.fn.now());
            });
            await db.schema.createTable('poll_votes', (t) => {
                t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
                t.uuid('poll_id').notNullable().references('id').inTable('polls').onDelete('CASCADE');
                t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
                t.integer('option_index').notNullable();
                t.timestamp('created_at').defaultTo(db.fn.now());
                t.unique(['poll_id', 'user_id']);
            });
            await db.raw('CREATE INDEX idx_poll_votes_poll ON poll_votes(poll_id)');
            await db.raw('CREATE INDEX idx_poll_votes_user ON poll_votes(user_id)');
            console.log('Migrated: created polls and poll_votes tables');
        } else {
            // Add option_images column if polls table exists but column doesn't
            const hasOptionImages = await db.schema.hasColumn('polls', 'option_images');
            if (!hasOptionImages) {
                await db.schema.alterTable('polls', (t) => { t.jsonb('option_images').nullable(); });
                console.log('Migrated: added option_images to polls');
            }
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
    // Start hourly request log cleanup (keeps last 24h only)
    startRequestLogCleanup();
});

export default app;
