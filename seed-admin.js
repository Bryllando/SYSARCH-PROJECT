const bcrypt = require('bcryptjs');
const db = require('./database/database');

async function createAdmin() {
    const hashed = await bcrypt.hash('Admin@1234', 10);

    db.run(
        `INSERT OR IGNORE INTO users 
         (id_number, last_name, first_name, middle_initial, course, year_level, email, password, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['23769862', 'Taburnal', 'Emmanuel', 'O.', 'BSIT', 3, 'bryllando@gmail.com', hashed, 'admin'],
        ['00000000', 'Salimbangon', 'Jeff Pelorina', '', 'BSCS', 4, 'jeff@gmail.com', hashed, 'admin'],
        function (err) {
            if (err) console.log('Error:', err.message);
            else console.log('Admin account created!');
            db.close();
        }
    );
}

createAdmin();