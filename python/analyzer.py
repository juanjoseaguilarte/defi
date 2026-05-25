#!/usr/bin/env python3
"""
DeFi Analyzer — Technical analysis engine.
Called from Node.js, reads candles from Binance API, returns JSON signal.

Usage: python3 analyzer.py ETH
       python3 analyzer.py BTC --mode daily
       python3 analyzer.py SOL --mode strategy
"""

import sys
import json
import math
import requests
import numpy as np
import pandas as pd
from datetime import datetime, timezone

# ═══════════════════════════════════════════════════════════════
# FETCH CANDLES FROM BINANCE
# ═══════════════════════════════════════════════════════════════

BINANCE_URLS = [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://data-api.binance.vision",
]

def fetch_candles(symbol, interval, limit=250):
    for base in BINANCE_URLS:
        try:
            url = f"{base}/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}"
            r = requests.get(url, timeout=8)
            if r.status_code != 200:
                continue
            data = r.json()
            df = pd.DataFrame(data, columns=[
                'ts', 'open', 'high', 'low', 'close', 'volume',
                'close_time', 'quote_vol', 'trades', 'taker_buy_base',
                'taker_buy_quote', 'ignore'
            ])
            for col in ['open', 'high', 'low', 'close', 'volume']:
                df[col] = df[col].astype(float)
            df['ts'] = pd.to_datetime(df['ts'], unit='ms')
            return df
        except Exception:
            continue
    raise Exception(f"Failed to fetch {symbol} {interval}")


# ═══════════════════════════════════════════════════════════════
# TECHNICAL INDICATORS
# ═══════════════════════════════════════════════════════════════

def sma(series, period):
    return series.rolling(window=period).mean()

def ema(series, period):
    return series.ewm(span=period, adjust=False).mean()

def rsi(series, period=14):
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1/period, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1/period, min_periods=period).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))

def macd(series, fast=12, slow=26, signal=9):
    ema_fast = ema(series, fast)
    ema_slow = ema(series, slow)
    macd_line = ema_fast - ema_slow
    signal_line = ema(macd_line, signal)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram

def bollinger_bands(series, period=20, std_dev=2):
    mid = sma(series, period)
    std = series.rolling(window=period).std()
    upper = mid + std_dev * std
    lower = mid - std_dev * std
    return upper, mid, lower

def atr(df, period=14):
    high_low = df['high'] - df['low']
    high_close = (df['high'] - df['close'].shift()).abs()
    low_close = (df['low'] - df['close'].shift()).abs()
    tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
    return tr.rolling(window=period).mean()

def stochastic(df, k_period=14, d_period=3):
    low_min = df['low'].rolling(window=k_period).min()
    high_max = df['high'].rolling(window=k_period).max()
    k = 100 * (df['close'] - low_min) / (high_max - low_min)
    d = k.rolling(window=d_period).mean()
    return k, d

def vwap(df):
    typical_price = (df['high'] + df['low'] + df['close']) / 3
    cum_vol = df['volume'].cumsum()
    cum_vp = (typical_price * df['volume']).cumsum()
    return cum_vp / cum_vol

def adx(df, period=14):
    plus_dm = df['high'].diff()
    minus_dm = -df['low'].diff()
    plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
    minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)

    atr_val = atr(df, period)
    plus_di = 100 * ema(plus_dm, period) / atr_val
    minus_di = 100 * ema(minus_dm, period) / atr_val
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    adx_val = ema(dx, period)
    return adx_val, plus_di, minus_di

def find_pivots(df, window=3):
    highs = []
    lows = []
    for i in range(window, len(df) - window):
        h = df['high'].iloc[i]
        l = df['low'].iloc[i]
        is_high = all(h > df['high'].iloc[i-j] and h > df['high'].iloc[i+j] for j in range(1, window+1))
        is_low = all(l < df['low'].iloc[i-j] and l < df['low'].iloc[i+j] for j in range(1, window+1))
        if is_high:
            highs.append({'idx': i, 'price': h, 'ts': str(df['ts'].iloc[i])})
        if is_low:
            lows.append({'idx': i, 'price': l, 'ts': str(df['ts'].iloc[i])})
    return highs, lows


