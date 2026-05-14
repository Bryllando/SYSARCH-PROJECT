const { createClient } = require('@libsql/client');
const path = require('path');
require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';

// In production, we use Turso. In development, we use a local SQLite file.
const client = createClient({
    url: isProd ? process.env.TURSO_DATABASE_URL : `file:${path.join(__dirname, 'sitin.db')}`,
    authToken: isProd ? process.env.TURSO_AUTH_TOKEN : undefined,
});

/**
 * Compatibility wrapper to make Turso client behave like sqlite3 (but with Promises)
 */
const db = {
    /**
     * Executes a query and returns all rows.
     */
    all: async (sql, params = [], callback) => {
        try {
            const result = await client.execute({ sql, args: params });
            const rows = result.rows;
            if (callback) callback(null, rows);
            return rows;
        } catch (err) {
            if (callback) callback(err);
            throw err;
        }
    },

    /**
     * Executes a query and returns the first row.
     */
    get: async (sql, params = [], callback) => {
        try {
            const result = await client.execute({ sql, args: params });
            const row = result.rows[0];
            if (callback) callback(null, row);
            return row;
        } catch (err) {
            if (callback) callback(err);
            throw err;
        }
    },

    /**
     * Executes a query (INSERT, UPDATE, DELETE).
     */
    run: async (sql, params = [], callback) => {
        try {
            const result = await client.execute({ sql, args: params });
            const response = {
                lastID: Number(result.lastInsertRowid),
                changes: result.rowsAffected
            };
            // Support 'this.lastID' pattern for sqlite3 compatibility in callbacks
            if (callback) callback.call(response, null);
            return response;
        } catch (err) {
            if (callback) callback(err);
            throw err;
        }
    },

    // Serialize is not needed for Turso/libsql as it handles concurrency differently,
    // but we'll provide a dummy wrapper for compatibility.
    serialize: (fn) => fn(),
    
    // Close the connection
    close: () => { /* client handles this */ }
};

