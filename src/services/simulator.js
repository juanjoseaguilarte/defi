const { getDb } = require('../../db/init');
const { sma, smaSlope, detectTrainTracks } = require('./ranges');

const AAVE_BORROW_APY = { ETH: 3.2, BTC: 1.5 };
const AAVE_LTV_USDC = 0.80;
const LP_FEE_DAILY = 25 / 100 / 365;

const COOLDOWN_DAYS = 5;
const MIN_HOLD_DAYS = 7;
const SHORT_LEV = 3;

function detectPhaseFromCandles(candles, price) {
    if (candles.length < 45) return 'accumulation';
    const closes = candles.map(c => c.close);
    const sma20 = sma(closes, 20);
    const sma40 = sma(closes, 40);
    const last20 = sma20.filter(v => v !== null).pop();
    const last40 = sma40.filter(v => v !== null).pop();
    const slope20 = smaSlope(sma20, 5);
    const dist = ((price - last20) / last20) * 100;
    if (dist < -15) return 'bear';
    if (dist > 15) return 'bull';
    if (dist < -5) return slope20 < 0 ? 'bear' : 'distribution';
    if (dist > 5) return slope20 > 0 ? 'bull' : 'accumulation';
    const tracks = detectTrainTracks(sma20, sma40);
    if (tracks === 'up' && price > last20) return 'bull';
    if (tracks === 'down' && price < last20) return 'bear';
    if (last20 > last40) return price > last20 ? 'bull' : 'distribution';
    return price > last20 ? 'accumulation' : 'bear';
}

function emptyPos() {
    return {
        aave_supply: 0, aave_borrow: 0,
        short_margin: 0, short_size: 0, short_entry: 0,
        lp_amount: 0, lp_entry: 0, lp_range_low: 0, lp_range_high: 0,
        lp_mode: null, // 'bull_ride' | 'bear_protect' | 'neutral'
    };
}

function isMajorChange(from, to) {
    if (!from) return true;
    if (from === 'bull' && to === 'bear') return true;
    if (from === 'bear' && to === 'bull') return true;
    return false;
}

function closeAll(pos, price, date, log) {
    let recovered = 0;
    if (pos.aave_supply > 0) recovered += pos.aave_supply;
    if (pos.short_margin > 0 && pos.short_entry > 0) {
        const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
        const result = Math.max(0, pos.short_margin + pnl);
        log.push({ date, type: 'close', message: `Cerrar SHORT: entrada $${pos.short_entry.toFixed(0)}, salida $${price.toFixed(0)}, P&L: $${pnl.toFixed(0)} (${(pnl / pos.short_margin * 100).toFixed(1)}%)` });
        recovered += result;
    }
    if (pos.lp_amount > 0) {
        const lpVal = getLpValue(pos, price);
        log.push({ date, type: 'close', message: `Cerrar LP (${pos.lp_mode}): valor $${lpVal.toFixed(0)}` });
        recovered += lpVal;
    }
    if (pos.aave_borrow > 0) recovered -= pos.aave_borrow;
    return recovered;
}

function closePerps(pos, price, date, log) {
    let recovered = 0;
    if (pos.short_margin > 0) {
        const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
        recovered += Math.max(0, pos.short_margin + pnl);
        log.push({ date, type: 'adjust_close', message: `Cerrar SHORT: P&L $${pnl.toFixed(0)}` });
        pos.short_margin = 0; pos.short_size = 0; pos.short_entry = 0;
    }
    return recovered;
}

