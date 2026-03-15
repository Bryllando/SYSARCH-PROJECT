// Middleware: must be logged in
function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) return next();
    res.redirect('/login');
}

// Middleware: must be admin
function isAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).redirect('/dashboard');
}

// Middleware: must be regular user
function isUser(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'user') return next();
    res.status(403).redirect('/admin');
}

module.exports = { isAuthenticated, isAdmin, isUser };