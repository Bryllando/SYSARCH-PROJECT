const express = require('express');
const router = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const db = require('../database/database');
const bcrypt = require('bcryptjs');

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

// ── Start sit-in ──────────────────────────────────────────────────────────────
router.post('/sitin/start', isAuthenticated, isAdmin, (req, res) => {
    const { user_id, purpose, lab_room, return_to } = req.body;
    const redirectTo = return_to || '/admin';

    db.get(`SELECT * FROM sitin_sessions WHERE user_id = ? AND status = 'active'`, [user_id], (err, existing) => {
        if (existing) {
            req.session.toast = { type: 'error', message: 'This student already has an active sit-in session.' };
            return res.redirect(redirectTo);
        }
        db.get(`SELECT first_name, last_name, remaining_sessions FROM users WHERE id = ?`, [user_id], (err2, student) => {
            if (!student || student.remaining_sessions <= 0) {
                req.session.toast = { type: 'error', message: 'Student has no remaining sessions left.' };
                return res.redirect(redirectTo);
            }
            db.run(
                `INSERT INTO sitin_sessions (user_id, purpose, lab_room, time_in)
                 VALUES (?, ?, ?, datetime('now','localtime'))`,
                [user_id, purpose, lab_room],
                () => {
                    req.session.toast = {
                        type: 'success',
                        message: `Sit-in started for ${student.first_name} ${student.last_name} in Lab ${lab_room}.`
                    };
                    res.redirect(redirectTo);
                }
            );
        });
    });
});

// Students list
router.get('/students', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT * FROM users WHERE role='user' ORDER BY last_name`, (err, students) => {
        res.render('pages/admin-students', { students: students || [] });
    });
});

// ── Add Student Account ───────────────────────────────────────────────────────
router.post('/students/add', isAuthenticated, isAdmin, async (req, res) => {
    const { id_number, last_name, first_name, middle_initial, course, year_level, email, password, address } = req.body;
    if (!/^\d{8}$/.test(id_number)) {
        req.session.toast = { type: 'error', message: 'ID Number must be exactly 8 digits.' };
        return res.redirect('/admin/students');
    }
    try {
        const hashed = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (id_number, last_name, first_name, middle_initial, course, year_level, email, password, address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id_number, last_name, first_name, middle_initial || '', course, year_level, email, hashed, address || ''],
            function (err) {
                if (err) {
                    const msg = err.message.includes('UNIQUE')
                        ? 'ID number or email already registered.'
                        : 'Failed to add student. Please try again.';
                    req.session.toast = { type: 'error', message: msg };
                } else {
                    req.session.toast = { type: 'success', message: `Student account for ${first_name} ${last_name} created successfully!` };
                }
                res.redirect('/admin/students');
            }
        );
    } catch (e) {
        req.session.toast = { type: 'error', message: 'An error occurred. Please try again.' };
        res.redirect('/admin/students');
    }
});

// Reset all sessions — must be before /:id routes
router.post('/students/reset-sessions', isAuthenticated, isAdmin, (req, res) => {
    db.run(`UPDATE users SET remaining_sessions = 30 WHERE role = 'user'`, () => {
        req.session.toast = { type: 'success', message: 'All student sessions have been reset to 30.' };
        res.redirect('/admin/students');
    });
});

// Student record (individual)
router.get('/students/:id', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, student) => {
        db.all(`SELECT * FROM sitin_sessions WHERE user_id = ? ORDER BY time_in DESC`,
            [req.params.id], (err2, sessions) => {
                res.render('pages/admin-student-record', { student, sessions: sessions || [] });
            });
    });
});

// ── Edit Student ──────────────────────────────────────────────────────────────
router.post('/students/:id/edit', isAuthenticated, isAdmin, (req, res) => {
    const { first_name, last_name, middle_initial, course, year_level, email, address, remaining_sessions } = req.body;
    db.run(
        `UPDATE users SET first_name=?, last_name=?, middle_initial=?, course=?, year_level=?, email=?, address=?, remaining_sessions=? WHERE id=?`,
        [first_name, last_name, middle_initial || '', course, year_level, email, address || '', parseInt(remaining_sessions) || 30, req.params.id],
        function (err) {
            if (err) {
                req.session.toast = { type: 'error', message: 'Update failed. Email may already be in use.' };
            } else {
                req.session.toast = { type: 'success', message: `Student ${first_name} ${last_name} updated successfully!` };
            }
            res.redirect('/admin/students');
        }
    );
});

// Current sit-in list
router.get('/sitin', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, u.id_number, u.first_name, u.last_name, u.course, u.remaining_sessions
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id
         WHERE s.status = 'active' ORDER BY s.time_in DESC`,
        (err, sessions) => res.render('pages/admin-sitin', { sessions: sessions || [] })
    );
});

