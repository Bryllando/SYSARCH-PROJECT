require('dotenv').config();
const express = require('express');
const express_layouts = require('express-ejs-layouts');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const db = require('./database/database');
const { getLeaderboardData } = require('./services/leaderboard');

const app = express();
const port = 3000;

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── Session ───────────────────────────────────────────────────────────────────
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: './database' }),
    secret: process.env.SESSION_SECRET || 'ccs-sitin-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

// ─── View engine ───────────────────────────────────────────────────────────────
app.use(express_layouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layouts/main');
app.use(express.static(path.join(__dirname, 'public')));

// ─── Global middleware ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.layout = req.session.user ? 'layouts/dashboard' : 'layouts/main';
    res.locals.toast = req.session.toast || null;
    if (req.session.toast) delete req.session.toast;
    next();
});

// ─── Public homepage ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    if (req.session.user) {
        return req.session.user.role === 'admin'
            ? res.redirect('/admin')
            : res.redirect('/dashboard');
    }
    res.render('pages/index');
});

// ─── Public Leaderboard PAGE (no auth required) ───────────────────────────────
app.get('/leaderboard-index', (req, res) => {
    getLeaderboardData(db)
        .then(({ students, labs }) => res.render('pages/leaderboard-index', { students, labs }))
        .catch(() => res.render('pages/leaderboard-index', { students: [], labs: [] }));
});

// ─── Public About page ────────────────────────────────────────────────────────
app.get('/about', (req, res) => {
    res.render('pages/about');
});

// ─── Public Community page ────────────────────────────────────────────────────
app.get('/community', (req, res) => {
    res.render('pages/community');
});

// ─── Public Leaderboard API (no auth required) - handled by user.js

// ─── Admin: All announcement comments (for feedback page comments tab) ────────
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
    `, (err, comments) => {
        if (err) return res.json([]);
        res.json(comments || []);
    });
});

// ─── Auth, User, Admin routes ─────────────────────────────────────────────────
app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/admin', adminRoutes);
app.use('/', aiRoutes);

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));