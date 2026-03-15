const express = require('express');
const router = express.Router();
const { isAuthenticated, isUser } = require('../middleware/auth');
const db = require('../database/database');

// User Dashboard
router.get('/dashboard', isAuthenticated, isUser, (req, res) => {
    res.set('layout', 'layouts/dashboard');
    // Fetch fresh user data (including remaining_sessions)
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, userData) => {
        db.all(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 10`, (err2, announcements) => {
            // Update session with fresh data
            if (userData) req.session.user = { ...req.session.user, ...userData };
            res.render('pages/dashboard', { announcements: announcements || [] });
        });
    });
});

// Edit Profile GET
router.get('/profile', isAuthenticated, isUser, (req, res) => {
    res.set('layout', 'layouts/dashboard');
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, userData) => {
        if (userData) req.session.user = { ...req.session.user, ...userData };
        res.render('pages/profile', { messages: [] });
    });
});

// Edit Profile POST
router.post('/profile', isAuthenticated, isUser, (req, res) => {
    res.set('layout', 'layouts/dashboard');
    const { first_name, last_name, middle_initial, course, year_level, email } = req.body;
    db.run(
        `UPDATE users SET first_name=?, last_name=?, middle_initial=?, course=?, year_level=?, email=? WHERE id=?`,
        [first_name, last_name, middle_initial || '', course, year_level, email, req.session.user.id],
        function (err) {
            if (err) {
                return res.render('pages/profile', {
                    messages: [{ type: 'error', text: 'Update failed. Email may already be in use.' }]
                });
            }
            req.session.user = { ...req.session.user, first_name, last_name, middle_initial, course, year_level, email };
            res.render('pages/profile', {
                messages: [{ type: 'success', text: 'Profile updated successfully!' }]
            });
        }
    );
});

// Sit-in History
router.get('/history', isAuthenticated, isUser, (req, res) => {
    res.set('layout', 'layouts/dashboard');
    db.all(`SELECT * FROM sitin_sessions WHERE user_id = ? ORDER BY time_in DESC`, [req.session.user.id], (err, sessions) => {
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
    res.set('layout', 'layouts/dashboard');
    db.all(`SELECT * FROM reservations WHERE user_id = ? ORDER BY created_at DESC`, [req.session.user.id], (err, reservations) => {
        res.render('pages/reservation', { reservations: reservations || [] });
    });
});

// Reservation POST
router.post('/reservation', isAuthenticated, isUser, (req, res) => {
    const { lab_room, date, time_slot, purpose } = req.body;
    db.run(
        `INSERT INTO reservations (user_id, lab_room, date, time_slot, purpose) VALUES (?, ?, ?, ?, ?)`,
        [req.session.user.id, lab_room, date, time_slot, purpose],
        () => res.redirect('/reservation')
    );
});

// Notifications JSON
router.get('/notifications', isAuthenticated, isUser, (req, res) => {
    db.all(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
        [req.session.user.id], (err, notifications) => res.json(notifications || []));
});

router.post('/notifications/read', isAuthenticated, isUser, (req, res) => {
    db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`, [req.session.user.id], () => res.json({ success: true }));
});

module.exports = router;