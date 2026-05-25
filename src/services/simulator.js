const { getDb } = require('../../db/init');
const { sma, smaSlope, detectTrainTracks } = require('./ranges');

const AAVE_BORROW_APY = { ETH: 3.2, BTC: 1.5 };
const LP_APY = { 'ETH-USDC': 25, 'BTC-USDC': 18 };
const AAVE_LTV_USDC = 0.80;

const COOLDOWN_DAYS = 5;
const MIN_HOLD_DAYS = 7;
const LONG_LEV = 3;
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
    return { aave_supply: 0, aave_borrow: 0, short_margin: 0, short_size: 0, short_entry: 0, short_lev: 0, long_margin: 0, long_size: 0, long_entry: 0, long_lev: 0, lp_amount: 0, lp_entry: 0, lp_range_low: 0, lp_range_high: 0 };
}

function isMajorChange(from, to) {
    if (!from) return true;
    // Only truly opposite transitions are MAJOR (close everything)
    // bull↔bear = MAJOR
    // Everything else = MINOR (keep LP, adjust hedge only)
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
    if (pos.long_margin > 0 && pos.long_entry > 0) {
        const pnl = (price - pos.long_entry) / pos.long_entry * pos.long_size;
        const result = Math.max(0, pos.long_margin + pnl);
        log.push({ date, type: 'close', message: `Cerrar LONG: entrada $${pos.long_entry.toFixed(0)}, salida $${price.toFixed(0)}, P&L: $${pnl.toFixed(0)} (${(pnl / pos.long_margin * 100).toFixed(1)}%)` });
        recovered += result;
    }
    if (pos.lp_amount > 0) {
        const il = pos.lp_amount * Math.abs(price - pos.lp_entry) / pos.lp_entry * 0.3;
        const val = Math.max(0, pos.lp_amount - il);
        log.push({ date, type: 'close', message: `Cerrar LP: IL $${il.toFixed(0)}, valor $${val.toFixed(0)}` });
        recovered += val;
    }
    if (pos.aave_borrow > 0) recovered -= pos.aave_borrow;
    return recovered;
}

function closePerps(pos, price, date, log) {
    let recovered = 0;
    if (pos.long_margin > 0) {
        const pnl = (price - pos.long_entry) / pos.long_entry * pos.long_size;
        recovered += Math.max(0, pos.long_margin + pnl);
        log.push({ date, type: 'adjust_close', message: `Cerrar LONG: P&L $${pnl.toFixed(0)}` });
        pos.long_margin = 0; pos.long_size = 0; pos.long_entry = 0;
    }
    if (pos.short_margin > 0) {
        const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
        recovered += Math.max(0, pos.short_margin + pnl);
        log.push({ date, type: 'adjust_close', message: `Cerrar SHORT: P&L $${pnl.toFixed(0)}` });
        pos.short_margin = 0; pos.short_size = 0; pos.short_entry = 0;
    }
    return recovered;
}

