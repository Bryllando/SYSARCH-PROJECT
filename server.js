const express = require('express');
const express_layouts = require('express-ejs-layouts');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');

const app = express();
const port = 3000;

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session setup
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: './database' }),
    secret: 'ccs-sitin-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
}));

// Make session user available in all EJS views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// EJS + Layouts
app.use(express_layouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('layout', 'layouts/main');

// Public routes
// Sa homepage route, pass empty defaults
app.get('/', (req, res) => {
    res.render('pages/index', {
        sessions: [],
        announcements: [],
        messages: []
    });
});
app.get('/about', (req, res) => res.render('pages/about'));


// seed-admin route (for testing)
app.get('/create-admin', async (req, res) => {
    const bcrypt = require('bcryptjs');
    const db = require('./database/database');
    const hashed = await bcrypt.hash('Admin@1234', 10);
    db.run(
        `INSERT OR IGNORE INTO users (id_number, last_name, first_name, middle_initial, course, year_level, email, password, role)
         VALUES ('0000-00000','Admin','CCS','','BSCS',1,'admin@ccs.edu',?,'admin')`,
        [hashed],
        () => res.send('Admin created! Delete this route now.')
    );
});

// Auth routes (login, register, logout)
app.use('/', authRoutes);

// User dashboard routes
app.use('/', userRoutes);

// Admin routes
app.use('/admin', adminRoutes);

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});