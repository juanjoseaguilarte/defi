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
// STRATEGY BUILDER — One cohesive chained strategy
// ═══════════════════════════════════════════════════════════════

function buildStrategy(amount, rates, phases) {
    const steps = [];
    const breakdown = [];
    let totalEstApy = 0;
    let remainingCapital = amount;

    const btcPhase = phases.BTC?.type || 'range';
    const ethPhase = phases.ETH?.type || 'range';

    const isBearish = btcPhase === 'bear' || ethPhase === 'bear';
    const isBullish = btcPhase === 'bull' && ethPhase === 'bull';
    const isTransition = !isBearish && !isBullish;

    const mainAsset = ethPhase === 'bull' ? 'ETH' : (btcPhase === 'bull' ? 'BTC' : 'ETH');
    const marketSummary = isBearish ? 'BAJISTA' : (isBullish ? 'ALCISTA' : 'LATERAL/TRANSICIÓN');

    // ── Step 1: Deposit USDC in Aave ──
    const depositAmount = amount;
    const supplyApy = rates.aave.supply.USDC;
    const supplyYield = depositAmount * supplyApy / 100;

    steps.push({
        step: 1,
        action: 'Depositar colateral en Aave',
        detail: `Depositar ${fmtUsd(depositAmount)} USDC como colateral en Aave V3 (Arbitrum)`,
        token: 'USDC',
        amount: depositAmount,
        apy: supplyApy,
        protocol: 'Aave V3',
    });
    breakdown.push({ label: 'Supply USDC en Aave', amount: depositAmount, apy: supplyApy });
    totalEstApy += supplyApy * (depositAmount / amount);

    // ── Step 2: Borrow from Aave ──
    const ltv = AAVE_LTV.USDC;
    const borrowPct = isBearish ? 0.50 : (isBullish ? 0.65 : 0.55);
    const borrowAmount = Math.floor(depositAmount * borrowPct);
    const borrowAsset = mainAsset;
    const borrowApy = rates.aave.borrow[borrowAsset];

    steps.push({
        step: 2,
        action: `Pedir prestado ${borrowAsset}`,
        detail: `Borrow ${fmtUsd(borrowAmount)} en ${borrowAsset} de Aave (${(borrowPct * 100).toFixed(0)}% LTV). Health Factor estimado: ${(ltv / borrowPct).toFixed(2)}`,
        token: borrowAsset,
        amount: borrowAmount,
        apy: -borrowApy,
        protocol: 'Aave V3',
    });
    breakdown.push({ label: `Borrow ${borrowAsset} Aave`, amount: borrowAmount, apy: -borrowApy });
    totalEstApy -= borrowApy * (borrowAmount / amount);

    // ── Distribute borrow across: hedge + IL hedge + LP ──
    const hedgePct = isBearish ? 0.15 : (isBullish ? 0.05 : 0.10);
    const ilHedgePct = 0.05;
    const hedgeAmount = Math.floor(borrowAmount * hedgePct);
    const ilHedgeAmount = Math.floor(borrowAmount * ilHedgePct);
    const lpAmount = borrowAmount - hedgeAmount - ilHedgeAmount;

    // ── Step 3: Hedge with perps (based on market phase) ──
    const hedgeLeverage = 10;
    const hedgeExposure = hedgeAmount * hedgeLeverage;

    const hedgeDirection = isBearish ? 'SHORT' : (isBullish ? 'LONG' : 'SHORT');
    const hedgeReason = isBearish
        ? `Mercado bajista (${btcPhase === 'bear' ? 'BTC' : 'ETH'} en E4) — proteger con short`
        : (isBullish
            ? `Mercado alcista — long apalancado para maximizar`
            : `Mercado lateral — short ligero como cobertura`);

    const fundingRate = rates.funding[mainAsset];
    const fundingApy = fundingRate
        ? (hedgeDirection === 'SHORT' && fundingRate.rate > 0 ? fundingRate.annualized * 100 : (hedgeDirection === 'LONG' && fundingRate.rate < 0 ? Math.abs(fundingRate.annualized) * 100 : -Math.abs(fundingRate.annualized) * 100))
        : 0;

    steps.push({
        step: 3,
        action: `${hedgeDirection} ${mainAsset} x${hedgeLeverage} (cobertura)`,
        detail: `${hedgeDirection} de ${fmtUsd(hedgeExposure)} en ${mainAsset}-PERP con ${fmtUsd(hedgeAmount)} de margen (x${hedgeLeverage}). ${hedgeReason}`,
        token: mainAsset,
        amount: hedgeAmount,
        exposure: hedgeExposure,
        leverage: hedgeLeverage,
        direction: hedgeDirection,
        apy: fundingApy,
        protocol: 'Hyperliquid / GMX',
    });
    breakdown.push({ label: `${hedgeDirection} ${mainAsset} x${hedgeLeverage}`, amount: hedgeAmount, apy: fundingApy });
    totalEstApy += fundingApy * (hedgeAmount / amount);

    // ── Step 4: Provide liquidity in pool ──
    const lpPair = `${mainAsset}-USDC`;
    const lpBaseApy = rates.lp[lpPair] || 20;

    steps.push({
        step: 4,
        action: `Pool de liquidez ${lpPair}`,
        detail: `Proveer ${fmtUsd(lpAmount)} en el pool ${lpPair} (Uniswap V3 / Camelot). Del borrow de ${fmtUsd(borrowAmount)}: ${fmtUsd(hedgeAmount)} hedge + ${fmtUsd(ilHedgeAmount)} hedge IL + ${fmtUsd(lpAmount)} LP.`,
        token: lpPair,
        amount: lpAmount,
        apy: lpBaseApy,
        protocol: 'Uniswap V3 / Camelot',
    });
    breakdown.push({ label: `LP ${lpPair}`, amount: lpAmount, apy: lpBaseApy });
    totalEstApy += lpBaseApy * (lpAmount / amount);

    // ── Step 5: Leverage LP x2 via Revert ──
    const leverageFactor = 2;
    const leveragedLpAmount = lpAmount * leverageFactor;
    const leverageBorrowCost = borrowApy;
    const leveragedApy = lpBaseApy * leverageFactor - leverageBorrowCost;

    steps.push({
        step: 5,
        action: `Apalancamiento LP x${leverageFactor} (Revert)`,
        detail: `Usar Revert Finance para apalancar la posición LP a x${leverageFactor}. Exposición total: ${fmtUsd(leveragedLpAmount)}. Pide prestado adicional contra tu LP.`,
        token: lpPair,
        amount: lpAmount,
        leveragedExposure: leveragedLpAmount,
        apy: leveragedApy,
        protocol: 'Revert Finance',
    });
    breakdown.push({ label: `LP x${leverageFactor} Revert`, amount: lpAmount, apy: leveragedApy - lpBaseApy });
    totalEstApy += (leveragedApy - lpBaseApy) * (lpAmount / amount);

    // ── Step 6: Hedge LP impermanent loss ──
    const ilHedgeDirection = 'SHORT';
    const ilHedgeLeverage = 5;

    steps.push({
        step: 6,
        action: `Hedge IL — ${ilHedgeDirection} ${mainAsset} x${ilHedgeLeverage}`,
        detail: `Cubrir impermanent loss del LP: ${ilHedgeDirection} ${fmtUsd(ilHedgeAmount * ilHedgeLeverage)} en ${mainAsset}-PERP con ${fmtUsd(ilHedgeAmount)} de margen. Protege contra movimientos bruscos que amplificarían el IL con apalancamiento.`,
        token: mainAsset,
        amount: ilHedgeAmount,
        exposure: ilHedgeAmount * ilHedgeLeverage,
        leverage: ilHedgeLeverage,
        direction: ilHedgeDirection,
        apy: 0,
        protocol: 'Hyperliquid / GMX',
    });
    breakdown.push({ label: `Hedge IL ${mainAsset}`, amount: ilHedgeAmount, apy: 0 });

    // ── Summary ──
    const hfEstimado = (depositAmount * ltv) / borrowAmount;

    const warnings = [];
    if (hfEstimado < 1.5) warnings.push(`Health Factor bajo (${hfEstimado.toFixed(2)}) — riesgo de liquidación en Aave`);
    if (isBearish) warnings.push('Mercado bajista: monitorizar hedge y considerar reducir LP leverage');
    warnings.push('Los APYs de los pools varían — verificar en DeFiLlama antes de ejecutar');
    warnings.push('Rebalancear el hedge de perps semanalmente');
    if (fundingRate) warnings.push(`Funding rate actual ${mainAsset}: ${(fundingRate.rate * 100).toFixed(4)}%/h — puede cambiar de signo`);

    return {
        amount,
        chain: 'Arbitrum',
        marketPhase: marketSummary,
        btcPhase: phases.BTC?.phase || 'N/A',
        ethPhase: phases.ETH?.phase || 'N/A',
        mainAsset,
        steps,
        breakdown,
        totalEstApy: parseFloat(totalEstApy.toFixed(1)),
        healthFactor: parseFloat(hfEstimado.toFixed(2)),
        totalExposure: {
            collateral: depositAmount,
            borrowed: borrowAmount,
            lpExposure: leveragedLpAmount,
            hedgeExposure: hedgeExposure + ilHedgeAmount * ilHedgeLeverage,
        },
        warnings,
        calculated_at: new Date().toISOString(),
    };
}

function fmtUsd(v) {
    return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function getStrategy(amount) {
    const [rates, phases] = await Promise.all([
        fetchLiveRates(),
        fetchMarketPhases(),
    ]);

    const strategy = buildStrategy(amount, rates, phases);

    return {
        ...strategy,
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
