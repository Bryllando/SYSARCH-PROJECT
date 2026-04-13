const express = require('express');
const router = express.Router();
const db = require('../database/database');
const {
    generateStudentRecommendation,
    generateAdminInsights,
    generateStudentTips
} = require('../services/ai-engine');
const LOG_THROTTLE_MS = 60 * 1000;
const errorLogCache = new Map();

function requireSession(req, res) {
    if (!req.session || !req.session.user) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return false;
    }
    return true;
}

function logThrottledError(scope, err) {
    const message = String(err && err.message ? err.message : 'Unknown error');
    const key = `${scope}:${message}`;
    const now = Date.now();
    const last = errorLogCache.get(key) || 0;
    if (now - last >= LOG_THROTTLE_MS) {
        console.error(`${scope} error:`, message);
        errorLogCache.set(key, now);
    }
}

router.post('/api/ai/student-recommendation', async (req, res) => {
    if (!requireSession(req, res)) return;
    if (req.session.user.role !== 'user') {
        return res.status(403).json({ success: false, message: 'Student access required.' });
    }
    try {
        const force = Boolean(req.body && req.body.refresh);
        const result = await generateStudentRecommendation(db, req.session.user.id, force);
        return res.json({
            success: true,
            recommendation: result.data,
            message: result.fallback ? 'Using saved recommendation' : null,
            meta: {
                cached: result.cached,
                fallback: Boolean(result.fallback),
                generated_at: result.generatedAt,
                minutes_ago: result.minutesAgo
            }
        });
    } catch (err) {
        logThrottledError('student-recommendation', err);
        return res.status(500).json({ success: false, message: 'AI is temporarily unavailable. Please try again later.' });
    }
});

router.post('/api/ai/student-tips', async (req, res) => {
    if (!requireSession(req, res)) return;
    if (req.session.user.role !== 'user') {
        return res.status(403).json({ success: false, message: 'Student access required.' });
    }
    try {
        const force = Boolean(req.body && req.body.refresh);
        const result = await generateStudentTips(db, req.session.user.id, force);
        return res.json({
            success: true,
            tips: result.data,
            message: result.fallback ? 'Using saved recommendation' : null,
            meta: {
                cached: result.cached,
                fallback: Boolean(result.fallback),
                generated_at: result.generatedAt,
                minutes_ago: result.minutesAgo
            }
        });
    } catch (err) {
        logThrottledError('student-tips', err);
        return res.status(500).json({ success: false, message: 'AI is temporarily unavailable. Please try again later.' });
    }
});

router.post('/api/ai/admin-insights', async (req, res) => {
    if (!requireSession(req, res)) return;
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required.' });
    }
    try {
        const force = Boolean(req.body && req.body.refresh);
        const result = await generateAdminInsights(db, force);
        return res.json({
            success: true,
            insights: result.data,
            message: result.fallback ? 'Using saved recommendation' : null,
            meta: {
                cached: result.cached,
                fallback: Boolean(result.fallback),
                generated_at: result.generatedAt,
                minutes_ago: result.minutesAgo
            }
        });
    } catch (err) {
        logThrottledError('admin-insights', err);
        return res.status(500).json({ success: false, message: 'AI is temporarily unavailable. Please try again later.' });
    }
});

module.exports = router;
