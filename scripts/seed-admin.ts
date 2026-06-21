/**
 * Script to create the initial admin user.
 * Run with: npm run seed:admin
 *
 * You will be prompted for the admin password, or set ADMIN_PASSWORD env var.
 */
import bcrypt from 'bcryptjs';
import db from '../src/db';

async function seedAdmin(): Promise<void> {
    const email = process.env.ADMIN_EMAIL || 'razeesck@gmail.com';
    const username = process.env.ADMIN_USERNAME || 'admin_razees';
    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
        console.error('Error: ADMIN_PASSWORD environment variable is required');
        console.error('Usage: ADMIN_PASSWORD=yourpassword npm run seed:admin');
        process.exit(1);
    }

    try {
        const existing = await db('users').where({ email }).first();
        if (existing) {
            console.log(`Admin user already exists: ${email}`);
            process.exit(0);
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const [admin] = await db('users')
            .insert({
                email,
                username,
                password_hash: passwordHash,
                role: 'admin',
                is_active: true,
            })
            .returning(['id', 'email', 'username', 'role']);

        console.log('Admin user created successfully:');
        console.log(`  ID:       ${admin.id}`);
        console.log(`  Email:    ${admin.email}`);
        console.log(`  Username: ${admin.username}`);
        console.log(`  Role:     ${admin.role}`);
    } catch (err) {
        console.error('Failed to create admin user:', err);
        process.exit(1);
    } finally {
        await db.destroy();
    }
}

seedAdmin();
