const express = require('express');
const router = express.Router();
const { isAuthenticated, isUser } = require('../middleware/auth');
const db = require('../database/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getLeaderboardData } = require('../services/leaderboard');
const { generateStudentRecommendation, generateStudentTips, generateStudentStudyTip } = require('../services/ai-engine');

function autoExpireReservationsForUser(db, userId, cb) {
    // Expire any pending/approved reservation whose end time has passed.
    // If no time_end, fallback to time_start; else treat as 00:00 (will expire next day).
    db.run(
        `UPDATE reservations
         SET status = 'expired',
             message = COALESCE(NULLIF(message,''), 'Expired automatically.'),
             updated_at = datetime('now','localtime')
         WHERE user_id = ?
           AND status IN ('pending', 'approved')
           AND datetime(
                date || ' ' || COALESCE(NULLIF(time_end, ''), NULLIF(time_start, ''), '00:00')
              ) < datetime('now','localtime')`,
        [userId],
        () => cb && cb()
    );
}

// ─── Profanity Filter ─────────────────────────────────────────────────────────
const VULGAR_WORDS = [
    // English
    'fuck', 'shit', 'ass', 'bitch', 'damn', 'bastard', 'dick', 'pussy', 'cock',
    'nigger', 'nigga', 'whore', 'slut', 'cunt', 'piss', 'fag', 'faggot', 'retard',
    // Filipino/Cebuano
    'puta', 'gago', 'bobo', 'tanga', 'putangina', 'tangina', 'tarantado', 'ulol',
    'leche', 'pakyu', 'animal', 'hunghang', 'buang', 'yawa', 'linti', 'hayop',
    'inutil', 'buwisit', 'bwisit', 'ampota', 'ampotah', 'shet', 'punyeta', 'boga'
];

const LEET_MAP = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a',
    '5': 's', '7': 't', '8': 'b', '@': 'a',
    '$': 's', '+': 't', '!': 'i'
};

function normalizeText(text) {
    let normalized = (text || '').toLowerCase();
    Object.keys(LEET_MAP).forEach((char) => {
        normalized = normalized.replaceAll(char, LEET_MAP[char]);
    });
    normalized = normalized.replace(/[\s.\-_*]+/g, '');
    normalized = normalized.replace(/(.)\1+/g, '$1');
    return normalized;
}

function containsVulgar(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const noSpaces = lower.replace(/\s+/g, '');
    const normalized = normalizeText(text);
    return VULGAR_WORDS.some(word =>
        lower.includes(word) ||
        noSpaces.includes(word) ||
        normalized.includes(word)
    );
}

// ─── Multer for profile pictures ─────────────────────────────────────────────
const uploadDir = path.join(__dirname, '../public/uploads/profiles');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `user_${req.session.user.id}_${Date.now()}${ext}`);
    }
});
const fileFilter = (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only image files are allowed.'), false);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// User Dashboard
router.get('/dashboard', isAuthenticated, isUser, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, userData) => {
        if (userData) req.session.user = { ...req.session.user, ...userData };
        db.get(`SELECT response_json FROM ai_recommendation_cache WHERE cache_key = ?`, [`student:${req.session.user.id}:student_recommendation`], (aiErr, aiCache) => {
            let initialAiRecommendation = null;
            if (aiCache && aiCache.response_json) {
                try {
                    initialAiRecommendation = JSON.parse(aiCache.response_json);
                } catch (_) {
                    initialAiRecommendation = null;
                }
            }
            db.all(`SELECT a.*, u.first_name, u.last_name FROM announcements a LEFT JOIN users u ON a.admin_id = u.id ORDER BY a.is_pinned DESC, a.created_at DESC LIMIT 15`, (err2, announcements) => {
                res.render('pages/dashboard', {
                    announcements: announcements || [],
                    initialAiRecommendation
                });
            });
        });
    });
});

router.get('/ai-recommendation', isAuthenticated, isUser, async (req, res) => {
    try {
        const recommendationResponse = await generateStudentRecommendation(
            db,
            req.session.user.id,
            String(req.query.refresh || '') === '1'
        );
        const recommendation = recommendationResponse.data;
        if (!recommendation) {
            return res.json({ success: false, message: 'No session data yet for AI recommendation.' });
        }
        return res.json({
            success: true,
            recommendation,
            message: recommendationResponse.fallback ? 'Using saved recommendation' : null,
            meta: {
                cached: recommendationResponse.cached,
                fallback: Boolean(recommendationResponse.fallback),
                generated_at: recommendationResponse.generatedAt,
                minutes_ago: recommendationResponse.minutesAgo
            }
        });
    } catch (_) {
        return res.status(500).json({ success: false, message: 'AI recommendation is temporarily unavailable.' });
    }
});

