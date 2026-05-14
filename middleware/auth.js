// Middleware: must be logged in
function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    console.log(`[AUTH] Unauthorized access attempt to ${req.originalUrl} - Redirecting to /login`);
    res.redirect('/login');
}

// Middleware: must be admin
function isAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    console.log(`[AUTH] Forbidden admin access to ${req.originalUrl} for user: ${req.session?.user?.id_number} (Role: ${req.session?.user?.role})`);
    res.status(403).redirect('/dashboard');
}

// Middleware: must be regular user
function isUser(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'user') {
        return next();
    }
    console.log(`[AUTH] Forbidden user access to ${req.originalUrl} for user: ${req.session?.user?.id_number} (Role: ${req.session?.user?.role})`);
    res.status(403).redirect('/admin');
}

module.exports = { isAuthenticated, isAdmin, isUser };