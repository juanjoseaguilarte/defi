const express = require('express');
const router = express.Router();
const { simulate } = require('../services/simulator');

router.get('/', async (req, res) => {
    const asset = (req.query.asset || 'ETH').toUpperCase();
    const amount = parseFloat(req.query.amount) || 10000;
    const startDate = req.query.startDate;

    if (!['BTC', 'ETH'].includes(asset)) {
        return res.status(400).json({ error: 'Asset debe ser BTC o ETH' });
    }
    if (!startDate) {
        return res.status(400).json({ error: 'startDate requerido (YYYY-MM-DD)' });
    }

    try {
        const result = await simulate(asset, amount, startDate);
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('Simulator error:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
