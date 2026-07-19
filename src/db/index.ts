import knex from 'knex';
import dotenv from 'dotenv';

dotenv.config();

const db = knex({
    client: 'pg',
    connection:
        process.env.NODE_ENV === 'production'
            ? {
                connectionString: process.env.DATABASE_URL,
                ssl: { rejectUnauthorized: false },
            }
            : process.env.DATABASE_URL,
    pool: {
        min: 0,
        max: 10,
        idleTimeoutMillis: 30000,
    },
});

export default db;