router.get('/ai/student-tips', isAuthenticated, isUser, async (req, res) => {
    try {
        const tipsResponse = await generateStudentTips(
            db,
            req.session.user.id,
            String(req.query.refresh || '') === '1'
        );
        return res.json({
            success: true,
            tips: tipsResponse.data,
            meta: {
                cached: tipsResponse.cached,
                generated_at: tipsResponse.generatedAt,
                minutes_ago: tipsResponse.minutesAgo
            }
        });
    } catch (_) {
        return res.status(500).json({ success: false, message: 'AI is temporarily unavailable. Please try again later.' });
    }
});

router.get('/ai-study-tip', isAuthenticated, isUser, async (req, res) => {
    try {
        const tip = await generateStudentStudyTip(
            db,
            req.session.user.id,
            String(req.query.refresh || '') === '1'
        );
        return res.json({
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
        return res.status(500).json({ success: false, message: 'AI is temporarily unavailable. Please try again later.' });
    }
});

// Edit Profile GET
router.get('/profile', isAuthenticated, isUser, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, userData) => {
        if (userData) req.session.user = { ...req.session.user, ...userData };
        generateStudentRecommendation(db, req.session.user.id, false).catch(() => { });
        res.render('pages/profile', { messages: [] });
    });
});

// Edit Profile POST
router.post('/profile', isAuthenticated, isUser, (req, res) => {
    const { first_name, last_name, middle_initial, course, year_level, email, address } = req.body;
    db.run(
        `UPDATE users SET first_name=?, last_name=?, middle_initial=?, course=?, year_level=?, email=?, address=? WHERE id=?`,
        [first_name, last_name, middle_initial || '', course, year_level, email, address || '', req.session.user.id],
        function (err) {
            if (err) return res.render('pages/profile', { messages: [{ type: 'error', text: 'Update failed.' }] });
            req.session.user = { ...req.session.user, first_name, last_name, middle_initial, course, year_level, email, address };
            res.render('pages/profile', { messages: [{ type: 'success', text: 'Profile updated!' }] });
        }
    );
});

// Upload Profile Picture
router.post('/profile/picture', isAuthenticated, isUser, upload.single('profile_picture'), (req, res) => {
    if (!req.file) {
        db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, userData) => {
            if (userData) req.session.user = { ...req.session.user, ...userData };
            return res.render('pages/profile', { messages: [{ type: 'error', text: 'No valid image file uploaded.' }] });
        });
        return;
    }
    const picturePath = `/uploads/profiles/${req.file.filename}`;
    const oldPic = req.session.user.profile_picture;
    if (oldPic && oldPic !== '') {
        const oldPath = path.join(__dirname, '../public', oldPic);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.run(`UPDATE users SET profile_picture=? WHERE id=?`, [picturePath, req.session.user.id], () => {
        db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err2, userData) => {
            if (userData) req.session.user = { ...req.session.user, ...userData };
            res.render('pages/profile', { messages: [{ type: 'success', text: 'Profile picture updated!' }] });
        });
    });
});

// Sit-in History
router.get('/history', isAuthenticated, isUser, (req, res) => {
    db.all(
        `SELECT s.*,
                EXISTS(
                    SELECT 1 FROM feedback f
                    WHERE f.user_id = s.user_id AND f.session_id = s.id
                ) AS has_feedback
         FROM sitin_sessions s
         WHERE s.user_id = ?
         ORDER BY s.time_in DESC`,
        [req.session.user.id],
        (err, sessions) => {
        generateStudentRecommendation(db, req.session.user.id, false).catch(() => { });
        res.render('pages/history', { sessions: sessions || [] });
        }
    );
});

