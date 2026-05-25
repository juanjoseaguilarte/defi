const express = require('express');
const router = express.Router();
const { getDailyTrade } = require('../services/daytrader');

// GET /api/daytrader?asset=ETH
router.get('/', async (req, res) => {
    const asset = (req.query.asset || 'ETH').toUpperCase();
    if (!['BTC', 'ETH', 'SOL'].includes(asset)) {
        return res.status(400).json({ error: 'Asset: BTC, ETH o SOL' });
    }
    try {
        const trade = await getDailyTrade(asset);
        res.json(trade);
    } catch (e) {
        console.error('Daytrader error:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
