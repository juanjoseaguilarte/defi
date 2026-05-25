const { checkRules, saveAlert } = require('./rules');

// ═══════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegram(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            }),
        });
        return resp.ok;
    } catch (e) {
        console.error('[Notify] Telegram error:', e.message);
        return false;
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

// ═══════════════════════════════════════════════════════════════
// PUSH SUBSCRIPTIONS (Web Push via VAPID)
// ═══════════════════════════════════════════════════════════════

let webpush;
try { webpush = require('web-push'); } catch (_) { webpush = null; }

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:defi@example.com';

if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

const pushSubscriptions = new Map();

function addPushSubscription(deviceToken, subscription) {
    pushSubscriptions.set(deviceToken, subscription);
}

function removePushSubscription(deviceToken) {
    pushSubscriptions.delete(deviceToken);
}

async function sendPush(deviceToken, payload) {
    if (!webpush || !VAPID_PUBLIC) return false;
    const sub = pushSubscriptions.get(deviceToken);
    if (!sub) return false;
    try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
        return true;
    } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
            pushSubscriptions.delete(deviceToken);
        }
        console.error('[Notify] Push error:', e.message);
        return false;
    }
}

function formatPushPayload(alert) {
    const icons = { critical: '🚨', action: '⚡', warning: '⚠️', info: 'ℹ️' };
    return {
        title: `${icons[alert.type] || '📋'} DeFi Alert`,
        body: alert.message,
        data: {
            type: alert.type,
            category: alert.category,
            asset: alert.asset,
            actions: alert.actions,
            url: '/strategy',
        },
        tag: alert.category + '-' + alert.asset,
        renotify: alert.type === 'critical',
    };
}

// ═══════════════════════════════════════════════════════════════
// DEDUP — Don't spam the same alert
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
// CRON — Periodic rule checker
// ═══════════════════════════════════════════════════════════════

let cronInterval = null;
let activeStrategyLoader = null;

function setStrategyLoader(fn) {
    activeStrategyLoader = fn;
}

async function runCheck() {
    try {
        let activeStrategy = null;
        if (activeStrategyLoader) {
            activeStrategy = await activeStrategyLoader();
        }

        const result = await checkRules(activeStrategy);
        const actionable = result.alerts.filter(a => a.type !== 'info');

        for (const alert of actionable) {
            if (!shouldSend(alert)) continue;

            const sent = { telegram: false, push: false };

            sent.telegram = await sendTelegram(formatTelegramAlert(alert));

            for (const [dt] of pushSubscriptions) {
                sent.push = await sendPush(dt, formatPushPayload(alert)) || sent.push;
            }

            if (activeStrategy?.id) {
                saveAlert(activeStrategy.id, alert.category, alert.message);
            }

            console.log(`[Notify] ${alert.type.toUpperCase()}: ${alert.message} | TG:${sent.telegram} Push:${sent.push}`);
        }

        return result;
    } catch (e) {
        console.error('[Notify] Check error:', e.message);
        return null;
    }
}

function startCron(intervalMs = 15 * 60 * 1000) {
    if (cronInterval) clearInterval(cronInterval);
    cronInterval = setInterval(runCheck, intervalMs);
    console.log(`[Notify] Cron started: checking every ${intervalMs / 60000} min`);
    setTimeout(runCheck, 5000);
}

function stopCron() {
    if (cronInterval) { clearInterval(cronInterval); cronInterval = null; }
}

// ═══════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════

function getNotifyStatus() {
    return {
        telegram: { configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) },
        push: { configured: !!(webpush && VAPID_PUBLIC), subscriptions: pushSubscriptions.size },
        cron: { running: !!cronInterval },
        dedup: { tracked: sentAlerts.size },
    };
}

module.exports = {
    sendTelegram, sendPush,
    addPushSubscription, removePushSubscription,
    startCron, stopCron, runCheck,
    setStrategyLoader, getNotifyStatus,
    VAPID_PUBLIC,
};