// Submit Feedback — with profanity check
router.post('/feedback', isAuthenticated, isUser, (req, res) => {
    const { session_id, message, rating } = req.body;

    if (!message || !message.trim()) {
        req.session.toast = { type: 'error', message: 'Feedback message cannot be empty.' };
        return req.session.save(() => res.redirect('/history'));
    }

    if (containsVulgar(message)) {
        req.session.toast = {
            type: 'error',
            message: '⚠ Your feedback contains inappropriate language. Please keep it respectful and resubmit.'
        };
        return req.session.save(() => res.redirect('/history'));
    }

    const ratingVal = Math.min(5, Math.max(0, parseInt(rating) || 0));
    const sessionId = parseInt(session_id) || null;

    if (sessionId) {
        db.get(
            `SELECT id FROM sitin_sessions WHERE id = ? AND user_id = ?`,
            [sessionId, req.session.user.id],
            (sessionErr, ownSession) => {
                if (sessionErr || !ownSession) {
                    req.session.toast = { type: 'error', message: 'Invalid session selected for feedback.' };
                    return req.session.save(() => res.redirect('/history'));
                }

                db.get(
                    `SELECT id FROM feedback WHERE user_id = ? AND session_id = ?`,
                    [req.session.user.id, sessionId],
                    (dupErr, existingFeedback) => {
                        if (dupErr) {
                            req.session.toast = { type: 'error', message: 'Failed to submit feedback. Please try again.' };
                            return req.session.save(() => res.redirect('/history'));
                        }
                        if (existingFeedback) {
                            req.session.toast = { type: 'error', message: 'You already submitted feedback for this session.' };
                            return req.session.save(() => res.redirect('/history'));
                        }

                        db.run(
                            `INSERT INTO feedback (user_id, session_id, message, rating) VALUES (?, ?, ?, ?)`,
                            [req.session.user.id, sessionId, message.trim(), ratingVal],
                            function (err) {
                                if (err) {
                                    req.session.toast = { type: 'error', message: 'Failed to submit feedback. Please try again.' };
                                    return req.session.save(() => res.redirect('/history'));
                                }
                                req.session.toast = { type: 'success', message: '✅ Thank you for your feedback! It has been submitted successfully.' };
                                req.session.save(() => res.redirect('/history'));
                            }
                        );
                    }
                );
            }
        );
        return;
    }

    db.run(
        `INSERT INTO feedback (user_id, session_id, message, rating) VALUES (?, ?, ?, ?)`,
        [req.session.user.id, null, message.trim(), ratingVal],
        function (err) {
            if (err) {
                req.session.toast = { type: 'error', message: 'Failed to submit feedback. Please try again.' };
                return req.session.save(() => res.redirect('/history'));
            }
            req.session.toast = { type: 'success', message: '✅ Thank you for your feedback! It has been submitted successfully.' };
            req.session.save(() => res.redirect('/history'));
        }
    );
});

// ─── RESERVATION (Lab PC only) ────────────────────────────────────────────────
router.get('/reservation', isAuthenticated, isUser, (req, res) => {
    db.get(`SELECT enabled, message FROM reservation_settings WHERE id = 1`, (sErr, settings) => {
        autoExpireReservationsForUser(db, req.session.user.id, () => {
            db.all(
                `SELECT * FROM reservations
                 WHERE user_id = ?
                   AND computer_number IS NOT NULL
                   AND COALESCE(deleted_by_user, 0) = 0
                 ORDER BY created_at DESC`,
                [req.session.user.id],
                (err, reservations) => {
                    res.render('pages/reservation', {
                        reservations: reservations || [],
                        reservationSettings: settings || { enabled: 1, message: '' }
                    });
                }
            );
        });
    });
});

// API: fetch current reservations (for live status refresh)
router.get('/api/reservations/mine', isAuthenticated, isUser, (req, res) => {
    autoExpireReservationsForUser(db, req.session.user.id, () => {
        db.all(
            `SELECT id, lab_room, computer_number, purpose, date, time_slot, status, created_at, updated_at
             FROM reservations
             WHERE user_id = ?
               AND computer_number IS NOT NULL
               AND COALESCE(deleted_by_user, 0) = 0
             ORDER BY created_at DESC`,
            [req.session.user.id],
            (err, rows) => {
                if (err) return res.status(500).json({ success: false });
                res.json({ success: true, reservations: rows || [] });
            }
        );
    });
});

// API: soft-delete reservation from user history (non-pending only)
router.delete('/api/reservations/delete/:id', isAuthenticated, isUser, (req, res) => {
    const id = req.params.id;
    db.get(
        `SELECT id, status FROM reservations WHERE id = ? AND user_id = ?`,
        [id, req.session.user.id],
        (err, row) => {
            if (err || !row) return res.status(404).json({ success: false, message: 'Not found' });
            if (row.status === 'pending') return res.status(400).json({ success: false, message: 'Pending reservations cannot be deleted.' });
            db.run(
                `UPDATE reservations
                 SET deleted_by_user = 1,
                     updated_at = datetime('now','localtime')
                 WHERE id = ? AND user_id = ?`,
                [id, req.session.user.id],
                function (upErr) {
                    if (upErr || this.changes === 0) return res.status(500).json({ success: false, message: 'Failed to delete.' });
                    res.json({ success: true });
                }
            );
        }
    );
});

