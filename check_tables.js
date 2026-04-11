const db = require('./database/database.js');
db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) => {
    console.log(rows);
});
