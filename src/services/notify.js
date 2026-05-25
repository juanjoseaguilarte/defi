const { checkRules, saveAlert } = require('./rules');
const { getDb } = require('../../db/init');

// ═══════════════════════════════════════════════════════════════
// TELEGRAM — Config stored in DB
// ═══════════════════════════════════════════════════════════════

function ensureConfigTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
    )`);
}

function getTelegramConfig() {
    try {
        const db = getDb();
        ensureConfigTable(db);
        const row = (k) => db.prepare('SELECT value FROM app_config WHERE key = ?').get(k)?.value || '';
        const cfg = { bot_token: row('telegram_bot_token'), chat_id: row('telegram_chat_id') };
        db.close();
        return cfg;
    } catch (_) { return { bot_token: '', chat_id: '' }; }
}

function setTelegramConfig(botToken, chatId) {
    const db = getDb();
    ensureConfigTable(db);
    const upsert = db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')");
    if (botToken) upsert.run('telegram_bot_token', botToken);
    if (chatId) upsert.run('telegram_chat_id', chatId);
    db.close();
}

async function sendTelegram(text) {
    const cfg = getTelegramConfig();
    if (!cfg.bot_token || !cfg.chat_id) return false;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: cfg.chat_id, text,
                parse_mode: 'Markdown', disable_web_page_preview: true,
            }),
        });
        return resp.ok;
    } catch (e) {
        console.error('[Notify] Telegram error:', e.message);
        return false;
    }
}

async function detectChatId(botToken) {
    try {
        const resp = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data.ok || !data.result?.length) return null;
        for (const u of data.result) {
            const chat = u.message?.chat || u.my_chat_member?.chat;
            if (chat?.id) return String(chat.id);
        }
        return null;
    } catch (e) {
        console.error('[Notify] detectChatId error:', e.message);
        return null;
    }
}

function formatTelegramAlert(alert) {
    const icons = { critical: '🚨', action: '⚡', warning: '⚠️', info: 'ℹ️' };
    const icon = icons[alert.type] || '📋';
    let msg = `${icon} *${alert.message}*\n`;
    if (alert.actions?.length) {
        msg += '\n*Acciones:*\n';
        for (const a of alert.actions) msg += `• ${a}\n`;
    }
    if (alert.rule?.name) msg += `\n_Regla: ${alert.rule.name}_`;
    return msg;
}

function fmtP(v) {
    if (!v || v === 0) return '—';
    if (v > 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ═══════════════════════════════════════════════════════════════
// DEDUP
// ═══════════════════════════════════════════════════════════════

const sentAlerts = new Map();
const DEDUP_TTL = {
    critical: 15 * 60 * 1000,
    action: 60 * 60 * 1000,
    warning: 4 * 60 * 60 * 1000,
    info: 24 * 60 * 60 * 1000,
};

function shouldSend(alert) {
    const key = `${alert.category}:${alert.asset}:${alert.type}`;
    const lastSent = sentAlerts.get(key);
    const ttl = DEDUP_TTL[alert.type] || DEDUP_TTL.info;
    if (lastSent && Date.now() - lastSent < ttl) return false;
    sentAlerts.set(key, Date.now());
    return true;
}

// ═══════════════════════════════════════════════════════════════
// DAYTRADER POSITION TRACKING (runs every 60s)
// ═══════════════════════════════════════════════════════════════

async function checkDaytraderPositions() {
    const { fetchAllPrices } = require('./binance');
    const db = getDb();

    let trades;
    try {
        trades = db.prepare("SELECT * FROM daytrade_signals WHERE status = 'tracking'").all();
    } catch (_) { db.close(); return; }

    if (!trades.length) { db.close(); return; }

    let prices;
    try { prices = await fetchAllPrices(); } catch (_) { db.close(); return; }

    for (const t of trades) {
        const pair = t.asset + 'USDT';
        const price = prices[pair];
        if (!price) continue;

        const isLong = t.signal === 'LONG';
        const pnlPct = isLong
            ? ((price - t.entry_price) / t.entry_price * t.leverage * 100)
            : ((t.entry_price - price) / t.entry_price * t.leverage * 100);

        let hit = null;
        if (isLong && price >= t.tp) hit = 'tp';
        else if (isLong && price <= t.sl) hit = 'sl';
        else if (!isLong && price <= t.tp) hit = 'tp';
        else if (!isLong && price >= t.sl) hit = 'sl';

        if (hit) {
            const icon = hit === 'tp' ? '✅' : '❌';
            const label = hit === 'tp' ? 'TAKE PROFIT' : 'STOP LOSS';
            const key = `dt:${t.id}:${hit}`;
            if (!shouldSend({ category: key, asset: t.asset, type: 'critical' })) continue;

            db.prepare("UPDATE daytrade_signals SET status = 'closed', result = ?, closed_price = ?, pnl_pct = ?, closed_at = datetime('now') WHERE id = ?")
                .run(hit, price, +pnlPct.toFixed(2), t.id);

            await sendTelegram([
                `${icon} *${label}: ${t.signal} ${t.asset}*`,
                '', `*Entrada:* $${fmtP(t.entry_price)}`,
                `*Cierre:* $${fmtP(price)}`,
                `*P&L:* ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (x${t.leverage})`,
            ].join('\n'));

            console.log(`[Notify] DT ${label}: ${t.signal} ${t.asset} P&L ${pnlPct.toFixed(1)}%`);
            continue;
        }

        // Warn near TP/SL (within 20% of range)
        const totalRange = Math.abs(t.tp - t.sl);
        const distToTp = Math.abs(price - t.tp);
        const distToSl = Math.abs(price - t.sl);

        if (totalRange > 0 && distToTp / totalRange < 0.2) {
            const key = `dt-near-tp:${t.id}`;
            if (shouldSend({ category: key, asset: t.asset, type: 'action' })) {
                await sendTelegram(`⚡ *Cerca de TP: ${t.signal} ${t.asset}*\nPrecio: $${fmtP(price)} | P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
            }
        } else if (totalRange > 0 && distToSl / totalRange < 0.2) {
            const key = `dt-near-sl:${t.id}`;
            if (shouldSend({ category: key, asset: t.asset, type: 'action' })) {
                await sendTelegram(`⚠️ *Cerca de SL: ${t.signal} ${t.asset}*\nPrecio: $${fmtP(price)} | P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
            }
        }

        // Expiry
        if (t.exit_by) {
            const remaining = new Date(t.exit_by).getTime() - Date.now();
            if (remaining < 0) {
                const key = `dt-expired:${t.id}`;
                if (shouldSend({ category: key, asset: t.asset, type: 'warning' })) {
                    await sendTelegram(`⏰ *Tiempo expirado: ${t.signal} ${t.asset}*\nPrecio: $${fmtP(price)} | P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%\nCerrar manualmente.`);
                }
            } else if (remaining < 30 * 60 * 1000) {
                const key = `dt-expiring:${t.id}`;
                if (shouldSend({ category: key, asset: t.asset, type: 'warning' })) {
                    await sendTelegram(`⏰ *Quedan ${Math.round(remaining/60000)} min: ${t.signal} ${t.asset}*\nPrecio: $${fmtP(price)} | P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
                }
            }
        }
    }

    db.close();
}

