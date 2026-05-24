const { fetchKlines, fetchAllPrices } = require('./binance');

function sma(values, period) {
    const result = [];
    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) { result.push(null); continue; }
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += values[j];
        result.push(sum / period);
    }
    return result;
}

function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p / 100);
    return sorted[Math.min(idx, sorted.length - 1)];
}

function volPercentile(volumes) {
    if (volumes.length < 2) return 50;
    const current = volumes[volumes.length - 1];
    const sorted = [...volumes].sort((a, b) => a - b);
    const idx = sorted.findIndex(v => v >= current);
    return Math.round((idx / sorted.length) * 100);
}

async function calculateRanges(pair, interval, limit) {
    const candles = await fetchKlines(pair, interval, limit);
    if (!candles.length) return null;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    const sup = percentile(lows, 10);
    const res = percentile(highs, 90);
    const mid = (sup + res) / 2;
    const widthPct = mid > 0 ? ((res - sup) / mid * 100) : 0;
    const lastCandle = candles[candles.length - 1];

    return {
        sup: parseFloat(sup.toFixed(8)),
        mid: parseFloat(mid.toFixed(8)),
        res: parseFloat(res.toFixed(8)),
        width_pct: parseFloat(widthPct.toFixed(2)),
        closed_at: new Date(lastCandle.ts).toISOString(),
    };
}

async function getRangesForPair(pair) {
    const [prices, daily, weekly, monthly] = await Promise.all([
        fetchAllPrices(),
        calculateRanges(pair, '1d', 30),
        calculateRanges(pair, '1w', 12),
        calculateRanges(pair, '1M', 6),
    ]);

    const currentPrice = prices[pair] || 0;

    const dailyCandles = await fetchKlines(pair, '1d', 30);
    const closes = dailyCandles.map(c => c.close);
    const sma20 = sma(closes, 20);
    const lastSma = sma20.filter(v => v !== null).pop();
    const trend = currentPrice > (lastSma || 0) ? 'ALCISTA' : 'BAJISTA';

    const volumes = dailyCandles.map(c => c.volume);
    const volPct = volPercentile(volumes);

    return {
        pair,
        current_price: currentPrice,
        trend,
        vol_percentile: volPct,
        daily,
        weekly,
        monthly,
    };
}

module.exports = { getRangesForPair, sma, percentile, volPercentile, calculateRanges };
