const express = require('express');
const router = express.Router();
const {
    addPushSubscription, removePushSubscription,
    runCheck, getNotifyStatus, sendTelegram, VAPID_PUBLIC,
} = require('../services/notify');

// GET /api/notify/status — Notification channels status
router.get('/status', (req, res) => {
    res.json(getNotifyStatus());
});

// GET /api/notify/vapid — Get VAPID public key for push subscription
router.get('/vapid', (req, res) => {
    if (!VAPID_PUBLIC) return res.json({ configured: false });
    res.json({ configured: true, publicKey: VAPID_PUBLIC });
});

// POST /api/notify/push/subscribe — Register push subscription
router.post('/push/subscribe', (req, res) => {
    const { device_token, subscription } = req.body;
    if (!device_token || !subscription) {
        return res.status(400).json({ error: 'device_token and subscription required' });
    }
    addPushSubscription(device_token, subscription);
    res.json({ ok: true, message: 'Push subscription registered' });
});

// POST /api/notify/push/unsubscribe
router.post('/push/unsubscribe', (req, res) => {
    const { device_token } = req.body;
    if (!device_token) return res.status(400).json({ error: 'device_token required' });
    removePushSubscription(device_token);
    res.json({ ok: true });
});

// POST /api/notify/telegram/test — Send test message
router.post('/telegram/test', async (req, res) => {
    const sent = await sendTelegram('🔔 *Test de conexión*\nDeFi Dashboard conectado correctamente.\nLas alertas llegarán aquí.');
    res.json({ ok: sent, message: sent ? 'Mensaje enviado' : 'Error: verifica TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID' });
});

// POST /api/notify/check — Force an immediate rule check
router.post('/check', async (req, res) => {
    try {
        const result = await runCheck();
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
