const express = require('express');
const router = express.Router();
const { getSignals } = require('../services/signals');

let cachedSignals = null;
let cacheTime = 0;
const CACHE_TTL = 120_000;

router.get('/', async (req, res) => {
    try {
        if (cachedSignals && Date.now() - cacheTime < CACHE_TTL) {
            return res.json(cachedSignals);
        }

        const data = await getSignals();
        cachedSignals = data;
        cacheTime = Date.now();
        res.json(data);
    } catch (e) {
        console.error('Signals error:', e);
        res.status(500).json({ error: 'Error al obtener señales' });
    }
});

module.exports = router;
