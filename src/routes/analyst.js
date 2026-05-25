const express = require('express');
const router = express.Router();
const { pyAnalyst } = require('../services/pybridge');

let cachedAnalysis = null;
let cacheTime = 0;
const CACHE_TTL = 120_000;

router.get('/', async (req, res) => {
    try {
        if (cachedAnalysis && Date.now() - cacheTime < CACHE_TTL) {
            return res.json(cachedAnalysis);
        }

        const data = await pyAnalyst();
        cachedAnalysis = data;
        cacheTime = Date.now();
        res.json(data);
    } catch (e) {
        console.error('Analyst error:', e.message);
        if (cachedAnalysis) {
            cachedAnalysis.engine = 'python-cached';
            return res.json(cachedAnalysis);
        }
        res.status(500).json({ error: 'Python: ' + e.message, engine: 'python-error' });
    }
});

module.exports = router;
