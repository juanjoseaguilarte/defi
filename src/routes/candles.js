const express = require('express');
const router = express.Router();
const { fetchKlines, fetchAllPrices } = require('../services/binance');
const { sma, findMR, findmR } = require('../services/ranges');

const VALID_PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'UNIUSDT', 'JUPUSDT', 'AAVEUSDT'];

const INTERVAL_MAP = {
    'M': '1M', '10080': '1w', '1440': '1d', '360': '6h',
    '1d': '1d', '1w': '1w', '1M': '1M', '6h': '6h',
};

router.get('/', async (req, res) => {
    const pair = (req.query.pair || '').toUpperCase();
    const intervalInput = req.query.interval || '1d';
    const interval = INTERVAL_MAP[intervalInput] || '1d';

    if (!VALID_PAIRS.includes(pair)) {
        return res.status(400).json({ error: 'Par no válido' });
    }

    try {
        const candles = await fetchKlines(pair, interval, 100);
        const prices = await fetchAllPrices();
        const closes = candles.map(c => c.close);
        const sma20 = sma(closes, 20);
        const sma40 = sma(closes, 40);

        const swing_highs = findMR(candles);
        const swing_lows = findmR(candles);

        res.json({
            candles: candles.map(c => [c.open, c.high, c.low, c.close, c.ts]),
            sma20,
            sma40,
            swing_highs,
            swing_lows,
            current: prices[pair] || candles[candles.length - 1]?.close || 0,
        });
    } catch (e) {
        console.error('Candles error:', e);
        res.status(500).json({ error: 'Error al obtener velas' });
    }
});

module.exports = router;
