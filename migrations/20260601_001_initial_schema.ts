import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    // Enable UUID extension
    await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    // ============================================
    // USERS TABLE
    // ============================================
    await knex.schema.createTable('users', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        table.string('email', 255).unique().notNullable();
        table.string('username', 100).unique().notNullable();
        table.string('password_hash', 255).notNullable();
        table.string('role', 20).defaultTo('user').notNullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('last_login').nullable();
        table.boolean('is_active').defaultTo(true);
    });

    await knex.raw(`
    ALTER TABLE users
    ADD CONSTRAINT valid_email CHECK (email ~ '^[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}$'),
    ADD CONSTRAINT valid_username CHECK (length(username) >= 3 AND length(username) <= 50),
    ADD CONSTRAINT valid_role CHECK (role IN ('user', 'admin'))
  `);

    // ============================================
    // SESSIONS TABLE
    // ============================================
    await knex.schema.createTable('sessions', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.string('token_hash', 64).unique().notNullable();
        table.timestamp('expires_at').notNullable();
        table.boolean('is_revoked').defaultTo(false);
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.string('ip_address', 45).nullable();
        table.string('user_agent', 512).nullable();
    });

    // ============================================
    // FIXTURES TABLE
    // ============================================
    await knex.schema.createTable('fixtures', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        table.integer('match_number').unique().notNullable();
        table.string('home_team', 100).notNullable();
        table.string('away_team', 100).notNullable();
        table.timestamp('kickoff_time').notNullable();
        table.string('stage', 20).notNullable();
        table.string('status', 20).defaultTo('scheduled').notNullable();
        table.integer('home_score').nullable();
        table.integer('away_score').nullable();
        table.timestamp('prediction_closes_at').notNullable();
        table.integer('api_fixture_id').nullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
    });

    await knex.raw(`
    ALTER TABLE fixtures
    ADD CONSTRAINT valid_match_number CHECK (match_number >= 1 AND match_number <= 64),
    ADD CONSTRAINT valid_stage CHECK (stage IN ('group', 'round16', 'qf', 'sf', 'final')),
    ADD CONSTRAINT valid_status CHECK (status IN ('scheduled', 'live', 'completed')),
    ADD CONSTRAINT valid_home_score CHECK (home_score IS NULL OR home_score >= 0),
    ADD CONSTRAINT valid_away_score CHECK (away_score IS NULL OR away_score >= 0)
  `);

    // ============================================
    // PREDICTIONS TABLE
    // ============================================
    await knex.schema.createTable('predictions', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.uuid('fixture_id').notNullable().references('id').inTable('fixtures').onDelete('CASCADE');
        table.integer('predicted_home_goals').notNullable();
        table.integer('predicted_away_goals').notNullable();
        table.integer('points').nullable();
        table.string('result', 20).nullable();
        table.timestamp('predicted_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());

        table.unique(['user_id', 'fixture_id']);
    });

    await knex.raw(`
    ALTER TABLE predictions
    ADD CONSTRAINT valid_home_goals CHECK (predicted_home_goals >= 0 AND predicted_home_goals <= 10),
    ADD CONSTRAINT valid_away_goals CHECK (predicted_away_goals >= 0 AND predicted_away_goals <= 10),
    ADD CONSTRAINT valid_result CHECK (result IS NULL OR result IN ('exact', 'winner', 'wrong'))
  `);

    // ============================================
    // ADMIN LOGS TABLE
    // ============================================
    await knex.schema.createTable('admin_logs', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        table.uuid('admin_id').notNullable().references('id').inTable('users').onDelete('SET NULL').nullable();
        table.string('action', 100).notNullable();
        table.jsonb('details').defaultTo('{}');
        table.timestamp('created_at').defaultTo(knex.fn.now());
    });

    // ============================================
    // INDEXES
    // ============================================
    await knex.raw(`
    CREATE INDEX idx_predictions_user ON predictions(user_id);
    CREATE INDEX idx_predictions_fixture ON predictions(fixture_id);
    CREATE INDEX idx_sessions_user ON sessions(user_id);
    CREATE INDEX idx_sessions_token ON sessions(token_hash);
    CREATE INDEX idx_fixtures_status ON fixtures(status);
    CREATE INDEX idx_fixtures_kickoff ON fixtures(kickoff_time);
    CREATE INDEX idx_fixtures_next_matches ON fixtures(kickoff_time) WHERE status IN ('scheduled', 'live');
    CREATE INDEX idx_predictions_fixture_status ON predictions(fixture_id) WHERE result IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists('admin_logs');
    await knex.schema.dropTableIfExists('predictions');
    await knex.schema.dropTableIfExists('fixtures');
    await knex.schema.dropTableIfExists('sessions');
    await knex.schema.dropTableIfExists('users');
}
