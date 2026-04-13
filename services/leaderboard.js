function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function safeHours(start, end) {
    if (!start || !end) return 0;
    const from = new Date(start).getTime();
    const to = new Date(end).getTime();
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return 0;
    return (to - from) / 3600000;
}

async function getLeaderboardData(db) {
    const users = await dbAll(
        db,
        `SELECT id, first_name, last_name, course, year_level, profile_picture,
                COALESCE(tidy_points_raw, 0) AS tidy_points_raw,
                COALESCE(task_completion_rate, 0) AS task_completion_rate
         FROM users
         WHERE role = 'user'`
    );
    const sessions = await dbAll(
        db,
        `SELECT user_id, lab_room, behavior_rating, time_in, time_out, time_end
         FROM sitin_sessions`
    );

    const byUser = new Map();
    sessions.forEach((s) => {
        const end = s.time_out || s.time_end;
        const h = safeHours(s.time_in, end);
        if (!byUser.has(s.user_id)) byUser.set(s.user_id, { totalHours: 0, totalSessions: 0 });
        const item = byUser.get(s.user_id);
        item.totalHours += h;
        item.totalSessions += 1;
    });

    const students = users.map((u) => {
        const agg = byUser.get(u.id) || { totalHours: 0, totalSessions: 0 };
        const tidyRaw = Number(u.tidy_points_raw || 0);
        const tidyLb = tidyRaw / 3;
        const taskRate = Math.max(0, Math.min(100, Number(u.task_completion_rate || 0)));
        const totalHours = Number(agg.totalHours.toFixed(2));
        const finalScore = Number((tidyLb * 0.5 + totalHours * 0.3 + taskRate * 0.2).toFixed(2));
        return {
            ...u,
            tidy_points_raw: tidyRaw,
            tidy_lb_points: Number(tidyLb.toFixed(2)),
            total_hours: totalHours,
            task_completion_rate: taskRate,
            points: finalScore,
            total_sessions: agg.totalSessions
        };
    }).sort((a, b) => b.points - a.points).map((s, idx) => ({ ...s, rank: idx + 1 }));

    const labAgg = new Map();
    sessions.forEach((s) => {
        if (!s.lab_room) return;
        if (!labAgg.has(s.lab_room)) {
            labAgg.set(s.lab_room, { lab_room: s.lab_room, sitins: 0, hours: 0, ratings: [], users: new Set() });
        }
        const row = labAgg.get(s.lab_room);
        row.sitins += 1;
        row.hours += safeHours(s.time_in, s.time_out || s.time_end);
        row.users.add(s.user_id);
        if (s.behavior_rating !== null && s.behavior_rating !== undefined) {
            const val = Number(s.behavior_rating);
            if (!Number.isNaN(val)) row.ratings.push(val);
        }
    });

    const labs = Array.from(labAgg.values()).map((l) => {
        const rating = l.ratings.length ? l.ratings.reduce((a, b) => a + b, 0) / l.ratings.length : 0;
        const score = (l.sitins * 0.25) + (l.hours * 0.25) + (rating * 0.25) + (l.users.size * 0.25);
        return {
            lab_room: l.lab_room,
            sitins: l.sitins,
            hours: Number(l.hours.toFixed(2)),
            rating: Number(rating.toFixed(2)),
            unique_users: l.users.size,
            score: Number(score.toFixed(2))
        };
    }).sort((a, b) => b.score - a.score);

    return { students, labs };
}

module.exports = { getLeaderboardData };
