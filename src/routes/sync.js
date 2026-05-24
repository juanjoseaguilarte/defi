const express = require('express');
const router = express.Router();
const { getSyncStatus, syncAll, syncPairInterval, getCandlesFromDb, PAIRS, INTERVALS } = require('../services/sync');
const { authMiddleware } = require('./admin');

router.get('/status', authMiddleware, (req, res) => {
    try {
        const status = getSyncStatus();
        res.json({ ok: true, ...status });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post('/run', authMiddleware, async (req, res) => {
    try {
        const results = await syncAll();
        res.json({ ok: true, results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.get('/candles', authMiddleware, (req, res) => {
    const pair = (req.query.pair || '').toUpperCase();
    const interval = req.query.interval || '1d';
    const limit = parseInt(req.query.limit) || 365;

    if (!PAIRS.includes(pair)) {
        return res.status(400).json({ error: 'Par no válido' });
    }
    if (!INTERVALS.includes(interval)) {
        return res.status(400).json({ error: 'Intervalo no válido. Usar: 1d, 1w, 1M' });
    }

    try {
        const candles = getCandlesFromDb(pair, interval, limit);
        res.json({ ok: true, pair, interval, count: candles.length, candles });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
