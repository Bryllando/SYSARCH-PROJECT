const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/database');
const { generateStudentRecommendation } = require('../services/ai-engine');

// GET Login
router.get('/login', (req, res) => {
    if (req.session.user) {
        return req.session.user.role === 'admin'
            ? res.redirect('/admin')
            : res.redirect('/dashboard');
    }
    res.render('pages/login', { messages: [] });
});

// POST Login
router.post('/login', (req, res) => {
    const { id_number, password } = req.body;
    db.get('SELECT * FROM users WHERE id_number = ?', [id_number], async (err, user) => {
        if (err || !user) {
            return res.render('pages/login', {
                messages: [{ type: 'error', text: 'Invalid ID number or password.' }]
            });
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.render('pages/login', {
                messages: [{ type: 'error', text: 'Invalid ID number or password.' }]
            });
        }
        req.session.user = {
            id: user.id,
            id_number: user.id_number,
            first_name: user.first_name,
            last_name: user.last_name,
            middle_initial: user.middle_initial,
            course: user.course,
            year_level: user.year_level,
            email: user.email,
            role: user.role,
            remaining_sessions: user.remaining_sessions,
            address: user.address || '',
            profile_picture: user.profile_picture || ''
        };

        // ── Flash toast for the next page ──────────────────────────────────────
        req.session.toast = {
            type: 'success',
            message: 'Welcome back, ' + user.first_name + '! You are now logged in.'
        };

        if (user.role === 'user') {
            generateStudentRecommendation(db, user.id, false).catch(() => { });
        }

        return user.role === 'admin'
            ? res.redirect('/admin')
            : res.redirect('/dashboard');
    });
});

// GET Register
router.get('/register', (req, res) => {
    res.render('pages/register', { messages: [] });
});

// POST Register
router.post('/register', async (req, res) => {
    const { id_number, last_name, first_name, middle_initial, course, section, email, password, confirm_password, confirmPassword, address } = req.body;
    if (!/^\d{8}$/.test(id_number)) {
        return res.render('pages/register', {
            messages: [{ type: 'error', text: 'ID Number must be exactly 8 digits.' }]
        });
    }
    if (!password || password.length < 6) {
        return res.render('pages/register', {
            messages: [{ type: 'error', text: 'Password must be at least 6 characters.' }]
        });
    }
    const confirmValue = (confirm_password || confirmPassword || '').trim();
    if (confirmValue && password !== confirmValue) {
        return res.render('pages/register', {
            messages: [{ type: 'error', text: 'Passwords do not match.' }]
        });
    }
    if (!email || !email.includes('@')) {
        return res.render('pages/register', {
            messages: [{ type: 'error', text: 'Invalid email format.' }]
        });
    }
    if (!['1', '2', '3', '4', 1, 2, 3, 4].includes(section)) {
        return res.render('pages/register', {
            messages: [{ type: 'error', text: 'Please select a valid year level.' }]
        });
    }
    try {
        const hashed = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (id_number, last_name, first_name, middle_initial, course, year_level, email, password, address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id_number, last_name, first_name, middle_initial || '', course, section, email, hashed, address || ''],
            function (err) {
                if (err) {
                    const msg = err.message.includes('UNIQUE')
                        ? 'ID number or email already registered.'
                        : 'Registration failed. Please try again.';
                    return res.render('pages/register', { messages: [{ type: 'error', text: msg }] });
                }

                // ── Flash toast for the login page ─────────────────────────────
                req.session.toast = {
                    type: 'success',
                    message: 'Account created successfully! Please log in to continue.'
                };

                res.redirect('/login');
            }
        );
    } catch (e) {
        res.render('pages/register', {
            messages: [{ type: 'error', text: 'An error occurred. Please try again.' }]
        });
    }
});

// Forgot Password (interaction endpoint parity)
router.post('/forgot-password', (req, res) => {
    const { forgotId, forgotEmail } = req.body;
    if (!forgotId || !forgotEmail) {
        return res.json({ success: false, message: 'Please fill in all fields.' });
    }
    db.get(
        'SELECT id FROM users WHERE id_number = ? AND email = ?',
        [forgotId, forgotEmail],
        (err, user) => {
            if (err) return res.json({ success: false, message: 'Unable to process request right now.' });
            if (!user) return res.json({ success: false, message: 'No matching account found for the provided ID and email.' });
            return res.json({
                success: true,
                message: 'If your account is valid, reset instructions have been sent.'
            });
        }
    );
});

// Logout
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) console.error('Session destroy error:', err);
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

module.exports = router;