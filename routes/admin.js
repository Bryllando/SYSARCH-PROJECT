const express = require('express');
const router = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const db = require('../database/database');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ── Multer for announcement media ──────────────────────────────────────────────
const annDir = path.join(__dirname, '../public/uploads/announcements');
if (!fs.existsSync(annDir)) fs.mkdirSync(annDir, { recursive: true });

const annStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, annDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `ann_${Date.now()}${ext}`);
    }
});
const annUpload = multer({
    storage: annStorage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm'];
        cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
    }
});

// Helper: fetch all top-stats in parallel
function fetchAdminHomeData(cb) {
    db.get(`SELECT COUNT(*) as total FROM users WHERE role='user'`, (e1, row) => {
        db.get(`SELECT COUNT(*) as active FROM sitin_sessions WHERE status='active'`, (e2, active) => {
            db.get(`SELECT COUNT(*) as totalSitins FROM sitin_sessions`, (e3, total) => {
                db.all(`SELECT a.*, u.first_name, u.last_name FROM announcements a LEFT JOIN users u ON a.admin_id = u.id ORDER BY a.created_at DESC LIMIT 15`, (e4, announcements) => {
                    db.all(`
                        SELECT u.id, u.id_number, u.first_name, u.last_name, u.course, u.profile_picture,
                               COUNT(s.id) as sitin_count
                        FROM sitin_sessions s JOIN users u ON s.user_id = u.id
                        GROUP BY u.id ORDER BY sitin_count DESC LIMIT 5
                    `, (e5, topStudents) => {
                        db.all(`
                            SELECT lab_room, COUNT(*) as count FROM sitin_sessions
                            WHERE lab_room IS NOT NULL AND lab_room != ''
                            GROUP BY lab_room ORDER BY count DESC LIMIT 5
                        `, (e6, topLabs) => {
                            db.all(`
                                SELECT purpose, COUNT(*) as count FROM sitin_sessions
                                WHERE purpose IS NOT NULL AND purpose != ''
                                GROUP BY purpose ORDER BY count DESC LIMIT 5
                            `, (e7, topPurposes) => {
                                cb({
                                    totalStudents: row?.total || 0,
                                    activeSitins: active?.active || 0,
                                    totalSitins: total?.totalSitins || 0,
                                    announcements: announcements || [],
                                    topStudents: topStudents || [],
                                    topLabs: topLabs || [],
                                    topPurposes: topPurposes || []
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

// Admin Home
router.get('/', isAuthenticated, isAdmin, (req, res) => {
    fetchAdminHomeData(data => res.render('pages/admin', data));
});

// Post Announcement (with optional media)
router.post('/announcement', isAuthenticated, isAdmin, annUpload.single('media'), (req, res) => {
    const { message } = req.body;
    let media_url = '';
    let media_type = '';
    if (req.file) {
        media_url = `/uploads/announcements/${req.file.filename}`;
        const ext = path.extname(req.file.filename).toLowerCase();
        if (ext === '.gif') media_type = 'gif';
        else if (['.mp4', '.webm'].includes(ext)) media_type = 'video';
        else media_type = 'image';
    }
    db.run(
        `INSERT INTO announcements (admin_id, message, media_url, media_type) VALUES (?, ?, ?, ?)`,
        [req.session.user.id, message, media_url, media_type],
        () => res.redirect('/admin')
    );
});

// Delete Announcement
router.post('/announcement/:id/delete', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT media_url FROM announcements WHERE id=?`, [req.params.id], (err, ann) => {
        if (ann && ann.media_url) {
            const filePath = path.join(__dirname, '../public', ann.media_url);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        db.run(`DELETE FROM announcements WHERE id=?`, [req.params.id], () => {
            db.run(`DELETE FROM announcement_reactions WHERE announcement_id=?`, [req.params.id]);
            db.run(`DELETE FROM announcement_comments WHERE announcement_id=?`, [req.params.id]);
            req.session.toast = { type: 'success', message: 'Announcement deleted.' };
            res.redirect('/admin');
        });
    });
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

// ── Start sit-in (now includes optional computer_number) ──────────────────────
router.post('/sitin/start', isAuthenticated, isAdmin, (req, res) => {
    const { user_id, purpose, lab_room, computer_number, return_to } = req.body;
    const redirectTo = return_to || '/admin';
    const pcNum = computer_number ? parseInt(computer_number) : null;

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

            // If a PC was selected, check it's still available and mark it in_use
            function doInsert() {
                db.run(
                    `INSERT INTO sitin_sessions (user_id, purpose, lab_room, computer_number, time_in)
                     VALUES (?, ?, ?, ?, datetime('now','localtime'))`,
                    [user_id, purpose, lab_room, pcNum],
                    () => {
                        // Mark PC as in_use
                        if (pcNum && lab_room) {
                            db.run(
                                `INSERT INTO lab_computers (lab_room, computer_number, status)
                                 VALUES (?, ?, 'in_use')
                                 ON CONFLICT(lab_room, computer_number) DO UPDATE SET status = 'in_use'`,
                                [lab_room, pcNum]
                            );
                        }
                        const pcLabel = pcNum ? ` — PC-${String(pcNum).padStart(2, '0')}` : '';
                        req.session.toast = {
                            type: 'success',
                            message: `Sit-in started for ${student.first_name} ${student.last_name} in Lab ${lab_room}${pcLabel}.`
                        };
                        res.redirect(redirectTo);
                    }
                );
            }

            if (pcNum && lab_room) {
                db.get(
                    `SELECT status FROM lab_computers WHERE lab_room = ? AND computer_number = ?`,
                    [lab_room, pcNum],
                    (err3, pc) => {
                        if (pc && pc.status !== 'available') {
                            req.session.toast = { type: 'error', message: `PC-${String(pcNum).padStart(2, '0')} is no longer available.` };
                            return res.redirect(redirectTo);
                        }
                        doInsert();
                    }
                );
            } else {
                doInsert();
            }
        });
    });
});

// ── Edit sit-in PC (admin can change which PC a student is on) ────────────────
router.post('/sitin/:id/edit-pc', isAuthenticated, isAdmin, (req, res) => {
    const { computer_number } = req.body;
    const newPc = computer_number ? parseInt(computer_number) : null;
    const sessionId = req.params.id;

    db.get(`SELECT * FROM sitin_sessions WHERE id = ?`, [sessionId], (err, session) => {
        if (!session) {
            req.session.toast = { type: 'error', message: 'Session not found.' };
            return res.redirect('/admin/sitin');
        }

        const oldPc = session.computer_number;
        const labRoom = session.lab_room;

        // Free old PC if there was one
        function freeOldPc(next) {
            if (oldPc && labRoom) {
                db.run(
                    `UPDATE lab_computers SET status = 'available'
                     WHERE lab_room = ? AND computer_number = ?`,
                    [labRoom, oldPc], next
                );
            } else {
                next();
            }
        }

        // Occupy new PC
        function occupyNewPc(next) {
            if (newPc && labRoom) {
                db.run(
                    `INSERT INTO lab_computers (lab_room, computer_number, status)
                     VALUES (?, ?, 'in_use')
                     ON CONFLICT(lab_room, computer_number) DO UPDATE SET status = 'in_use'`,
                    [labRoom, newPc], next
                );
            } else {
                next();
            }
        }

        freeOldPc(() => {
            occupyNewPc(() => {
                db.run(
                    `UPDATE sitin_sessions SET computer_number = ? WHERE id = ?`,
                    [newPc, sessionId],
                    () => {
                        const label = newPc ? `PC-${String(newPc).padStart(2, '0')}` : 'No PC';
                        req.session.toast = { type: 'success', message: `PC updated to ${label}.` };
                        res.redirect('/admin/sitin');
                    }
                );
            });
        });
    });
});

// Students list
router.get('/students', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT * FROM users WHERE role='user' ORDER BY last_name`, (err, students) => {
        res.render('pages/admin-students', { students: students || [] });
    });
});

// Add Student
router.post('/students/add', isAuthenticated, isAdmin, async (req, res) => {
    const { id_number, last_name, first_name, middle_initial, course, year_level, email, password, address } = req.body;
    if (!/^\d{8}$/.test(id_number)) {
        req.session.toast = { type: 'error', message: 'ID Number must be exactly 8 digits.' };
        return res.redirect('/admin/students');
    }
    try {
        const hashed = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (id_number, last_name, first_name, middle_initial, course, year_level, email, password, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id_number, last_name, first_name, middle_initial || '', course, year_level, email, hashed, address || ''],
            function (err) {
                if (err) {
                    const msg = err.message.includes('UNIQUE') ? 'ID number or email already registered.' : 'Failed to add student.';
                    req.session.toast = { type: 'error', message: msg };
                } else {
                    req.session.toast = { type: 'success', message: `Student ${first_name} ${last_name} created!` };
                }
                res.redirect('/admin/students');
            }
        );
    } catch (e) {
        req.session.toast = { type: 'error', message: 'An error occurred.' };
        res.redirect('/admin/students');
    }
});

// Reset all sessions
router.post('/students/reset-sessions', isAuthenticated, isAdmin, (req, res) => {
    db.run(`UPDATE users SET remaining_sessions = 30 WHERE role = 'user'`, () => {
        req.session.toast = { type: 'success', message: 'All student sessions reset to 30.' };
        res.redirect('/admin/students');
    });
});

// Student record
router.get('/students/:id', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, student) => {
        db.all(`SELECT * FROM sitin_sessions WHERE user_id = ? ORDER BY time_in DESC`, [req.params.id], (err2, sessions) => {
            res.render('pages/admin-student-record', { student, sessions: sessions || [] });
        });
    });
});

// Edit Student
router.post('/students/:id/edit', isAuthenticated, isAdmin, (req, res) => {
    const { first_name, last_name, middle_initial, course, year_level, email, address, remaining_sessions } = req.body;
    db.run(
        `UPDATE users SET first_name=?, last_name=?, middle_initial=?, course=?, year_level=?, email=?, address=?, remaining_sessions=? WHERE id=?`,
        [first_name, last_name, middle_initial || '', course, year_level, email, address || '', parseInt(remaining_sessions) || 30, req.params.id],
        function (err) {
            if (err) { req.session.toast = { type: 'error', message: 'Update failed.' }; }
            else { req.session.toast = { type: 'success', message: `Student ${first_name} ${last_name} updated!` }; }
            res.redirect('/admin/students');
        }
    );
});

// Current sit-in list
router.get('/sitin', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, u.id_number, u.first_name, u.last_name, u.course, u.remaining_sessions
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id WHERE s.status = 'active' ORDER BY s.time_in DESC`,
        (err, sessions) => res.render('pages/admin-sitin', { sessions: sessions || [] })
    );
});

// ── End sit-in (free the PC) ──────────────────────────────────────────────────
router.post('/sitin/:id/end', isAuthenticated, isAdmin, (req, res) => {
    db.get(
        `SELECT s.user_id, s.lab_room, s.computer_number, u.first_name, u.last_name
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?`,
        [req.params.id], (err, row) => {
            db.run(`UPDATE sitin_sessions SET time_out = datetime('now','localtime'), status = 'done' WHERE id = ?`, [req.params.id], () => {
                if (row && row.user_id) {
                    db.run(`UPDATE users SET remaining_sessions = remaining_sessions - 1 WHERE id = ? AND remaining_sessions > 0`, [row.user_id], () => {
                        // Free the PC
                        if (row.computer_number && row.lab_room) {
                            db.run(
                                `UPDATE lab_computers SET status = 'available'
                                 WHERE lab_room = ? AND computer_number = ?`,
                                [row.lab_room, row.computer_number]
                            );
                        }
                        req.session.toast = { type: 'success', message: `${row.first_name} ${row.last_name} logged out. PC is now vacant.` };
                        res.redirect('/admin/sitin');
                    });
                } else {
                    res.redirect('/admin/sitin');
                }
            });
        });
});

// History
router.get('/history', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, u.id_number, u.first_name, u.last_name, u.course, u.year_level, f.message as feedback_message FROM sitin_sessions s JOIN users u ON s.user_id = u.id LEFT JOIN feedback f ON f.session_id = s.id ORDER BY s.time_in DESC`,
        (err, sessions) => res.render('pages/admin-history', { sessions: sessions || [] })
    );
});

// Reports
router.get('/reports', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, u.id_number, u.first_name, u.last_name, u.course, f.message as feedback_message FROM sitin_sessions s JOIN users u ON s.user_id = u.id LEFT JOIN feedback f ON f.session_id = s.id ORDER BY s.time_in DESC`,
        (err, sessions) => res.render('pages/admin-reports', { sessions: sessions || [] })
    );
});

// Feedback
router.get('/feedback', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT f.*, u.id_number, u.first_name, u.last_name, u.course, u.profile_picture
         FROM feedback f JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC`,
        (err, feedbacks) => res.render('pages/admin-feedback', { feedbacks: feedbacks || [] })
    );
});

// Reservations — only lab PC reservations now
router.get('/reservations', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT r.*, u.id_number, u.first_name, u.last_name, u.course
         FROM reservations r JOIN users u ON r.user_id = u.id
         WHERE r.computer_number IS NOT NULL AND r.computer_number > 0
         ORDER BY r.date DESC, r.created_at DESC`,
        (err, reservations) => res.render('pages/admin-reservations', { reservations: reservations || [] })
    );
});

// Approve lab reservation
router.post('/reservations/:id/approve', isAuthenticated, isAdmin, (req, res) => {
    db.get(
        `SELECT r.*, u.first_name, u.last_name FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.id = ?`,
        [req.params.id],
        (err, r) => {
            if (!r) { req.session.toast = { type: 'error', message: 'Reservation not found.' }; return res.redirect('/admin/reservations'); }
            db.run(`UPDATE reservations SET status = 'approved' WHERE id = ?`, [req.params.id], () => {
                db.run(
                    `INSERT INTO lab_computers (lab_room, computer_number, status)
                     VALUES (?, ?, 'reserved')
                     ON CONFLICT(lab_room, computer_number) DO UPDATE SET status = 'reserved'`,
                    [r.lab_room, r.computer_number]
                );
                db.run(
                    `INSERT INTO notifications (user_id, message) VALUES (?, ?)`,
                    [r.user_id, `Your reservation for Lab ${r.lab_room} PC-${String(r.computer_number).padStart(2, '0')} on ${r.date} (${r.time_slot}) has been APPROVED.`]
                );
                req.session.toast = { type: 'success', message: `Reservation approved. PC-${String(r.computer_number).padStart(2, '0')} marked as reserved.` };
                res.redirect('/admin/reservations');
            });
        }
    );
});

// Reject lab reservation
router.post('/reservations/:id/reject', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM reservations WHERE id = ?`, [req.params.id], (err, r) => {
        if (!r) { return res.redirect('/admin/reservations'); }
        db.run(`UPDATE reservations SET status = 'rejected' WHERE id = ?`, [req.params.id], () => {
            db.run(
                `INSERT INTO notifications (user_id, message) VALUES (?, ?)`,
                [r.user_id, `Your reservation for Lab ${r.lab_room} PC-${String(r.computer_number || 0).padStart(2, '0')} on ${r.date} has been REJECTED.`]
            );
            req.session.toast = { type: 'error', message: 'Reservation rejected.' };
            res.redirect('/admin/reservations');
        });
    });
});

// Admin Notifications
router.get('/notifications', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 20`, (err, notifs) => res.json(notifs || []));
});
router.post('/notifications/read', isAuthenticated, isAdmin, (req, res) => {
    db.run(`UPDATE admin_notifications SET is_read = 1`, () => res.json({ success: true }));
});

// Admin: update PC status
router.post('/lab-computers/status', isAuthenticated, isAdmin, (req, res) => {
    const { lab_room, computer_number, status } = req.body;
    const allowed = ['available', 'in_use', 'defective', 'reserved'];
    if (!allowed.includes(status)) return res.json({ error: 'Invalid status' });

    db.run(
        `INSERT INTO lab_computers (lab_room, computer_number, status)
         VALUES (?, ?, ?)
         ON CONFLICT(lab_room, computer_number) DO UPDATE SET status = excluded.status`,
        [lab_room, computer_number, status],
        (err) => {
            if (err) return res.json({ error: err.message });
            res.json({ success: true, lab_room, computer_number, status });
        }
    );


});


router.get('/lab-computers', isAuthenticated, isAdmin, (req, res) => {
    res.render('pages/admin-lab-computers');
});

// Admin Leaderboard page
router.get('/leaderboard', isAuthenticated, isAdmin, (req, res) => {
    db.all(`
        SELECT u.id, u.first_name, u.last_name, u.course, u.year_level,
               u.remaining_sessions, u.profile_picture,
               COUNT(DISTINCT s.id) as total_sitins,
               COUNT(DISTINCT f.id) as feedback_count
        FROM users u
        LEFT JOIN sitin_sessions s ON s.user_id = u.id AND s.status = 'done'
        LEFT JOIN feedback f ON f.user_id = u.id
        WHERE u.role = 'user'
        GROUP BY u.id
        ORDER BY total_sitins DESC
    `, (err, students) => {
        const ranked = (students || []).map(s => {
            const sessionsUsed = Math.max(0, 30 - (s.remaining_sessions || 30));
            s.points = Math.round((sessionsUsed / 30) * 50 + Math.min(s.total_sitins, 30) + Math.min(s.feedback_count * 4, 20));
            return s;
        }).sort((a, b) => b.points - a.points);
        res.render('pages/leaderboard-index', { students: ranked });
    });
});

// Admin reply to a student's feedback — sends notification to the student
router.post('/feedback/:id/reply', isAuthenticated, isAdmin, (req, res) => {
    const { reply_message } = req.body;
    const feedbackId = req.params.id;

    if (!reply_message || !reply_message.trim()) {
        req.session.toast = { type: 'error', message: 'Reply message cannot be empty.' };
        return res.redirect('/admin/feedback');
    }

    db.get(
        `SELECT f.*, u.first_name, u.last_name, u.id AS student_id
         FROM feedback f JOIN users u ON f.user_id = u.id WHERE f.id = ?`,
        [feedbackId],
        (err, feedback) => {
            if (err || !feedback) {
                req.session.toast = { type: 'error', message: 'Feedback not found.' };
                return res.redirect('/admin/feedback');
            }

            const adminName = req.session.user.first_name + ' ' + req.session.user.last_name;
            const notifMsg = `📩 Admin ${adminName} replied to your feedback: "${reply_message.trim().substring(0, 200)}"`;

            db.run(
                `INSERT INTO notifications (user_id, message) VALUES (?, ?)`,
                [feedback.user_id, notifMsg],
                (err2) => {
                    if (err2) {
                        req.session.toast = { type: 'error', message: 'Failed to send reply notification.' };
                    } else {
                        req.session.toast = {
                            type: 'success',
                            message: `✅ Reply sent! ${feedback.first_name} ${feedback.last_name} has been notified.`
                        };
                    }
                    res.redirect('/admin/feedback');
                }
            );
        }
    );
});


module.exports = router;