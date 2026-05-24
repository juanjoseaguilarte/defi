const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/ranges', require('./src/routes/ranges'));
app.use('/api/synthetic', require('./src/routes/synthetic'));
app.use('/api/analyst', require('./src/routes/analyst'));
app.use('/api/candles_detail', require('./src/routes/candles'));
app.use('/api/signals', require('./src/routes/signals'));
app.use('/api/aave', require('./src/routes/aave'));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
});
