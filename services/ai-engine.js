const { getLeaderboardData } = require('./leaderboard');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-3-4b-it:free';

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function parseJson(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

function toIsoOrNull(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function minutesBetween(a, b) {
    const d1 = new Date(a).getTime();
    const d2 = new Date(b).getTime();
    if (Number.isNaN(d1) || Number.isNaN(d2) || d2 <= d1) return 0;
    return Math.round((d2 - d1) / 60000);
}

function hoursBetween(a, b) {
    const m = minutesBetween(a, b);
    return Number((m / 60).toFixed(2));
}

function nowIso() {
    return new Date().toISOString();
}

function minutesAgo(isoDate) {
    if (!isoDate) return null;
    const ms = Date.now() - new Date(isoDate).getTime();
    if (Number.isNaN(ms) || ms < 0) return null;
    return Math.floor(ms / 60000);
}

function extractJson(raw) {
    if (!raw) return null;
    // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    // Try to find JSON object boundaries
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    return parseJson(cleaned);
}

async function callAI({ systemPrompt, payload }) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing. Set it in your .env file.');

    const body = {
        model: OPENROUTER_MODEL,
        max_tokens: 1500,
        temperature: 0.4,
        messages: [
            { role: 'user', content: systemPrompt + '\n\nHere is the data to analyze:\n' + JSON.stringify(payload) }
        ]
    };

    const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'CCS SitIn Monitoring System'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const txt = await response.text().catch(() => '');
        const err = new Error(`OpenRouter API error ${response.status}`);
        err.httpStatus = response.status;
        err.raw = txt;
        throw err;
    }

    const data = await response.json();
    const text = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content || ''
        : '';
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') {
        const err = new Error('AI returned invalid JSON');
        err.rawText = text;
        throw err;
    }
    return parsed;
}

async function getLabAnalytics(db) {
    const rows = await dbAll(
        db,
        `SELECT lab_room, user_id, behavior_rating, time_in, COALESCE(time_out, time_end) as time_end
         FROM sitin_sessions
         WHERE lab_room IS NOT NULL AND lab_room != ''`
    );
    const map = new Map();
    const hourMap = new Map();
    rows.forEach((r) => {
        if (!map.has(r.lab_room)) {
            map.set(r.lab_room, { lab_name: `Lab ${r.lab_room}`, total_sitins: 0, total_hours: 0, ratings: [], users: new Set() });
        }
        const item = map.get(r.lab_room);
        item.total_sitins += 1;
        item.total_hours += hoursBetween(r.time_in, r.time_end);
        item.users.add(r.user_id);
        if (r.behavior_rating !== null && r.behavior_rating !== undefined) item.ratings.push(Number(r.behavior_rating) || 0);

        const h = new Date(r.time_in).getHours();
        if (!Number.isNaN(h)) hourMap.set(h, (hourMap.get(h) || 0) + 1);
    });
    const labs = Array.from(map.values()).map((l) => {
        const average_rating = l.ratings.length ? Number((l.ratings.reduce((a, b) => a + b, 0) / l.ratings.length).toFixed(2)) : 0;
        const unique_users = l.users.size;
        const computed_score = Number(((l.total_sitins * 0.25) + (l.total_hours * 0.25) + (average_rating * 0.25) + (unique_users * 0.25)).toFixed(2));
        return {
            lab_name: l.lab_name,
            total_sitins: l.total_sitins,
            total_hours: Number(l.total_hours.toFixed(2)),
            average_rating,
            unique_users,
            computed_score
        };
    }).sort((a, b) => b.computed_score - a.computed_score);

    const peak = Array.from(hourMap.entries()).sort((a, b) => b[1] - a[1])[0] || null;
    return {
        labs,
        top_lab: labs[0] || null,
        low_usage_labs: labs.filter(l => l.total_sitins <= 1),
        peak_usage_hour: peak ? `${peak[0]}:00` : null
    };
}

