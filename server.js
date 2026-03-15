const express = require('express');
const express_layouts = require('express-ejs-layouts');
const path = require('path');
const port = 3000;
const app = express();


app.use(express_layouts);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('layout', 'layouts/main');

app.get('/', (req, res) => {
    res.render('pages/index');
})

app.get('/register', (req, res) => {
    res.render('pages/register');
});

app.get('/login', (req, res) => {
    res.render('pages/login');
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});