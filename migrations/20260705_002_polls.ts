import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable('polls', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        table.text('question').notNullable();
        table.jsonb('options').notNullable(); // string[]
        table.string('emoji', 10).nullable();
        table.boolean('is_active').defaultTo(true).notNullable();
        table.timestamp('closes_at').nullable(); // null = open indefinitely
        table.uuid('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
    });

    await knex.schema.createTable('poll_votes', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        table.uuid('poll_id').notNullable().references('id').inTable('polls').onDelete('CASCADE');
        table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.integer('option_index').notNullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.unique(['poll_id', 'user_id']);
    });

    await knex.raw(`CREATE INDEX idx_poll_votes_poll ON poll_votes(poll_id)`);
    await knex.raw(`CREATE INDEX idx_poll_votes_user ON poll_votes(user_id)`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists('poll_votes');
    await knex.schema.dropTableIfExists('polls');
}