function openStrategy(phase, cash, price, asset, pos, date, log) {
    let allocated = 0;

    if (phase === 'bear') {
        // E4: Stables + SHORT para proteger y beneficiar de caída
        const stableAmt = Math.floor(cash * 0.75);
        pos.aave_supply = stableAmt;
        allocated += stableAmt;
        const sm = Math.floor(cash * 0.15);
        pos.short_margin = sm; pos.short_lev = SHORT_LEV;
        pos.short_size = sm * SHORT_LEV; pos.short_entry = price;
        allocated += sm;
        log.push({ date, type: 'open', message: `E4 BAJISTA: Supply $${stableAmt} + SHORT x${SHORT_LEV} $${sm} (entrada $${price.toFixed(0)})` });

    } else if (phase === 'bull') {
        // E2: LP + LONG para amplificar tendencia alcista
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.55);
        pos.aave_borrow = borrow;
        const hedgeAmt = Math.floor(borrow * 0.05);
        const lp = borrow - hedgeAmt;
        pos.lp_amount = lp; pos.lp_entry = price;
        pos.lp_range_low = price * 0.80; pos.lp_range_high = price * 1.25;
        pos.long_margin = hedgeAmt; pos.long_lev = LONG_LEV;
        pos.long_size = hedgeAmt * LONG_LEV; pos.long_entry = price;
        allocated = cash;
        log.push({ date, type: 'open', message: `E2 ALCISTA: Colateral $${cash.toFixed(0)}, Borrow $${borrow}, LP $${lp} rango $${pos.lp_range_low.toFixed(0)}-$${pos.lp_range_high.toFixed(0)}, LONG x${LONG_LEV} $${hedgeAmt} (entrada $${price.toFixed(0)})` });

    } else if (phase === 'accumulation') {
        // E1: LP + SHORT pequeño delta neutral (protege LP sin apostar dirección)
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.40);
        pos.aave_borrow = borrow;
        const hedgeAmt = Math.floor(borrow * 0.08);
        const lp = borrow - hedgeAmt;
        pos.lp_amount = lp; pos.lp_entry = price;
        pos.lp_range_low = price * 0.85; pos.lp_range_high = price * 1.15;
        pos.short_margin = hedgeAmt; pos.short_lev = SHORT_LEV;
        pos.short_size = hedgeAmt * SHORT_LEV; pos.short_entry = price;
        allocated = cash;
        log.push({ date, type: 'open', message: `E1 ACUMULACIÓN: Colateral $${cash.toFixed(0)}, Borrow $${borrow}, LP $${lp}, SHORT hedge x${SHORT_LEV} $${hedgeAmt} (entrada $${price.toFixed(0)})` });

    } else if (phase === 'distribution') {
        // E3: LP + SHORT más grande (protege LP y prepara para caída)
        pos.aave_supply = cash;
        const borrow = Math.floor(cash * 0.35);
        pos.aave_borrow = borrow;
        const hedgeAmt = Math.floor(borrow * 0.12);
        const lp = borrow - hedgeAmt;
        pos.lp_amount = lp; pos.lp_entry = price;
        pos.lp_range_low = price * 0.80; pos.lp_range_high = price * 1.10;
        pos.short_margin = hedgeAmt; pos.short_lev = SHORT_LEV;
        pos.short_size = hedgeAmt * SHORT_LEV; pos.short_entry = price;
        allocated = cash;
        log.push({ date, type: 'open', message: `E3 DISTRIBUCIÓN: Colateral $${cash.toFixed(0)}, Borrow $${borrow}, LP $${lp}, SHORT hedge x${SHORT_LEV} $${hedgeAmt} (entrada $${price.toFixed(0)})` });
    }
    return allocated;
}

