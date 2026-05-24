const AAVE_LTV = { USDC: 0.80, ETH: 0.80, BTC: 0.73 };
const AAVE_EST_SUPPLY_APY = { USDC: 4.5, ETH: 1.8, BTC: 0.3 };
const AAVE_EST_BORROW_APY = { USDC: 5.5, ETH: 3.2, BTC: 1.5 };
const LP_EST_APY = { 'ETH-USDC': 25, 'BTC-USDC': 18, 'ETH-BTC': 12 };

async function tryFetch(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

async function tryPost(url, body, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } catch (e) { clearTimeout(timer); throw e; }
}

// ═══════════════════════════════════════════════════════════════
// LIVE DATA FETCHERS
// ═══════════════════════════════════════════════════════════════

async function fetchLiveRates() {
    const rates = {
        aave: { supply: { ...AAVE_EST_SUPPLY_APY }, borrow: { ...AAVE_EST_BORROW_APY } },
        lp: { ...LP_EST_APY },
        funding: {},
    };

    // DefiLlama for Aave rates
    try {
        const data = await tryFetch('https://yields.llama.fi/pools');
        if (data?.data) {
            for (const p of data.data) {
                if (p.chain !== 'Arbitrum') continue;
                const proto = (p.project || '').toLowerCase();
                const sym = (p.symbol || '').toUpperCase();
                if (proto.includes('aave')) {
                    if (sym.includes('USDC') && !sym.includes('-')) rates.aave.supply.USDC = p.apyBase || p.apy || rates.aave.supply.USDC;
                    if (sym.includes('ETH') && !sym.includes('-') && !sym.includes('WSTETH')) rates.aave.supply.ETH = p.apyBase || p.apy || rates.aave.supply.ETH;
                    if (sym.includes('BTC') && !sym.includes('-')) rates.aave.supply.BTC = p.apyBase || p.apy || rates.aave.supply.BTC;
                }
                if ((proto.includes('uniswap') || proto.includes('camelot')) && p.tvlUsd > 500000) {
                    if (sym.includes('ETH') && sym.includes('USDC')) rates.lp['ETH-USDC'] = Math.max(rates.lp['ETH-USDC'], p.apy || 0);
                    if (sym.includes('BTC') && sym.includes('USDC')) rates.lp['BTC-USDC'] = Math.max(rates.lp['BTC-USDC'], p.apy || 0);
                    if (sym.includes('ETH') && sym.includes('BTC')) rates.lp['ETH-BTC'] = Math.max(rates.lp['ETH-BTC'], p.apy || 0);
                }
            }
        }
    } catch (_) {}

    // Hyperliquid funding rates
    try {
        const data = await tryPost('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
        if (Array.isArray(data) && data.length >= 2) {
            const meta = data[0];
            const ctxs = data[1];
            for (let i = 0; i < ctxs.length; i++) {
                const name = meta.universe?.[i]?.name;
                if (name === 'BTC' || name === 'ETH') {
                    rates.funding[name] = {
                        rate: parseFloat(ctxs[i].funding || 0),
                        annualized: parseFloat(ctxs[i].funding || 0) * 8760,
                    };
                }
            }
        }
    } catch (_) {}

    return rates;
}

async function fetchMarketPhases() {
    const phases = { BTC: null, ETH: null };
    try {
        const data = await tryFetch('http://localhost:' + (process.env.PORT || 3000) + '/api/analyst');
        if (data?.results) {
            for (const coin of ['BTC', 'ETH']) {
                const daily = data.results[coin]?.['Diario'];
                const weekly = data.results[coin]?.['Semanal'];
                if (daily) {
                    phases[coin] = {
                        type: daily.type,
                        phase: daily.phase,
                        weeklyType: weekly?.type || 'range',
                        weeklyPhase: weekly?.phase || 'N/A',
                    };
                }
            }
        }
    } catch (_) {}
    return phases;
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY BUILDER — 4 completely different playbooks per market phase
// ═══════════════════════════════════════════════════════════════

function getMarketRegime(phases) {
    const btc = phases.BTC?.type || 'accumulation';
    const eth = phases.ETH?.type || 'accumulation';

    if (btc === 'bear' || eth === 'bear') return 'bear';
    if (btc === 'bull' && eth === 'bull') return 'bull';
    if (btc === 'distribution' || eth === 'distribution') return 'distribution';
    return 'accumulation';
}

function getFundingApy(rates, asset, direction) {
    const f = rates.funding[asset];
    if (!f) return 0;
    if (direction === 'SHORT' && f.rate > 0) return f.annualized * 100;
    if (direction === 'LONG' && f.rate < 0) return Math.abs(f.annualized) * 100;
    return -Math.abs(f.annualized) * 100;
}

// ═══════════════════════════════════════════════════════════════
// PRICE-BASED CALCULATIONS
// ═══════════════════════════════════════════════════════════════

function calcLiquidationPrice(entryPrice, leverage, direction) {
    if (direction === 'LONG') return entryPrice * (1 - 0.9 / leverage);
    return entryPrice * (1 + 0.9 / leverage);
}

function calcStopLoss(entryPrice, leverage, direction, riskPct = 0.5) {
    if (direction === 'LONG') return entryPrice * (1 - riskPct / leverage);
    return entryPrice * (1 + riskPct / leverage);
}

function calcTakeProfit(entryPrice, leverage, direction, targetPct = 1.5) {
    if (direction === 'LONG') return entryPrice * (1 + targetPct / leverage);
    return entryPrice * (1 - targetPct / leverage);
}

function calcLpRange(price, regime) {
    const widths = { bear: [0.20, 0.05], bull: [0.05, 0.25], accumulation: [0.08, 0.08], distribution: [0.12, 0.06] };
    const [downPct, upPct] = widths[regime] || [0.10, 0.10];
    return { low: price * (1 - downPct), high: price * (1 + upPct) };
}

function calcAaveLiqPrice(collateralUsd, borrowUsd, borrowAssetPrice, ltv) {
    if (borrowUsd <= 0) return 0;
    return borrowAssetPrice * (collateralUsd * ltv) / borrowUsd;
}

function fmtPrice(v) {
    if (!v || v === 0) return '—';
    if (v > 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (v > 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// ═══════════════════════════════════════════════════════════════
// PLAYBOOKS
// ═══════════════════════════════════════════════════════════════

// ── E4 BAJISTA: Máxima protección, stables, shorts ──
function buildBearStrategy(amount, rates, phases, prices) {
    const steps = [];
    let totalApy = 0;
    const asset = phases.ETH?.type === 'bear' ? 'ETH' : 'BTC';
    const price = prices[asset] || 0;
    const regime = 'bear';

    const stableAmount = Math.floor(amount * 0.70);
    const supplyApy = rates.aave.supply.USDC;
    steps.push({
        step: 1, action: 'Supply USDC en Aave (refugio)',
        detail: `Depositar ${fmtUsd(stableAmount)} USDC en Aave V3. Preservar capital en mercado bajista.`,
        token: 'USDC', amount: stableAmount, apy: supplyApy, protocol: 'Aave V3',
    });
    totalApy += supplyApy * (stableAmount / amount);

    const shortMargin = Math.floor(amount * 0.20);
    const shortLev = 3;
    const shortExposure = shortMargin * shortLev;
    const fundApy = getFundingApy(rates, asset, 'SHORT');
    const sl = calcStopLoss(price, shortLev, 'SHORT');
    const tp = calcTakeProfit(price, shortLev, 'SHORT');
    const liq = calcLiquidationPrice(price, shortLev, 'SHORT');
    steps.push({
        step: 2, action: `SHORT ${asset} x${shortLev}`,
        detail: `SHORT ${fmtUsd(shortExposure)} en ${asset}-PERP. Entrada: $${fmtPrice(price)}`,
        token: asset, amount: shortMargin, exposure: shortExposure,
        leverage: shortLev, direction: 'SHORT', apy: fundApy, protocol: 'Hyperliquid',
        entry_price: price, stop_loss: sl, take_profit: tp, liquidation: liq,
    });
    totalApy += fundApy * (shortMargin / amount);

    const arbAmount = Math.floor(amount * 0.10);
    steps.push({
        step: 3, action: `Funding Arb ${asset}`,
        detail: `${fmtUsd(arbAmount)} en short adicional si funding positivo. Cobrar funding rate en mercado bajista.`,
        token: asset, amount: arbAmount, apy: Math.max(0, fundApy), protocol: 'Hyperliquid',
        entry_price: price,
    });
    totalApy += Math.max(0, fundApy) * (arbAmount / amount);

    return finish(amount, 'E4 — BAJISTA', phases, asset, steps, totalApy, regime, prices, [
        `Stop Loss SHORT: $${fmtPrice(sl)} — cerrar si el precio sube ahí`,
        `Take Profit SHORT: $${fmtPrice(tp)} — recoger beneficios`,
        `Liquidación SHORT: $${fmtPrice(liq)} — nunca dejar llegar`,
        'Si cambia a E1, cerrar shorts y rotar a acumulación',
    ]);
}

// ── E2 ALCISTA: Máxima exposición, LP apalancado, longs ──
function buildBullStrategy(amount, rates, phases, prices) {
    const steps = [];
    let totalApy = 0;
    const asset = phases.ETH?.type === 'bull' ? 'ETH' : 'BTC';
    const price = prices[asset] || 0;
    const regime = 'bull';
    const lpPair = `${asset}-USDC`;
    const lpApy = rates.lp[lpPair] || 20;
    const borrowApy = rates.aave.borrow[asset];
    const lpRange = calcLpRange(price, regime);

    steps.push({
        step: 1, action: 'Depositar USDC en Aave',
        detail: `Depositar ${fmtUsd(amount)} USDC como colateral en Aave V3.`,
        token: 'USDC', amount: amount, apy: rates.aave.supply.USDC, protocol: 'Aave V3',
    });
    totalApy += rates.aave.supply.USDC;

    const borrowAmount = Math.floor(amount * 0.65);
    const hf = (amount * AAVE_LTV.USDC) / borrowAmount;
    const aaveLiq = price * (borrowAmount / (amount * AAVE_LTV.USDC));
    steps.push({
        step: 2, action: `Borrow ${asset} (65% LTV)`,
        detail: `Borrow ${fmtUsd(borrowAmount)} en ${asset} a $${fmtPrice(price)}. HF: ${hf.toFixed(2)}.`,
        token: asset, amount: borrowAmount, apy: -borrowApy, protocol: 'Aave V3',
        entry_price: price, liquidation: aaveLiq,
    });
    totalApy -= borrowApy * (borrowAmount / amount);

    const lpAmount = borrowAmount;
    steps.push({
        step: 3, action: `LP ${lpPair} concentrado`,
        detail: `Proveer ${fmtUsd(lpAmount)} en pool ${lpPair}. Rango: $${fmtPrice(lpRange.low)} — $${fmtPrice(lpRange.high)}`,
        token: lpPair, amount: lpAmount, apy: lpApy, protocol: 'Uniswap V3 / Camelot',
        entry_price: price, lp_range_low: lpRange.low, lp_range_high: lpRange.high,
    });
    totalApy += lpApy * (lpAmount / amount);

    const levApy = lpApy * 2 - borrowApy;
    steps.push({
        step: 4, action: 'Apalancar LP x2 (Revert)',
        detail: `Exposición total: ${fmtUsd(lpAmount * 2)}. Apalancar LP para maximizar fees en E2.`,
        token: lpPair, amount: lpAmount, leveragedExposure: lpAmount * 2,
        apy: levApy, protocol: 'Revert Finance',
        lp_range_low: lpRange.low, lp_range_high: lpRange.high,
    });
    totalApy += (levApy - lpApy) * (lpAmount / amount);

    const longMargin = Math.floor(amount * 0.05);
    const longLev = 3;
    const longSl = calcStopLoss(price, longLev, 'LONG');
    const longTp = calcTakeProfit(price, longLev, 'LONG');
    const longLiq = calcLiquidationPrice(price, longLev, 'LONG');
    steps.push({
        step: 5, action: `LONG ${asset} x${longLev}`,
        detail: `LONG ${fmtUsd(longMargin * longLev)} con ${fmtUsd(longMargin)} margen. Entrada: $${fmtPrice(price)}`,
        token: asset, amount: longMargin, exposure: longMargin * longLev,
        leverage: longLev, direction: 'LONG', protocol: 'Hyperliquid',
        apy: getFundingApy(rates, asset, 'LONG'),
        entry_price: price, stop_loss: longSl, take_profit: longTp, liquidation: longLiq,
    });

    return finish(amount, 'E2 — ALCISTA', phases, asset, steps, totalApy, regime, prices, [
        `Rango LP: $${fmtPrice(lpRange.low)} — $${fmtPrice(lpRange.high)} — rebalancear si sale`,
        `Stop Loss LONG: $${fmtPrice(longSl)} | Take Profit: $${fmtPrice(longTp)}`,
        `Aave liquidación si ${asset} sube a $${fmtPrice(aaveLiq)} (borrow, no supply)`,
        'Si cambia a E3, cerrar long, reducir leverage, tomar beneficios LP',
    ]);
}

// ── E1 ACUMULACIÓN ──
function buildAccumulationStrategy(amount, rates, phases, prices) {
    const steps = [];
    let totalApy = 0;
    const asset = phases.BTC?.type === 'accumulation' ? 'BTC' : 'ETH';
    const price = prices[asset] || 0;
    const regime = 'accumulation';
    const lpPair = `${asset}-USDC`;
    const lpApy = rates.lp[lpPair] || 20;
    const borrowApy = rates.aave.borrow[asset];
    const lpRange = calcLpRange(price, regime);

    steps.push({
        step: 1, action: 'Supply USDC en Aave',
        detail: `Depositar ${fmtUsd(amount)} USDC en Aave V3. Construir posición para E2.`,
        token: 'USDC', amount: amount, apy: rates.aave.supply.USDC, protocol: 'Aave V3',
    });
    totalApy += rates.aave.supply.USDC;

    const borrowAmount = Math.floor(amount * 0.45);
    const hf = (amount * AAVE_LTV.USDC) / borrowAmount;
    steps.push({
        step: 2, action: `Borrow ${asset} (45% LTV)`,
        detail: `Borrow ${fmtUsd(borrowAmount)} en ${asset} a $${fmtPrice(price)}. HF conservador: ${hf.toFixed(2)}.`,
        token: asset, amount: borrowAmount, apy: -borrowApy, protocol: 'Aave V3',
        entry_price: price,
    });
    totalApy -= borrowApy * (borrowAmount / amount);

    const lpAmount = Math.floor(borrowAmount * 0.80);
    steps.push({
        step: 3, action: `LP ${lpPair} rango estrecho`,
        detail: `${fmtUsd(lpAmount)} en pool. Rango: $${fmtPrice(lpRange.low)} — $${fmtPrice(lpRange.high)}. Rango estrecho = más fees en E1.`,
        token: lpPair, amount: lpAmount, apy: lpApy * 1.5, protocol: 'Uniswap V3 / Camelot',
        entry_price: price, lp_range_low: lpRange.low, lp_range_high: lpRange.high,
    });
    totalApy += (lpApy * 1.5) * (lpAmount / amount);

    const hedgeAmount = Math.floor(borrowAmount * 0.15);
    const hedgeLev = 3;
    const hedgeSl = calcStopLoss(price, hedgeLev, 'SHORT');
    const hedgeLiq = calcLiquidationPrice(price, hedgeLev, 'SHORT');
    steps.push({
        step: 4, action: `SHORT ${asset} x${hedgeLev} (delta neutral)`,
        detail: `SHORT ${fmtUsd(hedgeAmount * hedgeLev)} con ${fmtUsd(hedgeAmount)} margen. Entrada: $${fmtPrice(price)}`,
        token: asset, amount: hedgeAmount, exposure: hedgeAmount * hedgeLev,
        leverage: hedgeLev, direction: 'SHORT', protocol: 'Hyperliquid',
        apy: getFundingApy(rates, asset, 'SHORT'),
        entry_price: price, stop_loss: hedgeSl, liquidation: hedgeLiq,
    });
    totalApy += getFundingApy(rates, asset, 'SHORT') * (hedgeAmount / amount);

    const reserveAmount = borrowAmount - lpAmount - hedgeAmount;
    steps.push({
        step: 5, action: 'Reserva USDC para ruptura E2',
        detail: `${fmtUsd(reserveAmount)} en USDC. Desplegar cuando ${asset} rompa MR y confirme E2.`,
        token: 'USDC', amount: reserveAmount, apy: 0, protocol: 'Wallet',
    });

    return finish(amount, 'E1 — ACUMULACIÓN', phases, asset, steps, totalApy, regime, prices, [
        `Rango LP: $${fmtPrice(lpRange.low)} — $${fmtPrice(lpRange.high)} — rebalancear si sale`,
        `Stop Loss hedge: $${fmtPrice(hedgeSl)} — cerrar short si rompe al alza`,
        `Si ${asset} rompe MR: cerrar short + desplegar reserva en LP/long`,
        `Si ${asset} pierde mR: cerrar LP + ampliar shorts`,
    ]);
}

// ── E3 DISTRIBUCIÓN ──
function buildDistributionStrategy(amount, rates, phases, prices) {
    const steps = [];
    let totalApy = 0;
    const asset = phases.BTC?.type === 'distribution' ? 'BTC' : 'ETH';
    const price = prices[asset] || 0;
    const regime = 'distribution';
    const borrowApy = rates.aave.borrow[asset];

    steps.push({
        step: 1, action: 'Supply USDC en Aave',
        detail: `Depositar ${fmtUsd(amount)} USDC en Aave V3. Capital seguro en E3.`,
        token: 'USDC', amount: amount, apy: rates.aave.supply.USDC, protocol: 'Aave V3',
    });
    totalApy += rates.aave.supply.USDC;

    const borrowAmount = Math.floor(amount * 0.35);
    const hf = (amount * AAVE_LTV.USDC) / borrowAmount;
    steps.push({
        step: 2, action: `Borrow ${asset} bajo (35% LTV)`,
        detail: `Borrow ${fmtUsd(borrowAmount)} en ${asset} a $${fmtPrice(price)}. HF: ${hf.toFixed(2)}.`,
        token: asset, amount: borrowAmount, apy: -borrowApy, protocol: 'Aave V3',
        entry_price: price,
    });
    totalApy -= borrowApy * (borrowAmount / amount);

    steps.push({
        step: 3, action: `Vender ${asset} → USDC (short sintético)`,
        detail: `Vender ${fmtUsd(borrowAmount)} de ${asset} a $${fmtPrice(price)}. Si cae, recompras más barato y devuelves a Aave con beneficio.`,
        token: asset, amount: borrowAmount, apy: 0, protocol: 'Swap',
        entry_price: price, take_profit: price * 0.85,
    });

    const shortMargin = Math.floor(amount * 0.05);
    const shortLev = 3;
    const sl = calcStopLoss(price, shortLev, 'SHORT');
    const tp = calcTakeProfit(price, shortLev, 'SHORT');
    const liq = calcLiquidationPrice(price, shortLev, 'SHORT');
    steps.push({
        step: 4, action: `SHORT ${asset} x${shortLev}`,
        detail: `SHORT ${fmtUsd(shortMargin * shortLev)} con ${fmtUsd(shortMargin)} margen. Entrada: $${fmtPrice(price)}`,
        token: asset, amount: shortMargin, exposure: shortMargin * shortLev,
        leverage: shortLev, direction: 'SHORT', protocol: 'Hyperliquid',
        apy: getFundingApy(rates, asset, 'SHORT'),
        entry_price: price, stop_loss: sl, take_profit: tp, liquidation: liq,
    });
    totalApy += getFundingApy(rates, asset, 'SHORT') * (shortMargin / amount);

    const stableLpAmount = borrowAmount;
    steps.push({
        step: 5, action: 'Pool USDC estable',
        detail: `${fmtUsd(stableLpAmount)} en pool de stables. Yield seguro sin exposición.`,
        token: 'USDC', amount: stableLpAmount, apy: 8, protocol: 'Curve / Uniswap Stables',
    });
    totalApy += 8 * (stableLpAmount / amount);

    return finish(amount, 'E3 — DISTRIBUCIÓN', phases, asset, steps, totalApy, regime, prices, [
        `Stop Loss SHORT: $${fmtPrice(sl)} | Take Profit: $${fmtPrice(tp)}`,
        `Liquidación SHORT: $${fmtPrice(liq)}`,
        `Short sintético (borrow+venta): recomprar ${asset} si cae a ~$${fmtPrice(price * 0.85)}`,
        `Si ${asset} recupera MR superior → cerrar todo rápido, posible vuelta a E2`,
    ]);
}

function finish(amount, marketPhase, phases, mainAsset, steps, totalApy, regime, prices, warnings) {
    let totalCollateral = 0, totalBorrowed = 0, totalLpExposure = 0, totalHedgeExposure = 0;
    let hf = 99;

    for (const s of steps) {
        if (s.action?.includes('Supply') || s.action?.includes('Depositar')) totalCollateral += s.amount;
        if (s.action?.includes('Borrow')) {
            totalBorrowed += s.amount;
            hf = (totalCollateral * AAVE_LTV.USDC) / totalBorrowed;
        }
        if (s.action?.includes('Pool') || s.action?.includes('LP')) totalLpExposure += (s.leveragedExposure || s.amount);
        if (s.direction) totalHedgeExposure += (s.exposure || s.amount);
    }

    warnings.push('APYs estimados — verificar en DeFiLlama y protocolos antes de ejecutar');

    return {
        amount, chain: 'Arbitrum', marketPhase,
        btcPhase: phases.BTC?.phase || 'N/A',
        ethPhase: phases.ETH?.phase || 'N/A',
        mainAsset, steps, breakdown: [],
        totalEstApy: parseFloat(totalApy.toFixed(1)),
        healthFactor: parseFloat(hf.toFixed(2)),
        totalExposure: { collateral: totalCollateral, borrowed: totalBorrowed, lpExposure: totalLpExposure, hedgeExposure: totalHedgeExposure },
        warnings, calculated_at: new Date().toISOString(),
    };
}

function buildStrategy(amount, rates, phases, prices) {
    const regime = getMarketRegime(phases);

    switch (regime) {
        case 'bear':         return buildBearStrategy(amount, rates, phases, prices);
        case 'bull':         return buildBullStrategy(amount, rates, phases, prices);
        case 'distribution': return buildDistributionStrategy(amount, rates, phases, prices);
        default:             return buildAccumulationStrategy(amount, rates, phases, prices);
    }
}

function fmtUsd(v) {
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function getStrategy(amount, livePrices = {}) {
    const [rates, phases] = await Promise.all([
        fetchLiveRates(),
        fetchMarketPhases(),
    ]);

    // Use live prices from frontend
    const prices = {
        BTC: livePrices.BTC || 0,
        ETH: livePrices.ETH || 0,
    };

    const strategy = buildStrategy(amount, rates, phases, prices);

    return {
        ...strategy,
        prices,
        rates_source: {
            aave_supply_usdc: rates.aave.supply.USDC,
            aave_borrow_eth: rates.aave.borrow.ETH,
            aave_borrow_btc: rates.aave.borrow.BTC,
            lp_eth_usdc: rates.lp['ETH-USDC'],
            lp_btc_usdc: rates.lp['BTC-USDC'],
            funding_btc: rates.funding.BTC?.rate || null,
            funding_eth: rates.funding.ETH?.rate || null,
        },
    };
}

module.exports = { getStrategy };
