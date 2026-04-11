const db = require('./database/database.js');
db.run("UPDATE users SET remaining_sessions = 30 WHERE role = 'user'", function(err) {
    if (err) console.error(err);
    console.log("Changes made:", this.changes);
});
