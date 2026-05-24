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

    // 70% en stables puras
    const stableAmount = Math.floor(amount * 0.70);
    const supplyApy = rates.aave.supply.USDC;
    steps.push({
        step: 1, action: 'Supply USDC en Aave (refugio)',
        detail: `Depositar ${fmtUsd(stableAmount)} USDC en Aave V3. En mercado bajista, la prioridad es preservar capital. Este depósito genera yield seguro sin exposición a volatilidad.`,
        token: 'USDC', amount: stableAmount, apy: supplyApy, protocol: 'Aave V3',
    });
    totalApy += supplyApy * (stableAmount / amount);

    // 20% short apalancado para beneficiarse de la caída
    const shortMargin = Math.floor(amount * 0.20);
    const shortLev = 5;
    const shortExposure = shortMargin * shortLev;
    const fundApy = getFundingApy(rates, asset, 'SHORT');
    steps.push({
        step: 2, action: `SHORT ${asset} x${shortLev} (beneficio de la caída)`,
        detail: `SHORT de ${fmtUsd(shortExposure)} en ${asset}-PERP con ${fmtUsd(shortMargin)} de margen. En E4 bajista el precio tiende a caer — este short genera beneficio con la tendencia, no solo cubre.`,
        token: asset, amount: shortMargin, exposure: shortExposure,
        leverage: shortLev, direction: 'SHORT', apy: fundApy, protocol: 'Hyperliquid',
    });
    totalApy += fundApy * (shortMargin / amount);

    // 10% funding rate arb si funding es positivo
    const arbAmount = Math.floor(amount * 0.10);
    steps.push({
        step: 3, action: `Funding Rate Arbitrage ${asset}`,
        detail: `Con ${fmtUsd(arbAmount)}: si el funding es positivo, abre short adicional para cobrar funding. Si es negativo, mantén en USDC. En mercado bajista los longs suelen pagar a los shorts.`,
        token: asset, amount: arbAmount, apy: Math.max(0, fundApy),
        protocol: 'Hyperliquid',
    });
    totalApy += Math.max(0, fundApy) * (arbAmount / amount);

    return finish(amount, 'E4 — BAJISTA', phases, asset, steps, totalApy, [
        'NO hacer LP con activos volátiles — el IL en mercado bajista es devastador',
        'El short puede liquidarse si hay un rebote fuerte — usar stop loss',
        'Si el mercado cambia a E1 (acumulación), cerrar shorts y rotar a estrategia neutral',
        'Monitorizar cambios de etapa diariamente',
    ]);
}

// ── E2 ALCISTA: Máxima exposición, LP apalancado, longs ──
function buildBullStrategy(amount, rates, phases) {
    const steps = [];
    let totalApy = 0;
    const asset = phases.ETH?.type === 'bull' ? 'ETH' : 'BTC';
    const lpPair = `${asset}-USDC`;
    const lpApy = rates.lp[lpPair] || 20;
    const borrowApy = rates.aave.borrow[asset];

    // 1. Depositar todo como colateral
    steps.push({
        step: 1, action: 'Depositar USDC como colateral en Aave',
        detail: `Depositar ${fmtUsd(amount)} USDC en Aave V3. Esto sirve como colateral para pedir prestado ${asset} y apalancar la posición.`,
        token: 'USDC', amount: amount, apy: rates.aave.supply.USDC, protocol: 'Aave V3',
    });
    totalApy += rates.aave.supply.USDC;

    // 2. Borrow agresivo (65%)
    const borrowAmount = Math.floor(amount * 0.65);
    const hf = (amount * AAVE_LTV.USDC) / borrowAmount;
    steps.push({
        step: 2, action: `Borrow ${asset} (65% LTV)`,
        detail: `Pedir prestado ${fmtUsd(borrowAmount)} en ${asset}. En mercado alcista se aprovecha el apalancamiento. Health Factor: ${hf.toFixed(2)}. El ${asset} prestado se usará para LP.`,
        token: asset, amount: borrowAmount, apy: -borrowApy, protocol: 'Aave V3',
    });
    totalApy -= borrowApy * (borrowAmount / amount);

    // 3. LP con todo el borrow
    const lpAmount = borrowAmount;
    steps.push({
        step: 3, action: `Pool de liquidez ${lpPair}`,
        detail: `Proveer ${fmtUsd(lpAmount)} en el pool ${lpPair} concentrado. En E2 alcista el precio sube — poner rango amplio hacia arriba para capturar el movimiento.`,
        token: lpPair, amount: lpAmount, apy: lpApy, protocol: 'Uniswap V3 / Camelot',
    });
    totalApy += lpApy * (lpAmount / amount);

    // 4. Apalancar LP x2
    const levApy = lpApy * 2 - borrowApy;
    steps.push({
        step: 4, action: 'Apalancar LP x2 (Revert)',
        detail: `Usar Revert Finance para doblar la posición LP. Exposición total: ${fmtUsd(lpAmount * 2)}. En mercado alcista el apalancamiento amplifica los fees y la apreciación del activo.`,
        token: lpPair, amount: lpAmount, leveragedExposure: lpAmount * 2,
        apy: levApy, protocol: 'Revert Finance',
    });
    totalApy += (levApy - lpApy) * (lpAmount / amount);

    // 5. LONG ligero para maximizar
    const longMargin = Math.floor(amount * 0.05);
    const longLev = 10;
    steps.push({
        step: 5, action: `LONG ${asset} x${longLev} (impulso)`,
        detail: `LONG de ${fmtUsd(longMargin * longLev)} con ${fmtUsd(longMargin)} de margen del rendimiento generado. Pequeña apuesta direccional a favor de la tendencia alcista.`,
        token: asset, amount: longMargin, exposure: longMargin * longLev,
        leverage: longLev, direction: 'LONG',
        apy: getFundingApy(rates, asset, 'LONG'), protocol: 'Hyperliquid',
    });

    return finish(amount, 'E2 — ALCISTA', phases, asset, steps, totalApy, [
        'Si el mercado cambia a E3 (distribución), cerrar longs y reducir leverage',
        'LP concentrado: ajustar rango si el precio sube mucho',
        `Health Factor ${hf.toFixed(2)} — si ${asset} cae un 30% podría acercarse a liquidación`,
        'En E2 de alta calidad (vías del tren claras) se puede ser más agresivo',
    ]);
}

