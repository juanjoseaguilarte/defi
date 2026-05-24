const express = require('express');
const router = express.Router();
const { fetchKlines, fetchAllPrices } = require('../services/binance');
const { sma, percentile, volPercentile } = require('../services/ranges');
const { getDb } = require('../../db/init');

const SYNTHETIC_PAIRS = {
    'BTCETH': ['BTCUSDT', 'ETHUSDT'],
    'BTCSOL': ['BTCUSDT', 'SOLUSDT'],
    'ETHSOL': ['ETHUSDT', 'SOLUSDT'],
    'SOLJUP': ['SOLUSDT', 'JUPUSDT'],
};

async function buildSyntheticCandles(base, quote, interval, limit) {
    const [baseCandles, quoteCandles] = await Promise.all([
        fetchKlines(base, interval, limit),
        fetchKlines(quote, interval, limit),
    ]);

    const len = Math.min(baseCandles.length, quoteCandles.length);
    const candles = [];
    for (let i = 0; i < len; i++) {
        const b = baseCandles[baseCandles.length - len + i];
        const q = quoteCandles[quoteCandles.length - len + i];
        if (q.close === 0) continue;
        candles.push({
            ts: b.ts,
            open: b.open / q.open,
            high: b.high / q.low,
            low: b.low / q.high,
            close: b.close / q.close,
            volume: b.volume,
        });
    }
    return candles;
}

async function calcRange(candles) {
    if (!candles.length) return null;
    const lows = candles.map(c => c.low);
    const highs = candles.map(c => c.high);
    const sup = percentile(lows, 10);
    const res = percentile(highs, 90);
    const mid = (sup + res) / 2;
    const widthPct = mid > 0 ? ((res - sup) / mid * 100) : 0;
    const last = candles[candles.length - 1];

    return {
        sup: parseFloat(sup.toFixed(8)),
        mid: parseFloat(mid.toFixed(8)),
        res: parseFloat(res.toFixed(8)),
        width_pct: parseFloat(widthPct.toFixed(2)),
        closed_at: new Date(last.ts).toISOString(),
    };
}

router.get('/', async (req, res) => {
    const pairKey = (req.query.pair || '').toUpperCase();
    const mapping = SYNTHETIC_PAIRS[pairKey];
    if (!mapping) {
        return res.status(400).json({ error: 'Par sintético no válido' });
    }

    try {
        const [base, quote] = mapping;
        const prices = await fetchAllPrices();
        const currentPrice = (prices[base] || 0) / (prices[quote] || 1);

        const [dailyCandles, weeklyCandles, monthlyCandles] = await Promise.all([
            buildSyntheticCandles(base, quote, '1d', 30),
            buildSyntheticCandles(base, quote, '1w', 12),
            buildSyntheticCandles(base, quote, '1M', 6),
        ]);

        const [daily, weekly, monthly] = await Promise.all([
            calcRange(dailyCandles),
            calcRange(weeklyCandles),
            calcRange(monthlyCandles),
        ]);

        const closes = dailyCandles.map(c => c.close);
        const sma20 = sma(closes, 20);
        const lastSma = sma20.filter(v => v !== null).pop();
        const trend = currentPrice > (lastSma || 0) ? 'ALCISTA' : 'BAJISTA';
        const vols = dailyCandles.map(c => c.volume);
        const volPct = volPercentile(vols);

        const data = { pair: pairKey, current_price: parseFloat(currentPrice.toFixed(8)), trend, vol_percentile: volPct, daily, weekly, monthly };

        const db = getDb();
        const customs = db.prepare('SELECT timeframe, sup, mid, res FROM custom_ranges WHERE pair = ? AND enabled = 1').all(pairKey);
        db.close();
        for (const c of customs) {
            if (data[c.timeframe]) {
                data[c.timeframe].sup = c.sup;
                data[c.timeframe].mid = c.mid;
                data[c.timeframe].res = c.res;
                data[c.timeframe]._custom = true;
            }
        }

        res.json(data);
    } catch (e) {
        console.error('Synthetic error:', e);
        res.status(500).json({ error: 'Error al calcular par sintético' });
    }
});

module.exports = router;
