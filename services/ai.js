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

function safeJsonParse(raw) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function fallbackRecommendation() {
    return {
        schedule_tip: 'Try reserving during less busy hours to get your preferred PC.',
        resource_tip: 'Choose labs that match your course activity and current availability.',
        behavior_insight: 'Maintain consistent sit-in sessions with clear study goals.',
        leaderboard_tip: 'Increase tidy points and complete tasks consistently to improve score.',
        feedback_insight: 'Use feedback trends to pick higher-rated labs during your study sessions.',
        alert: null
    };
}

async function callAI(systemPrompt, payload, responseMode = 'student') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;

    const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'CCS SitIn Monitoring System'
        },
        body: JSON.stringify({
            model: OPENROUTER_MODEL,
            max_tokens: 1000,
            temperature: 0.4,
            messages: [
                { role: 'user', content: systemPrompt + ' IMPORTANT: Return ONLY a valid JSON object. No markdown, no explanation.\n\nHere is the data to analyze:\n' + JSON.stringify(payload) }
            ]
        })
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content || ''
        : '';
    // Extract JSON robustly (strip markdown fences)
    let cleaned = text.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    const parsed = safeJsonParse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;
    if (responseMode !== 'student') return parsed;
    const fallback = fallbackRecommendation();
    return {
        schedule_tip: parsed.schedule_tip || fallback.schedule_tip,
        resource_tip: parsed.resource_tip || fallback.resource_tip,
        behavior_insight: parsed.behavior_insight || fallback.behavior_insight,
        leaderboard_tip: parsed.leaderboard_tip || fallback.leaderboard_tip,
        feedback_insight: parsed.feedback_insight || fallback.feedback_insight,
        alert: parsed.alert ?? null
    };
}

