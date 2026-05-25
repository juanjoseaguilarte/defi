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
app.use('/api/rules', require('./src/routes/rules'));
app.use('/api/notify', require('./src/routes/notify'));
app.use('/api/daytrader', require('./src/routes/daytrader'));

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

    // Install Python deps if needed
    const { execSync } = require('child_process');
    try {
        execSync('python3 -c "import pandas, numpy"', { stdio: 'ignore' });
    } catch (_) {
        console.log('[Setup] Installing Python dependencies...');
        try { execSync('pip3 install --break-system-packages -q pandas numpy requests', { stdio: 'inherit', timeout: 120000 }); }
        catch (e) { console.error('[Setup] Python install failed:', e.message); }
    }

    const { startPeriodicSync } = require('./src/services/sync');
    startPeriodicSync(3600000); // sync every hour

    const { startCron, setStrategyLoader } = require('./src/services/notify');
    const { getDb } = require('./db/init');
    setStrategyLoader(() => {
        const db = getDb();
        const strat = db.prepare("SELECT * FROM executed_strategies WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get();
        if (!strat) { db.close(); return null; }
        const steps = db.prepare('SELECT * FROM executed_steps WHERE strategy_id = ? ORDER BY step_num').all(strat.id);
        db.close();
        return {
            id: strat.id, market_phase: strat.market_phase, main_asset: strat.main_asset,
            amount: strat.amount,
            steps: steps.map(s => ({ ...s, done: !!s.done, entry_asset: strat.main_asset })),
        };
    });
    startCron(); // trades every 60s, strategy every 15min
});
