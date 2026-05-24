const { fetchKlines, fetchAllPrices } = require('./binance');
const { sma } = require('./ranges');

const COINS = ['BTC', 'ETH', 'SOL', 'UNI', 'JUP', 'AAVE'];
const TF_MAP = {
    'Mensual': { interval: '1M', limit: 30 },
    'Semanal': { interval: '1w', limit: 30 },
    'Diario':  { interval: '1d', limit: 50 },
    '6H':      { interval: '6h', limit: 80 },
};

const PHASE_STYLES = {
    bull:         { bg: 'rgba(34,197,94,0.15)',  color: '#22c55e', emoji: '🟢' },
    bear:         { bg: 'rgba(239,68,68,0.15)',  color: '#ef4444', emoji: '🔴' },
    accumulation: { bg: 'rgba(59,130,246,0.15)', color: '#3b82f6', emoji: '🔵' },
    distribution: { bg: 'rgba(234,179,8,0.15)',  color: '#eab308', emoji: '🟡' },
    range:        { bg: 'rgba(156,163,175,0.12)', color: '#9ca3af', emoji: '⚪' },
};

function smaSlope(smaValues, lookback = 5) {
    const valid = smaValues.filter(v => v !== null);
    if (valid.length < lookback) return 0;
    const recent = valid.slice(-lookback);
    return (recent[recent.length - 1] - recent[0]) / recent[0] * 100;
}

function hasHigherHighs(highs, count = 3) {
    const last = highs.slice(-count);
    for (let i = 1; i < last.length; i++) {
        if (last[i] <= last[i - 1]) return false;
    }
    return true;
}

function hasLowerLows(lows, count = 3) {
    const last = lows.slice(-count);
    for (let i = 1; i < last.length; i++) {
        if (last[i] >= last[i - 1]) return false;
    }
    return true;
}

function atr(candles, period = 14) {
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const prevClose = candles[i - 1].close;
        const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
        trs.push(tr);
    }
    if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / (trs.length || 1);
    const recent = trs.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / period;
}

function detectPhase(candles, currentPrice) {
    if (candles.length < 20) {
        return { type: 'range', phase: 'Datos insuficientes', reason: 'Se necesitan al menos 20 velas' };
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const sma20 = sma(closes, 20);
    const lastSma = sma20.filter(v => v !== null).pop();
    const slope = smaSlope(sma20);
    const aboveSma = currentPrice > lastSma;

    const recentATR = atr(candles.slice(-5), 5);
    const fullATR = atr(candles.slice(-20), 20);
    const rangeContracting = recentATR < fullATR * 0.7;

    const hh = hasHigherHighs(highs.slice(-5));
    const ll = hasLowerLows(lows.slice(-5));

    if (aboveSma && slope > 0.5 && hh) {
        return {
            type: 'bull',
            phase: 'Etapa 2 — Avance',
            reason: 'Precio por encima de SMA20, pendiente positiva, máximos crecientes',
        };
    }

    if (!aboveSma && slope < -0.5 && ll) {
        return {
            type: 'bear',
            phase: 'Etapa 4 — Declive',
            reason: 'Precio por debajo de SMA20, pendiente negativa, mínimos decrecientes',
        };
    }

    if (!aboveSma && Math.abs(slope) < 0.5 && rangeContracting) {
        return {
            type: 'accumulation',
            phase: 'Etapa 1 — Acumulación',
            reason: 'Precio cerca de soporte, rango comprimido, pendiente plana',
        };
    }

    if (aboveSma && Math.abs(slope) < 0.5 && rangeContracting) {
        return {
            type: 'distribution',
            phase: 'Etapa 3 — Distribución',
            reason: 'Precio cerca de resistencia, rango comprimido, pendiente plana',
        };
    }

    if (aboveSma && slope > 0.2) {
        return {
            type: 'bull',
            phase: 'Etapa 2 — Avance',
            reason: 'Precio por encima de SMA20 con tendencia alcista',
        };
    }

    if (!aboveSma && slope < -0.2) {
        return {
            type: 'bear',
            phase: 'Etapa 4 — Declive',
            reason: 'Precio por debajo de SMA20 con tendencia bajista',
        };
    }

    return {
        type: 'range',
        phase: 'Rango',
        reason: 'Sin tendencia clara, precio oscilando alrededor de SMA20',
    };
}

async function getAnalysis() {
    const prices = await fetchAllPrices();
    const timeframes = Object.keys(TF_MAP);
    const results = {};

    for (const coin of COINS) {
        results[coin] = {};
        const pair = coin + 'USDT';
        const price = prices[pair] || 0;

        for (const tf of timeframes) {
            try {
                const { interval, limit } = TF_MAP[tf];
                const candles = await fetchKlines(pair, interval, limit);
                const phase = detectPhase(candles, price);
                results[coin][tf] = {
                    type: phase.type,
                    phase: phase.phase,
                    reason: phase.reason,
                    price,
                    style: PHASE_STYLES[phase.type] || PHASE_STYLES.range,
                    is_stale: false,
                };
            } catch (e) {
                results[coin][tf] = {
                    type: 'range',
                    phase: 'Error',
                    reason: e.message,
                    price,
                    style: PHASE_STYLES.range,
                    is_stale: true,
                };
            }
        }
    }

    return {
        calculated_at: new Date().toISOString(),
        coins: COINS,
        timeframes,
        results,
    };
}

module.exports = { getAnalysis, detectPhase, PHASE_STYLES, TF_MAP, COINS };
