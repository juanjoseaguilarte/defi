const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/ranges', require('./src/routes/ranges'));
app.use('/api/synthetic', require('./src/routes/synthetic'));
app.use('/api/analyst', require('./src/routes/analyst'));
app.use('/api/candles_detail', require('./src/routes/candles'));
app.use('/api/signals', require('./src/routes/signals'));
app.use('/api/aave', require('./src/routes/aave'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

if (process.env.SERVE_STATIC !== '0') {
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard API running on port ${PORT}`);
});
