require('dotenv').config();
const express = require('express');
const express_layouts = require('express-ejs-layouts');
const cookieSession = require('cookie-session');
const path = require('path');
const { db, initDb } = require('./database/database');
const { getLeaderboardData } = require('./services/leaderboard');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Database
initDb().catch(console.error);

app.set('trust proxy', 1);

// ─── Session (Cookie Session for Vercel/Serverless) ───────────────────────────
// This stores session data directly in the cookie, ensuring it persists across
// different serverless lambda instances.
app.use(cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'ccs-sitin-secret-key'],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    httpOnly: true
}));

// ─── View engine ───────────────────────────────────────────────────────────────
app.use(express_layouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layouts/main');
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── Global middleware ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.layout = req.session.user ? 'layouts/dashboard' : 'layouts/main';
    res.locals.toast = req.session.toast || null;
    if (req.session.toast) delete req.session.toast;
    next();
});

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');

// ─── Public homepage ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    if (req.session.user) {
        return req.session.user.role === 'admin'
            ? res.redirect('/admin')
            : res.redirect('/dashboard');
    }
    res.render('pages/index');
});

app.get('/leaderboard-index', (req, res) => {
    getLeaderboardData(db)
        .then(({ students, labs }) => res.render('pages/leaderboard-index', { students, labs }))
        .catch(() => res.render('pages/leaderboard-index', { students: [], labs: [] }));
});

app.get('/about', (req, res) => res.render('pages/about'));
app.get('/community', (req, res) => res.render('pages/community'));

app.get('/admin/all-comments', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json([]);
    }
    db.all(`
        SELECT c.id, c.message, c.created_at,
               u.first_name, u.last_name, u.id_number, u.profile_picture, u.course,
               a.message as announcement_message
        FROM announcement_comments c
        JOIN users u ON c.user_id = u.id
        JOIN announcements a ON c.announcement_id = a.id
        ORDER BY c.created_at DESC
        LIMIT 200
    `, [], (err, comments) => {
        if (err) return res.json([]);
        res.json(comments || []);
    });
});

app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/admin', adminRoutes);
app.use('/', aiRoutes);

// Export for Vercel, listen for local
app.listen(port, () => console.log(`Server running on port ${port}`));

module.exports = app;
