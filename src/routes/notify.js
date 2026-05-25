const express = require('express');
const router = express.Router();
const {
    getNotifyStatus, sendTelegram, detectChatId,
    setTelegramConfig, getTelegramConfig,
} = require('../services/notify');

// GET /api/notify/status
router.get('/status', (req, res) => {
    res.json(getNotifyStatus());
});

// GET /api/notify/telegram
router.get('/telegram', (req, res) => {
    const cfg = getTelegramConfig();
    res.json({ bot_token_set: !!cfg.bot_token, chat_id_set: !!cfg.chat_id, chat_id: cfg.chat_id || null });
});

// POST /api/notify/telegram/setup
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
        res.json({ ok: false, chat_id: null, message: 'Bot token guardado. Manda /start al bot en Telegram y pulsa "Detectar" de nuevo.' });
    }
});

// POST /api/notify/telegram/detect
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

// POST /api/notify/check
router.post('/check', async (req, res) => {
    try {
        const { checkRules } = require('../services/rules');
        const result = await checkRules(null);
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