# ═══════════════════════════════════════════════════════════════
# TIMEFRAME ANALYSIS
# ═══════════════════════════════════════════════════════════════

def analyze_tf(df):
    """Full analysis of a single timeframe."""
    c = df['close']
    price = c.iloc[-1]

    sma20 = sma(c, 20)
    sma40 = sma(c, 40)
    ema9 = ema(c, 9)
    ema21 = ema(c, 21)

    rsi_val = rsi(c, 14)
    macd_line, macd_signal, macd_hist = macd(c)
    bb_upper, bb_mid, bb_lower = bollinger_bands(c)
    atr_val = atr(df, 14)
    stoch_k, stoch_d = stochastic(df)
    adx_val, plus_di, minus_di = adx(df)

    last_sma20 = sma20.iloc[-1]
    last_sma40 = sma40.iloc[-1] if not pd.isna(sma40.iloc[-1]) else last_sma20

    # SMA slope
    sma20_5ago = sma20.iloc[-6] if len(sma20) > 5 and not pd.isna(sma20.iloc[-6]) else last_sma20
    slope = (last_sma20 - sma20_5ago) / sma20_5ago * 100 if sma20_5ago else 0

    # Momentum: count bull/bear candles
    last5 = df.tail(5)
    bull_candles = (last5['close'] > last5['open']).sum()
    bear_candles = (last5['close'] < last5['open']).sum()

    return {
        'price': round(price, 2),
        'sma20': round(last_sma20, 2),
        'sma40': round(last_sma40, 2),
        'ema9': round(ema9.iloc[-1], 2),
        'ema21': round(ema21.iloc[-1], 2),
        'sma20_slope': round(slope, 3),
        'above_sma20': bool(price > last_sma20),
        'dist_pct': round((price - last_sma20) / last_sma20 * 100, 2),
        'rsi': round(rsi_val.iloc[-1], 1),
        'macd': round(macd_line.iloc[-1], 4),
        'macd_signal': round(macd_signal.iloc[-1], 4),
        'macd_hist': round(macd_hist.iloc[-1], 4),
        'macd_cross': 'bullish' if macd_hist.iloc[-1] > 0 and macd_hist.iloc[-2] <= 0 else
                      'bearish' if macd_hist.iloc[-1] < 0 and macd_hist.iloc[-2] >= 0 else 'none',
        'bb_upper': round(bb_upper.iloc[-1], 2),
        'bb_lower': round(bb_lower.iloc[-1], 2),
        'bb_width': round((bb_upper.iloc[-1] - bb_lower.iloc[-1]) / bb_mid.iloc[-1] * 100, 2),
        'bb_position': round((price - bb_lower.iloc[-1]) / (bb_upper.iloc[-1] - bb_lower.iloc[-1]) * 100, 1) if bb_upper.iloc[-1] != bb_lower.iloc[-1] else 50,
        'atr': round(atr_val.iloc[-1], 2),
        'atr_pct': round(atr_val.iloc[-1] / price * 100, 3),
        'stoch_k': round(stoch_k.iloc[-1], 1),
        'stoch_d': round(stoch_d.iloc[-1], 1),
        'adx': round(adx_val.iloc[-1], 1) if not pd.isna(adx_val.iloc[-1]) else 0,
        'plus_di': round(plus_di.iloc[-1], 1) if not pd.isna(plus_di.iloc[-1]) else 0,
        'minus_di': round(minus_di.iloc[-1], 1) if not pd.isna(minus_di.iloc[-1]) else 0,
        'bull_candles_5': int(bull_candles),
        'bear_candles_5': int(bear_candles),
        'ema_cross': 'bullish' if ema9.iloc[-1] > ema21.iloc[-1] and ema9.iloc[-2] <= ema21.iloc[-2] else
                     'bearish' if ema9.iloc[-1] < ema21.iloc[-1] and ema9.iloc[-2] >= ema21.iloc[-2] else 'none',
        'trend': 'up' if ema9.iloc[-1] > ema21.iloc[-1] else 'down',
    }


