const { fetchKlines, fetchAllPrices } = require('./binance');
const { sma, findMR, findmR, filterCredible, smaSlope, detectTrainTracks } = require('./ranges');

const COINS = ['BTC', 'ETH', 'SOL', 'UNI', 'JUP', 'AAVE'];
const TF_MAP = {
    'Mensual': { interval: '1M', limit: 50 },
    'Semanal': { interval: '1w', limit: 60 },
    'Diario':  { interval: '1d', limit: 250 },
    '6H':      { interval: '6h', limit: 250 },
    '1H':      { interval: '1h', limit: 250 },
    '15M':     { interval: '15m', limit: 250 },
};

const PHASE_STYLES = {
    bull:         { bg: 'rgba(34,197,94,0.15)',  color: '#22c55e', emoji: '🟢' },
    bear:         { bg: 'rgba(239,68,68,0.15)',  color: '#ef4444', emoji: '🔴' },
    accumulation: { bg: 'rgba(59,130,246,0.15)', color: '#3b82f6', emoji: '🔵' },
    distribution: { bg: 'rgba(234,179,8,0.15)',  color: '#eab308', emoji: '🟡' },
};

// ═══════════════════════════════════════════════════════════════
// POWER 4 — Helper detection functions
// ═══════════════════════════════════════════════════════════════

function sma20Color(sma20Arr) {
    const valid = sma20Arr.filter(v => v !== null);
    if (valid.length < 2) return 'flat';
    const last = valid[valid.length - 1];
    const prev = valid[valid.length - 2];
    if (last > prev) return 'green';
    if (last < prev) return 'red';
    return 'flat';
}

function countSMA20Crosses(candles, sma20Arr, lookback = 15) {
    let crosses = 0;
    const start = Math.max(0, candles.length - lookback);
    for (let i = start + 1; i < candles.length; i++) {
        const s = sma20Arr[i], sp = sma20Arr[i - 1];
        if (s === null || sp === null) continue;
        const aboveNow = candles[i].close > s;
        const abovePrev = candles[i - 1].close > sp;
        if (aboveNow !== abovePrev) crosses++;
    }
    return crosses;
}

function risingmR(pivots) {
    if (pivots.length < 2) return false;
    const last = pivots.slice(-3);
    for (let i = 1; i < last.length; i++) {
        if (last[i].v <= last[i - 1].v) return false;
    }
    return true;
}

function decliningMR(pivots) {
    if (pivots.length < 2) return false;
    const last = pivots.slice(-3);
    for (let i = 1; i < last.length; i++) {
        if (last[i].v >= last[i - 1].v) return false;
    }
    return true;
}

// How many MR levels did the last candle break in a single close?
function countBrokenMR(mrs, lastClose) {
    return mrs.filter(m => lastClose > m.v).length;
}

// How many mR levels did the last candle break downward?
function countBrokenmR(mrs_low, lastClose) {
    return mrs_low.filter(m => lastClose < m.v).length;
}

// Regla del 90%: did the retrace consume 80-90%+ of the prior impulse?
function retraceRatio(candles, lookback = 20) {
    if (candles.length < lookback) return 0;
    const recent = candles.slice(-lookback);
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    const maxH = Math.max(...highs);
    const minL = Math.min(...lows);
    const impulse = maxH - minL;
    if (impulse <= 0) return 0;

    const maxIdx = highs.indexOf(maxH);
    const minIdx = lows.indexOf(minL);

    const lastClose = candles[candles.length - 1].close;

    if (maxIdx < minIdx) {
        // downward impulse, retrace upward
        const retrace = lastClose - minL;
        return retrace / impulse;
    } else {
        // upward impulse, retrace downward
        const retrace = maxH - lastClose;
        return retrace / impulse;
    }
}

// Acunamiento (Cradling): price pulls back to rising SMA20 but doesn't close below it
function detectCradling(candles, sma20Arr) {
    if (candles.length < 5) return false;
    const last5 = candles.slice(-5);
    const smaSlice = sma20Arr.slice(-5);

    let touchedSMA = false;
    let closedBelow = false;

    for (let i = 0; i < last5.length; i++) {
        const s = smaSlice[i];
        if (s === null) continue;
        if (last5[i].low <= s * 1.005) touchedSMA = true;
        if (last5[i].close < s) closedBelow = true;
    }

    return touchedSMA && !closedBelow;
}

