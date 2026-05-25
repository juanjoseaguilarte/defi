const express = require('express');
const router = express.Router();
const {
    addPushSubscription, removePushSubscription,
    runCheck, getNotifyStatus, sendTelegram, detectChatId,
    setTelegramConfig, getTelegramConfig, VAPID_PUBLIC,
} = require('../services/notify');

// GET /api/notify/status
router.get('/status', (req, res) => {
    res.json(getNotifyStatus());
});

// GET /api/notify/vapid
router.get('/vapid', (req, res) => {
    if (!VAPID_PUBLIC) return res.json({ configured: false });
    res.json({ configured: true, publicKey: VAPID_PUBLIC });
});

// POST /api/notify/push/subscribe
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

// GET /api/notify/telegram — Get current Telegram config status
router.get('/telegram', (req, res) => {
    const cfg = getTelegramConfig();
    res.json({
        bot_token_set: !!cfg.bot_token,
        chat_id_set: !!cfg.chat_id,
        chat_id: cfg.chat_id || null,
    });
});

// POST /api/notify/telegram/setup — Save bot token + auto-detect chat_id
router.post('/telegram/setup', async (req, res) => {
    const { bot_token } = req.body;
    if (!bot_token) return res.status(400).json({ error: 'bot_token required' });

    setTelegramConfig(bot_token, null);

    const chatId = await detectChatId(bot_token);
    if (chatId) {
        setTelegramConfig(null, chatId);
        const sent = await sendTelegram('✅ *DeFi Dashboard conectado*\nRecibirás alertas de tu estrategia aquí.');
        res.json({ ok: true, chat_id: chatId, test_sent: sent });
    } else {
        res.json({
            ok: false,
            chat_id: null,
            message: 'Bot token guardado. Manda /start al bot en Telegram y pulsa "Detectar" de nuevo.',
        });
    }
});

// POST /api/notify/telegram/detect — Re-detect chat_id
router.post('/telegram/detect', async (req, res) => {
    const cfg = getTelegramConfig();
    if (!cfg.bot_token) return res.status(400).json({ error: 'Bot token not configured' });

    const chatId = await detectChatId(cfg.bot_token);
    if (chatId) {
        setTelegramConfig(null, chatId);
        const sent = await sendTelegram('✅ *DeFi Dashboard conectado*\nRecibirás alertas de tu estrategia aquí.');
        res.json({ ok: true, chat_id: chatId, test_sent: sent });
    } else {
        res.json({ ok: false, message: 'No se encontró chat. Manda /start al bot en Telegram.' });
    }
});

// POST /api/notify/telegram/test
router.post('/telegram/test', async (req, res) => {
    const sent = await sendTelegram('🔔 *Test de conexión*\nDeFi Dashboard conectado correctamente.\nLas alertas llegarán aquí.');
    res.json({ ok: sent, message: sent ? 'Mensaje enviado' : 'Error: verifica token y chat_id' });
});

// POST /api/notify/check — Force immediate rule check
router.post('/check', async (req, res) => {
    try {
        const result = await runCheck();
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
