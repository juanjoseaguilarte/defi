const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Build ID: hash of key source files — changes on every deploy
const BUILD_FILES = ['server.js', 'public/assets/app.js', 'public/assets/app.css', 'public/index.html', 'package.json'];
const buildContent = BUILD_FILES.map(f => {
    try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch (_) { return ''; }
}).join('');
const BUILD_ID = crypto.createHash('md5').update(buildContent).digest('hex').slice(0, 12);
const APP_VERSION = require('./package.json').version;

app.use(cors());
app.use(express.json());

app.use('/api/ranges', require('./src/routes/ranges'));
app.use('/api/synthetic', require('./src/routes/synthetic'));
app.use('/api/analyst', require('./src/routes/analyst'));
app.use('/api/candles_detail', require('./src/routes/candles'));
app.use('/api/signals', require('./src/routes/signals'));
app.use('/api/aave', require('./src/routes/aave'));
app.use('/api/strategy', require('./src/routes/strategy'));
app.use('/api/tracker', require('./src/routes/tracker'));
app.use('/api/simulator', require('./src/routes/simulator'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/sync', require('./src/routes/sync'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/version', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ version: APP_VERSION, build: BUILD_ID });
});

if (process.env.SERVE_STATIC !== '0') {
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard API running on port ${PORT}`);

    const { startPeriodicSync } = require('./src/services/sync');
    startPeriodicSync(3600000); // sync every hour
});
