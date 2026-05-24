const { fetchKlines, fetchAllPrices } = require('./binance');
const { sma, percentile, volPercentile } = require('./ranges');
const { detectPhase, PHASE_STYLES } = require('./phases');

const COINS = ['BTC', 'ETH', 'SOL', 'UNI', 'JUP', 'AAVE'];
const SIGNAL_TFS = {
    'Diario': { interval: '1d', limit: 50 },
    '6H':     { interval: '6h', limit: 80 },
};

const SIGNAL_STYLES = {
    strong_buy:  { bg: 'rgba(34,197,94,0.2)',  color: '#22c55e', emoji: '🟢', label: 'Compra Fuerte' },
    buy:         { bg: 'rgba(6,182,212,0.2)',   color: '#06b6d4', emoji: '🔵', label: 'Compra' },
    strong_sell: { bg: 'rgba(239,68,68,0.2)',   color: '#ef4444', emoji: '🔴', label: 'Venta Fuerte' },
    sell:        { bg: 'rgba(234,179,8,0.2)',    color: '#eab308', emoji: '🟡', label: 'Venta' },
    watch:       { bg: 'rgba(167,139,250,0.15)', color: '#a78bfa', emoji: '👀', label: 'Vigilar' },
};

function detectWyckoff(candles) {
    if (candles.length < 10) return null;
    const recent = candles.slice(-5);
    const prior = candles.slice(-10, -5);

    const priorLow = Math.min(...prior.map(c => c.low));
    const priorHigh = Math.max(...prior.map(c => c.high));

    const lastCandle = recent[recent.length - 1];
    const prevCandle = recent[recent.length - 2];

    if (prevCandle.low < priorLow && lastCandle.close > priorLow) {
        return 'spring';
    }

    if (prevCandle.high > priorHigh && lastCandle.close < priorHigh) {
        return 'upthrust';
    }

    return null;
}

function findNearestLevels(candles, currentPrice) {
    const swingHighs = [];
    const swingLows = [];

    for (let i = 2; i < candles.length - 2; i++) {
        if (candles[i].high > candles[i - 1].high &&
            candles[i].high > candles[i - 2].high &&
            candles[i].high > candles[i + 1].high &&
            candles[i].high > candles[i + 2].high) {
            swingHighs.push(candles[i].high);
        }
        if (candles[i].low < candles[i - 1].low &&
            candles[i].low < candles[i - 2].low &&
            candles[i].low < candles[i + 1].low &&
            candles[i].low < candles[i + 2].low) {
            swingLows.push(candles[i].low);
        }
    }

    const supports = swingLows.filter(l => l < currentPrice).sort((a, b) => b - a);
    const resists = swingHighs.filter(h => h > currentPrice).sort((a, b) => a - b);

    return {
        nearest_support: supports[0] || null,
        nearest_resist: resists[0] || null,
    };
}

function generateSignal(candles, currentPrice, phase) {
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const lows = candles.map(c => c.low);
    const highs = candles.map(c => c.high);

    const sma20 = sma(closes, 20);
    const lastSma = sma20.filter(v => v !== null).pop() || currentPrice;
    const smaDistance = ((currentPrice - lastSma) / lastSma) * 100;

    const sup = percentile(lows, 10);
    const res = percentile(highs, 90);
    const range = res - sup;
    const posInRange = range > 0 ? ((currentPrice - sup) / range) * 100 : 50;

    const volPct = volPercentile(volumes);
    const wyckoff = detectWyckoff(candles);
    const levels = findNearestLevels(candles, currentPrice);

    let score = 50;
    const reasons = [];

    if (phase.type === 'bull') { score += 10; reasons.push('Fase alcista activa'); }
    if (phase.type === 'bear') { score -= 10; reasons.push('Fase bajista activa'); }
    if (phase.type === 'accumulation') { score += 15; reasons.push('Zona de acumulación'); }
    if (phase.type === 'distribution') { score -= 15; reasons.push('Zona de distribución'); }

    if (posInRange < 20) { score += 15; reasons.push('Precio cerca de soporte'); }
    else if (posInRange > 80) { score -= 15; reasons.push('Precio cerca de resistencia'); }

    if (smaDistance > 0 && smaDistance < 2) { score += 5; reasons.push('Precio ligeramente sobre SMA20'); }
    if (smaDistance < 0 && smaDistance > -2) { score += 5; reasons.push('Cerca de cruce alcista SMA20'); }
    if (smaDistance < -5) { score -= 10; reasons.push('Lejos por debajo de SMA20'); }
    if (smaDistance > 5) { score -= 5; reasons.push('Sobreextendido sobre SMA20'); }

    if (volPct > 75) { score += 5; reasons.push(`Volumen alto (percentil ${volPct}%)`); }

    if (wyckoff === 'spring') { score += 15; reasons.push('Patrón Spring detectado (alcista)'); }
    if (wyckoff === 'upthrust') { score -= 15; reasons.push('Patrón Upthrust detectado (bajista)'); }

    score = Math.max(0, Math.min(100, score));

    let signalType, style;
    if (score >= 75) { signalType = 'strong_buy'; style = SIGNAL_STYLES.strong_buy; }
    else if (score >= 60) { signalType = 'buy'; style = SIGNAL_STYLES.buy; }
    else if (score <= 25) { signalType = 'strong_sell'; style = SIGNAL_STYLES.strong_sell; }
    else if (score <= 40) { signalType = 'sell'; style = SIGNAL_STYLES.sell; }
    else { signalType = 'watch'; style = SIGNAL_STYLES.watch; }

    return {
        signal_type: signalType,
        score,
        reasons,
        sma20_distance: parseFloat(smaDistance.toFixed(2)),
        nearest_support: levels.nearest_support,
        nearest_resist: levels.nearest_resist,
        wyckoff_pattern: wyckoff,
        current_phase: phase.phase,
        phase_style: PHASE_STYLES[phase.type],
        style,
    };
}

async function getSignals() {
    const prices = await fetchAllPrices();
    const signals = [];

    for (const coin of COINS) {
        const pair = coin + 'USDT';
        const price = prices[pair];
        if (!price) continue;

        for (const [tfLabel, { interval, limit }] of Object.entries(SIGNAL_TFS)) {
            try {
                const candles = await fetchKlines(pair, interval, limit);
                const phase = detectPhase(candles, price);
                const signal = generateSignal(candles, price, phase);

                if (signal.signal_type !== 'watch') {
                    signals.push({
                        coin,
                        timeframe: tfLabel,
                        price,
                        created_at: new Date().toISOString(),
                        ...signal,
                    });
                }
            } catch (_) {}
        }
    }

    signals.sort((a, b) => b.score - a.score);

    return {
        calculated_at: new Date().toISOString(),
        signals,
    };
}

module.exports = { getSignals };