// Lab Reservation POST (submit)
router.post('/lab-reservation', isAuthenticated, isUser, (req, res) => {
    const { lab_room, computer_number, date, purpose, time_start, time_end } = req.body;
    let time_slot = req.body.time_slot || '';

    if (!time_slot && time_start && time_end) {
        const to12h = (t) => {
            const [h, m] = t.split(':').map(Number);
            const ampm = h >= 12 ? 'PM' : 'AM';
            const hour = h % 12 || 12;
            return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
        };
        time_slot = `${to12h(time_start)} – ${to12h(time_end)}`;
    }

    if (!lab_room || !computer_number || !date || !time_slot || !purpose) {
        req.session.toast = { type: 'error', message: 'Please fill in all required fields.' };
        return res.redirect('/reservation');
    }

    const start = (time_start || '').trim();
    const end = (time_end || '').trim();

    db.get(`SELECT enabled, message FROM reservation_settings WHERE id = 1`, (setErr, settings) => {
        if (setErr) {
            req.session.toast = { type: 'error', message: 'Reservation failed. Try again.' };
            return res.redirect('/reservation');
        }
        if (settings && Number(settings.enabled) === 0) {
            req.session.toast = { type: 'error', message: settings.message || 'Reservations are currently unavailable.' };
            return res.redirect('/reservation');
        }

        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        if (date < today) {
            req.session.toast = { type: 'error', message: 'You cannot book a reservation in the past.' };
            return res.redirect('/reservation');
        }
        const bookingDate = new Date(`${date}T00:00:00`);
        if (bookingDate.getDay() === 0) {
            req.session.toast = { type: 'error', message: 'Reservations are not allowed on Sundays.' };
            return res.redirect('/reservation');
        }
        if (start && (start < '08:00' || start > '20:00')) {
            req.session.toast = { type: 'error', message: 'Reservation time must be between 8:00 AM and 8:00 PM only.' };
            return res.redirect('/reservation');
        }
        if (end && end > '20:00') {
            req.session.toast = { type: 'error', message: 'Reservation end time must not exceed 8:00 PM.' };
            return res.redirect('/reservation');
        }
        if (date === today && start) {
            const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            if (start <= currentHHMM) {
                req.session.toast = { type: 'error', message: 'That time has already passed. Please choose a future time.' };
                return res.redirect('/reservation');
            }
        }

        db.get(
            `SELECT id FROM sitin_sessions WHERE user_id = ? AND status = 'active'`,
            [req.session.user.id],
            (activeErr, activeSession) => {
            if (activeErr) {
                req.session.toast = { type: 'error', message: 'Reservation failed. Try again.' };
                return res.redirect('/reservation');
            }
            if (activeSession) {
                req.session.toast = { type: 'error', message: 'You currently have an active sit-in session. Please finish it before reserving.' };
                return res.redirect('/reservation');
            }

            db.get(
                `SELECT id FROM reservations
                 WHERE user_id = ? AND date = ? AND status IN ('pending', 'approved')`,
                [req.session.user.id, date],
                (ownResErr, ownReservation) => {
                    if (ownResErr) {
                        req.session.toast = { type: 'error', message: 'Reservation failed. Try again.' };
                        return res.redirect('/reservation');
                    }
                    if (ownReservation) {
                        req.session.toast = { type: 'error', message: 'You already have a pending or approved reservation on this date.' };
                        return res.redirect('/reservation');
                    }

                    const overlapQuery = `
                        SELECT id FROM reservations
                        WHERE lab_room = ? AND computer_number = ? AND date = ?
                          AND status IN ('pending', 'approved', 'sitting_in')
                          AND (
                            (? != '' AND ? != '' AND COALESCE(time_start, '') != '' AND COALESCE(time_end, '') != ''
                             AND time_start < ? AND time_end > ?)
                            OR (? = '' OR ? = '' OR COALESCE(time_start, '') = '' OR COALESCE(time_end, '') = '')
                          )
                        LIMIT 1
                    `;

                    db.get(
                        overlapQuery,
                        [lab_room, computer_number, date, start, end, end, start, start, end],
                        (conflictErr, conflict) => {
                            if (conflictErr) {
                                req.session.toast = { type: 'error', message: 'Reservation failed. Try again.' };
                                return res.redirect('/reservation');
                            }
                            if (conflict) {
                                req.session.toast = { type: 'error', message: `PC-${String(computer_number).padStart(2, '0')} in Lab ${lab_room} is already reserved for that date/time.` };
                                return res.redirect('/reservation');
                            }

                            db.run(
                                `INSERT INTO reservations (user_id, lab_room, computer_number, date, time_slot, time_start, time_end, purpose, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                                [req.session.user.id, lab_room, computer_number, date, time_slot, start || null, end || null, purpose],
                                function (err) {
                                    if (err) {
                                        req.session.toast = { type: 'error', message: 'Reservation failed. Try again.' };
                                        return res.redirect('/reservation');
                                    }

                                    const u = req.session.user;
                                    db.run(
                                        `INSERT INTO admin_notifications (message, type, related_id) VALUES (?, ?, ?)`,
                                        [`New lab reservation from ${u.first_name} ${u.last_name} (${u.id_number}) — Lab ${lab_room}, PC-${String(computer_number).padStart(2, '0')}, ${date} at ${time_slot}.`, 'reservation', this.lastID]
                                    );

                                    req.session.toast = {
                                        type: 'success',
                                        message: `Reservation for Lab ${lab_room} PC-${String(computer_number).padStart(2, '0')} on ${date} submitted! Awaiting approval.`
                                    };
                                    res.redirect('/reservation');
                                }
                            );
                        }
                    );
                }
            );
            }
        );
    });
});

// Cancel reservation (user-owned only)
router.post('/reservation/:id/cancel', isAuthenticated, isUser, (req, res) => {
    const reservationId = req.params.id;
    db.get(
        `SELECT * FROM reservations WHERE id = ? AND user_id = ?`,
        [reservationId, req.session.user.id],
        (err, reservation) => {
            if (err || !reservation) {
                req.session.toast = { type: 'error', message: 'Reservation not found.' };
                return res.redirect('/reservation');
            }
            if (!['pending', 'approved'].includes(reservation.status)) {
                req.session.toast = { type: 'error', message: 'Only pending or approved reservations can be cancelled.' };
                return res.redirect('/reservation');
            }
            db.run(`UPDATE reservations SET status = 'cancelled', message = 'Cancelled by student.' WHERE id = ?`, [reservationId], (upErr) => {
                if (upErr) req.session.toast = { type: 'error', message: 'Failed to cancel reservation.' };
                else req.session.toast = { type: 'success', message: 'Reservation cancelled.' };
                res.redirect('/reservation');
            });
        }
    );
});

// Get PC status for a lab (JSON, for AJAX)
router.get('/lab-computers/:lab_room', isAuthenticated, (req, res) => {
    db.all(
        `SELECT lc.computer_number, lc.status,
                r.id as reservation_id, r.date, r.time_slot, r.user_id,
                u.first_name, u.last_name
         FROM lab_computers lc
         LEFT JOIN reservations r ON r.lab_room = lc.lab_room
             AND r.computer_number = lc.computer_number
             AND r.status = 'approved'
             AND r.date = date('now','localtime')
         LEFT JOIN users u ON r.user_id = u.id
         WHERE lc.lab_room = ?
         ORDER BY lc.computer_number`,
        [req.params.lab_room],
        (err, computers) => {
            res.json(computers || []);
        }
    );
});

// Notifications JSON
router.get('/notifications', isAuthenticated, isUser, (req, res) => {
    db.all(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, [req.session.user.id], (err, notifications) => res.json(notifications || []));
});
router.post('/notifications/read', isAuthenticated, isUser, (req, res) => {
    db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`, [req.session.user.id], () => res.json({ success: true }));
});

// Leaderboard page - redirects to leaderboard-index
router.get('/leaderboard', isAuthenticated, (req, res) => {
    res.redirect('/leaderboard-index');
});

// API: Leaderboard JSON (public, no auth required)
router.get('/api/leaderboard', (req, res) => {
    getLeaderboardData(db)
        .then(({ students, labs }) => res.json({ students, labs }))
        .catch(() => res.status(500).json({ students: [], labs: [] }));
});

// Leaderboard Index
router.get('/leaderboard-index', isAuthenticated, (req, res) => {
    getLeaderboardData(db)
        .then(({ students, labs }) => res.render('pages/leaderboard-index', { students, labs }))
        .catch(() => res.render('pages/leaderboard-index', { students: [], labs: [] }));
});

module.exports = router;