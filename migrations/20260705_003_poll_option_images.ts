import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable('polls', (table) => {
        // Array of image URLs parallel to options[], nullable per-option
        table.jsonb('option_images').nullable(); // (string | null)[]
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable('polls', (table) => {
        table.dropColumn('option_images');
    });
}