// ── E1 ACUMULACIÓN: Preparar posición, delta neutral, esperar ruptura ──
function buildAccumulationStrategy(amount, rates, phases) {
    const steps = [];
    let totalApy = 0;
    const asset = phases.BTC?.type === 'accumulation' ? 'BTC' : 'ETH';
    const lpPair = `${asset}-USDC`;
    const lpApy = rates.lp[lpPair] || 20;
    const borrowApy = rates.aave.borrow[asset];

    // 1. Supply USDC
    const supplyAmount = amount;
    steps.push({
        step: 1, action: 'Supply USDC en Aave (colateral)',
        detail: `Depositar ${fmtUsd(supplyAmount)} USDC en Aave V3. En E1 (acumulación) el precio se estabiliza — momento de construir posición para la próxima E2.`,
        token: 'USDC', amount: supplyAmount, apy: rates.aave.supply.USDC, protocol: 'Aave V3',
    });
    totalApy += rates.aave.supply.USDC;

    // 2. Borrow moderado (45%)
    const borrowAmount = Math.floor(amount * 0.45);
    const hf = (amount * AAVE_LTV.USDC) / borrowAmount;
    steps.push({
        step: 2, action: `Borrow ${asset} moderado (45% LTV)`,
        detail: `Pedir prestado ${fmtUsd(borrowAmount)} en ${asset}. Borrow conservador — en acumulación el precio puede hacer falsas rupturas. HF: ${hf.toFixed(2)}.`,
        token: asset, amount: borrowAmount, apy: -borrowApy, protocol: 'Aave V3',
    });
    totalApy -= borrowApy * (borrowAmount / amount);

    // 3. LP con rango ajustado (delta neutral)
    const lpAmount = Math.floor(borrowAmount * 0.80);
    steps.push({
        step: 3, action: `LP ${lpPair} rango estrecho (delta neutral)`,
        detail: `Proveer ${fmtUsd(lpAmount)} en pool ${lpPair} con rango estrecho alrededor del precio actual. En E1 el precio oscila en rango — rango estrecho = más fees con el mismo capital. Mantiene delta neutral.`,
        token: lpPair, amount: lpAmount, apy: lpApy * 1.5, protocol: 'Uniswap V3 / Camelot',
    });
    totalApy += (lpApy * 1.5) * (lpAmount / amount);

    // 4. Hedge delta neutral con short
    const hedgeAmount = Math.floor(borrowAmount * 0.15);
    const hedgeLev = 3;
    steps.push({
        step: 4, action: `SHORT ${asset} x${hedgeLev} (cobertura delta neutral)`,
        detail: `SHORT de ${fmtUsd(hedgeAmount * hedgeLev)} con ${fmtUsd(hedgeAmount)} de margen. Cubre la exposición del LP para mantener delta neutral. En E1 no queremos apostar dirección.`,
        token: asset, amount: hedgeAmount, exposure: hedgeAmount * hedgeLev,
        leverage: hedgeLev, direction: 'SHORT',
        apy: getFundingApy(rates, asset, 'SHORT'), protocol: 'Hyperliquid',
    });
    totalApy += getFundingApy(rates, asset, 'SHORT') * (hedgeAmount / amount);

    // 5. Reserva para la ruptura
    const reserveAmount = borrowAmount - lpAmount - hedgeAmount;
    steps.push({
        step: 5, action: 'Reserva USDC para ruptura E2',
        detail: `Mantener ${fmtUsd(reserveAmount)} en USDC listo para desplegar. Cuando ${asset} confirme ruptura del MR y entre en E2, usar para: cerrar short, ampliar LP, o abrir long.`,
        token: 'USDC', amount: reserveAmount, apy: 0, protocol: 'Wallet',
    });

    return finish(amount, 'E1 — ACUMULACIÓN', phases, asset, steps, totalApy, [
        `Vigilar el MR (Máximo Relevante) de ${asset} — su ruptura confirma inicio de E2`,
        'Si el precio pierde el mR inferior, podría volver a E4 — cerrar LP y activar shorts',
        'Rango del LP estrecho = más fees pero necesita rebalanceo frecuente',
        'La reserva de USDC es clave — no desplegarla hasta confirmación de E2',
    ]);
}

