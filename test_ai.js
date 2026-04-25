const { generateAdminInsights } = require('./services/ai-engine');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database', 'sitin.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error('Cannot open DB:', err.message); process.exit(1); }
});

(async () => {
    try {
        const result = await generateAdminInsights(db, true); // force refresh
        console.log("SUCCESS:");
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("FAILED:");
        console.error(e);
    }
    db.close();
})();