async function buildStudentPayload(db, userId) {
    const student = await dbGet(
        db,
        `SELECT id, first_name, last_name, course, year_level FROM users WHERE id = ?`,
        [userId]
    );
    if (!student) return null;

    const sessions = await dbAll(
        db,
        `SELECT id, purpose, lab_room, computer_number, time_in, time_out, time_end, status
         FROM sitin_sessions
         WHERE user_id = ?
         ORDER BY time_in DESC
         LIMIT 10`,
        [userId]
    );
    const active = sessions.find(s => s.status === 'active') || null;
    if (!sessions.length && !active) return null;

    const stats = await dbGet(
        db,
        `SELECT COALESCE(lab_room, '') as most_used_lab, COUNT(*) as total_sessions
         FROM sitin_sessions
         WHERE user_id = ?
         GROUP BY lab_room
         ORDER BY COUNT(*) DESC
         LIMIT 1`,
        [userId]
    );

    const feedbackStats = await dbGet(
        db,
        `SELECT
            COALESCE(AVG(rating), 0) as avg_rating,
            COUNT(*) as total_feedback
         FROM feedback
         WHERE user_id = ?`,
        [userId]
    );
    const labRatings = await dbAll(
        db,
        `SELECT lab_room, ROUND(COALESCE(AVG(behavior_rating), 0), 2) as rating
         FROM sitin_sessions
         WHERE lab_room IS NOT NULL AND lab_room != ''
         GROUP BY lab_room
         ORDER BY rating DESC
         LIMIT 5`
    );
    const leaderboardRows = await dbAll(
        db,
        `SELECT id, COALESCE(tidy_points_raw, 0) as tidy_points_raw, COALESCE(task_completion_rate, 0) as task_completion_rate
         FROM users WHERE role = 'user'`
    );
    const leaderboardDurations = await dbAll(
        db,
        `SELECT user_id, time_in, time_out, time_end FROM sitin_sessions`
    );
    const hoursByUser = new Map();
    leaderboardDurations.forEach((s) => {
        const from = s.time_in ? new Date(s.time_in).getTime() : NaN;
        const toRaw = s.time_out || s.time_end;
        const to = toRaw ? new Date(toRaw).getTime() : NaN;
        const h = !Number.isNaN(from) && !Number.isNaN(to) && to > from ? (to - from) / 3600000 : 0;
        hoursByUser.set(s.user_id, (hoursByUser.get(s.user_id) || 0) + h);
    });
    const leaderboard = leaderboardRows
        .map((u) => {
            const tidyLb = Number(u.tidy_points_raw || 0) / 3;
            const hrs = Number(hoursByUser.get(u.id) || 0);
            const task = Number(u.task_completion_rate || 0);
            return {
                id: u.id,
                score: (tidyLb * 0.5) + (hrs * 0.3) + (task * 0.2),
                tidy_raw: Number(u.tidy_points_raw || 0),
                tidy_lb: tidyLb,
                hours: hrs,
                task_rate: task
            };
        })
        .sort((a, b) => b.score - a.score);
    const myRank = leaderboard.findIndex((r) => r.id === userId) + 1;
    const myEntry = leaderboard.find((r) => r.id === userId) || null;
    const topAverage = leaderboard.slice(0, 3).reduce((sum, r) => sum + r.score, 0) / (leaderboard.slice(0, 3).length || 1);

    return {
        student: {
            name: `${student.first_name} ${student.last_name}`,
            course: student.course,
            year_level: student.year_level
        },
        recent_sessions: sessions.map(s => ({
            date: s.time_in,
            lab: s.lab_room,
            pc: s.computer_number,
            time_in: s.time_in,
            time_out: s.time_out || s.time_end || null,
            purpose: s.purpose
        })),
        current_session: active
            ? {
                session_id: active.id,
                lab: active.lab_room,
                pc: active.computer_number,
                time_in: active.time_in,
                expected_end: active.time_end || null
            }
            : null,
        lab_stats: {
            most_used_lab: stats?.most_used_lab || null,
            weekly_count: sessions.filter(s => {
                if (!s.time_in) return false;
                const d = new Date(s.time_in);
                return Date.now() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
            }).length,
            average_duration_minutes: sessions.length
                ? Math.round(sessions.reduce((sum, s) => {
                    const start = s.time_in ? new Date(s.time_in).getTime() : NaN;
                    const endRaw = s.time_out || s.time_end;
                    const end = endRaw ? new Date(endRaw).getTime() : NaN;
                    return sum + (!Number.isNaN(start) && !Number.isNaN(end) && end > start ? (end - start) / 60000 : 0);
                }, 0) / sessions.length)
                : 0
        },
        feedback_analytics: {
            student_avg_rating: Number(feedbackStats?.avg_rating || 0),
            student_feedback_count: Number(feedbackStats?.total_feedback || 0),
            top_lab_ratings: labRatings
        },
        leaderboard_data: {
            rank: myRank || null,
            score: myEntry ? Number(myEntry.score.toFixed(2)) : null,
            tidy_points_raw: myEntry ? myEntry.tidy_raw : 0,
            tidy_lb_points: myEntry ? Number(myEntry.tidy_lb.toFixed(2)) : 0,
            total_hours: myEntry ? Number(myEntry.hours.toFixed(2)) : 0,
            task_completion_rate: myEntry ? myEntry.task_rate : 0,
            top_rank_average_score: Number(topAverage.toFixed(2))
        }
    };
}

async function bumpStudentAiVersion(db, userId) {
    await dbRun(
        db,
        `UPDATE users SET ai_reco_version = COALESCE(ai_reco_version, 0) + 1 WHERE id = ?`,
        [userId]
    );
}

