const express = require('express');
const router = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const db = require('../database/database');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { bumpStudentAiVersion } = require('../services/ai');
const { getLeaderboardData } = require('../services/leaderboard');
const { generateAdminInsights, generateStudentRecommendation, generateAdminStudyTip } = require('../services/ai-engine');

const { uploadToCloudinary } = require('../services/cloudinary');

// ── Multer for announcement media (Memory Storage for Cloudinary) ──────────────
const annStorage = multer.memoryStorage();
const annUpload = multer({
    storage: annStorage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm'];
        cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
    }
});

function toSqlDateTime(dtLocal) {
    if (!dtLocal) return null;
    const normalized = String(dtLocal).trim().replace('T', ' ');
    return normalized.length === 16 ? `${normalized}:00` : normalized;
}

// Helper: fetch all top-stats in parallel
function fetchAdminHomeData(cb) {
    db.get(`SELECT COUNT(*) as total FROM users WHERE role='user'`, (e1, row) => {
        db.get(`SELECT COUNT(*) as active FROM sitin_sessions WHERE status='active'`, (e2, active) => {
            db.get(`SELECT COUNT(*) as totalSitins FROM sitin_sessions`, (e3, total) => {
                db.all(`SELECT a.*, u.first_name, u.last_name FROM announcements a LEFT JOIN users u ON a.admin_id = u.id ORDER BY a.is_pinned DESC, a.created_at DESC LIMIT 15`, (e4, announcements) => {
                    db.all(`
                        SELECT u.id, u.id_number, u.first_name, u.last_name, u.course, u.profile_picture,
                               COUNT(s.id) as sitin_count
                        FROM sitin_sessions s JOIN users u ON s.user_id = u.id
                        GROUP BY u.id ORDER BY sitin_count DESC LIMIT 5
                    `, (e5, topStudents) => {
                        db.all(`
                            SELECT
                                lab_room,
                                COUNT(*) as count,
                                ROUND(SUM(
                                    CASE
                                        WHEN time_in IS NOT NULL AND COALESCE(time_out, time_end) IS NOT NULL
                                        THEN (julianday(COALESCE(time_out, time_end)) - julianday(time_in)) * 24
                                        ELSE 0
                                    END
                                ), 2) as hours,
                                ROUND(COALESCE(AVG(behavior_rating), 0), 2) as rating,
                                COUNT(DISTINCT user_id) as unique_users,
                                ROUND(
                                    (COUNT(*) * 0.25) +
                                    (SUM(
                                        CASE
                                            WHEN time_in IS NOT NULL AND COALESCE(time_out, time_end) IS NOT NULL
                                            THEN (julianday(COALESCE(time_out, time_end)) - julianday(time_in)) * 24
                                            ELSE 0
                                        END
                                    ) * 0.25) +
                                    (COALESCE(AVG(behavior_rating), 0) * 0.25) +
                                    (COUNT(DISTINCT user_id) * 0.25),
                                    2
                                ) as score
                            FROM sitin_sessions
                            WHERE lab_room IS NOT NULL AND lab_room != ''
                            GROUP BY lab_room
                            ORDER BY score DESC
                            LIMIT 5
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
router.post('/announcement', isAuthenticated, isAdmin, annUpload.single('media'), async (req, res) => {
    const message = (req.body.message || '').trim();
    if (!message) {
        req.session.toast = { type: 'error', message: 'Announcement message cannot be empty.' };
        return res.redirect('/admin');
    }
    let media_url = '';
    let media_type = '';
    if (req.file) {
        try {
            const result = await uploadToCloudinary(req.file.buffer, 'announcements');
            media_url = result.secure_url;
            const ext = path.extname(req.file.originalname).toLowerCase();
            if (ext === '.gif') media_type = 'gif';
            else if (['.mp4', '.webm'].includes(ext)) media_type = 'video';
            else media_type = 'image';
        } catch (uploadErr) {
            console.error('Cloudinary Announcement Upload Error:', uploadErr);
        }
    }
    db.run(
        `INSERT INTO announcements (admin_id, message, media_url, media_type) VALUES (?, ?, ?, ?)`,
        [req.session.user.id, message, media_url, media_type],
        () => res.redirect('/admin')
    );
});

// Edit announcement message
router.post('/announcement/:id/edit', isAuthenticated, isAdmin, (req, res) => {
    const message = (req.body.message || '').trim();
    if (!message) {
        req.session.toast = { type: 'error', message: 'Announcement message cannot be empty.' };
        return res.redirect('/admin');
    }
    db.run(`UPDATE announcements SET message = ? WHERE id = ?`, [message, req.params.id], (err) => {
        if (err) req.session.toast = { type: 'error', message: 'Failed to update announcement.' };
        else req.session.toast = { type: 'success', message: 'Announcement updated.' };
        res.redirect('/admin');
    });
});

// Toggle pin announcement
router.post('/announcement/:id/pin', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT is_pinned FROM announcements WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) {
            req.session.toast = { type: 'error', message: 'Announcement not found.' };
            return res.redirect('/admin');
        }
        const nextValue = row.is_pinned ? 0 : 1;
        db.run(`UPDATE announcements SET is_pinned = ? WHERE id = ?`, [nextValue, req.params.id], (upErr) => {
            if (upErr) req.session.toast = { type: 'error', message: 'Failed to update pin state.' };
            else req.session.toast = { type: 'success', message: nextValue ? 'Announcement pinned.' : 'Announcement unpinned.' };
            res.redirect('/admin');
        });
    });
});

// Delete Announcement
router.post('/announcement/:id/delete', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT media_url FROM announcements WHERE id=?`, [req.params.id], (err, ann) => {
        if (ann && ann.media_url && ann.media_url.trim() !== '') {
            const filePath = path.join(__dirname, '../public', ann.media_url);
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                } catch (err) {
                    console.error('Failed to delete media file:', err);
                }
            }
        }
        db.run(`DELETE FROM announcements WHERE id=?`, [req.params.id], (err) => {
            if (err) {
                console.error('Failed to delete announcement:', err);
                req.session.toast = { type: 'error', message: 'DB Error: ' + err.message };
            } else {
                req.session.toast = { type: 'success', message: 'Announcement deleted.' };
            }
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
    const nowHour = new Date().getHours();

    if (nowHour >= 20) {
        req.session.toast = { type: 'error', message: 'Cannot start a sit-in after 8:00 PM.' };
        return res.redirect(redirectTo);
    }

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
            db.get(
                `SELECT id, lab_room, computer_number, time_slot FROM reservations
                 WHERE user_id = ? AND date = date('now','localtime') AND status = 'pending'
                 ORDER BY created_at DESC LIMIT 1`,
                [user_id],
                (resErr, pendingReservation) => {
                    if (resErr) {
                        req.session.toast = { type: 'error', message: 'Failed to validate student reservation state.' };
                        return res.redirect(redirectTo);
                    }
                    if (pendingReservation) {
                        req.session.toast = {
                            type: 'error',
                            message: `This student has a pending reservation today (Lab ${pendingReservation.lab_room}, PC-${String(pendingReservation.computer_number || 0).padStart(2, '0')}${pendingReservation.time_slot ? `, ${pendingReservation.time_slot}` : ''}). Process that reservation first.`
                        };
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
                                bumpStudentAiVersion(db, user_id)
                                    .then(() => generateStudentRecommendation(db, user_id, true))
                                    .catch(() => { });
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
                }
            );
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
    db.run(`UPDATE users SET remaining_sessions = 30 WHERE role = 'user'`, (err) => {
        if (err) {
            console.error('Failed to reset sessions:', err);
            req.session.toast = { type: 'error', message: 'DB Error: ' + err.message };
        } else {
            req.session.toast = { type: 'success', message: 'All student sessions reset to 30.' };
        }
        res.redirect('/admin/students');
    });
});

// Student record
router.get('/students/:id', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, student) => {
        db.all(`SELECT * FROM sitin_sessions WHERE user_id = ? ORDER BY time_in DESC`, [req.params.id], (err2, sessions) => {
            db.get(
                `SELECT ROUND(AVG(behavior_rating),1) as avg_rating, COUNT(behavior_rating) as rated_count
                 FROM sitin_sessions WHERE user_id = ? AND behavior_rating IS NOT NULL`,
                [req.params.id],
                (err3, ratingRow) => {
                    res.render('pages/admin-student-record', {
                        student,
                        sessions: sessions || [],
                        avg_rating: ratingRow?.avg_rating || null,
                        rated_count: ratingRow?.rated_count || 0
                    });
                }
            );
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
    const filterDate = (req.query.filter_date || '').trim();

    const filters = [`s.status = 'active'`];
    const params = [];
    if (filterDate) {
        filters.push(`date(s.time_in) = date(?)`);
        params.push(filterDate);
    }

    db.all(
        `SELECT s.*, u.id_number, u.first_name, u.last_name, u.course, u.remaining_sessions
         FROM sitin_sessions s
         JOIN users u ON s.user_id = u.id
         WHERE ${filters.join(' AND ')}
         ORDER BY s.time_in DESC`,
        params,
        (err, sessions) => res.render('pages/admin-sitin', {
            sessions: sessions || [],
            sitinFilters: { filter_date: filterDate }
        })
    );
});

// Extend active sit-in session
router.post('/sitin/:id/extend', isAuthenticated, isAdmin, (req, res) => {
    const sessionId = req.params.id;
    const startInput = toSqlDateTime(req.body.start_time);
    const endInput = toSqlDateTime(req.body.end_time);
    if (!startInput || !endInput) {
        req.session.toast = { type: 'error', message: 'Start and end time are required for extension.' };
        return res.redirect('/admin/sitin');
    }
    if (endInput <= startInput) {
        req.session.toast = { type: 'error', message: 'End time must be after start time.' };
        return res.redirect('/admin/sitin');
    }

    const durationMinutes = Math.floor((new Date(endInput) - new Date(startInput)) / 60000);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 180) {
        req.session.toast = { type: 'error', message: 'Maximum extension is 3 hours only.' };
        return res.redirect('/admin/sitin');
    }

    db.get(`SELECT * FROM sitin_sessions WHERE id = ? AND status = 'active'`, [sessionId], (err, s) => {
        if (err || !s) {
            req.session.toast = { type: 'error', message: 'Active sit-in session not found.' };
            return res.redirect('/admin/sitin');
        }

        const currentEnd = s.time_end ? new Date(s.time_end) : new Date(new Date(s.time_in).getTime() + (2 * 60 * 60 * 1000));
        if (new Date(startInput) < currentEnd) {
            req.session.toast = { type: 'error', message: 'Extension start time must be at or after the current end time.' };
            return res.redirect('/admin/sitin');
        }

        db.run(
            `UPDATE sitin_sessions SET time_end = ? WHERE id = ?`,
            [endInput, sessionId],
            (upErr) => {
                if (upErr) req.session.toast = { type: 'error', message: 'Failed to extend sit-in session.' };
                else req.session.toast = { type: 'success', message: `Sit-in extended successfully (${durationMinutes} minute extension).` };
                res.redirect('/admin/sitin');
            }
        );
    });
});

// ── End sit-in (free the PC) ──────────────────────────────────────────────────
router.post('/sitin/:id/end', isAuthenticated, isAdmin, (req, res) => {
    db.get(
        `SELECT s.user_id, s.lab_room, s.computer_number, u.first_name, u.last_name
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?`,
        [req.params.id], (err, row) => {
            db.run(`UPDATE sitin_sessions SET time_out = datetime('now','localtime'), status = 'completed' WHERE id = ?`, [req.params.id], () => {
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
                        bumpStudentAiVersion(db, row.user_id)
                            .then(() => generateStudentRecommendation(db, row.user_id, true))
                            .catch(() => { });
                        res.redirect('/admin/sitin');
                    });
                } else {
                    res.redirect('/admin/sitin');
                }
            });
        });
});

// ── Rate student behavior for a sit-in session (AJAX) ─────────────────────────
router.post('/sitin/:id/rate', isAuthenticated, isAdmin, (req, res) => {
    const sessionId = req.params.id;
    const rating = parseInt(req.body.rating);
    if (!rating || rating < 1 || rating > 5) {
        return res.json({ error: 'Invalid rating. Must be 1–5.' });
    }
    db.run(
        `UPDATE sitin_sessions SET behavior_rating = ? WHERE id = ?`,
        [rating, sessionId],
        function (err) {
            if (err) return res.json({ error: err.message });
            res.json({ success: true, rating, sessionId });
        }
    );
});


// History
router.get('/history', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, s.behavior_rating, u.id_number, u.first_name, u.last_name, u.course, u.year_level, f.message as feedback_message
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id LEFT JOIN feedback f ON f.session_id = s.id
         ORDER BY s.time_in DESC`,
        (err, sessions) => res.render('pages/admin-history', { sessions: sessions || [] })
    );
});

// Reports
router.get('/reports', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT s.*, s.behavior_rating, u.id_number, u.first_name, u.last_name, u.course, f.message as feedback_message
         FROM sitin_sessions s JOIN users u ON s.user_id = u.id LEFT JOIN feedback f ON f.session_id = s.id
         ORDER BY s.time_in DESC`,
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
    const viewMode = req.query.view === 'history' ? 'history' : 'active';
    const statusFilterSql = viewMode === 'history'
        ? `r.status IN ('rejected', 'expired', 'cancelled', 'completed', 'done', 'deleted')`
        : `r.status IN ('pending', 'approved')`;

    db.get(`SELECT enabled, message FROM reservation_settings WHERE id = 1`, (sErr, settings) => {
        db.all(
            `SELECT r.*, u.id_number, u.first_name, u.last_name, u.course
             FROM reservations r JOIN users u ON r.user_id = u.id
             WHERE r.computer_number IS NOT NULL AND r.computer_number > 0
               AND ${statusFilterSql}
             ORDER BY r.date DESC, r.created_at DESC`,
            (err, reservations) => res.render('pages/admin-reservations', {
                reservations: reservations || [],
                reservationSettings: settings || { enabled: 1, message: '' },
                reservationViewMode: viewMode
            })
        );
    });
});

// Reservation settings toggle/message
router.post('/reservation-settings', isAuthenticated, isAdmin, (req, res) => {
    const enabled = Number(req.body.enabled) === 1 ? 1 : 0;
    const message = (req.body.message || '').trim() || 'Reservations are temporarily unavailable.';
    db.run(
        `INSERT INTO reservation_settings (id, enabled, message)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, message = excluded.message`,
        [enabled, message],
        (err) => {
            if (err) req.session.toast = { type: 'error', message: 'Failed to update reservation settings.' };
            else req.session.toast = { type: 'success', message: enabled ? 'Reservations are now enabled.' : 'Reservations are now disabled.' };
            res.redirect('/admin/reservations');
        }
    );
});

// Approve lab reservation
router.post('/reservations/:id/approve', isAuthenticated, isAdmin, (req, res) => {
    db.get(
        `SELECT r.*, u.first_name, u.last_name FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.id = ?`,
        [req.params.id],
        (err, r) => {
            if (!r) { req.session.toast = { type: 'error', message: 'Reservation not found.' }; return res.redirect('/admin/reservations'); }
            const start = (r.time_start || '').trim();
            const end = (r.time_end || '').trim();

            const conflictQuery = `
                SELECT id FROM reservations
                WHERE id != ? AND lab_room = ? AND computer_number = ? AND date = ?
                  AND status = 'approved'
                  AND (
                    (? != '' AND ? != '' AND COALESCE(time_start, '') != '' AND COALESCE(time_end, '') != ''
                     AND time_start < ? AND time_end > ?)
                    OR (? = '' OR ? = '' OR COALESCE(time_start, '') = '' OR COALESCE(time_end, '') = '')
                  )
                LIMIT 1
            `;

            db.get(
                conflictQuery,
                [r.id, r.lab_room, r.computer_number, r.date, start, end, end, start, start, end],
                (cErr, cRow) => {
                    if (cErr) {
                        req.session.toast = { type: 'error', message: 'Failed to approve reservation. Please try again.' };
                        return res.redirect('/admin/reservations');
                    }
                    if (cRow) {
                        req.session.toast = { type: 'error', message: `Cannot approve. Lab ${r.lab_room} PC-${String(r.computer_number).padStart(2, '0')} already has an approved overlapping reservation.` };
                        return res.redirect('/admin/reservations');
                    }

                    db.run(
                        `UPDATE reservations
                         SET status = 'approved',
                             approved_by = ?,
                             updated_at = datetime('now','localtime')
                         WHERE id = ?`,
                        [req.session.user.id, req.params.id],
                        () => {
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
                        }
                    );
                }
            );
        }
    );
});

// Reject lab reservation
router.post('/reservations/:id/reject', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM reservations WHERE id = ?`, [req.params.id], (err, r) => {
        if (!r) { return res.redirect('/admin/reservations'); }
        db.run(
            `UPDATE reservations
             SET status = 'rejected',
                 approved_by = ?,
                 updated_at = datetime('now','localtime')
             WHERE id = ?`,
            [req.session.user.id, req.params.id],
            () => {
            db.run(
                `INSERT INTO notifications (user_id, message) VALUES (?, ?)`,
                [r.user_id, `Your reservation for Lab ${r.lab_room} PC-${String(r.computer_number || 0).padStart(2, '0')} on ${r.date} has been REJECTED.`]
            );
            req.session.toast = { type: 'error', message: 'Reservation rejected.' };
            res.redirect('/admin/reservations');
            }
        );
    });
});

// Sit-in form for approved reservation
router.get('/reservations/:id/sit-in', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM reservations WHERE id = ?`, [req.params.id], (err, r) => {
        if (err || !r) {
            req.session.toast = { type: 'error', message: 'Reservation not found.' };
            return res.redirect('/admin/reservations');
        }
        if (r.status !== 'approved') {
            req.session.toast = { type: 'error', message: 'Only approved reservations can be moved to sit-in.' };
            return res.redirect('/admin/reservations');
        }
        db.get(`SELECT * FROM users WHERE id = ?`, [r.user_id], (uErr, user) => {
            if (uErr || !user) {
                req.session.toast = { type: 'error', message: 'Student account for this reservation was not found.' };
                return res.redirect('/admin/reservations');
            }
            res.render('pages/admin-reservation-sitin-form', { reservation: r, student: user });
        });
    });
});

// Transition approved reservation to sit-in session (submit form)
router.post('/reservations/:id/sit-in', isAuthenticated, isAdmin, (req, res) => {
    const startInput = req.body.start_time;
    const endInput = req.body.end_time;
    const startSql = toSqlDateTime(startInput);
    const endSql = toSqlDateTime(endInput);

    if (!startSql || !endSql) {
        req.session.toast = { type: 'error', message: 'Start and end time are required.' };
        return res.redirect(`/admin/reservations/${req.params.id}/sit-in`);
    }
    if (endSql <= startSql) {
        req.session.toast = { type: 'error', message: 'End time must be later than start time.' };
        return res.redirect(`/admin/reservations/${req.params.id}/sit-in`);
    }

    db.get(`SELECT * FROM reservations WHERE id = ?`, [req.params.id], (err, r) => {
        if (err || !r) {
            req.session.toast = { type: 'error', message: 'Reservation not found.' };
            return res.redirect('/admin/reservations');
        }
        if (r.status !== 'approved') {
            req.session.toast = { type: 'error', message: 'Only approved reservations can be moved to sit-in.' };
            return res.redirect('/admin/reservations');
        }

        db.get(`SELECT id FROM sitin_sessions WHERE user_id = ? AND status = 'active'`, [r.user_id], (activeErr, active) => {
            if (activeErr) {
                req.session.toast = { type: 'error', message: 'Failed to validate active sit-in state.' };
                return res.redirect('/admin/reservations');
            }
            if (active) {
                req.session.toast = { type: 'error', message: 'Student already has an active sit-in session.' };
                return res.redirect('/admin/reservations');
            }

            db.get(
                `SELECT id FROM sitin_sessions
                 WHERE status = 'active' AND lab_room = ? AND computer_number = ?`,
                [r.lab_room, r.computer_number],
                (pcErr, pcActive) => {
                    if (pcErr) {
                        req.session.toast = { type: 'error', message: 'Failed to validate PC availability.' };
                        return res.redirect('/admin/reservations');
                    }
                    if (pcActive) {
                        req.session.toast = { type: 'error', message: `PC-${String(r.computer_number || 0).padStart(2, '0')} is currently active in another sit-in session.` };
                        return res.redirect('/admin/reservations');
                    }

                    db.run(
                        `INSERT INTO sitin_sessions (user_id, purpose, lab_room, computer_number, time_in, time_end, status)
                         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
                        [r.user_id, r.purpose || 'Reservation Sit-In', r.lab_room, r.computer_number, startSql, endSql],
                        function (insertErr) {
                            if (insertErr) {
                                req.session.toast = { type: 'error', message: 'Failed to start sit-in from reservation.' };
                                return res.redirect('/admin/reservations');
                            }

                            db.run(
                                `UPDATE reservations
                                 SET status = 'completed',
                                     message = 'Moved to sit-in session.'
                                 WHERE id = ?`,
                                [r.id]
                            );

                            db.run(
                                `INSERT INTO lab_computers (lab_room, computer_number, status)
                                 VALUES (?, ?, 'in_use')
                                 ON CONFLICT(lab_room, computer_number) DO UPDATE SET status = 'in_use'`,
                                [r.lab_room, r.computer_number]
                            );

                            db.run(
                                `INSERT INTO notifications (user_id, message) VALUES (?, ?)`,
                                [r.user_id, `Your reservation for Lab ${r.lab_room} PC-${String(r.computer_number || 0).padStart(2, '0')} has been started as a sit-in session.`]
                            );

                            req.session.toast = { type: 'success', message: 'Reservation moved to sit-in successfully.' };
                            bumpStudentAiVersion(db, r.user_id)
                                .then(() => generateStudentRecommendation(db, r.user_id, true))
                                .catch(() => { });
                            res.redirect('/admin/reservations');
                        }
                    );
                }
            );
        });
    });
});

// Soft-delete reservation from active/admin views
router.post('/reservations/:id/delete', isAuthenticated, isAdmin, (req, res) => {
    db.run(
        `UPDATE reservations
         SET status = 'deleted',
             message = 'Deleted by admin.'
         WHERE id = ?`,
        [req.params.id],
        function (err) {
            if (err || this.changes === 0) {
                req.session.toast = { type: 'error', message: 'Failed to delete reservation.' };
            } else {
                req.session.toast = { type: 'success', message: 'Reservation marked as deleted.' };
            }
            const backTo = req.query.view === 'history' ? '/admin/reservations?view=history' : '/admin/reservations';
            res.redirect(backTo);
        }
    );
});

// Delete all archived reservation history
router.post('/reservations/delete-history', isAuthenticated, isAdmin, (req, res) => {
    db.run(
        `DELETE FROM reservations
         WHERE status IN ('rejected', 'completed', 'expired', 'cancelled', 'deleted', 'done')`,
        function (err) {
            if (err) {
                req.session.toast = { type: 'error', message: 'Failed to delete reservation history.' };
            } else {
                req.session.toast = { type: 'success', message: `${this.changes} history record(s) deleted.` };
            }
            res.redirect('/admin/reservations?view=history');
        }
    );
});

// Auto-expire overdue reservations
router.post('/reservations/auto-expire', isAuthenticated, isAdmin, (req, res) => {
    db.all(
        `SELECT id, user_id, lab_room, computer_number, date, time_slot, time_start, time_end, status
         FROM reservations
         WHERE status IN ('pending', 'approved')
           AND datetime(date || ' ' || COALESCE(NULLIF(time_end, ''), NULLIF(time_start, ''), '00:00')) < datetime('now','localtime')`,
        (selErr, rows) => {
            if (selErr) {
                req.session.toast = { type: 'error', message: 'Failed to auto-expire reservations.' };
                return res.redirect('/admin/reservations');
            }
            if (!rows || rows.length === 0) {
                req.session.toast = { type: 'success', message: 'Auto-expire complete. 0 reservation(s) updated.' };
                return res.redirect('/admin/reservations');
            }

            db.run(
                `UPDATE reservations
                 SET status = 'expired',
                     message = 'Your reservation has expired as your time slot has already passed. Please book a new reservation at a different time.'
                 WHERE status IN ('pending', 'approved')
                   AND datetime(date || ' ' || COALESCE(NULLIF(time_end, ''), NULLIF(time_start, ''), '00:00')) < datetime('now','localtime')`,
                function (err) {
                    if (err) {
                        req.session.toast = { type: 'error', message: 'Failed to auto-expire reservations.' };
                        return res.redirect('/admin/reservations');
                    }

                    rows.forEach((r) => {
                        db.run(
                            `INSERT INTO notifications (user_id, message) VALUES (?, ?)`,
                            [r.user_id, `Your reservation for Lab ${r.lab_room} PC-${String(r.computer_number || 0).padStart(2, '0')} on ${r.date} (${r.time_slot || 'scheduled slot'}) has EXPIRED.`]
                        );
                        if (r.status === 'approved') {
                            db.run(
                                `UPDATE lab_computers SET status = 'available' WHERE lab_room = ? AND computer_number = ?`,
                                [r.lab_room, r.computer_number]
                            );
                        }
                    });

                    req.session.toast = { type: 'success', message: `Auto-expire complete. ${this.changes} reservation(s) updated.` };
                    res.redirect('/admin/reservations');
                }
            );
        }
    );
});

// Admin Notifications
router.get('/notifications', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 20`, (err, notifs) => res.json(notifs || []));
});
router.post('/notifications/read', isAuthenticated, isAdmin, (req, res) => {
    db.run(`UPDATE admin_notifications SET is_read = 1`, () => res.json({ success: true }));
});

router.get('/ai-insights', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const response = await generateAdminInsights(db, String(req.query.refresh || '') === '1');
        res.json({
            success: true,
            insights: response.data,
            meta: {
                cached: response.cached,
                generated_at: response.generatedAt,
                minutes_ago: response.minutesAgo
            }
        });
    } catch (_) {
        res.status(500).json({ success: false, message: 'AI insights are temporarily unavailable.' });
    }
});

router.get('/ai-study-tip', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const tip = await generateAdminStudyTip(db, String(req.query.refresh || '') === '1');
        res.json({
            success: true,
            tip: tip.data,
            meta: {
                cached: tip.cached,
                fallback: Boolean(tip.fallback),
                generated_at: tip.generatedAt,
                minutes_ago: tip.minutesAgo
            }
        });
    } catch (_) {
        res.status(500).json({ success: false, message: 'AI is temporarily unavailable. Please try again later.' });
    }
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
    getLeaderboardData(db)
        .then(({ students, labs }) => res.render('pages/leaderboard-index', { students, labs }))
        .catch(() => res.render('pages/leaderboard-index', { students: [], labs: [] }));
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

// ── Delete single sit-in history record ───────────────────────────────────────
router.post('/history/:id/delete', isAuthenticated, isAdmin, (req, res) => {
    const sessionId = req.params.id;
    db.get(`SELECT * FROM sitin_sessions WHERE id = ?`, [sessionId], (err, session) => {
        if (err || !session) {
            req.session.toast = { type: 'error', message: 'Session record not found.' };
            return res.redirect('/admin/history');
        }
        // Only allow deleting completed sessions (not active ones)
        if (session.status === 'active') {
            req.session.toast = { type: 'error', message: 'Cannot delete an active sit-in session. End it first.' };
            return res.redirect('/admin/history');
        }
        db.run(`DELETE FROM sitin_sessions WHERE id = ?`, [sessionId], (err2) => {
            if (err2) {
                req.session.toast = { type: 'error', message: 'Failed to delete record.' };
            } else {
                req.session.toast = { type: 'success', message: 'Session record removed successfully.' };
            }
            res.redirect('/admin/history');
        });
    });
});

// ── Delete ALL sit-in history (completed sessions only) ───────────────────────
router.post('/history/delete-all', isAuthenticated, isAdmin, (req, res) => {
    db.run(`DELETE FROM sitin_sessions WHERE status IN ('completed', 'done')`, function (err) {
        if (err) {
            req.session.toast = { type: 'error', message: 'Failed to clear history.' };
        } else {
            req.session.toast = {
                type: 'success',
                message: `All sit-in history cleared. ${this.changes} record(s) removed.`
            };
        }
        res.redirect('/admin/history');
    });
});

// ── Lab Software Management ───────────────────────────────────────────────────

// Multer for software file uploads (Memory Storage)
const softwareUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.csv', '.xlsx', '.xls', '.pdf'];
        cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
    }
});

// GET: All software (JSON)
router.get('/software', isAuthenticated, isAdmin, (req, res) => {
    const lab = req.query.lab || '';
    const where = lab ? `WHERE lab_room = ?` : '';
    const params = lab ? [lab] : [];
    db.all(
        `SELECT * FROM lab_software ${where} ORDER BY lab_room, software_name`,
        params,
        (err, rows) => {
            if (req.accepts('json')) {
                return res.json(rows || []);
            }
            res.json(rows || []);
        }
    );
});

// POST: Add single software
router.post('/software/add', isAuthenticated, isAdmin, (req, res) => {
    const { lab_room, software_name, version, status } = req.body;
    if (!lab_room || !software_name) {
        return res.json({ error: 'Lab room and software name are required.' });
    }
    const swStatus = (status === 'Unavailable') ? 'Unavailable' : 'Available';
    db.run(
        `INSERT INTO lab_software (lab_room, software_name, version, status) VALUES (?, ?, ?, ?)`,
        [lab_room, software_name.trim(), (version || '').trim(), swStatus],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.json({ error: 'This software already exists in that lab with the same version.' });
                }
                return res.json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

// POST: Edit software
router.post('/software/:id/edit', isAuthenticated, isAdmin, (req, res) => {
    const { software_name, version, status } = req.body;
    if (!software_name) {
        return res.json({ error: 'Software name is required.' });
    }
    const swStatus = (status === 'Unavailable') ? 'Unavailable' : 'Available';
    db.run(
        `UPDATE lab_software SET software_name = ?, version = ?, status = ? WHERE id = ?`,
        [software_name.trim(), (version || '').trim(), swStatus, req.params.id],
        function (err) {
            if (err) return res.json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// POST: Delete software
router.post('/software/:id/delete', isAuthenticated, isAdmin, (req, res) => {
    db.run(`DELETE FROM lab_software WHERE id = ?`, [req.params.id], function (err) {
        if (err) return res.json({ error: err.message });
        res.json({ success: true });
    });
});

// POST: Upload software file (CSV, XLSX, PDF)
router.post('/software/upload', isAuthenticated, isAdmin, softwareUpload.single('software_file'), async (req, res) => {
    if (!req.file) {
        return res.json({ error: 'No file uploaded.' });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows = [];

    try {
        if (ext === '.csv') {
            const fileContent = req.file.buffer.toString('utf8');
            const lines = fileContent.split(/\r?\n/);
            
            let headerIdx = -1;
            for (let i = 0; i < lines.length; i++) {
                const lowerLine = lines[i].toLowerCase();
                if ((lowerLine.includes('lab') || lowerLine.includes('room')) && (lowerLine.includes('software') || lowerLine.includes('name'))) {
                    headerIdx = i;
                    break;
                }
            }
            
            const validLines = headerIdx !== -1 ? lines.slice(headerIdx) : lines;
            const validCsv = validLines.join('\n');
            const csvParser = require('csv-parser');
            const stream = require('stream');
            
            rows = await new Promise((resolve, reject) => {
                const results = [];
                const bufferStream = new stream.PassThrough();
                bufferStream.end(Buffer.from(validCsv));
                bufferStream.pipe(csvParser()).on('data', (data) => results.push(data)).on('end', () => resolve(results)).on('error', (err) => reject(err));
            });
        } else if (ext === '.xlsx' || ext === '.xls') {
            const XLSX = require('xlsx');
            const workbook = XLSX.read(req.file.buffer);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            let headerIdx = -1;
            for (let i = 0; i < rawRows.length; i++) {
                const rowStr = (rawRows[i] || []).join(' ').toLowerCase();
                if ((rowStr.includes('lab') || rowStr.includes('room')) && (rowStr.includes('software') || rowStr.includes('name'))) {
                    headerIdx = i;
                    break;
                }
            }
            if (headerIdx !== -1) {
                const headers = rawRows[headerIdx];
                for (let i = headerIdx + 1; i < rawRows.length; i++) {
                    const obj = {};
                    for (let j = 0; j < headers.length; j++) { if (headers[j]) obj[headers[j]] = rawRows[i][j]; }
                    if (Object.keys(obj).length > 0) rows.push(obj);
                }
            } else {
                rows = XLSX.utils.sheet_to_json(sheet);
            }
        } else if (ext === '.pdf') {
            const PDFParser = require('pdf2json');
            rows = await new Promise((resolve, reject) => {
                const pdfParser = new PDFParser(null, 1);
                pdfParser.on("pdfParser_dataError", errData => reject(new Error(errData.parserError)));
                pdfParser.on("pdfParser_dataReady", () => {
                    const text = pdfParser.getRawTextContent() || '';
                    const extractedRows = [];
                    const regex = /(?:Lab\s*)?(\d{3})[\s\|]+([\s\S]+?)[\s\|]+(Available|Unavailable)/gi;
                    let match;
                    while ((match = regex.exec(text)) !== null) {
                        const lab = match[1];
                        const middle = match[2].trim().replace(/\r?\n/g, ' ');
                        const status = match[3];
                        let name = middle; let version = '';
                        const words = middle.split(/\s+/);
                        if (words.length > 1) {
                            const lastWord = words[words.length - 1];
                            if (/[\d\.]/.test(lastWord) || lastWord.toLowerCase().startsWith('v')) {
                                version = words.pop(); name = words.join(' ');
                            }
                        }
                        extractedRows.push({ lab, software_name: name, version, status });
                    }
                    resolve(extractedRows);
                });
                pdfParser.parseBuffer(req.file.buffer);
            });
        }
    } catch (parseErr) {
        return res.json({ error: 'Failed to parse file: ' + parseErr.message });
    }

    if (!rows.length) {
        return res.json({ error: 'No valid data found in the file.' });
    }

    // Normalize column headers (case-insensitive matching)
    function normalizeKey(obj) {
        const normalized = {};
        Object.keys(obj).forEach(key => {
            const k = key.toLowerCase().replace(/[^a-z0-9_]/g, '_').trim();
            normalized[k] = String(obj[key] || '').trim();
        });
        return normalized;
    }

    let inserted = 0;
    let duplicates = 0;
    let errors = [];

    for (const rawRow of rows) {
        const row = normalizeKey(rawRow);
        const lab = row.lab || row.lab_room || row.laboratory || '';
        const swName = row.software_name || row.name || row.software || '';
        const version = row.version || '';
        const status = (row.status || 'Available').trim();

        // Extract lab number (just digits like 524, 526, etc.)
        const labNum = lab.match(/\d{3}/);
        if (!labNum || !swName) continue;

        const labRoom = labNum[0];
        const swStatus = status.toLowerCase().includes('unavail') ? 'Unavailable' : 'Available';

        try {
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO lab_software (lab_room, software_name, version, status) VALUES (?, ?, ?, ?)`,
                    [labRoom, swName, version, swStatus],
                    function (err) {
                        if (err) {
                            if (err.message.includes('UNIQUE')) {
                                duplicates++;
                                resolve();
                            } else {
                                errors.push(err.message);
                                resolve();
                            }
                        } else {
                            inserted++;
                            resolve();
                        }
                    }
                );
            });
        } catch (e) {
            errors.push(e.message);
        }
    }

    res.json({
        success: true,
        inserted,
        duplicates,
        total: rows.length,
        errors: errors.length > 0 ? errors.slice(0, 5) : undefined
    });
});

module.exports = router;