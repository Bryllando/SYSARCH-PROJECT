const express = require('express');
const express_layouts = require('express-ejs-layouts');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');

const app = express();
const port = 3000;

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── Session ───────────────────────────────────────────────────────────────────
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: './database' }),
    secret: 'ccs-sitin-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// ─── View engine ───────────────────────────────────────────────────────────────
app.use(express_layouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layouts/main');   // global fallback (guest layout)
app.use(express.static(path.join(__dirname, 'public')));

// ─── Global middleware: expose user, toast, and choose layout ──────────────────
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.layout = req.session.user ? 'layouts/dashboard' : 'layouts/main';

    // Flash toast: read once then clear from session
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

// ─── Auth, User, Admin routes ─────────────────────────────────────────────────
app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/admin', adminRoutes);

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
// // seed-admin route (for testing)
// app.get('/create-admin', async (req, res) => {
//     const bcrypt = require('bcryptjs');
//     const db = require('./database/database');
//     const hashed = await bcrypt.hash('Admin@1234', 10);
//     db.run(
//         `INSERT OR IGNORE INTO users (id_number, last_name, first_name, middle_initial, course, year_level, email, password, role)
//          VALUES ('0000-00000','Admin','CCS','','BSCS',1,'admin@ccs.edu',?,'admin')`,
//         [hashed],
//         () => res.send('Admin created! Delete this route now.')
//     );
// });