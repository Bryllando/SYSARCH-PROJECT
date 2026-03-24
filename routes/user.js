const express = require('express');
const router = express.Router();
const { isAuthenticated, isUser } = require('../middleware/auth');
const db = require('../database/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ─── Multer setup ─────────────────────────────────────────────────────────────
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
        db.all(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 10`, (err2, announcements) => {
            if (userData) req.session.user = { ...req.session.user, ...userData };
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
            if (err) {
                return res.render('pages/profile', {
                    messages: [{ type: 'error', text: 'Update failed. Email may already be in use.' }]
                });
            }
            req.session.user = { ...req.session.user, first_name, last_name, middle_initial, course, year_level, email, address };
            res.render('pages/profile', { messages: [{ type: 'success', text: 'Profile updated successfully!' }] });
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
            res.render('pages/profile', { messages: [{ type: 'success', text: 'Profile picture updated successfully!' }] });
        });
    });
});

// Sit-in History
router.get('/history', isAuthenticated, isUser, (req, res) => {
    db.all(`SELECT * FROM sitin_sessions WHERE user_id = ? ORDER BY time_in DESC`,
        [req.session.user.id], (err, sessions) => {
            res.render('pages/history', { sessions: sessions || [] });
        });
});

// Submit Feedback
router.post('/feedback', isAuthenticated, isUser, (req, res) => {
    const { session_id, message, rating } = req.body;
    db.run(
        `INSERT INTO feedback (user_id, session_id, message, rating) VALUES (?, ?, ?, ?)`,
        [req.session.user.id, session_id || null, message, rating || 0],
        () => res.redirect('/history')
    );
});

// Reservation GET
router.get('/reservation', isAuthenticated, isUser, (req, res) => {
    db.all(`SELECT * FROM reservations WHERE user_id = ? ORDER BY created_at DESC`,
        [req.session.user.id], (err, reservations) => {
            res.render('pages/reservation', { reservations: reservations || [], messages: [] });
        });
});

// Reservation POST — build time_slot server-side from time_start + time_end
router.post('/reservation', isAuthenticated, isUser, (req, res) => {
    const { lab_room, date, purpose, time_start, time_end } = req.body;
    let time_slot = req.body.time_slot || '';

    // Build time_slot server-side if not provided by JS
    if (!time_slot && time_start && time_end) {
        const to12h = (t) => {
            const [h, m] = t.split(':').map(Number);
            const ampm = h >= 12 ? 'PM' : 'AM';
            const hour = h % 12 || 12;
            return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
        };
        time_slot = `${to12h(time_start)} – ${to12h(time_end)}`;
    }

    if (!lab_room || !date || !time_slot || !purpose) {
        db.all(`SELECT * FROM reservations WHERE user_id = ? ORDER BY created_at DESC`,
            [req.session.user.id], (err, reservations) => {
                res.render('pages/reservation', {
                    reservations: reservations || [],
                    messages: [{ type: 'error', text: 'Please fill in all required fields including time slot.' }]
                });
            });
        return;
    }

    db.run(
        `INSERT INTO reservations (user_id, lab_room, date, time_slot, purpose) VALUES (?, ?, ?, ?, ?)`,
        [req.session.user.id, lab_room, date, time_slot, purpose],
        (err) => {
            if (err) {
                db.all(`SELECT * FROM reservations WHERE user_id = ? ORDER BY created_at DESC`,
                    [req.session.user.id], (e2, reservations) => {
                        res.render('pages/reservation', {
                            reservations: reservations || [],
                            messages: [{ type: 'error', text: 'Reservation failed. Please try again.' }]
                        });
                    });
                return;
            }
            req.session.toast = { type: 'success', message: `Reservation for Lab ${lab_room} on ${date} submitted successfully!` };
            res.redirect('/reservation');
        }
    );
});

// Notifications JSON
router.get('/notifications', isAuthenticated, isUser, (req, res) => {
    db.all(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
        [req.session.user.id], (err, notifications) => res.json(notifications || []));
});

router.post('/notifications/read', isAuthenticated, isUser, (req, res) => {
    db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`,
        [req.session.user.id], () => res.json({ success: true }));
});

module.exports = router;