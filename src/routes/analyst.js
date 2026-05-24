const express = require('express');
const router = express.Router();
const { getAnalysis } = require('../services/phases');

let cachedAnalysis = null;
let cacheTime = 0;
const CACHE_TTL = 120_000;

router.get('/', async (req, res) => {
    try {
        if (cachedAnalysis && Date.now() - cacheTime < CACHE_TTL) {
            return res.json(cachedAnalysis);
        }

        const data = await getAnalysis();
        cachedAnalysis = data;
        cacheTime = Date.now();
        res.json(data);
    } catch (e) {
        console.error('Analyst error:', e);
        res.status(500).json({ error: 'Error al obtener análisis' });
    }
});

module.exports = router;