def find_sr_zones(df):
    """S/R from 1H pivots."""
    resistances, supports = find_pivots(df, window=3)
    price = df['close'].iloc[-1]

    res_above = [r for r in resistances if r['price'] > price]
    res_above.sort(key=lambda x: x['price'])
    sup_below = [s for s in supports if s['price'] < price]
    sup_below.sort(key=lambda x: -x['price'])

    return {
        'resistances': [{'price': round(r['price'], 2), 'dist_pct': round((r['price'] - price) / price * 100, 2)} for r in res_above[:3]],
        'supports': [{'price': round(s['price'], 2), 'dist_pct': round((price - s['price']) / price * 100, 2)} for s in sup_below[:3]],
    }


# ═══════════════════════════════════════════════════════════════
# SIGNAL SCORING
# ═══════════════════════════════════════════════════════════════

def score_signal(tf6h, tf1h, tf15m, zones):
    """Score from -20 to +20. Positive = LONG, negative = SHORT."""
    score = 0
    reasons = []

    # ── 6H TREND (weight x3) ──
    if tf6h['above_sma20'] and tf6h['sma20_slope'] > 0.1:
        score += 3
        reasons.append(f"6H alcista: sobre SMA20, pendiente +{tf6h['sma20_slope']:.2f}%")
    elif not tf6h['above_sma20'] and tf6h['sma20_slope'] < -0.1:
        score -= 3
        reasons.append(f"6H bajista: bajo SMA20, pendiente {tf6h['sma20_slope']:.2f}%")

    if tf6h['trend'] == 'up':
        score += 1
    else:
        score -= 1

    # ── 1H TREND + INDICATORS (weight x2) ──
    if tf1h['above_sma20'] and tf1h['sma20_slope'] > 0.1:
        score += 2
        reasons.append(f"1H alcista: SMA20 ${tf1h['sma20']:.0f}")
    elif not tf1h['above_sma20'] and tf1h['sma20_slope'] < -0.1:
        score -= 2
        reasons.append(f"1H bajista: SMA20 ${tf1h['sma20']:.0f}")

    # RSI
    if tf1h['rsi'] < 30:
        score += 2
        reasons.append(f"1H RSI {tf1h['rsi']:.0f} — sobreventa")
    elif tf1h['rsi'] > 70:
        score -= 2
        reasons.append(f"1H RSI {tf1h['rsi']:.0f} — sobrecompra")
    elif tf1h['rsi'] < 45:
        score += 1
    elif tf1h['rsi'] > 55:
        score -= 1

    # MACD
    if tf1h['macd_cross'] == 'bullish':
        score += 2
        reasons.append("1H MACD cruce alcista")
    elif tf1h['macd_cross'] == 'bearish':
        score -= 2
        reasons.append("1H MACD cruce bajista")
    elif tf1h['macd_hist'] > 0:
        score += 1
    else:
        score -= 1

    # ADX (trend strength)
    if tf1h['adx'] > 25:
        if tf1h['plus_di'] > tf1h['minus_di']:
            score += 1
            reasons.append(f"1H ADX {tf1h['adx']:.0f} — tendencia alcista fuerte")
        else:
            score -= 1
            reasons.append(f"1H ADX {tf1h['adx']:.0f} — tendencia bajista fuerte")

    # Bollinger position
    if tf1h['bb_position'] < 10:
        score += 1
        reasons.append("1H precio en fondo de Bollinger")
    elif tf1h['bb_position'] > 90:
        score -= 1
        reasons.append("1H precio en techo de Bollinger")

    # ── 15M ENTRY TIMING ──
    if tf15m['macd_cross'] == 'bullish':
        score += 2
        reasons.append("15M MACD cruce alcista — timing entrada")
    elif tf15m['macd_cross'] == 'bearish':
        score -= 2
        reasons.append("15M MACD cruce bajista — timing entrada")

    if tf15m['rsi'] < 30:
        score += 1
        reasons.append(f"15M RSI {tf15m['rsi']:.0f} — sobreventa extrema")
    elif tf15m['rsi'] > 70:
        score -= 1
        reasons.append(f"15M RSI {tf15m['rsi']:.0f} — sobrecompra extrema")

    # Stochastic
    if tf15m['stoch_k'] < 20 and tf15m['stoch_k'] > tf15m['stoch_d']:
        score += 1
        reasons.append("15M Stochastic cruce alcista en sobreventa")
    elif tf15m['stoch_k'] > 80 and tf15m['stoch_k'] < tf15m['stoch_d']:
        score -= 1
        reasons.append("15M Stochastic cruce bajista en sobrecompra")

    # EMA cross
    if tf15m['ema_cross'] == 'bullish':
        score += 1
        reasons.append("15M EMA9/21 cruce alcista")
    elif tf15m['ema_cross'] == 'bearish':
        score -= 1
        reasons.append("15M EMA9/21 cruce bajista")

    # Momentum
    if tf15m['bull_candles_5'] >= 4:
        score += 1
        reasons.append("15M: momentum comprador fuerte (4-5 velas verdes)")
    elif tf15m['bear_candles_5'] >= 4:
        score -= 1
        reasons.append("15M: momentum vendedor fuerte (4-5 velas rojas)")

    return score, reasons


