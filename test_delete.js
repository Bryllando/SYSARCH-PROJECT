const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/admin/announcement/14/delete',
  method: 'POST',
  headers: {
    // We would need the session cookie to pass isAuthenticated and isAdmin
  }
};

console.log("Cannot test natively without session cookie.");