// ── E3 DISTRIBUCIÓN: Reducir exposición, tomar beneficios, preparar cobertura ──
function buildDistributionStrategy(amount, rates, phases) {
    const steps = [];
    let totalApy = 0;
    const asset = phases.BTC?.type === 'distribution' ? 'BTC' : 'ETH';
    const borrowApy = rates.aave.borrow[asset];

    // 1. Supply USDC conservador
    steps.push({
        step: 1, action: 'Supply USDC en Aave (seguro)',
        detail: `Depositar ${fmtUsd(amount)} USDC en Aave V3. En E3 (distribución) el mercado se prepara para caer — prioridad es capital seguro en stables.`,
        token: 'USDC', amount: amount, apy: rates.aave.supply.USDC, protocol: 'Aave V3',
    });
    totalApy += rates.aave.supply.USDC;

    // 2. Borrow bajo (35%)
    const borrowAmount = Math.floor(amount * 0.35);
    const hf = (amount * AAVE_LTV.USDC) / borrowAmount;
    steps.push({
        step: 2, action: `Borrow ${asset} bajo (35% LTV)`,
        detail: `Pedir prestado solo ${fmtUsd(borrowAmount)} en ${asset}. En E3 se borra poco — alto riesgo de caída inminente. HF conservador: ${hf.toFixed(2)}.`,
        token: asset, amount: borrowAmount, apy: -borrowApy, protocol: 'Aave V3',
    });
    totalApy -= borrowApy * (borrowAmount / amount);

    // 3. Vender el borrow inmediatamente (convertir a USDC)
    steps.push({
        step: 3, action: `Vender ${asset} del borrow → USDC`,
        detail: `Vender inmediatamente los ${fmtUsd(borrowAmount)} de ${asset} prestado por USDC. Esto crea una posición SHORT sintética: si ${asset} cae, recompras más barato y devuelves a Aave con beneficio.`,
        token: asset, amount: borrowAmount, apy: 0, protocol: 'Swap (1inch/Paraswap)',
    });

    // 4. Short directo adicional
    const shortMargin = Math.floor(amount * 0.15);
    const shortLev = 5;
    steps.push({
        step: 4, action: `SHORT ${asset} x${shortLev} (anticipar E4)`,
        detail: `SHORT de ${fmtUsd(shortMargin * shortLev)} con ${fmtUsd(shortMargin)} de margen. En E3 se anticipa la caída a E4. Si ${asset} pierde el primer mR, la caída suele ser rápida.`,
        token: asset, amount: shortMargin, exposure: shortMargin * shortLev,
        leverage: shortLev, direction: 'SHORT',
        apy: getFundingApy(rates, asset, 'SHORT'), protocol: 'Hyperliquid',
    });
    totalApy += getFundingApy(rates, asset, 'SHORT') * (shortMargin / amount);

    // 5. Pool de stables (yield seguro con el capital restante)
    const stableLpAmount = borrowAmount;
    const stableLpApy = 8;
    steps.push({
        step: 5, action: 'Pool USDC estable (yield seguro)',
        detail: `Depositar ${fmtUsd(stableLpAmount)} en un pool de stables (USDC-USDT o similar) para generar yield sin exposición a volatilidad. Alternativa: re-depositar en Aave.`,
        token: 'USDC', amount: stableLpAmount, apy: stableLpApy,
        protocol: 'Curve / Uniswap Stables',
    });
    totalApy += stableLpApy * (stableLpAmount / amount);

    return finish(amount, 'E3 — DISTRIBUCIÓN', phases, asset, steps, totalApy, [
        `Si ${asset} pierde el mR (mínimo relevante), confirma E4 — mantener shorts`,
        `Si ${asset} recupera el MR superior, podría volver a E2 — cerrar shorts rápido`,
        'La venta del borrow es una posición SHORT sintética — devolver el borrow cuando el precio caiga',
        'E3 puede ser rápida (en V) o lenta (redondeada) — ajustar según el comportamiento',
        'NO hacer LP apalancado en E3 — riesgo de IL catastrófico si comienza E4',
    ]);
}

function finish(amount, marketPhase, phases, mainAsset, steps, totalApy, warnings) {
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
