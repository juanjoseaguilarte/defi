const { fetchKlines, fetchAllPrices } = require('./binance');

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// POWER 4 — Pivot 3+3 for MR (Relevant Highs) and mR (Relevant Lows)
// ═══════════════════════════════════════════════════════════════

function findMR(candles) {
    const results = [];
    for (let i = 3; i < candles.length - 3; i++) {
        const h = candles[i].high;
        if (h > candles[i - 1].high && h > candles[i - 2].high && h > candles[i - 3].high &&
            h > candles[i + 1].high && h > candles[i + 2].high && h > candles[i + 3].high) {
            results.push({ i, v: h, ts: candles[i].ts });
        }
    }
    return results;
}

function findmR(candles) {
    const results = [];
    for (let i = 3; i < candles.length - 3; i++) {
        const l = candles[i].low;
        if (l < candles[i - 1].low && l < candles[i - 2].low && l < candles[i - 3].low &&
            l < candles[i + 1].low && l < candles[i + 2].low && l < candles[i + 3].low) {
            results.push({ i, v: l, ts: candles[i].ts });
        }
    }
    return results;
}

function filterCredible(pivots, sma20Values) {
    return pivots.filter(p => {
        const smaVal = sma20Values[p.i];
        if (smaVal === null || smaVal === undefined) return true;
        const distance = Math.abs(p.v - smaVal) / smaVal;
        return distance <= 0.04;
    });
}

// ═══════════════════════════════════════════════════════════════
// POWER 4 — Train Tracks (Vías del Tren)
// ═══════════════════════════════════════════════════════════════

function smaSlope(smaArr, lookback = 5) {
    const valid = smaArr.filter(v => v !== null);
    if (valid.length < lookback) return 0;
    const recent = valid.slice(-lookback);
    return (recent[recent.length - 1] - recent[0]) / recent[0] * 100;
}

function detectTrainTracks(sma20Arr, sma40Arr) {
    const s20 = sma20Arr.filter(v => v !== null);
    const s40 = sma40Arr.filter(v => v !== null);
    if (s20.length < 5 || s40.length < 5) return 'none';

    const slope20 = smaSlope(sma20Arr, 5);
    const slope40 = smaSlope(sma40Arr, 5);

    const last20 = s20[s20.length - 1];
    const last40 = s40[s40.length - 1];

    if (slope20 > 0.15 && slope40 > 0.1 && last20 > last40) return 'up';
    if (slope20 < -0.15 && slope40 < -0.1 && last20 < last40) return 'down';
    return 'none';
}

// ═══════════════════════════════════════════════════════════════
// RANGE CALCULATION — Power 4 (MR/mR pivots as sup/res)
// ═══════════════════════════════════════════════════════════════

function calculateRangesFromCandles(candles, currentPrice) {
    if (candles.length < 10) return null;

    const closes = candles.map(c => c.close);
    const sma20 = sma(closes, 20);

    const mrs = findMR(candles);
    const mrs_low = findmR(candles);

    let sup, res;

    // Support = most recent mR below price, fallback to most recent mR, fallback to lowest low
    const mrsBelow = mrs_low.filter(m => m.v <= currentPrice);
    if (mrsBelow.length > 0) {
        sup = mrsBelow[mrsBelow.length - 1].v;
    } else if (mrs_low.length > 0) {
        sup = mrs_low[mrs_low.length - 1].v;
    } else {
        sup = Math.min(...candles.slice(-20).map(c => c.low));
    }

    // Resistance = nearest MR above price, fallback to most recent MR, fallback to highest high
    const mrsAbove = mrs.filter(m => m.v >= currentPrice);
    if (mrsAbove.length > 0) {
        res = mrsAbove[0].v;
    } else if (mrs.length > 0) {
        res = mrs[mrs.length - 1].v;
    } else {
        res = Math.max(...candles.slice(-20).map(c => c.high));
    }

    if (sup >= res) {
        sup = Math.min(...candles.slice(-10).map(c => c.low));
        res = Math.max(...candles.slice(-10).map(c => c.high));
    }

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
    const [prices, dailyCandles, weeklyCandles, monthlyCandles] = await Promise.all([
        fetchAllPrices(),
        fetchKlines(pair, '1d', 250),
        fetchKlines(pair, '1w', 60),
        fetchKlines(pair, '1M', 24),
    ]);

    const currentPrice = prices[pair] || 0;

    const daily = calculateRangesFromCandles(dailyCandles, currentPrice);
    const weekly = calculateRangesFromCandles(weeklyCandles, currentPrice);
    const monthly = calculateRangesFromCandles(monthlyCandles, currentPrice);

    // Train tracks from daily SMA20/SMA40
    const closes = dailyCandles.map(c => c.close);
    const sma20 = sma(closes, 20);
    const sma40 = sma(closes, 40);
    const tracks = detectTrainTracks(sma20, sma40);

    let trend;
    if (tracks === 'up') trend = 'ALCISTA';
    else if (tracks === 'down') trend = 'BAJISTA';
    else trend = 'LATERAL';

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

module.exports = {
    getRangesForPair,
    sma, percentile, volPercentile,
    findMR, findmR, filterCredible,
    smaSlope, detectTrainTracks,
    calculateRangesFromCandles,
};