// Database Initialization (Migrations)
async function initDb() {
    console.log(`[DB] Attempting to connect to ${isProd ? 'Turso' : 'Local SQLite'}...`);
    
    try {
        // Test connection
        await client.execute("SELECT 1");
        console.log("[DB] Connection successful.");
    } catch (connErr) {
        console.error("[DB] Connection FAILED:", connErr.message);
        return;
    }

    const migrations = [
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            id_number TEXT UNIQUE NOT NULL,
            last_name TEXT NOT NULL,
            first_name TEXT NOT NULL,
            middle_initial TEXT,
            course TEXT NOT NULL,
            year_level INTEGER NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            remaining_sessions INTEGER DEFAULT 30,
            address TEXT DEFAULT '',
            profile_picture TEXT DEFAULT '',
            ai_reco_version INTEGER DEFAULT 0,
            tidy_points_raw INTEGER DEFAULT 0,
            task_completion_rate REAL DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now','localtime'))
        )`,
        `CREATE TABLE IF NOT EXISTS sitin_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            lab_room TEXT,
            computer_number INTEGER DEFAULT NULL,
            purpose TEXT,
            time_in DATETIME DEFAULT (datetime('now','localtime')),
            time_end DATETIME DEFAULT NULL,
            time_out DATETIME,
            status TEXT DEFAULT 'active',
            behavior_rating INTEGER DEFAULT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            lab_room TEXT NOT NULL,
            date TEXT NOT NULL,
            time_slot TEXT NOT NULL,
            purpose TEXT,
            message TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            computer_number INTEGER DEFAULT NULL,
            computer_id INTEGER DEFAULT NULL,
            time_start TEXT DEFAULT NULL,
            time_end TEXT DEFAULT NULL,
            approved_by INTEGER DEFAULT NULL,
            updated_at DATETIME DEFAULT NULL,
            deleted_by_user INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS reservation_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER DEFAULT 1,
            message TEXT DEFAULT 'Reservations are temporarily unavailable.'
        )`,
        `INSERT OR IGNORE INTO reservation_settings (id, enabled, message)
         VALUES (1, 1, 'Reservations are temporarily unavailable.')`,
        `CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_id INTEGER,
            message TEXT NOT NULL,
            rating INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER,
            message TEXT NOT NULL,
            is_pinned INTEGER DEFAULT 0,
            media_url TEXT DEFAULT '',
            media_type TEXT DEFAULT '',
            created_at DATETIME DEFAULT (datetime('now','localtime'))
        )`,
        `CREATE TABLE IF NOT EXISTS announcement_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            announcement_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (announcement_id) REFERENCES announcements(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS admin_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message TEXT NOT NULL,
            type TEXT DEFAULT 'info',
            related_id INTEGER,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now','localtime'))
        )`,
        `CREATE TABLE IF NOT EXISTS lab_computers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lab_room TEXT NOT NULL,
            computer_number INTEGER NOT NULL,
            status TEXT DEFAULT 'available',
            UNIQUE(lab_room, computer_number)
        )`,
        `CREATE TABLE IF NOT EXISTS ai_recommendations (
            user_id INTEGER PRIMARY KEY,
            version INTEGER DEFAULT 0,
            payload TEXT NOT NULL,
            updated_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS ai_admin_insights (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            payload TEXT NOT NULL,
            updated_at DATETIME DEFAULT (datetime('now','localtime'))
        )`,
        `CREATE TABLE IF NOT EXISTS ai_recommendation_cache (
            cache_key TEXT PRIMARY KEY,
            student_id INTEGER,
            type TEXT NOT NULL,
            response_json TEXT NOT NULL,
            generated_at DATETIME DEFAULT (datetime('now','localtime')),
            source_session_at DATETIME,
            source_feedback_at DATETIME,
            source_updated_at DATETIME,
            FOREIGN KEY (student_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS lab_software (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lab_room TEXT NOT NULL,
            software_name TEXT NOT NULL,
            version TEXT DEFAULT '',
            status TEXT DEFAULT 'Available',
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            UNIQUE(lab_room, software_name, version)
        )`
    ];

    for (const sql of migrations) {
        try {
            await client.execute(sql);
        } catch (err) {
            if (!err.message.includes('already exists') && !err.message.includes('duplicate')) {
                console.error('[DB] Migration Error:', err.message);
            }
        }
    }

    // Seed computers if empty
    try {
        const res = await client.execute(`SELECT COUNT(*) as c FROM lab_computers`);
        const count = res.rows[0]?.c || 0;
        if (Number(count) === 0) {
            console.log('[DB] Seeding lab computers...');
            const labs = ['530', '528', '526', '542', '544', '524'];
            const statements = [];
            for (const room of labs) {
                for (let i = 1; i <= 50; i++) {
                    statements.push({
                        sql: `INSERT OR IGNORE INTO lab_computers (lab_room, computer_number, status) VALUES (?, ?, 'available')`,
                        args: [room, i]
                    });
                }
            }
            // Execute in batches of 100 to avoid any limits
            for (let i = 0; i < statements.length; i += 100) {
                await client.batch(statements.slice(i, i + 100));
            }
        }
    } catch (e) { console.error("[DB] Computer Seeding Error:", e.message); }

    // Seed Admin Accounts
    try {
        console.log('[DB] Ensuring static admin accounts...');
        const bcrypt = require('bcryptjs');
        const hashed = await bcrypt.hash('Admin@1234', 10);
        
        const admins = [
            ['23769862', 'Taburnal', 'Emmanuel', 'O', 'BSIT', 3, 'bryllando@gmail.com', hashed, 'admin'],
            ['00000000', 'Salimbangon', 'Jeff Pelorina', '', 'BSCS', 4, 'jeff@gmail.com', hashed, 'admin']
        ];

        for (const a of admins) {
            // Try to insert if doesn't exist
            await client.execute({
                sql: `INSERT OR IGNORE INTO users 
                      (id_number, last_name, first_name, middle_initial, course, year_level, email, password, role)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: a
            });
            // Force role and password update for these specific IDs
            await client.execute({
                sql: `UPDATE users SET role = 'admin', password = ? WHERE id_number = ?`,
                args: [hashed, a[0]]
            });
        }
        console.log("[DB] Admin accounts verified/updated.");
    } catch (e) { console.error("[DB] Admin Seeding Error:", e.message); }
}

// Initializing DB (exported so server.js can await it)
module.exports = { db, initDb };