function calcUnrealized(pos, price) {
    let t = pos.aave_supply - pos.aave_borrow;
    if (pos.short_margin > 0) t += pos.short_margin + (pos.short_entry - price) / pos.short_entry * pos.short_size;
    if (pos.long_margin > 0) t += pos.long_margin + (price - pos.long_entry) / pos.long_entry * pos.long_size;
    if (pos.lp_amount > 0) t += pos.lp_amount - pos.lp_amount * Math.abs(price - pos.lp_entry) / pos.lp_entry * 0.3;
    return t;
}

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

        // Cooldown
        if (rawPhase !== confirmedPhase) {
            if (rawPhase === pendingPhase) pendingCount++;
            else { pendingPhase = rawPhase; pendingCount = 1; }
        } else { pendingPhase = null; pendingCount = 0; }

        if (pendingPhase && pendingCount >= COOLDOWN_DAYS) {
            const newPhase = pendingPhase;
            const prevPhase = confirmedPhase;
            pendingPhase = null; pendingCount = 0;

            if (strategyActive && daysSinceOpen < MIN_HOLD_DAYS) {
                log.push({ date, type: 'cooldown', message: `${newPhase} confirmada pero hold ${daysSinceOpen}d < ${MIN_HOLD_DAYS}d mín. Esperando.` });
            } else {
                const major = isMajorChange(prevPhase, newPhase);

                if (strategyActive && major) {
                    cash += closeAll(pos, price, date, log);
                    pos = emptyPos();
                    log.push({ date, type: 'phase_change', message: `CAMBIO MAYOR: ${prevPhase} → ${newPhase}. Cash: $${cash.toFixed(0)}` });
                    confirmedPhase = newPhase;
                    daysSinceOpen = 0;
                    cash -= openStrategy(newPhase, cash, price, asset, pos, date, log);
                } else if (strategyActive && !major) {
                    // Close old hedge, open new one — LP always protected
                    cash += closePerps(pos, price, date, log);
                    confirmedPhase = newPhase;

                    // Always open a hedge matching the new phase
                    if (newPhase === 'bear') {
                        const hm = Math.floor(cash * 0.08);
                        if (hm > 30) {
                            pos.short_margin = hm; pos.short_lev = SHORT_LEV;
                            pos.short_size = hm * SHORT_LEV; pos.short_entry = price;
                            cash -= hm;
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E4: LP mantenido + SHORT x${SHORT_LEV} $${hm} (protege LP de caída)` });
                        }
                    } else if (newPhase === 'distribution') {
                        const hm = Math.floor(cash * 0.04);
                        if (hm > 30) {
                            pos.short_margin = hm; pos.short_lev = SHORT_LEV;
                            pos.short_size = hm * SHORT_LEV; pos.short_entry = price;
                            cash -= hm;
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E3: LP mantenido + SHORT hedge x${SHORT_LEV} $${hm} (protege LP)` });
                        } else {
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E3: LP mantenido. Hedge demasiado pequeño.` });
                        }
                    } else if (newPhase === 'accumulation') {
                        const hm = Math.floor(cash * 0.03);
                        if (hm > 30) {
                            pos.short_margin = hm; pos.short_lev = SHORT_LEV;
                            pos.short_size = hm * SHORT_LEV; pos.short_entry = price;
                            cash -= hm;
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E1: LP mantenido + SHORT delta-neutral x${SHORT_LEV} $${hm}` });
                        } else {
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E1: LP mantenido sin hedge (capital bajo).` });
                        }
                    } else if (newPhase === 'bull') {
                        const lm = Math.floor(cash * 0.04);
                        if (lm > 30) {
                            pos.long_margin = lm; pos.long_lev = LONG_LEV;
                            pos.long_size = lm * LONG_LEV; pos.long_entry = price;
                            cash -= lm;
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E2: LP mantenido + LONG x${LONG_LEV} $${lm} (amplifica LP)` });
                        } else {
                            log.push({ date, type: 'phase_adjust', message: `${prevPhase} → E2: LP mantenido sin long (capital bajo).` });
                        }
                    }
                } else {
                    confirmedPhase = newPhase;
                    strategyActive = true; daysSinceOpen = 0;
                    cash -= openStrategy(newPhase, cash, price, asset, pos, date, log);
                }
            }
        }

        if (strategyActive) {
            const unr = calcUnrealized(pos, price);
            dailyPnL.push({ date, price, phase: confirmedPhase, cash, unrealized: unr, totalValue: cash + unr, pnlPct: ((cash + unr - amount) / amount * 100) });

            if (pos.lp_amount > 0 && (price < pos.lp_range_low || price > pos.lp_range_high)) {
                const cost = pos.lp_amount * 0.01;
                cash -= cost;
                log.push({ date, type: 'lp_rebalance', message: `LP rebalanceado. Coste: $${cost.toFixed(0)}` });
                pos.lp_range_low = price * 0.80; pos.lp_range_high = price * 1.20; pos.lp_entry = price;
            }
            if (pos.lp_amount > 0) cash += pos.lp_amount * (LP_APY[`${asset}-USDC`] || 20) / 100 / 365;
            if (pos.aave_supply > 0) cash += pos.aave_supply * 0.035 / 365;
            if (pos.aave_borrow > 0) cash -= pos.aave_borrow * (AAVE_BORROW_APY[asset] || 3) / 100 / 365;

            if (pos.short_margin > 0) {
                const pnl = (pos.short_entry - price) / pos.short_entry * pos.short_size;
                if (pos.short_margin + pnl <= pos.short_margin * 0.1) {
                    log.push({ date, type: 'liquidation', message: `SHORT liquidado $${price.toFixed(0)}. Pérdida: $${pos.short_margin.toFixed(0)}` });
                    pos.short_margin = 0; pos.short_size = 0;
                }
            }
            if (pos.long_margin > 0) {
                const pnl = (price - pos.long_entry) / pos.long_entry * pos.long_size;
                if (pos.long_margin + pnl <= pos.long_margin * 0.1) {
                    log.push({ date, type: 'liquidation', message: `LONG liquidado $${price.toFixed(0)}. Pérdida: $${pos.long_margin.toFixed(0)}` });
                    pos.long_margin = 0; pos.long_size = 0;
                }
            }
        }
    }

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
        phaseAdjusts: log.filter(l => l.type === 'phase_adjust').length,
        liquidations: log.filter(l => l.type === 'liquidation').length,
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
    if (all.length < 55) throw new Error(`Datos insuficientes para ${asset}. Velas: ${all.length}. Sincroniza desde /admin.`);
    return runBacktest(all, amount, asset);
}

module.exports = { simulate };
