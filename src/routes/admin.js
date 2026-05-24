const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../../db/init');

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autenticado' });

    const db = getDb();
    const session = db.prepare(
        "SELECT s.*, u.username FROM sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
    ).get(token);
    db.close();

    if (!session) return res.status(401).json({ error: 'Sesión expirada' });
    req.user = { id: session.user_id, username: session.username };
    next();
}

// POST /api/admin/setup — create first admin user (only if none exist)
router.post('/setup', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || password.length < 4) {
        return res.status(400).json({ error: 'Usuario y contraseña requeridos (mín. 4 caracteres)' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT COUNT(*) as c FROM admin_users').get();
    if (existing.c > 0) {
        db.close();
        return res.status(403).json({ error: 'Ya existe un admin. Usa /login.' });
    }

    db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
    db.close();
    res.json({ ok: true });
});

// POST /api/admin/login
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const db = getDb();
    const user = db.prepare('SELECT * FROM admin_users WHERE username = ? AND password_hash = ?').get(username, hashPassword(password));

    if (!user) {
        db.close();
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

    const token = generateToken();
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))").run(token, user.id);
    db.close();

    res.json({ ok: true, token, username: user.username });
});

// POST /api/admin/logout
router.post('/logout', authMiddleware, (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const db = getDb();
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    db.close();
    res.json({ ok: true });
});

// GET /api/admin/me
router.get('/me', authMiddleware, (req, res) => {
    res.json({ ok: true, username: req.user.username });
});

// GET /api/admin/ranges — list all custom ranges
router.get('/ranges', authMiddleware, (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM custom_ranges ORDER BY pair, timeframe').all();
    db.close();
    res.json({ ok: true, ranges: rows });
});

// POST /api/admin/ranges — upsert a custom range
router.post('/ranges', authMiddleware, (req, res) => {
    const { pair, timeframe, sup, mid, res: resistance, enabled } = req.body;
    if (!pair || !timeframe || sup == null || mid == null || resistance == null) {
        return res.status(400).json({ error: 'Campos requeridos: pair, timeframe, sup, mid, res' });
    }

    const db = getDb();
    db.prepare(`
        INSERT INTO custom_ranges (pair, timeframe, sup, mid, res, enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(pair, timeframe) DO UPDATE SET
            sup = excluded.sup,
            mid = excluded.mid,
            res = excluded.res,
            enabled = excluded.enabled,
            updated_at = datetime('now')
    `).run(pair, timeframe, sup, mid, resistance, enabled !== undefined ? (enabled ? 1 : 0) : 1);
    db.close();
    res.json({ ok: true });
});

// DELETE /api/admin/ranges/:pair/:timeframe
router.delete('/ranges/:pair/:timeframe', authMiddleware, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM custom_ranges WHERE pair = ? AND timeframe = ?').run(req.params.pair, req.params.timeframe);
    db.close();
    res.json({ ok: true });
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
