const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'sitin.db'), (err) => {
    if (err) console.error('DB Error:', err.message);
    else console.log('Connected to SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
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
        created_at DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`ALTER TABLE users ADD COLUMN address TEXT DEFAULT ''`, () => { });
    db.run(`ALTER TABLE users ADD COLUMN profile_picture TEXT DEFAULT ''`, () => { });
    db.run(`ALTER TABLE users ADD COLUMN ai_reco_version INTEGER DEFAULT 0`, () => { });
    db.run(`ALTER TABLE users ADD COLUMN tidy_points_raw INTEGER DEFAULT 0`, () => { });
    db.run(`ALTER TABLE users ADD COLUMN task_completion_rate REAL DEFAULT 0`, () => { });

    db.run(`CREATE TABLE IF NOT EXISTS sitin_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        lab_room TEXT,
        computer_number INTEGER DEFAULT NULL,
        purpose TEXT,
        time_in DATETIME DEFAULT (datetime('now','localtime')),
        time_end DATETIME DEFAULT NULL,
        time_out DATETIME,
        status TEXT DEFAULT 'active',
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Add computer_number to existing sitin_sessions if it doesn't exist
    db.run(`ALTER TABLE sitin_sessions ADD COLUMN computer_number INTEGER DEFAULT NULL`, () => { });
    db.run(`ALTER TABLE sitin_sessions ADD COLUMN time_end DATETIME DEFAULT NULL`, () => { });
    // Add behavior_rating column (1=Disruptive … 5=Excellent, NULL=unrated)
    db.run(`ALTER TABLE sitin_sessions ADD COLUMN behavior_rating INTEGER DEFAULT NULL`, () => { });


    db.run(`CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        lab_room TEXT NOT NULL,
        date TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        purpose TEXT,
        message TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`ALTER TABLE reservations ADD COLUMN computer_number INTEGER DEFAULT NULL`, () => { });
    db.run(`ALTER TABLE reservations ADD COLUMN computer_id INTEGER DEFAULT NULL`, () => { });
    db.run(`ALTER TABLE reservations ADD COLUMN time_start TEXT DEFAULT NULL`, () => { });
    db.run(`ALTER TABLE reservations ADD COLUMN time_end TEXT DEFAULT NULL`, () => { });
    db.run(`ALTER TABLE reservations ADD COLUMN message TEXT DEFAULT ''`, () => { });
    // Reservation workflow metadata (SQLite-safe additive migrations)
    db.run(`ALTER TABLE reservations ADD COLUMN approved_by INTEGER DEFAULT NULL`, () => { });
    // Note: SQLite ALTER TABLE only allows constant DEFAULT values; keep NULL and set in code.
    db.run(`ALTER TABLE reservations ADD COLUMN updated_at DATETIME DEFAULT NULL`, () => { });
    db.run(`ALTER TABLE reservations ADD COLUMN deleted_by_user INTEGER DEFAULT 0`, () => { });

    db.run(`CREATE TABLE IF NOT EXISTS reservation_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER DEFAULT 1,
        message TEXT DEFAULT 'Reservations are temporarily unavailable.'
    )`);
    db.run(
        `INSERT OR IGNORE INTO reservation_settings (id, enabled, message)
         VALUES (1, 1, 'Reservations are temporarily unavailable.')`
    );

    db.run(`CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_id INTEGER,
        message TEXT NOT NULL,
        rating INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER,
        message TEXT NOT NULL,
        is_pinned INTEGER DEFAULT 0,
        media_url TEXT DEFAULT '',
        media_type TEXT DEFAULT '',
        created_at DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS announcement_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        announcement_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (announcement_id) REFERENCES announcements(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`ALTER TABLE announcements ADD COLUMN is_pinned INTEGER DEFAULT 0`, () => { });
    db.run(`ALTER TABLE announcements ADD COLUMN media_url TEXT DEFAULT ''`, () => { });
    db.run(`ALTER TABLE announcements ADD COLUMN media_type TEXT DEFAULT ''`, () => { });


    db.run(`CREATE TABLE IF NOT EXISTS admin_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        related_id INTEGER,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS lab_computers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lab_room TEXT NOT NULL,
        computer_number INTEGER NOT NULL,
        status TEXT DEFAULT 'available',
        UNIQUE(lab_room, computer_number)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ai_recommendations (
        user_id INTEGER PRIMARY KEY,
        version INTEGER DEFAULT 0,
        payload TEXT NOT NULL,
        updated_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ai_admin_insights (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ai_recommendation_cache (
        cache_key TEXT PRIMARY KEY,
        student_id INTEGER,
        type TEXT NOT NULL,
        response_json TEXT NOT NULL,
        generated_at DATETIME DEFAULT (datetime('now','localtime')),
        source_session_at DATETIME,
        source_feedback_at DATETIME,
        source_updated_at DATETIME,
        FOREIGN KEY (student_id) REFERENCES users(id)
    )`);

    // Seed computers for each lab on first run
    function seedLabComputers() {
        const labs = [
            { room: '530', total: 50 },
            { room: '528', total: 50 },
            { room: '526', total: 50 },
            { room: '542', total: 50 },
            { room: '544', total: 50 },
            { room: '524', total: 50 },
        ];
        labs.forEach(lab => {
            for (let i = 1; i <= lab.total; i++) {
                db.run(
                    `INSERT OR IGNORE INTO lab_computers (lab_room, computer_number, status)
                 VALUES (?, ?, 'available')`,
                    [lab.room, i]
                );
            }
        });
    }
    seedLabComputers();
});

module.exports = db;