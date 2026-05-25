const express = require('express');
const router = express.Router();
const { pySignals } = require('../services/pybridge');

let cachedSignals = null;
let cacheTime = 0;
const CACHE_TTL = 120_000;

router.get('/', async (req, res) => {
    try {
        if (cachedSignals && Date.now() - cacheTime < CACHE_TTL) {
            return res.json(cachedSignals);
        }

        const data = await pySignals();
        cachedSignals = data;
        cacheTime = Date.now();
        res.json(data);
    } catch (e) {
        console.error('Signals error:', e.message);
        if (cachedSignals) {
            cachedSignals.engine = 'python-cached';
            return res.json(cachedSignals);
        }
        res.status(500).json({ error: 'Python: ' + e.message, engine: 'python-error' });
    }
});

module.exports = router;