// ═══════════════════════════════════════════════════════════════
// CRON — Two intervals: trades 60s, strategy 15min
// ═══════════════════════════════════════════════════════════════

let trackingInterval = null;
let strategyInterval = null;
let activeStrategyLoader = null;

function setStrategyLoader(fn) {
    activeStrategyLoader = fn;
}

function startCron() {
    if (trackingInterval) clearInterval(trackingInterval);
    if (strategyInterval) clearInterval(strategyInterval);

    trackingInterval = setInterval(checkDaytraderPositions, 60 * 1000);
    strategyInterval = setInterval(async () => {
        try {
            let strat = null;
            if (activeStrategyLoader) strat = await activeStrategyLoader();
            const result = await checkRules(strat);
            for (const alert of result.alerts.filter(a => a.type !== 'info')) {
                if (!shouldSend(alert)) continue;
                const sent = await sendTelegram(formatTelegramAlert(alert));
                if (strat?.id) saveAlert(strat.id, alert.category, alert.message);
                console.log(`[Notify] ${alert.type.toUpperCase()}: ${alert.message} | TG:${sent}`);
            }
        } catch (e) { console.error('[Notify] Strategy check error:', e.message); }
    }, 15 * 60 * 1000);

    console.log('[Notify] Cron started: trades every 60s, strategy every 15min');
    setTimeout(checkDaytraderPositions, 5000);
}

function stopCron() {
    if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
    if (strategyInterval) { clearInterval(strategyInterval); strategyInterval = null; }
}

// ═══════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════

function getNotifyStatus() {
    const cfg = getTelegramConfig();
    return {
        telegram: { configured: !!(cfg.bot_token && cfg.chat_id), bot_token_set: !!cfg.bot_token, chat_id_set: !!cfg.chat_id },
        cron: { running: !!(trackingInterval || strategyInterval) },
        dedup: { tracked: sentAlerts.size },
    };
}

module.exports = {
    sendTelegram, detectChatId,
    startCron, stopCron,
    setStrategyLoader, getNotifyStatus,
    setTelegramConfig, getTelegramConfig,
};
