const express = require('express');
const router = express.Router();
const { getRangesForPair } = require('../services/ranges');

const VALID_PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'UNIUSDT', 'JUPUSDT', 'AAVEUSDT'];

router.get('/', async (req, res) => {
    const pair = (req.query.pair || '').toUpperCase();
    if (!VALID_PAIRS.includes(pair)) {
        return res.status(400).json({ error: 'Par no válido' });
    }

    try {
        const data = await getRangesForPair(pair);
        res.json(data);
    } catch (e) {
        console.error('Ranges error:', e);
        res.status(500).json({ error: 'Error al obtener rangos' });
    }
});

module.exports = router;