// ── End sit-in ────────────────────────────────────────────────────────────────
router.post('/sitin/:id/end', isAuthenticated, isAdmin, (req, res) => {
    db.get(
        `SELECT s.user_id, u.first_name, u.last_name FROM sitin_sessions s
         JOIN users u ON s.user_id = u.id WHERE s.id = ?`,
        [req.params.id], (err, row) => {
            db.run(
                `UPDATE sitin_sessions SET time_out = datetime('now','localtime'), status = 'done' WHERE id = ?`,
                [req.params.id],
                () => {
                    if (row && row.user_id) {
                        db.run(
                            `UPDATE users SET remaining_sessions = remaining_sessions - 1
                             WHERE id = ? AND remaining_sessions > 0`,
                            [row.user_id],
                            () => {
                                req.session.toast = {
                                    type: 'success',
                                    message: `${row.first_name} ${row.last_name} has been logged out of the lab.`
                                };
                                res.redirect('/admin/sitin');
                            }
                        );
                    } else {
                        res.redirect('/admin/sitin');
                    }
                }
            );
        });
});

// ── Sit-in History ────────────────────────────────────────────────────────────
router.get('/history', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, u.id_number, u.first_name, u.last_name, u.course, u.year_level
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id
         ORDER BY s.time_in DESC`,
        (err, sessions) => res.render('pages/admin-history', { sessions: sessions || [] })
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

// ── Reservations ──────────────────────────────────────────────────────────────
router.get('/reservations', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT r.*, u.id_number, u.first_name, u.last_name, u.course
         FROM reservations r JOIN users u ON r.user_id = u.id ORDER BY r.date DESC, r.created_at DESC`,
        (err, reservations) => res.render('pages/admin-reservations', { reservations: reservations || [] })
    );
});

// Approve reservation
router.post('/reservations/:id/approve', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT r.*, u.id as uid FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.id = ?`,
        [req.params.id], (err, r) => {
            db.run(`UPDATE reservations SET status = 'approved' WHERE id = ?`, [req.params.id], () => {
                if (r) {
                    db.run(
                        `INSERT INTO notifications (user_id, message) VALUES (?, ?)`,
                        [r.user_id, `Your reservation for Lab ${r.lab_room} on ${r.date} (${r.time_slot}) has been APPROVED.`]
                    );
                }
                req.session.toast = { type: 'success', message: 'Reservation approved successfully.' };
                res.redirect('/admin/reservations');
            });
        });
});

// Reject reservation
router.post('/reservations/:id/reject', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT r.*, u.id as uid FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.id = ?`,
        [req.params.id], (err, r) => {
            db.run(`UPDATE reservations SET status = 'rejected' WHERE id = ?`, [req.params.id], () => {
                if (r) {
                    db.run(
                        `INSERT INTO notifications (user_id, message) VALUES (?, ?)`,
                        [r.user_id, `Your reservation for Lab ${r.lab_room} on ${r.date} (${r.time_slot}) has been REJECTED.`]
                    );
                }
                req.session.toast = { type: 'error', message: 'Reservation has been rejected.' };
                res.redirect('/admin/reservations');
            });
        });
});

// ── Admin Notifications ───────────────────────────────────────────────────────
router.get('/notifications', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 20`,
        (err, notifs) => res.json(notifs || [])
    );
});

router.post('/notifications/read', isAuthenticated, isAdmin, (req, res) => {
    db.run(`UPDATE admin_notifications SET is_read = 1`, () => res.json({ success: true }));
});

module.exports = router;