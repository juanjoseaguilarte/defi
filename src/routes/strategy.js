const express = require('express');
const router = express.Router();
const { getStrategy } = require('../services/strategy');

let cachedStrategy = null;
let cacheTime = 0;
let cacheAmount = 0;
const CACHE_TTL = 300_000;

router.get('/', async (req, res) => {
    const amount = parseFloat(req.query.amount);
    if (!amount || amount < 100) {
        return res.status(400).json({ error: 'Cantidad mínima: 100 USD' });
    }

    try {
        if (cachedStrategy && Date.now() - cacheTime < CACHE_TTL && cacheAmount === amount) {
            return res.json(cachedStrategy);
        }

        const data = await getStrategy(amount);
        cachedStrategy = data;
        cacheTime = Date.now();
        cacheAmount = amount;
        res.json(data);
    } catch (e) {
        console.error('Strategy error:', e);
        res.status(500).json({ error: 'Error al generar estrategia: ' + e.message });
    }
});

module.exports = router;
