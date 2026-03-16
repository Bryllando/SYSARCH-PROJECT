const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/database');

// GET Login — if already logged in, redirect to their dashboard
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
            course: user.course,
            year_level: user.year_level,
            email: user.email,
            role: user.role,
            remaining_sessions: user.remaining_sessions
        };

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
    const { id_number, last_name, first_name, middle_initial, course, section, email, password } = req.body;

    if (!/^\d{8}$/.test(id_number)) {
        return res.render('pages/register', {
            messages: [{ type: 'error', text: 'ID Number must be exactly 8 digits.' }]
        });
    }

    try {
        const hashed = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (id_number, last_name, first_name, middle_initial, course, year_level, email, password)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id_number, last_name, first_name, middle_initial || '', course, section, email, hashed],
            function (err) {
                if (err) {
                    const msg = err.message.includes('UNIQUE')
                        ? 'ID number or email already registered.'
                        : 'Registration failed. Please try again.';
                    return res.render('pages/register', {
                        messages: [{ type: 'error', text: msg }]
                    });
                }
                res.redirect('/login');
            }
        );
    } catch (e) {
        res.render('pages/register', {
            messages: [{ type: 'error', text: 'An error occurred. Please try again.' }]
        });
    }
});

// Logout — destroy session completely, clear the cookie, go back to guest homepage
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) console.error('Session destroy error:', err);
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

module.exports = router;