// LP value based on where price is relative to range
function getLpValue(pos, price) {
    if (pos.lp_amount <= 0) return 0;
    const { lp_amount, lp_range_low, lp_range_high, lp_entry } = pos;

    if (price >= lp_range_high) {
        // Price above range: 100% USDC — you "sold" at the top
        return lp_amount; // preserved in USDC
    }
    if (price <= lp_range_low) {
        // Price below range: 100% volatile asset
        // Value = lp_amount * (price / lp_entry) approximately
        return lp_amount * (price / lp_entry);
    }
    // In range: mix of both, subject to IL
    const il = lp_amount * Math.abs(price - lp_entry) / lp_entry * 0.3;
    return Math.max(0, lp_amount - il);
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY OPEN — completely different per phase
// ═══════════════════════════════════════════════════════════════

function openStrategy(phase, cash, price, asset, pos, date, log) {
    let allocated = 0;

    if (phase === 'bear') {
        // E4: SHORT + LP con rango POR ENCIMA del precio (auto-exit a USDC)
        // Si cae → ya estás en USDC. Si sube → vendes ETH por USDC.
        const stableAmt = Math.floor(cash * 0.60);
        pos.aave_supply = stableAmt;
        allocated += stableAmt;

        // Short para beneficiarse de la caída
        const sm = Math.floor(cash * 0.15);
        pos.short_margin = sm; pos.short_size = sm * SHORT_LEV; pos.short_entry = price;
        allocated += sm;

        // LP protector: rango por encima del precio actual
        // Si el precio sube al rango → empiezas a vender ETH por USDC (auto-exit)
        // Si el precio baja → no estás en el LP, tu dinero está en USDC
        const lpAmt = Math.floor(cash * 0.20);
        pos.lp_amount = lpAmt; pos.lp_entry = price;
        pos.lp_range_low = price * 1.00; // desde el precio actual
        pos.lp_range_high = price * 1.15; // hasta +15%
        pos.lp_mode = 'bear_protect';
        allocated += lpAmt;

        log.push({ date, type: 'open', message: `E4 BAJISTA: Supply $${stableAmt} + SHORT x${SHORT_LEV} $${sm} (entrada $${price.toFixed(0)}) + LP protector $${lpAmt} rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)} (auto-exit a USDC si sube)` });

    } else if (phase === 'bull') {
        // E2: LP apalancado + rango amplio hacia arriba
        // Cuando sale por arriba → 100% USDC = take profit → remontar más arriba
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.55);
        pos.aave_borrow = borrow;

        const lpAmt = borrow;
        pos.lp_amount = lpAmt; pos.lp_entry = price;
        pos.lp_range_low = price * 0.85;  // soporte: -15%
        pos.lp_range_high = price * 1.30; // resistencia: +30%
        pos.lp_mode = 'bull_ride';
        allocated = cash;

        log.push({ date, type: 'open', message: `E2 ALCISTA: Colateral $${cash.toFixed(0)}, Borrow $${borrow}, LP $${lpAmt} rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)} (take profit si sale por arriba). Apalancado via Revert.` });

    } else if (phase === 'accumulation') {
        // E1: LP delta neutral con rango estrecho + short pequeño
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.40);
        pos.aave_borrow = borrow;

        const hedgeAmt = Math.floor(borrow * 0.08);
        const lpAmt = borrow - hedgeAmt;
        pos.lp_amount = lpAmt; pos.lp_entry = price;
        pos.lp_range_low = price * 0.88;
        pos.lp_range_high = price * 1.12;
        pos.lp_mode = 'neutral';

        pos.short_margin = hedgeAmt; pos.short_size = hedgeAmt * SHORT_LEV; pos.short_entry = price;
        allocated = cash;

        log.push({ date, type: 'open', message: `E1 ACUMULACIÓN: Colateral $${cash.toFixed(0)}, Borrow $${borrow}, LP $${lpAmt} rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)}, SHORT hedge x${SHORT_LEV} $${hedgeAmt}` });

    } else if (phase === 'distribution') {
        // E3: LP con rango sesgado abajo (auto-exit a USDC si sube) + short pequeño
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.30);
        pos.aave_borrow = borrow;

        const hedgeAmt = Math.floor(borrow * 0.10);
        const lpAmt = borrow - hedgeAmt;
        pos.lp_amount = lpAmt; pos.lp_entry = price;
        pos.lp_range_low = price * 0.85;
        pos.lp_range_high = price * 1.10; // rango corto arriba, si sube → USDC
        pos.lp_mode = 'bear_protect';

        pos.short_margin = hedgeAmt; pos.short_size = hedgeAmt * SHORT_LEV; pos.short_entry = price;
        allocated = cash;

        log.push({ date, type: 'open', message: `E3 DISTRIBUCIÓN: Colateral $${cash.toFixed(0)}, Borrow $${borrow}, LP $${lpAmt} rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)} (auto-exit USDC), SHORT hedge x${SHORT_LEV} $${hedgeAmt}` });
    }
    return allocated;
}

// ═══════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════

