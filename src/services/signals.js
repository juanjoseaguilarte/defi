const { fetchKlines, fetchAllPrices } = require('./binance');
const { sma, findMR, findmR, volPercentile } = require('./ranges');
const { detectPhase, PHASE_STYLES } = require('./phases');

const COINS = ['BTC', 'ETH', 'SOL', 'UNI', 'JUP', 'AAVE'];
const SIGNAL_TFS = {
    'Diario': { interval: '1d', limit: 250 },
    '6H':     { interval: '6h', limit: 250 },
};

const SIGNAL_STYLES = {
    strong_buy:  { bg: 'rgba(34,197,94,0.2)',  color: '#22c55e', emoji: '🟢', label: 'Compra Fuerte' },
    buy:         { bg: 'rgba(6,182,212,0.2)',   color: '#06b6d4', emoji: '🔵', label: 'Compra' },
    strong_sell: { bg: 'rgba(239,68,68,0.2)',   color: '#ef4444', emoji: '🔴', label: 'Venta Fuerte' },
    sell:        { bg: 'rgba(234,179,8,0.2)',    color: '#eab308', emoji: '🟡', label: 'Venta' },
    watch:       { bg: 'rgba(167,139,250,0.15)', color: '#a78bfa', emoji: '👀', label: 'Vigilar' },
};

function generateSignal(candles, currentPrice, phase) {
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    const sma20 = sma(closes, 20);
    const lastSma = sma20.filter(v => v !== null).pop() || currentPrice;
    const smaDistance = ((currentPrice - lastSma) / lastSma) * 100;

    const mrs = findMR(candles);
    const mrs_low = findmR(candles);

    const supports = mrs_low.filter(m => m.v < currentPrice).sort((a, b) => b.v - a.v);
    const resists = mrs.filter(m => m.v > currentPrice).sort((a, b) => a.v - b.v);
    const nearest_support = supports[0]?.v || null;
    const nearest_resist = resists[0]?.v || null;

    const volPct = volPercentile(volumes);

    let score = 50;
    const reasons = [];

    // Phase alignment
    if (phase.type === 'bull') { score += 12; reasons.push('Etapa 2 activa (alcista)'); }
    if (phase.type === 'bear') { score -= 12; reasons.push('Etapa 4 activa (bajista)'); }
    if (phase.type === 'accumulation') { score += 15; reasons.push('Etapa 1 — zona de acumulación'); }
    if (phase.type === 'distribution') { score -= 15; reasons.push('Etapa 3 — zona de distribución'); }

    // Traps and special phases
    if (phase.phase.includes('Shakeout')) { score += 18; reasons.push('Shakeout: trampa alcista confirmada'); }
    if (phase.phase.includes('Checkout')) { score -= 18; reasons.push('Checkout: trampa bajista confirmada'); }
    if (phase.phase.includes('Acunamiento')) { score += 10; reasons.push('Acunamiento: precio apoyándose en SMA20'); }
    if (phase.phase.includes('Paso Directo') && phase.type === 'bull') { score += 15; reasons.push('Paso directo alcista'); }
    if (phase.phase.includes('Paso Directo') && phase.type === 'bear') { score -= 15; reasons.push('Paso directo bajista'); }
    if (phase.phase.includes('90%')) { score += (phase.type === 'accumulation' ? 8 : -8); }

    // SMA20 distance
    if (smaDistance > 0 && smaDistance < 2) { score += 5; reasons.push('Precio ligeramente sobre SMA20'); }
    if (smaDistance < 0 && smaDistance > -2) { score += 5; reasons.push('Cerca de cruce alcista SMA20'); }
    if (smaDistance < -5) { score -= 8; reasons.push('Lejos por debajo de SMA20'); }
    if (smaDistance > 5) { score -= 5; reasons.push('Sobreextendido sobre SMA20'); }

    // Position relative to MR/mR levels
    if (nearest_support && nearest_resist) {
        const range = nearest_resist - nearest_support;
        if (range > 0) {
            const posInRange = ((currentPrice - nearest_support) / range) * 100;
            if (posInRange < 20) { score += 10; reasons.push('Precio cerca de mR (soporte relevante)'); }
            else if (posInRange > 80) { score -= 10; reasons.push('Precio cerca de MR (resistencia relevante)'); }
        }
    }

    // Volume
    if (volPct > 75) { score += 5; reasons.push(`Volumen alto (percentil ${volPct}%)`); }

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
        nearest_support,
        nearest_resist,
        wyckoff_pattern: phase.phase.includes('Shakeout') ? 'spring' : (phase.phase.includes('Checkout') ? 'upthrust' : null),
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
