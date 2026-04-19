require('dotenv').config();

async function test() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    console.log('API Key:', apiKey ? apiKey.slice(0, 15) + '...' : 'MISSING');

    const systemPrompt = 'You are an AI study assistant. Return ONLY valid JSON with keys: schedule_tip, resource_tip, behavior_insight, leaderboard_tip, feedback_insight, alert. Each value should be a short string under 200 characters.';
    const payload = {
        student_context: {
            student: { student_id: 1, name: "Juan Dela Cruz", course: "BSIT", year_level: 2 },
            session_history_last_10: [
                { date: "2026-04-15", lab_name: "524", time_in: "2026-04-15 08:00", duration_minutes: 60, purpose: "Java Programming" },
                { date: "2026-04-14", lab_name: "524", time_in: "2026-04-14 10:00", duration_minutes: 45, purpose: "Database" }
            ],
            totals: { sessions_this_week: 3, sessions_this_month: 10, most_used_lab: "Lab 524", average_session_duration_minutes: 45 }
        }
    };

    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'CCS SitIn Monitoring System'
            },
            body: JSON.stringify({
                model: 'google/gemma-3-4b-it:free',
                max_tokens: 1500,
                temperature: 0.4,
                messages: [
                    { role: 'user', content: systemPrompt + '\n\nHere is the data to analyze:\n' + JSON.stringify(payload) }
                ]
            })
        });
        console.log('Status:', res.status);
        const data = await res.json();
        if (data.choices && data.choices[0]) {
            const content = data.choices[0].message.content;
            console.log('\n=== RAW RESPONSE ===');
            console.log(content);

            // Test extractJson
            let cleaned = content.trim();
            const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (fenceMatch) cleaned = fenceMatch[1].trim();
            const firstBrace = cleaned.indexOf('{');
            const lastBrace = cleaned.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
            const parsed = JSON.parse(cleaned);
            console.log('\n=== PARSED JSON ===');
            console.log(JSON.stringify(parsed, null, 2));
        } else {
            console.log('Error response:', JSON.stringify(data).slice(0, 500));
        }
    } catch(e) {
        console.log('Error:', e.message);
    }
}
test();
