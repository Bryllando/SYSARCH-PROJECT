const express = require('express');
const router = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const db = require('../database/database');

// Admin Home
router.get('/', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT COUNT(*) as total FROM users WHERE role='user'`, (err, row) => {
        db.get(`SELECT COUNT(*) as active FROM sitin_sessions WHERE status='active'`, (err2, active) => {
            db.get(`SELECT COUNT(*) as totalSitins FROM sitin_sessions`, (err3, total) => {
                db.all(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 10`, (err4, announcements) => {
                    res.render('pages/admin', {
                        totalStudents: row?.total || 0,
                        activeSitins: active?.active || 0,
                        totalSitins: total?.totalSitins || 0,
                        announcements: announcements || []
                    });
                });
            });
        });
    });
});

// Post Announcement
router.post('/announcement', isAuthenticated, isAdmin, (req, res) => {
    const { message } = req.body;
    db.run(`INSERT INTO announcements (admin_id, message) VALUES (?, ?)`,
        [req.session.user.id, message], () => res.redirect('/admin'));
});

// Search student by ID — JSON for modal
router.get('/search-student', isAuthenticated, isAdmin, (req, res) => {
    const q = req.query.q || '';
    db.get(`SELECT * FROM users WHERE role='user' AND id_number = ?`, [q], (err, student) => {
        if (err || !student) return res.json({ error: 'Not found' });
        res.json(student);
    });
});

// Search page
router.get('/search', isAuthenticated, isAdmin, (req, res) => {
    const q = req.query.q || '';
    db.all(
        `SELECT * FROM users WHERE role='user' AND (id_number LIKE ? OR first_name LIKE ? OR last_name LIKE ?)`,
        [`%${q}%`, `%${q}%`, `%${q}%`],
        (err, students) => res.render('pages/admin-search', { students: students || [], query: q })
    );
});

// Start sit-in — uses datetime('now','localtime') so stored time matches the server's local clock
router.post('/sitin/start', isAuthenticated, isAdmin, (req, res) => {
    const { user_id, purpose, lab_room } = req.body;
    db.get(`SELECT * FROM sitin_sessions WHERE user_id = ? AND status = 'active'`, [user_id], (err, existing) => {
        if (existing) return res.redirect('/admin/sitin');
        db.run(
            `UPDATE users SET remaining_sessions = remaining_sessions - 1 WHERE id = ? AND remaining_sessions > 0`,
            [user_id], () => {
                db.run(
                    `INSERT INTO sitin_sessions (user_id, purpose, lab_room, time_in)
                     VALUES (?, ?, ?, datetime('now','localtime'))`,
                    [user_id, purpose, lab_room],
                    () => res.redirect('/admin/sitin')
                );
            }
        );
    });
});

// Students list — renders student.ejs
router.get('/students', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT * FROM users WHERE role='user' ORDER BY last_name`, (err, students) => {
        res.render('pages/admin-students', { students: students || [] });
    });
});

// Student record (individual) — renders admin-student-record.ejs
router.get('/students/:id', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, student) => {
        db.all(`SELECT * FROM sitin_sessions WHERE user_id = ? ORDER BY time_in DESC`,
            [req.params.id], (err2, sessions) => {
                res.render('pages/admin-student-record', { student, sessions: sessions || [] });
            });
    });
});

// Current sit-in
router.get('/sitin', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, u.id_number, u.first_name, u.last_name, u.course, u.remaining_sessions
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id
         WHERE s.status = 'active' ORDER BY s.time_in DESC`,
        (err, sessions) => res.render('pages/admin-sitin', { sessions: sessions || [] })
    );
});

// End sit-in — also use localtime for time_out
router.post('/sitin/:id/end', isAuthenticated, isAdmin, (req, res) => {
    db.run(
        `UPDATE sitin_sessions SET time_out = datetime('now','localtime'), status = 'done' WHERE id = ?`,
        [req.params.id],
        () => res.redirect('/admin/sitin')
    );
});

// Reports
router.get('/reports', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, u.id_number, u.first_name, u.last_name, u.course
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id ORDER BY s.time_in DESC`,
        (err, sessions) => res.render('pages/admin-reports', { sessions: sessions || [] })
    );
});

// Feedback
router.get('/feedback', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT f.*, u.id_number, u.first_name, u.last_name
         FROM feedback f JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC`,
        (err, feedbacks) => res.render('pages/admin-feedback', { feedbacks: feedbacks || [] })
    );
});

// Reservations
router.get('/reservations', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT r.*, u.id_number, u.first_name, u.last_name, u.course
         FROM reservations r JOIN users u ON r.user_id = u.id ORDER BY r.date DESC`,
        (err, reservations) => res.render('pages/admin-reservations', { reservations: reservations || [] })
    );
});

// Reset all sessions
router.post('/students/reset-sessions', isAuthenticated, isAdmin, (req, res) => {
    db.run(`UPDATE users SET remaining_sessions = 30 WHERE role = 'user'`, () => {
        res.redirect('/admin/students');
    });
});

module.exports = router;