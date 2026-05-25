const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'positions.db');

function getDb() {
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS custom_ranges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pair TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            sup REAL NOT NULL,
            mid REAL NOT NULL,
            res REAL NOT NULL,
            enabled INTEGER DEFAULT 1,
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(pair, timeframe)
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES admin_users(id)
        );

        CREATE TABLE IF NOT EXISTS candles (
            pair TEXT NOT NULL,
            interval TEXT NOT NULL,
            open_time INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            close_time INTEGER NOT NULL,
            PRIMARY KEY (pair, interval, open_time)
        );

        CREATE INDEX IF NOT EXISTS idx_candles_pair_interval
            ON candles(pair, interval, open_time);

        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pair TEXT NOT NULL,
            interval TEXT NOT NULL,
            candles_synced INTEGER DEFAULT 0,
            last_open_time INTEGER,
            synced_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS executed_strategies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_token TEXT NOT NULL,
            amount REAL NOT NULL,
            market_phase TEXT,
            main_asset TEXT,
            strategy_json TEXT,
            status TEXT DEFAULT 'active',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS executed_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id INTEGER NOT NULL,
            step_num INTEGER NOT NULL,
            done INTEGER DEFAULT 0,
            entry_price REAL,
            lp_range_low REAL,
            lp_range_high REAL,
            leverage REAL,
            direction TEXT,
            margin_amount REAL,
            notes TEXT DEFAULT '',
            executed_at TEXT,
            FOREIGN KEY (strategy_id) REFERENCES executed_strategies(id),
            UNIQUE(strategy_id, step_num)
        );

        CREATE TABLE IF NOT EXISTS alert_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id INTEGER NOT NULL,
            alert_type TEXT NOT NULL,
            message TEXT NOT NULL,
            dismissed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

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

        CREATE TABLE IF NOT EXISTS app_config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );
    `);

    return db;
}

module.exports = { getDb };