// Trap detection (Shakeout / Checkout)
function detectTrap(candles, mrs, mrs_low) {
    if (candles.length < 3) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    // Shakeout: prev candle broke below a mR support, but last candle closed above it
    for (const m of mrs_low.slice(-3)) {
        if (prev.close < m.v && prev.low < m.v && last.close > m.v) {
            return { type: 'shakeout', level: m.v };
        }
    }

    // Checkout: prev candle broke above a MR resistance, but last candle closed below it
    for (const m of mrs.slice(-3)) {
        if (prev.close > m.v && prev.high > m.v && last.close < m.v) {
            return { type: 'checkout', level: m.v };
        }
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════
// POWER 4 — Main stage detection
// ═══════════════════════════════════════════════════════════════

function detectPhase(candles, currentPrice) {
    if (candles.length < 45) {
        return { type: 'accumulation', phase: 'Etapa 1 — Acumulación (datos limitados)', reason: 'Menos de 45 velas disponibles — asignado E1 por defecto' };
    }

    const closes = candles.map(c => c.close);
    const sma20Arr = sma(closes, 20);
    const sma40Arr = sma(closes, 40);

    const lastSma20 = sma20Arr.filter(v => v !== null).pop();
    const lastSma40 = sma40Arr.filter(v => v !== null).pop();
    const slope20 = smaSlope(sma20Arr, 5);
    const slope40 = smaSlope(sma40Arr, 5);
    const tracks = detectTrainTracks(sma20Arr, sma40Arr);
    const color = sma20Color(sma20Arr);
    const aboveSma20 = currentPrice > lastSma20;
    const sma20Flat = Math.abs(slope20) < 0.3;

    const allMR = findMR(candles);
    const allmR = findmR(candles);
    const credMR = filterCredible(allMR, sma20Arr);
    const credmR = filterCredible(allmR, sma20Arr);

    const crosses = countSMA20Crosses(candles, sma20Arr, 15);
    const retrace = retraceRatio(candles, 20);
    const trap = detectTrap(candles, allMR, allmR);
    const cradling = detectCradling(candles, sma20Arr);

    const reasons = [];

    // ── Paso Directo: single candle wiped 2+ levels ──
    const lastCandle = candles[candles.length - 1];
    const recentMR = allMR.slice(-4);
    const recentmR = allmR.slice(-4);

    const brokenMRcount = recentMR.filter(m => lastCandle.close > m.v && candles[candles.length - 2]?.close <= m.v).length;
    const brokenmRcount = recentmR.filter(m => lastCandle.close < m.v && candles[candles.length - 2]?.close >= m.v).length;

    if (brokenMRcount >= 2) {
        return {
            type: 'bull',
            phase: 'Etapa 2 — Paso Directo',
            reason: `Ruptura explosiva: ${brokenMRcount} MR superados en una vela. Salto directo a E2`,
        };
    }
    if (brokenmRcount >= 2) {
        return {
            type: 'bear',
            phase: 'Etapa 4 — Paso Directo',
            reason: `Ruptura explosiva: ${brokenmRcount} mR perdidos en una vela. Salto directo a E4`,
        };
    }

    // ── Trampa (Shakeout / Checkout) ──
    if (trap) {
        if (trap.type === 'shakeout') {
            reasons.push(`Shakeout detectado en ${trap.level.toFixed(2)}: falsa ruptura de soporte, cierre por encima`);
            return {
                type: 'bull',
                phase: 'Etapa 2 — Trampa alcista (Shakeout)',
                reason: reasons[0],
            };
        }
        if (trap.type === 'checkout') {
            reasons.push(`Checkout detectado en ${trap.level.toFixed(2)}: falsa ruptura de resistencia, cierre por debajo`);
            return {
                type: 'bear',
                phase: 'Etapa 4 — Trampa bajista (Checkout)',
                reason: reasons[0],
            };
        }
    }

    // ── Regla del 90% ──
    if (retrace >= 0.80) {
        if (aboveSma20 && slope20 < 0) {
            return {
                type: 'distribution',
                phase: 'Etapa 3 — Regla del 90%',
                reason: `Retroceso consumió ${(retrace * 100).toFixed(0)}% del impulso previo. Cambio oficioso de etapa`,
            };
        }
        if (!aboveSma20 && slope20 > 0) {
            return {
                type: 'accumulation',
                phase: 'Etapa 1 — Regla del 90%',
                reason: `Retroceso consumió ${(retrace * 100).toFixed(0)}% del impulso previo. Cambio oficioso de etapa`,
            };
        }
    }

    // ── Strong price signal: price far from SMA20 ──
    // This catches cases where SMA20/SMA40 slope hasn't turned yet
    // (e.g. BTC drops from 108k to 76k but monthly SMA20 still rising from 20 months of uptrend)
    const priceSmaDistance = ((currentPrice - lastSma20) / lastSma20) * 100;

    // >15% below SMA20 = E4 regardless of slope (the drop is undeniable)
    if (priceSmaDistance < -15) {
        return {
            type: 'bear',
            phase: 'Etapa 4 — Declive',
            reason: `Precio ${priceSmaDistance.toFixed(1)}% por debajo de SMA20. Caída severa sin importar la pendiente de las medias`,
        };
    }
    if (priceSmaDistance > 15) {
        return {
            type: 'bull',
            phase: 'Etapa 2 — Avance',
            reason: `Precio +${priceSmaDistance.toFixed(1)}% por encima de SMA20. Subida fuerte sin importar la pendiente de las medias`,
        };
    }

    // 5-15% below: check slope direction for E4 vs E3
    if (priceSmaDistance < -5) {
        if (slope20 < 0) {
            return {
                type: 'bear',
                phase: 'Etapa 4 — Declive',
                reason: `Precio ${priceSmaDistance.toFixed(1)}% por debajo de SMA20. SMA20 con pendiente negativa (${slope20.toFixed(2)}%)`,
            };
        }
        // Price dropped but SMA20 still rising → distribution turning into decline
        return {
            type: 'distribution',
            phase: 'Etapa 3 — Distribución (cayendo)',
            reason: `Precio ${priceSmaDistance.toFixed(1)}% por debajo de SMA20 pero SMA20 aún con pendiente positiva. Transición de E3 a E4 inminente`,
        };
    }

    if (priceSmaDistance > 5) {
        if (slope20 > 0) {
            return {
                type: 'bull',
                phase: 'Etapa 2 — Avance',
                reason: `Precio +${priceSmaDistance.toFixed(1)}% por encima de SMA20. SMA20 con pendiente positiva (+${slope20.toFixed(2)}%)`,
            };
        }
        return {
            type: 'accumulation',
            phase: 'Etapa 1 — Acumulación (rebotando)',
            reason: `Precio +${priceSmaDistance.toFixed(1)}% por encima de SMA20 pero SMA20 aún bajando. Posible inicio de E1`,
        };
    }

    // ── Price below SMA20 with clear negative slope ──
    if (!aboveSma20 && slope20 < -0.5 && color === 'red') {
        const reasons = ['Precio por debajo de SMA20 roja', `Pendiente SMA20: ${slope20.toFixed(2)}%`];
        if (slope40 < 0) {
            reasons.push('SMA40 también bajando');
            return { type: 'bear', phase: 'Etapa 4 — Declive', reason: reasons.join('. ') };
        }
        reasons.push('SMA40 aún no confirma (retrasada)');
        return { type: 'bear', phase: 'Etapa 4 — Declive (temprano)', reason: reasons.join('. ') };
    }

    if (aboveSma20 && slope20 > 0.5 && color === 'green') {
        const reasons = ['Precio por encima de SMA20 verde', `Pendiente SMA20: +${slope20.toFixed(2)}%`];
        if (slope40 > 0) {
            reasons.push('SMA40 también subiendo');
            return { type: 'bull', phase: 'Etapa 2 — Avance', reason: reasons.join('. ') };
        }
        reasons.push('SMA40 aún no confirma (retrasada)');
        return { type: 'bull', phase: 'Etapa 2 — Avance (temprano)', reason: reasons.join('. ') };
    }

    // ── E2: Alcista (with full train tracks) ──
    if (tracks === 'up' && aboveSma20 && color === 'green') {
        reasons.push('Vías del tren alcistas (SMA20 y SMA40 subiendo en paralelo)');
        reasons.push('Precio por encima de SMA20 verde');
        if (risingmR(allmR)) reasons.push('Mínimos relevantes (mR) crecientes');
        if (cradling) reasons.push('Acunamiento detectado: precio se apoya en SMA20 sin perderla');

        let quality = '';
        if (risingmR(allmR) && Math.abs(slope20 - slope40) < 0.5) quality = ' [Alta calidad]';

        if (candles.length >= 200) {
            const sma200 = sma(closes, 200);
            const last200 = sma200.filter(v => v !== null).pop();
            if (last200 && currentPrice > last200) {
                reasons.push('SMA200 por debajo del precio (soporte de fondo)');
            }
        }

        return { type: 'bull', phase: `Etapa 2 — Avance${quality}`, reason: reasons.join('. ') };
    }

    // ── E4: Bajista ──
    if (tracks === 'down' && !aboveSma20 && color === 'red') {
        reasons.push('Vías del tren bajistas (SMA20 y SMA40 bajando en paralelo)');
        reasons.push('Precio por debajo de SMA20 roja');
        if (decliningMR(allMR)) reasons.push('Máximos relevantes (MR) decrecientes');

        let quality = '';
        if (decliningMR(allMR) && Math.abs(slope20 - slope40) < 0.5) quality = ' [Alta calidad]';

        return { type: 'bear', phase: `Etapa 4 — Declive${quality}`, reason: reasons.join('. ') };
    }

    // ── E3: Distribución ──
    // Price loses first mR after uptrend, or SMA20 flattening above SMA40 with erratic crosses
    if (lastSma20 > lastSma40) {
        // Check if price lost first mR
        const lostmR = credmR.length > 0 && currentPrice < credmR[credmR.length - 1].v;

        if ((sma20Flat && crosses >= 2) || lostmR) {
            reasons.push('SMA20 aplanándose tras tendencia alcista');
            if (crosses >= 2) reasons.push(`Precio cortando SMA20 erráticamente (${crosses} cruces)`);
            if (lostmR) reasons.push(`Precio perdió mR credible en ${credmR[credmR.length - 1].v.toFixed(2)} — confirma E3`);
            reasons.push('SMA20 aún por encima de SMA40');

            return { type: 'distribution', phase: 'Etapa 3 — Distribución', reason: reasons.join('. ') };
        }
    }

    // ── E1: Acumulación ──
    // Price breaks first MR after downtrend, or SMA20 flattening below SMA40
    if (lastSma20 <= lastSma40) {
        const brokeMR = credMR.length > 0 && currentPrice > credMR[credMR.length - 1].v;

        if ((sma20Flat && crosses >= 2) || brokeMR) {
            reasons.push('SMA20 aplanándose tras tendencia bajista');
            if (crosses >= 2) reasons.push(`Precio cortando SMA20 erráticamente (${crosses} cruces)`);
            if (brokeMR) reasons.push(`Precio superó MR credible en ${credMR[credMR.length - 1].v.toFixed(2)} — confirma E1`);
            reasons.push('SMA20 por debajo o al nivel de SMA40');

            return { type: 'accumulation', phase: 'Etapa 1 — Acumulación', reason: reasons.join('. ') };
        }
    }

    // ── E2 temprana (Acunamiento / slope positive) ──
    if (aboveSma20 && slope20 > 0.2 && color === 'green') {
        if (cradling) {
            return {
                type: 'bull',
                phase: 'Etapa 2 — Acunamiento',
                reason: 'Precio retrocede a SMA20 alcista sin perderla a cierre. Preludio de ruptura',
            };
        }
        return {
            type: 'bull',
            phase: 'Etapa 2 — Avance (temprano)',
            reason: 'SMA20 verde y precio encima. Vías del tren formándose',
        };
    }

    // ── E4 temprana ──
    if (!aboveSma20 && slope20 < -0.2 && color === 'red') {
        return {
            type: 'bear',
            phase: 'Etapa 4 — Declive (temprano)',
            reason: 'SMA20 roja y precio debajo. Vías del tren bajistas formándose',
        };
    }

    // ── Broad E3/E1 ──
    if (lastSma20 > lastSma40 && sma20Flat) {
        return {
            type: 'distribution',
            phase: 'Etapa 3 — Distribución',
            reason: 'SMA20 aplanándose por encima de SMA40',
        };
    }

    if (lastSma20 <= lastSma40 && sma20Flat) {
        return {
            type: 'accumulation',
            phase: 'Etapa 1 — Acumulación',
            reason: 'SMA20 aplanándose por debajo de SMA40',
        };
    }

    // No "Rango" — always assign one of the 4 stages
    // If price is above SMA20 → leaning bullish side (E1 or E2)
    // If price is below SMA20 → leaning bearish side (E3 or E4)
    if (aboveSma20) {
        if (slope20 > 0) {
            return { type: 'bull', phase: 'Etapa 2 — Avance (débil)', reason: `Precio sobre SMA20 con pendiente positiva (${slope20.toFixed(2)}%). Sin confirmación completa de vías del tren` };
        }
        return { type: 'accumulation', phase: 'Etapa 1 — Acumulación', reason: `Precio sobre SMA20 pero pendiente aún no positiva (${slope20.toFixed(2)}%). Posible formación de base` };
    } else {
        if (slope20 < 0) {
            return { type: 'bear', phase: 'Etapa 4 — Declive (débil)', reason: `Precio bajo SMA20 con pendiente negativa (${slope20.toFixed(2)}%). Sin confirmación completa de vías del tren` };
        }
        return { type: 'distribution', phase: 'Etapa 3 — Distribución', reason: `Precio bajo SMA20 pero pendiente aún no negativa (${slope20.toFixed(2)}%). Posible techo formándose` };
    }
}

// ═══════════════════════════════════════════════════════════════
// ANALYSIS ENDPOINT
// ═══════════════════════════════════════════════════════════════

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
                    style: PHASE_STYLES[phase.type] || PHASE_STYLES.accumulation,
                    is_stale: false,
                };
            } catch (e) {
                results[coin][tf] = {
                    type: 'accumulation',
                    phase: 'Error',
                    reason: e.message,
                    price,
                    style: PHASE_STYLES.accumulation,
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
