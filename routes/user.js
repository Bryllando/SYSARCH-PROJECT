const express = require('express');
const router = express.Router();
const { isAuthenticated, isUser } = require('../middleware/auth');
const db = require('../database/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

function containsVulgar(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return VULGAR_WORDS.some(word => lower.includes(word));
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
        db.all(`SELECT a.*, u.first_name, u.last_name FROM announcements a LEFT JOIN users u ON a.admin_id = u.id ORDER BY a.created_at DESC LIMIT 15`, (err2, announcements) => {
            res.render('pages/dashboard', { announcements: announcements || [] });
        });
    });
});

// Edit Profile GET
router.get('/profile', isAuthenticated, isUser, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, userData) => {
        if (userData) req.session.user = { ...req.session.user, ...userData };
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
    db.all(`SELECT * FROM sitin_sessions WHERE user_id = ? ORDER BY time_in DESC`, [req.session.user.id], (err, sessions) => {
        res.render('pages/history', { sessions: sessions || [] });
    });
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

    const ratingVal = parseInt(rating) || 0;

    db.run(
        `INSERT INTO feedback (user_id, session_id, message, rating) VALUES (?, ?, ?, ?)`,
        [req.session.user.id, session_id || null, message.trim(), ratingVal],
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
    db.all(
        `SELECT * FROM reservations WHERE user_id = ? AND computer_number IS NOT NULL ORDER BY created_at DESC`,
        [req.session.user.id],
        (err, reservations) => {
            res.render('pages/reservation', { reservations: reservations || [] });
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

    db.get(
        `SELECT id FROM reservations WHERE lab_room = ? AND computer_number = ? AND date = ? AND status = 'approved'`,
        [lab_room, computer_number, date],
        (err, conflict) => {
            if (conflict) {
                req.session.toast = { type: 'error', message: `PC-${String(computer_number).padStart(2, '0')} in Lab ${lab_room} is already reserved on ${date}.` };
                return res.redirect('/reservation');
            }

            db.run(
                `INSERT INTO reservations (user_id, lab_room, computer_number, date, time_slot, purpose, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                [req.session.user.id, lab_room, computer_number, date, time_slot, purpose],
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
            const sessionsScore = (sessionsUsed / 30) * 50;
            const sitinScore = Math.min(s.total_sitins * 1, 30);
            const taskScore = Math.min(s.feedback_count * 4, 20);
            s.points = Math.round(sessionsScore + sitinScore + taskScore);
            return s;
        }).sort((a, b) => b.points - a.points);
        res.json(ranked);
    });
});

// Leaderboard Index
router.get('/leaderboard-index', isAuthenticated, (req, res) => {
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
            const sessionsScore = (sessionsUsed / 30) * 50;
            const sitinScore = Math.min(s.total_sitins * 1, 30);
            const taskScore = Math.min(s.feedback_count * 4, 20);
            s.points = Math.round(sessionsScore + sitinScore + taskScore);
            return s;
        }).sort((a, b) => b.points - a.points);
        res.render('pages/leaderboard-index', { students: ranked });
    });
});

module.exports = router;