async function getFeedbackAnalytics(db) {
    const rows = await dbAll(db, `SELECT user_id, message, rating, created_at FROM feedback ORDER BY created_at DESC`);
    const total = rows.length;
    const rated = rows.filter(r => Number(r.rating) > 0);
    const average_rating = rated.length ? Number((rated.reduce((s, r) => s + Number(r.rating || 0), 0) / rated.length).toFixed(2)) : 0;
    const satisfaction_rate = rated.length ? Number((((rated.filter(r => Number(r.rating) >= 4).length) / rated.length) * 100).toFixed(2)) : 0;
    const buckets = { excellent: 0, very_good: 0, good: 0, fair: 0, poor: 0, no_rating: 0 };
    rows.forEach((r) => {
        const v = Number(r.rating || 0);
        if (v === 5) buckets.excellent += 1;
        else if (v === 4) buckets.very_good += 1;
        else if (v === 3) buckets.good += 1;
        else if (v === 2) buckets.fair += 1;
        else if (v === 1) buckets.poor += 1;
        else buckets.no_rating += 1;
    });
    const byStudent = new Map();
    rows.forEach((r) => byStudent.set(r.user_id, (byStudent.get(r.user_id) || 0) + 1));
    const mostActive = Array.from(byStudent.entries()).sort((a, b) => b[1] - a[1])[0] || null;

    return {
        total_feedback_count: total,
        satisfaction_rate_percentage: satisfaction_rate,
        average_rating_score: average_rating,
        rating_distribution: buckets,
        most_active_feedback_student_id: mostActive ? mostActive[0] : null,
        recent_feedback_messages_anonymized: rows.slice(0, 5).map((r, i) => ({ alias: `Student-${i + 1}`, rating: r.rating, message: String(r.message || '').slice(0, 180) }))
    };
}

