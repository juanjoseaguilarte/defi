const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'positions.db');

function getDb() {
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_token TEXT NOT NULL,
            collateral_coin TEXT NOT NULL,
            collateral_qty REAL NOT NULL,
            debt_coin TEXT NOT NULL,
            debt_qty REAL NOT NULL,
            hf_alert_threshold REAL DEFAULT 1.80,
            notes TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS position_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_token TEXT NOT NULL,
            action_type TEXT NOT NULL,
            from_asset TEXT,
            to_asset TEXT,
            qty TEXT,
            executed_at TEXT DEFAULT (datetime('now')),
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);

    return db;
}

module.exports = { getDb };