function runBacktest(candles, amount, asset) {
    const log = [];
    const dailyPnL = [];
    let cash = amount;
    let pos = emptyPos();
    let confirmedPhase = null;
    let pendingPhase = null;
    let pendingCount = 0;
    let strategyActive = false;
    let daysSinceOpen = 0;
    const minC = 50;

    for (let i = minC; i < candles.length; i++) {
        const price = candles[i].close;
        const date = new Date(candles[i].ts).toISOString().split('T')[0];
        const rawPhase = detectPhaseFromCandles(candles.slice(Math.max(0, i - 59), i + 1), price);

        if (strategyActive) daysSinceOpen++;

        // ── LP auto-exit detection ──
        if (strategyActive && pos.lp_amount > 0) {
            if (pos.lp_mode === 'bull_ride' && price > pos.lp_range_high) {
                // Bull LP: price exited top → take profit (100% USDC)
                const lpVal = pos.lp_amount; // 100% USDC at exit
                log.push({ date, type: 'lp_exit_top', message: `LP TAKE PROFIT: precio $${price.toFixed(0)} salió por arriba del rango ($${pos.lp_range_high.toFixed(0)}). LP = 100% USDC = $${lpVal.toFixed(0)}. Remontando LP más arriba.` });
                // Remount LP higher
                pos.lp_entry = price;
                pos.lp_range_low = price * 0.85;
                pos.lp_range_high = price * 1.30;
                log.push({ date, type: 'lp_remount', message: `LP remontado: nuevo rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)}. Coste rebalanceo: $${(lpVal * 0.005).toFixed(0)}` });
                cash -= lpVal * 0.005; // small rebalance cost

            } else if (pos.lp_mode === 'bull_ride' && price < pos.lp_range_low) {
                // Bull LP: price exited bottom → trend might be ending
                const lpVal = getLpValue(pos, price);
                log.push({ date, type: 'lp_exit_bottom', message: `LP EXIT BOTTOM: precio $${price.toFixed(0)} cayó bajo el rango ($${pos.lp_range_low.toFixed(0)}). LP = 100% ${asset} = $${lpVal.toFixed(0)}. Cerrando LP.` });
                cash += lpVal;
                pos.lp_amount = 0; pos.lp_mode = null;

            } else if (pos.lp_mode === 'bear_protect' && price > pos.lp_range_high) {
                // Bear LP: price went above range → auto-converted to USDC
                log.push({ date, type: 'lp_auto_usdc', message: `LP AUTO-EXIT USDC: precio $${price.toFixed(0)} superó rango ($${pos.lp_range_high.toFixed(0)}). LP convertido a 100% USDC = $${pos.lp_amount.toFixed(0)}. Protección exitosa.` });
                cash += pos.lp_amount;
                pos.lp_amount = 0; pos.lp_mode = null;

            } else if (pos.lp_mode === 'neutral' && (price < pos.lp_range_low || price > pos.lp_range_high)) {
                // Neutral LP: rebalance
                const lpVal = getLpValue(pos, price);
                const cost = lpVal * 0.01;
                cash -= cost;
                pos.lp_entry = price;
                pos.lp_range_low = price * 0.88;
                pos.lp_range_high = price * 1.12;
                log.push({ date, type: 'lp_rebalance', message: `LP neutral rebalanceado. Coste: $${cost.toFixed(0)}` });
            }

            // Daily LP fees (only if price is in range)
            if (pos.lp_amount > 0 && price >= pos.lp_range_low && price <= pos.lp_range_high) {
                cash += pos.lp_amount * LP_FEE_DAILY;
            }
        }

        // Daily Aave yield/cost
        if (pos.aave_supply > 0) cash += pos.aave_supply * 0.035 / 365;
        if (pos.aave_borrow > 0) cash -= pos.aave_borrow * (AAVE_BORROW_APY[asset] || 3) / 100 / 365;

        // Liquidation check
        if (pos.short_margin > 0) {
            const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
            if (pos.short_margin + pnl <= pos.short_margin * 0.1) {
                log.push({ date, type: 'liquidation', message: `SHORT liquidado $${price.toFixed(0)}. Pérdida: $${pos.short_margin.toFixed(0)}` });
                pos.short_margin = 0; pos.short_size = 0;
            }
        }

        // ── Phase change logic ──
        if (rawPhase !== confirmedPhase) {
            if (rawPhase === pendingPhase) pendingCount++;
            else { pendingPhase = rawPhase; pendingCount = 1; }
        } else { pendingPhase = null; pendingCount = 0; }

        if (pendingPhase && pendingCount >= COOLDOWN_DAYS) {
            const newPhase = pendingPhase;
            const prevPhase = confirmedPhase;
            pendingPhase = null; pendingCount = 0;

            if (strategyActive && daysSinceOpen < MIN_HOLD_DAYS) {
                log.push({ date, type: 'cooldown', message: `${newPhase} confirmada pero hold ${daysSinceOpen}d < ${MIN_HOLD_DAYS}d.` });
            } else {
                const major = isMajorChange(prevPhase, newPhase);

                if (strategyActive && major) {
                    cash += closeAll(pos, price, date, log);
                    pos = emptyPos();
                    log.push({ date, type: 'phase_change', message: `CAMBIO MAYOR: ${prevPhase} → ${newPhase}. Cash: $${cash.toFixed(0)}` });
                    confirmedPhase = newPhase; daysSinceOpen = 0;
                    cash -= openStrategy(newPhase, cash, price, asset, pos, date, log);

                } else if (strategyActive && !major) {
                    // Minor: close perps, adjust hedge, keep LP
                    cash += closePerps(pos, price, date, log);
                    confirmedPhase = newPhase;

                    if (newPhase === 'bear' || newPhase === 'distribution') {
                        const hm = Math.floor(cash * (newPhase === 'bear' ? 0.08 : 0.04));
                        if (hm > 30) {
                            pos.short_margin = hm; pos.short_size = hm * SHORT_LEV; pos.short_entry = price;
                            cash -= hm;
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → ${newPhase}: SHORT x${SHORT_LEV} $${hm} (protege LP)` });
                        } else {
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → ${newPhase}: LP mantenido, hedge bajo.` });
                        }
                    } else if (newPhase === 'accumulation') {
                        const hm = Math.floor(cash * 0.03);
                        if (hm > 30) {
                            pos.short_margin = hm; pos.short_size = hm * SHORT_LEV; pos.short_entry = price;
                            cash -= hm;
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E1: SHORT delta-neutral x${SHORT_LEV} $${hm}` });
                        } else {
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E1: LP mantenido.` });
                        }
                    } else if (newPhase === 'bull') {
                        log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E2: LP mantenido, sin hedge direccional.` });
                    }
                } else {
                    confirmedPhase = newPhase; strategyActive = true; daysSinceOpen = 0;
                    cash -= openStrategy(newPhase, cash, price, asset, pos, date, log);
                }
            }
        }

        // Daily P&L
        if (strategyActive) {
            let totalVal = cash;
            if (pos.short_margin > 0) totalVal += pos.short_margin + (pos.short_entry - price) / pos.short_entry * pos.short_size;
            if (pos.lp_amount > 0) totalVal += getLpValue(pos, price);
            dailyPnL.push({ date, price, phase: confirmedPhase, cash, totalValue: totalVal, pnlPct: ((totalVal - amount) / amount * 100) });
        }
    }

    // Close at end
    if (strategyActive) {
        const lp = candles[candles.length - 1].close;
        const ld = new Date(candles[candles.length - 1].ts).toISOString().split('T')[0];
        cash += closeAll(pos, lp, ld, log);
        log.push({ date: ld, type: 'end', message: `Fin simulación. Cash: $${cash.toFixed(0)}` });
    }

    const bh = candles.length > minC ? ((candles[candles.length - 1].close - candles[minC].close) / candles[minC].close * 100) : 0;
    const ret = ((cash - amount) / amount * 100);

    return {
        initialAmount: amount, finalValue: +cash.toFixed(2),
        totalReturn: +ret.toFixed(2), buyHoldReturn: +bh.toFixed(2),
        alpha: +(ret - bh).toFixed(2), totalDays: candles.length - minC,
        phaseChanges: log.filter(l => l.type === 'phase_change').length,
        liquidations: log.filter(l => l.type === 'liquidation').length,
        lpExitTop: log.filter(l => l.type === 'lp_exit_top').length,
        lpExitBottom: log.filter(l => l.type === 'lp_exit_bottom').length,
        lpAutoUsdc: log.filter(l => l.type === 'lp_auto_usdc').length,
        log, dailyPnL,
        startDate: new Date(candles[minC]?.ts).toISOString().split('T')[0],
        endDate: new Date(candles[candles.length - 1]?.ts).toISOString().split('T')[0],
    };
}

async function simulate(asset, amount, startDate) {
    const db = getDb();
    const pair = asset + 'USDT';
    const startTs = new Date(startDate).getTime();
    const candles = db.prepare('SELECT * FROM candles WHERE pair = ? AND interval = ? AND open_time >= ? ORDER BY open_time ASC').all(pair, '1d', startTs);
    const pre = db.prepare('SELECT * FROM candles WHERE pair = ? AND interval = ? AND open_time < ? ORDER BY open_time DESC LIMIT 60').all(pair, '1d', startTs).reverse();
    db.close();
    const all = [...pre, ...candles].map(c => ({ ts: c.open_time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    if (all.length < 55) throw new Error(`Datos insuficientes para ${asset}. Sincroniza desde /admin.`);
    return runBacktest(all, amount, asset);
}

module.exports = { simulate };
