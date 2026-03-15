const bcrypt = require('bcryptjs');
const db = require('./database/database');

async function createAdmin() {
    const hashed = await bcrypt.hash('Admin@1234', 10);

    // Admin 1
    db.run(
        `INSERT OR IGNORE INTO users 
         (id_number, last_name, first_name, middle_initial, course, year_level, email, password, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['23769862', 'Taburnal', 'Emmanuel', 'O', 'BSIT', 3, 'bryllando@gmail.com', hashed, 'admin'],
        function (err) {
            if (err) console.log('Admin 1 Error:', err.message);
            else console.log('Admin 1 created! ID: 23769862 | Pass: Admin@1234');
        }
    );

    // Admin 2
    db.run(
        `INSERT OR IGNORE INTO users 
         (id_number, last_name, first_name, middle_initial, course, year_level, email, password, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['00000000', 'Salimbangon', 'Jeff Pelorina', '', 'BSCS', 4, 'jeff@gmail.com', hashed, 'admin'],
        function (err) {
            if (err) console.log('Admin 2 Error:', err.message);
            else console.log('Admin 2 created! ID: 00000000 | Pass: Admin@1234');
            db.close();
        }
    );
}

createAdmin();