def generate_trade(price, asset, tf6h, tf1h, tf15m, zones):
    score, reasons = score_signal(tf6h, tf1h, tf15m, zones)

    direction = None
    confidence = None

    if score >= 7:
        direction, confidence = 'LONG', 'alta'
    elif score >= 4:
        direction, confidence = 'LONG', 'media'
    elif score <= -7:
        direction, confidence = 'SHORT', 'alta'
    elif score <= -4:
        direction, confidence = 'SHORT', 'media'

    if not direction:
        leaning = 'LONG' if score > 0 else 'SHORT' if score < 0 else 'ninguna'
        return {
            'signal': 'NO_TRADE',
            'reason': f"Señal insuficiente (score {score}, tendencia {leaning}). Solo opero con media o alta.",
            'score': score,
            'analysis': {'tf6h': tf6h, 'tf1h': tf1h, 'tf15m': tf15m},
            'zones': zones,
            'reasons': reasons,
        }

    # S/R check
    res_list = zones.get('resistances', [])
    sup_list = zones.get('supports', [])
    nearest_resist = res_list[0]['price'] if res_list else None
    nearest_support = sup_list[0]['price'] if sup_list else None

    if direction == 'LONG' and nearest_resist and (nearest_resist - price) / price * 100 < 0.3:
        reasons.append(f"PELIGRO: resistencia ${nearest_resist:.0f} a {(nearest_resist-price)/price*100:.2f}%")
        return {'signal': 'NO_TRADE', 'reason': f'Resistencia demasiado cerca (${nearest_resist:.0f})', 'score': score, 'analysis': {'tf6h': tf6h, 'tf1h': tf1h, 'tf15m': tf15m}, 'zones': zones, 'reasons': reasons}

    if direction == 'SHORT' and nearest_support and (price - nearest_support) / price * 100 < 0.3:
        reasons.append(f"PELIGRO: soporte ${nearest_support:.0f} a {(price-nearest_support)/price*100:.2f}%")
        return {'signal': 'NO_TRADE', 'reason': f'Soporte demasiado cerca (${nearest_support:.0f})', 'score': score, 'analysis': {'tf6h': tf6h, 'tf1h': tf1h, 'tf15m': tf15m}, 'zones': zones, 'reasons': reasons}

    # TP/SL using ATR
    atr_val = tf1h['atr']

    if direction == 'LONG':
        sl = price - atr_val * 1.5
        tp = nearest_resist if nearest_resist else price + atr_val * 2.5
        if nearest_support and nearest_support > sl:
            sl = nearest_support - atr_val * 0.2
    else:
        sl = price + atr_val * 1.5
        tp = nearest_support if nearest_support else price - atr_val * 2.5
        if nearest_resist and nearest_resist < sl:
            sl = nearest_resist + atr_val * 0.2

    reward = abs(tp - price)
    risk = abs(price - sl)
    rr = reward / risk if risk > 0 else 0

    if rr < 1.5:
        reasons.append(f"R:R {rr:.2f} < 1.5")
        return {'signal': 'NO_TRADE', 'reason': f'R:R {rr:.2f} insuficiente (mínimo 1.5)', 'score': score, 'analysis': {'tf6h': tf6h, 'tf1h': tf1h, 'tf15m': tf15m}, 'zones': zones, 'reasons': reasons, 'rr': round(rr, 2)}

    sl_dist_pct = risk / price * 100
    leverage = 5 if confidence == 'alta' and sl_dist_pct > 1 else 3

    liq_price = price * (1 - 0.9 / leverage) if direction == 'LONG' else price * (1 + 0.9 / leverage)

    exit_by = datetime.now(timezone.utc).isoformat()

    return {
        'signal': direction,
        'asset': asset,
        'confidence': confidence,
        'score': score,
        'entry': round(price, 2),
        'tp': round(tp, 2),
        'sl': round(sl, 2),
        'rr': round(rr, 2),
        'leverage': leverage,
        'maxLeverage': leverage,
        'liqPrice': round(liq_price, 2),
        'slDistPct': round(sl_dist_pct, 2),
        'tpDistPct': round(reward / price * 100, 2),
        'maxHoldHours': 6,
        'exitBy': exit_by,
        'potentialPnl': {
            'win': f"+{reward / price * leverage * 100:.1f}%",
            'loss': f"-{risk / price * leverage * 100:.1f}%",
        },
        'warning': f"NO usar más de x{leverage}",
        'analysis': {'tf6h': tf6h, 'tf1h': tf1h, 'tf15m': tf15m},
        'zones': zones,
        'reasons': reasons,
        'indicators': {
            '1h_rsi': tf1h['rsi'],
            '1h_macd': tf1h['macd_hist'],
            '1h_adx': tf1h['adx'],
            '1h_bb_pos': tf1h['bb_position'],
            '1h_atr_pct': tf1h['atr_pct'],
            '15m_rsi': tf15m['rsi'],
            '15m_stoch': tf15m['stoch_k'],
        },
    }


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def analyze(asset):
    pair = asset.upper() + 'USDT'

    df_6h = fetch_candles(pair, '6h', 100)
    df_1h = fetch_candles(pair, '1h', 250)
    df_15m = fetch_candles(pair, '15m', 100)

    tf6h = analyze_tf(df_6h)
    tf1h = analyze_tf(df_1h)
    tf15m = analyze_tf(df_15m)

    zones = find_sr_zones(df_1h)
    price = df_15m['close'].iloc[-1]

    trade = generate_trade(price, asset.upper(), tf6h, tf1h, tf15m, zones)
    trade['pair'] = pair
    trade['price'] = round(price, 2)
    trade['calculated_at'] = datetime.now(timezone.utc).isoformat()
    trade['engine'] = 'python'

    return trade


if __name__ == '__main__':
    asset = sys.argv[1] if len(sys.argv) > 1 else 'ETH'
    try:
        result = analyze(asset)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'signal': 'ERROR', 'error': str(e)}))
        sys.exit(1)