async function getStudentContext(db, userId) {
    const student = await dbGet(db, `SELECT id, first_name, last_name, course, year_level, tidy_points_raw, task_completion_rate FROM users WHERE id = ?`, [userId]);
    if (!student) return null;
    const sessions = await dbAll(
        db,
        `SELECT id, lab_room as lab_name, purpose, time_in, time_out, time_end
         FROM sitin_sessions
         WHERE user_id = ?
         ORDER BY time_in DESC
         LIMIT 10`,
        [userId]
    );
    const normalizedSessions = sessions.map((s) => {
        const end = s.time_out || s.time_end;
        return {
            date: s.time_in,
            lab_name: s.lab_name,
            time_in: s.time_in,
            time_out: end || null,
            duration_minutes: end ? minutesBetween(s.time_in, end) : 0,
            purpose: s.purpose || null
        };
    });
    const weekCountRow = await dbGet(db, `SELECT COUNT(*) as c FROM sitin_sessions WHERE user_id = ? AND datetime(time_in) >= datetime('now','-7 days')`, [userId]);
    const monthCountRow = await dbGet(db, `SELECT COUNT(*) as c FROM sitin_sessions WHERE user_id = ? AND datetime(time_in) >= datetime('now','-30 days')`, [userId]);
    const mostUsedLabRow = await dbGet(db, `SELECT lab_room, COUNT(*) as c FROM sitin_sessions WHERE user_id = ? GROUP BY lab_room ORDER BY c DESC LIMIT 1`, [userId]);
    const avgDurationRow = await dbGet(
        db,
        `SELECT AVG((julianday(COALESCE(time_out, time_end)) - julianday(time_in)) * 24 * 60) as avg_mins
         FROM sitin_sessions
         WHERE user_id = ? AND time_in IS NOT NULL AND COALESCE(time_out, time_end) IS NOT NULL`,
        [userId]
    );
    const ownFeedback = await dbAll(db, `SELECT rating, message, created_at FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, [userId]);
    const activeSession = await dbGet(
        db,
        `SELECT id, lab_room, time_in, time_end FROM sitin_sessions WHERE user_id = ? AND status = 'active' ORDER BY time_in DESC LIMIT 1`,
        [userId]
    );

    const { students } = await getLeaderboardData(db);
    const me = students.find(s => s.id === userId) || null;
    const top5 = students.slice(0, 5).map((s) => ({ rank: s.rank, score: s.points, course: s.course }));
    const idx = students.findIndex(s => s.id === userId);
    const nextUp = idx > 0 ? students[idx - 1] : null;
    const gapToNext = nextUp && me ? Number((nextUp.points - me.points).toFixed(2)) : 0;

    return {
        student: {
            student_id: student.id,
            name: `${student.first_name} ${student.last_name}`,
            course: student.course,
            year_level: student.year_level
        },
        session_history_last_10: normalizedSessions,
        totals: {
            sessions_this_week: Number(weekCountRow?.c || 0),
            sessions_this_month: Number(monthCountRow?.c || 0),
            most_used_lab: mostUsedLabRow?.lab_room ? `Lab ${mostUsedLabRow.lab_room}` : null,
            average_session_duration_minutes: Number((avgDurationRow?.avg_mins || 0).toFixed(2))
        },
        leaderboard: {
            current_rank: me?.rank || null,
            current_score: me?.points || 0,
            tidy_points_raw: Number(student.tidy_points_raw || 0),
            tidy_points_lb: Number((Number(student.tidy_points_raw || 0) / 3).toFixed(2)),
            total_hours: me?.total_hours || 0,
            task_completion_rate: Number(student.task_completion_rate || 0),
            score_gap_to_next_rank_up: gapToNext,
            top5_students: top5,
            total_students: students.length
        },
        feedback_history: ownFeedback,
        current_active_session: activeSession ? {
            session_id: activeSession.id,
            lab_name: activeSession.lab_room ? `Lab ${activeSession.lab_room}` : null,
            time_in: activeSession.time_in,
            expected_time_out: activeSession.time_end || null
        } : null
    };
}

async function buildUnifiedContext(db, userId = null) {
    const labAnalytics = await getLabAnalytics(db);
    const feedbackAnalytics = await getFeedbackAnalytics(db);
    const leaderboard = await getLeaderboardData(db);
    const studentContext = userId ? await getStudentContext(db, userId) : null;
    return { student_context: studentContext, lab_analytics: labAnalytics, feedback_analytics: feedbackAnalytics, leaderboard_global: { top_5: leaderboard.students.slice(0, 5), total_students: leaderboard.students.length } };
}

async function getSourceLatestTimes(db, userId = null) {
    const lastSession = userId
        ? await dbGet(db, `SELECT MAX(datetime(COALESCE(time_out, time_end, time_in))) as ts FROM sitin_sessions WHERE user_id = ?`, [userId])
        : await dbGet(db, `SELECT MAX(datetime(COALESCE(time_out, time_end, time_in))) as ts FROM sitin_sessions`);
    const lastFeedback = userId
        ? await dbGet(db, `SELECT MAX(datetime(created_at)) as ts FROM feedback WHERE user_id = ?`, [userId])
        : await dbGet(db, `SELECT MAX(datetime(created_at)) as ts FROM feedback`);
    const lastUpdated = await dbGet(db, `SELECT MAX(datetime(created_at)) as ts FROM users`);
    return {
        source_session_at: toIsoOrNull(lastSession?.ts),
        source_feedback_at: toIsoOrNull(lastFeedback?.ts),
        source_updated_at: toIsoOrNull(lastUpdated?.ts)
    };
}

async function getCache(db, cacheKey) {
    return dbGet(db, `SELECT * FROM ai_recommendation_cache WHERE cache_key = ?`, [cacheKey]);
}

async function setCache(db, { cacheKey, studentId, type, payload, sourceTimes }) {
    await dbRun(
        db,
        `INSERT INTO ai_recommendation_cache
         (cache_key, student_id, type, response_json, generated_at, source_session_at, source_feedback_at, source_updated_at)
         VALUES (?, ?, ?, ?, datetime('now','localtime'), ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
            response_json = excluded.response_json,
            generated_at = excluded.generated_at,
            source_session_at = excluded.source_session_at,
            source_feedback_at = excluded.source_feedback_at,
            source_updated_at = excluded.source_updated_at`,
        [cacheKey, studentId, type, JSON.stringify(payload), sourceTimes.source_session_at, sourceTimes.source_feedback_at, sourceTimes.source_updated_at]
    );
}

function isCacheFresh(cacheRow, hours) {
    if (!cacheRow?.generated_at) return false;
    return (Date.now() - new Date(cacheRow.generated_at).getTime()) <= (hours * 60 * 60 * 1000);
}

function isSourceSame(cacheRow, sourceTimes, type) {
    if (type === 'admin_insights') {
        return cacheRow?.source_session_at === sourceTimes.source_session_at &&
            cacheRow?.source_feedback_at === sourceTimes.source_feedback_at;
    }
    return cacheRow?.source_session_at === sourceTimes.source_session_at;
}

function studentPrompt() {
    return 'You are an AI study assistant for the College of Computer Studies SIT-IN Monitoring System at University of Cebu. ' +
        'Your role is to analyze a student\'s personal data and provide actionable, encouraging recommendations. ' +
        'Given the student\'s data, return ONLY valid JSON with these exact keys: ' +
        'schedule_tip (insight about attendance patterns and scheduling), ' +
        'resource_tip (advice about lab selection and resource usage), ' +
        'behavior_insight (feedback on behavior ratings and professionalism), ' +
        'leaderboard_tip (motivation based on leaderboard position), ' +
        'feedback_insight (recognition of engagement through feedback submissions), ' +
        'alert (warning if inactive or falling behind, null if none). ' +
        'Guidelines: 1) Be positive and motivating. 2) Use specific data points (numbers, dates, lab names). ' +
        '3) Keep tips actionable and practical. 4) Alert only if genuine concern (7+ days inactive, low ratings). ' +
        '5) Acknowledge strengths before suggesting improvements. 6) Make it personal - use "you" and "your". ' +
        '7) Each tip must be under 200 characters. 8) Avoid jargon - use simple language. ' +
        'Context awareness: If student is new (<5 sessions), focus on onboarding tips. ' +
        'If struggling (rating <3), focus on support. If excelling (top 20%), focus on maintaining excellence.';
}
function adminPrompt() {
    return 'You are an AI analytics assistant for administrators managing the College of Computer Studies SIT-IN Monitoring System at University of Cebu. ' +
        'Analyze system-wide data and provide strategic insights. ' +
        'Return ONLY valid JSON with these exact keys: ' +
        'lab_insight (overview of lab performance and usage patterns), ' +
        'feedback_summary (sentiment analysis and key themes from student feedback), ' +
        'underperforming_labs (identification of labs needing attention with reasons), ' +
        'peak_usage_insight (timing patterns and capacity recommendations), ' +
        'student_engagement (analysis of student participation and trends), ' +
        'recommended_action (specific action items for this week). ' +
        'Guidelines: 1) Use data-driven language with specific numbers. 2) Highlight both successes and areas for improvement. ' +
        '3) Make recommendations concrete and time-bound. 4) Consider resource allocation and student experience. ' +
        '5) Identify patterns across time, labs, and student cohorts. 6) Prioritize high-impact, actionable insights.';
}
function tipsPrompt() {
    return 'You are an AI productivity coach for the College of Computer Studies SIT-IN Monitoring System at University of Cebu. ' +
        'Analyze the student\'s behavior and provide practical, motivating tips. ' +
        'Return ONLY valid JSON with these exact keys: ' +
        'daily_tip (one actionable tip for today/this week), ' +
        'improvement_tip (specific advice to boost leaderboard score), ' +
        'lab_tip (strategic guidance on lab selection and timing), ' +
        'streak_message (encouragement about consistency and streaks). ' +
        'Guidelines: 1) Keep tips concise (1-2 sentences). 2) Be specific to their data patterns. ' +
        '3) Focus on wins and small improvements. 4) Make tips time-sensitive ("today", "this week"). ' +
        '5) Vary the tone between motivational and tactical.';
}
function adminStudyTipPrompt() {
    return 'You are an AI analytics assistant for admin study-tip panel in a university SIT-IN system. ' +
        'Use the provided real system-wide data and return ONLY valid JSON with keys: badge, hero_title, hero_description, hero_stat, best_day, busiest_day, most_available_lab, best_time, footer.';
}
function studentStudyTipPrompt() {
    return 'You are an AI study-tip assistant for one student in a university SIT-IN system. ' +
        'Use provided real personal data and return ONLY valid JSON with keys: badge, best_week, best_day, busiest_day, best_lab, best_time, note.';
}

async function callWithRetry(prompt, payload, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            return await callAI({ systemPrompt: prompt, payload });
        } catch (err) {
            lastErr = err;
            if (err.httpStatus === 429 || String(err.message || '').includes('429')) {
                // Rate limited (likely concurrent requests on free tier).
                // Wait a random amount between 1.5s and 3.5s before retrying to prevent stampede.
                console.warn(`[AI-ENGINE] OpenRouter 429 Rate Limit Hit (attempt ${i + 1}/${retries}). Waiting to retry...`);
                await new Promise(res => setTimeout(res, 1500 + Math.random() * 2000));
                continue; 
            }
            if (String(err.message || '').includes('invalid JSON')) {
                // Retry with explicit instruction to return only JSON
                prompt = prompt + ' IMPORTANT: Return ONLY a single valid JSON object. No markdown, no explanation, no code fences. Just raw JSON.';
                continue; 
            }
            throw err; // Other errors (like 500, 401) throw immediately
        }
    }
    // If we exhausted retries specifically on 429 or JSON, fallback gracefully instead of crashing
    if (lastErr && (lastErr.httpStatus === 429 || String(lastErr.message || '').includes('429'))) {
        console.warn('[AI-ENGINE] OpenRouter 429 Rate Limit exhausted. Using system default fallbacks.');
        return {}; // Returning an empty object forces the upstream functions to use their default string fallbacks
    }
    throw lastErr;
}

async function generateStudentRecommendation(db, userId, forceRefresh = false) {
    const cacheKey = `student:${userId}:student_recommendation`;
    const sourceTimes = await getSourceLatestTimes(db, userId);
    const cache = await getCache(db, cacheKey);
    if (!forceRefresh && cache && isCacheFresh(cache, 6) && isSourceSame(cache, sourceTimes, 'student_recommendation')) {
        return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at) };
    }
    try {
        const context = await buildUnifiedContext(db, userId);
        const ai = await callWithRetry(studentPrompt(), context);
        const response = {
            schedule_tip: ai.schedule_tip || null,
            resource_tip: ai.resource_tip || null,
            behavior_insight: ai.behavior_insight || null,
            leaderboard_tip: ai.leaderboard_tip || null,
            feedback_insight: ai.feedback_insight || null,
            alert: ai.alert ?? null
        };
        await setCache(db, { cacheKey, studentId: userId, type: 'student_recommendation', payload: response, sourceTimes });
        const newCache = await getCache(db, cacheKey);
        return { data: response, cached: false, generatedAt: newCache?.generated_at || nowIso(), minutesAgo: minutesAgo(newCache?.generated_at || nowIso()) };
    } catch (err) {
        if (cache?.response_json) {
            return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at), fallback: true };
        }
        throw err;
    }
}

async function generateStudentTips(db, userId, forceRefresh = false) {
    const cacheKey = `student:${userId}:student_tips`;
    const sourceTimes = await getSourceLatestTimes(db, userId);
    const cache = await getCache(db, cacheKey);
    if (!forceRefresh && cache && isCacheFresh(cache, 6) && isSourceSame(cache, sourceTimes, 'student_tips')) {
        return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at) };
    }
    try {
        const context = await buildUnifiedContext(db, userId);
        const ai = await callWithRetry(tipsPrompt(), context);
        const response = {
            daily_tip: ai.daily_tip || 'Show up consistently this week to build momentum.',
            improvement_tip: ai.improvement_tip || 'Increase tidy points and complete tasks to raise your leaderboard score.',
            lab_tip: ai.lab_tip || 'Pick lower-traffic labs for better focus.',
            streak_message: ai.streak_message || 'You can start a strong study streak this week.'
        };
        await setCache(db, { cacheKey, studentId: userId, type: 'student_tips', payload: response, sourceTimes });
        const newCache = await getCache(db, cacheKey);
        return { data: response, cached: false, generatedAt: newCache?.generated_at || nowIso(), minutesAgo: minutesAgo(newCache?.generated_at || nowIso()) };
    } catch (err) {
        if (cache?.response_json) {
            return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at), fallback: true };
        }
        throw err;
    }
}

async function generateAdminInsights(db, forceRefresh = false) {
    const cacheKey = 'admin:admin_insights';
    const sourceTimes = await getSourceLatestTimes(db, null);
    const cache = await getCache(db, cacheKey);
    if (!forceRefresh && cache && isCacheFresh(cache, 12) && isSourceSame(cache, sourceTimes, 'admin_insights')) {
        return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at) };
    }
    try {
        const context = await buildUnifiedContext(db, null);
        const ai = await callWithRetry(adminPrompt(), context);
        const response = {
            lab_insight: ai.lab_insight || 'Lab performance varies; prioritize low-performing labs.',
            feedback_summary: ai.feedback_summary || 'Feedback is currently limited; gather more responses.',
            underperforming_labs: ai.underperforming_labs || 'Monitor low-usage labs for improvement opportunities.',
            peak_usage_insight: ai.peak_usage_insight || 'Peak usage periods should be monitored.',
            student_engagement: ai.student_engagement || 'Engagement can be improved with targeted nudges.',
            recommended_action: ai.recommended_action || 'Focus on underutilized labs and student participation this week.'
        };
        await setCache(db, { cacheKey, studentId: null, type: 'admin_insights', payload: response, sourceTimes });
        const newCache = await getCache(db, cacheKey);
        return { data: response, cached: false, generatedAt: newCache?.generated_at || nowIso(), minutesAgo: minutesAgo(newCache?.generated_at || nowIso()) };
    } catch (err) {
        if (cache?.response_json) {
            return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at), fallback: true };
        }
        throw err;
    }
}

async function generateAdminStudyTip(db, forceRefresh = false) {
    const cacheKey = 'admin:study_tip';
    const sourceTimes = await getSourceLatestTimes(db, null);
    const cache = await getCache(db, cacheKey);
    if (!forceRefresh && cache && isCacheFresh(cache, 12) && isSourceSame(cache, sourceTimes, 'admin_insights')) {
        return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at) };
    }
    try {
        const context = await buildUnifiedContext(db, null);
        const ai = await callWithRetry(adminStudyTipPrompt(), context);
        const response = {
            badge: ai.badge || 'Best Week: Data-driven window',
            hero_title: ai.hero_title || 'Best week to sit-in — System analytics',
            hero_description: ai.hero_description || 'This recommendation is generated from real lab usage trends.',
            hero_stat: ai.hero_stat || '📌 Updated from real sit-in activity records.',
            best_day: ai.best_day || 'No data yet.',
            busiest_day: ai.busiest_day || 'No data yet.',
            most_available_lab: ai.most_available_lab || 'No data yet.',
            best_time: ai.best_time || 'No data yet.',
            footer: ai.footer || 'Based on system-wide lab data'
        };
        await setCache(db, { cacheKey, studentId: null, type: 'admin_study_tip', payload: response, sourceTimes });
        const newCache = await getCache(db, cacheKey);
        return { data: response, cached: false, generatedAt: newCache?.generated_at || nowIso(), minutesAgo: minutesAgo(newCache?.generated_at || nowIso()) };
    } catch (err) {
        if (cache?.response_json) {
            return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at), fallback: true };
        }
        throw err;
    }
}

async function generateStudentStudyTip(db, userId, forceRefresh = false) {
    const cacheKey = `student:${userId}:study_tip`;
    const sourceTimes = await getSourceLatestTimes(db, userId);
    const cache = await getCache(db, cacheKey);
    if (!forceRefresh && cache && isCacheFresh(cache, 6) && isSourceSame(cache, sourceTimes, 'student_tips')) {
        return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at) };
    }
    try {
        const context = await buildUnifiedContext(db, userId);
        const ai = await callWithRetry(studentStudyTipPrompt(), context);
        const response = {
            badge: ai.badge || 'Best Week: Personal analytics',
            best_week: ai.best_week || 'No data yet',
            best_day: ai.best_day || 'No data yet',
            busiest_day: ai.busiest_day || 'No data yet',
            best_lab: ai.best_lab || 'No data yet',
            best_time: ai.best_time || 'No data yet',
            note: ai.note || 'Based on your own sit-in history patterns.'
        };
        await setCache(db, { cacheKey, studentId: userId, type: 'student_study_tip', payload: response, sourceTimes });
        const newCache = await getCache(db, cacheKey);
        return { data: response, cached: false, generatedAt: newCache?.generated_at || nowIso(), minutesAgo: minutesAgo(newCache?.generated_at || nowIso()) };
    } catch (err) {
        if (cache?.response_json) {
            return { data: parseJson(cache.response_json), cached: true, generatedAt: cache.generated_at, minutesAgo: minutesAgo(cache.generated_at), fallback: true };
        }
        throw err;
    }
}

module.exports = {
    generateStudentRecommendation,
    generateAdminInsights,
    generateStudentTips,
    generateAdminStudyTip,
    generateStudentStudyTip
};
