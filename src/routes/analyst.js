const express = require('express');
const router = express.Router();
const { pyAnalyst } = require('../services/pybridge');
const { getAnalysis } = require('../services/phases');

let cachedAnalysis = null;
let cacheTime = 0;
const CACHE_TTL = 120_000;

router.get('/', async (req, res) => {
    try {
        if (cachedAnalysis && Date.now() - cacheTime < CACHE_TTL) {
            return res.json(cachedAnalysis);
        }

        let data;
        try {
            data = await pyAnalyst();
        } catch (pyErr) {
            console.error('[Analyst] Python failed, JS fallback:', pyErr.message);
            data = await getAnalysis();
            data.engine = 'js-fallback';
        }

        cachedAnalysis = data;
        cacheTime = Date.now();
        res.json(data);
    } catch (e) {
        console.error('Analyst error:', e);
        res.status(500).json({ error: 'Error al obtener análisis' });
    }
});

module.exports = router;