async function getStudentRecommendation(db, userId) {
    const student = await dbGet(db, `SELECT ai_reco_version FROM users WHERE id = ?`, [userId]);
    if (!student) return null;
    const version = Number(student.ai_reco_version || 0);
    const cached = await dbGet(
        db,
        `SELECT payload, version FROM ai_recommendations WHERE user_id = ?`,
        [userId]
    );
    if (cached && Number(cached.version) === version) {
        const parsed = safeJsonParse(cached.payload);
        if (parsed) return parsed;
    }

    const payload = await buildStudentPayload(db, userId);
    if (!payload) return null;

    const systemPrompt =
        'You are embedded in a university College of Computer Studies SIT-IN Monitoring System. ' +
        'Use session history, lab usage, feedback analytics, and leaderboard context. ' +
        'Leaderboard formulas: student score=(TidyLBPoints*0.5)+(TotalHours*0.3)+(TaskCompletionRate*0.2), TidyLBPoints=raw_tidy_points/3. ' +
        'Most visited lab score=(Sit-ins*0.25)+(Hours*0.25)+(Rating*0.25)+(UniqueUsers*0.25). ' +
        'Return ONLY valid JSON with keys: schedule_tip, resource_tip, behavior_insight, leaderboard_tip, feedback_insight, alert.';

    const recommendation = (await callAI(systemPrompt, payload, 'student')) || fallbackRecommendation();
    await dbRun(
        db,
        `INSERT INTO ai_recommendations (user_id, version, payload, updated_at)
         VALUES (?, ?, ?, datetime('now','localtime'))
         ON CONFLICT(user_id) DO UPDATE
         SET version = excluded.version, payload = excluded.payload, updated_at = excluded.updated_at`,
        [userId, version, JSON.stringify(recommendation)]
    );
    return recommendation;
}

async function getAdminInsights(db) {
    const cached = await dbGet(db, `SELECT payload, updated_at FROM ai_admin_insights WHERE id = 1`);
    if (cached?.updated_at) {
        const updated = new Date(cached.updated_at).getTime();
        if (!Number.isNaN(updated) && Date.now() - updated < 60 * 60 * 1000) {
            const parsed = safeJsonParse(cached.payload);
            if (parsed) return parsed;
        }
    }

    const rows = await dbAll(
        db,
        `SELECT lab_room, strftime('%H', time_in) as hour, COUNT(*) as cnt
         FROM sitin_sessions
         GROUP BY lab_room, hour
         ORDER BY cnt DESC
         LIMIT 15`
    );
    const topLab = rows[0]?.lab_room || 'N/A';
    const peakHour = rows[0]?.hour ? `${rows[0].hour}:00` : 'N/A';
    const lowRatings = await dbAll(
        db,
        `SELECT u.first_name, u.last_name, AVG(s.behavior_rating) as avg_rating
         FROM sitin_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.behavior_rating IS NOT NULL
         GROUP BY s.user_id
         HAVING avg_rating <= 2
         LIMIT 10`
    );

    const payload = { topLab, peakHour, flaggedStudents: lowRatings };
    const systemPrompt =
        'You provide concise admin insights for a university SIT-IN monitoring system. ' +
        'Return ONLY valid JSON with keys: lab_recommendation, feedback_summary, at_risk_students, peak_hours_insight, admin_action.';

    const aiRaw = await callAI(systemPrompt, payload, 'admin');
    const insights = aiRaw && typeof aiRaw === 'object' && aiRaw.lab_recommendation
        ? aiRaw
        : {
            lab_recommendation: `Most used lab is ${topLab}; promote alternative labs during peak periods.`,
            feedback_summary: 'Overall behavior ratings are acceptable but require continuous monitoring.',
            at_risk_students: `${lowRatings.length} students are currently flagged with low behavior ratings.`,
            peak_hours_insight: `Peak usage is around ${peakHour}.`,
            admin_action: 'Run targeted reminders on lab rules and monitor high-traffic periods.'
        };

    await dbRun(
        db,
        `INSERT INTO ai_admin_insights (id, payload, updated_at)
         VALUES (1, ?, datetime('now','localtime'))
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        [JSON.stringify(insights)]
    );
    return insights;
}

module.exports = {
    bumpStudentAiVersion,
    getStudentRecommendation,
    getAdminInsights
};
