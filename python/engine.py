#!/usr/bin/env python3
"""
Unified analysis engine. Three modes:
  python3 engine.py analyst          → phases for all coins/timeframes
  python3 engine.py signals          → buy/sell signals
  python3 engine.py daytrader ETH    → intraday trade signal
"""

import sys, json, math, requests
import numpy as np
import pandas as pd
from datetime import datetime, timezone

# ═══════════════════════════════════════════════════════════════
# BINANCE
# ═══════════════════════════════════════════════════════════════

BINANCE = ["https://api.binance.com","https://api1.binance.com","https://data-api.binance.vision"]
COINS = ['BTC','ETH','SOL','UNI','JUP','AAVE']
TF_MAP = {
    'Mensual': ('1M', 50), 'Semanal': ('1w', 60), 'Diario': ('1d', 250),
    '6H': ('6h', 250), '1H': ('1h', 250), '15M': ('15m', 250),
}
PHASE_STYLES = {
    'bull': {'bg':'rgba(34,197,94,0.15)','color':'#22c55e','emoji':'🟢'},
    'bear': {'bg':'rgba(239,68,68,0.15)','color':'#ef4444','emoji':'🔴'},
    'accumulation': {'bg':'rgba(59,130,246,0.15)','color':'#3b82f6','emoji':'🔵'},
    'distribution': {'bg':'rgba(234,179,8,0.15)','color':'#eab308','emoji':'🟡'},
}
SIGNAL_STYLES = {
    'strong_buy': {'bg':'rgba(34,197,94,0.2)','color':'#22c55e','emoji':'🟢','label':'Compra Fuerte'},
    'buy': {'bg':'rgba(6,182,212,0.2)','color':'#06b6d4','emoji':'🔵','label':'Compra'},
    'strong_sell': {'bg':'rgba(239,68,68,0.2)','color':'#ef4444','emoji':'🔴','label':'Venta Fuerte'},
    'sell': {'bg':'rgba(234,179,8,0.2)','color':'#eab308','emoji':'🟡','label':'Venta'},
    'watch': {'bg':'rgba(167,139,250,0.15)','color':'#a78bfa','emoji':'👀','label':'Vigilar'},
}

def fetch_candles(symbol, interval, limit=250):
    for base in BINANCE:
        try:
            r = requests.get(f"{base}/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}", timeout=8)
            if r.status_code != 200: continue
            df = pd.DataFrame(r.json(), columns=['ts','open','high','low','close','volume','ct','qv','t','tbb','tbq','ig'])
            for c in ['open','high','low','close','volume']: df[c] = df[c].astype(float)
            df['ts'] = pd.to_datetime(df['ts'], unit='ms')
            return df
        except: continue
    return None

def fetch_prices():
    for base in BINANCE:
        try:
            r = requests.get(f"{base}/api/v3/ticker/price", timeout=8)
            if r.status_code == 200:
                return {t['symbol']: float(t['price']) for t in r.json()}
        except: continue
    return {}

# ═══════════════════════════════════════════════════════════════
# INDICATORS
# ═══════════════════════════════════════════════════════════════

def sma(s, p): return s.rolling(window=p).mean()
def ema(s, p): return s.ewm(span=p, adjust=False).mean()

def rsi(s, p=14):
    d = s.diff(); g = d.where(d>0,0.0); l = (-d).where(d<0,0.0)
    ag = g.ewm(alpha=1/p, min_periods=p).mean()
    al = l.ewm(alpha=1/p, min_periods=p).mean()
    return 100 - 100/(1 + ag/al)

def macd_calc(s, f=12, sl=26, sg=9):
    ml = ema(s,f) - ema(s,sl); sig = ema(ml,sg)
    return ml, sig, ml - sig

def bollinger(s, p=20, sd=2):
    m = sma(s,p); st = s.rolling(window=p).std()
    return m+sd*st, m, m-sd*st

def atr_calc(df, p=14):
    tr = pd.concat([df['high']-df['low'], (df['high']-df['close'].shift()).abs(), (df['low']-df['close'].shift()).abs()], axis=1).max(axis=1)
    return tr.rolling(window=p).mean()

def stoch(df, kp=14, dp=3):
    lm = df['low'].rolling(window=kp).min(); hm = df['high'].rolling(window=kp).max()
    k = 100*(df['close']-lm)/(hm-lm); return k, k.rolling(window=dp).mean()

def adx_calc(df, p=14):
    pdm = df['high'].diff(); mdm = -df['low'].diff()
    pdm = pdm.where((pdm>mdm)&(pdm>0),0.0); mdm = mdm.where((mdm>pdm)&(mdm>0),0.0)
    av = atr_calc(df,p)
    pdi = 100*ema(pdm,p)/av; mdi = 100*ema(mdm,p)/av
    dx = 100*(pdi-mdi).abs()/(pdi+mdi)
    return ema(dx,p), pdi, mdi

def vwap_calc(df):
    tp = (df['high']+df['low']+df['close'])/3
    return (tp*df['volume']).cumsum() / df['volume'].cumsum()

def find_pivots(df, w=3):
    highs, lows = [], []
    for i in range(w, len(df)-w):
        h, l = df['high'].iloc[i], df['low'].iloc[i]
        if all(h > df['high'].iloc[i-j] and h > df['high'].iloc[i+j] for j in range(1,w+1)):
            highs.append({'idx':i,'price':h})
        if all(l < df['low'].iloc[i-j] and l < df['low'].iloc[i+j] for j in range(1,w+1)):
            lows.append({'idx':i,'price':l})
    return highs, lows

# ═══════════════════════════════════════════════════════════════
# FULL TIMEFRAME ANALYSIS
# ═══════════════════════════════════════════════════════════════

def analyze_tf(df):
    if df is None or len(df) < 30:
        return None
    c = df['close']; price = c.iloc[-1]
    s20 = sma(c,20); s40 = sma(c,40)
    e9 = ema(c,9); e21 = ema(c,21)
    r = rsi(c,14); ml,ms,mh = macd_calc(c)
    bbu,bbm,bbl = bollinger(c); av = atr_calc(df,14)
    sk,sd = stoch(df); adxv,pdi,mdi = adx_calc(df)

    ls20 = s20.dropna().iloc[-1] if s20.dropna().shape[0] else price
    ls40 = s40.dropna().iloc[-1] if s40.dropna().shape[0] else ls20

    s5 = s20.dropna()
    slope = (s5.iloc[-1]-s5.iloc[-6])/s5.iloc[-6]*100 if len(s5)>5 else 0

    last5 = df.tail(5)
    bc = int((last5['close']>last5['open']).sum())
    brc = int((last5['close']<last5['open']).sum())
    momentum = 'bullish' if bc>=4 else 'bearish' if brc>=4 else 'neutral'

    above = bool(price > ls20)
    if above and slope > 0.1: bias = 'bullish'
    elif not above and slope < -0.1: bias = 'bearish'
    elif above and slope < -0.1: bias = 'weakBullish'
    elif not above and slope > 0.1: bias = 'weakBearish'
    else: bias = 'neutral'

    def safe(v): return round(float(v),2) if not pd.isna(v) else 0

    return {
        'price':round(price,2), 'sma20':round(ls20,2), 'sma40':round(ls40,2),
        'ema9':safe(e9.iloc[-1]), 'ema21':safe(e21.iloc[-1]),
        'slope':round(slope,3), 'sma20_slope':round(slope,3),
        'aboveSma':above, 'above_sma20':above,
        'distPct':round((price-ls20)/ls20*100,2), 'dist_pct':round((price-ls20)/ls20*100,2),
        'bias':bias, 'momentum':momentum,
        'rsi':safe(r.iloc[-1]),
        'macd':safe(ml.iloc[-1]), 'macd_signal':safe(ms.iloc[-1]), 'macd_hist':safe(mh.iloc[-1]),
        'macd_cross':'bullish' if mh.iloc[-1]>0 and mh.iloc[-2]<=0 else 'bearish' if mh.iloc[-1]<0 and mh.iloc[-2]>=0 else 'none',
        'bb_upper':safe(bbu.iloc[-1]), 'bb_lower':safe(bbl.iloc[-1]),
        'bb_width':round((bbu.iloc[-1]-bbl.iloc[-1])/bbm.iloc[-1]*100,2) if not pd.isna(bbm.iloc[-1]) and bbm.iloc[-1]!=0 else 0,
        'bb_position':round((price-bbl.iloc[-1])/(bbu.iloc[-1]-bbl.iloc[-1])*100,1) if not pd.isna(bbu.iloc[-1]) and bbu.iloc[-1]!=bbl.iloc[-1] else 50,
        'atr':safe(av.iloc[-1]), 'atr_pct':round(float(av.iloc[-1])/price*100,3) if not pd.isna(av.iloc[-1]) else 0,
        'stoch_k':safe(sk.iloc[-1]), 'stoch_d':safe(sd.iloc[-1]),
        'adx':safe(adxv.iloc[-1]), 'plus_di':safe(pdi.iloc[-1]), 'minus_di':safe(mdi.iloc[-1]),
        'bull_candles_5':bc, 'bear_candles_5':brc,
        'ema_cross':'bullish' if e9.iloc[-1]>e21.iloc[-1] and e9.iloc[-2]<=e21.iloc[-2] else 'bearish' if e9.iloc[-1]<e21.iloc[-1] and e9.iloc[-2]>=e21.iloc[-2] else 'none',
        'trend':'up' if e9.iloc[-1]>e21.iloc[-1] else 'down',
    }

def find_sr(df, price):
    highs, lows = find_pivots(df, 3)
    res = sorted([h for h in highs if h['price']>price], key=lambda x:x['price'])[:3]
    sup = sorted([s for s in lows if s['price']<price], key=lambda x:-x['price'])[:3]
    return {
        'resistances':[{'price':round(r['price'],2),'distPct':round((r['price']-price)/price*100,2)} for r in res],
        'supports':[{'price':round(s['price'],2),'distPct':round((price-s['price'])/price*100,2)} for s in sup],
    }

# ═══════════════════════════════════════════════════════════════
# PHASE DETECTION (Power 4 — same logic as JS but with indicators)
# ═══════════════════════════════════════════════════════════════

def detect_phase(df, price):
    if df is None or len(df) < 45:
        return {'type':'accumulation','phase':'Etapa 1 — Acumulación (datos limitados)','reason':'Datos insuficientes'}

    tf = analyze_tf(df)
    if tf is None:
        return {'type':'accumulation','phase':'Etapa 1 — Acumulación (error)','reason':'Error en análisis'}

    slope = tf['slope']; above = tf['aboveSma']; dist = tf['distPct']
    r = tf['rsi']; mh = tf['macd_hist']; adxv = tf['adx']
    pdi = tf['plus_di']; mdi = tf['minus_di']

    # Strong price signals
    if dist < -15:
        return {'type':'bear','phase':'Etapa 4 — Declive','reason':f'Precio {dist:.1f}% bajo SMA20. RSI {r:.0f}. MACD hist {mh:.2f}'}
    if dist > 15:
        return {'type':'bull','phase':'Etapa 2 — Avance','reason':f'Precio +{dist:.1f}% sobre SMA20. RSI {r:.0f}. MACD hist {mh:.2f}'}

    # 5-15% from SMA20
    if dist < -5:
        if slope < 0:
            return {'type':'bear','phase':'Etapa 4 — Declive','reason':f'Precio {dist:.1f}% bajo SMA20. Pendiente {slope:.2f}%. RSI {r:.0f}'}
        return {'type':'distribution','phase':'Etapa 3 — Distribución (cayendo)','reason':f'Precio {dist:.1f}% bajo SMA20 pero pendiente aún positiva. RSI {r:.0f}'}

    if dist > 5:
        if slope > 0:
            return {'type':'bull','phase':'Etapa 2 — Avance','reason':f'Precio +{dist:.1f}% sobre SMA20. Pendiente +{slope:.2f}%. RSI {r:.0f}'}
        return {'type':'accumulation','phase':'Etapa 1 — Acumulación (rebotando)','reason':f'Precio +{dist:.1f}% sobre SMA20 pero pendiente negativa. RSI {r:.0f}'}

    # ADX + directional indicators
    if adxv > 25:
        if pdi > mdi and above and slope > 0.3:
            return {'type':'bull','phase':'Etapa 2 — Avance [ADX fuerte]','reason':f'ADX {adxv:.0f}, DI+ > DI-. Pendiente +{slope:.2f}%. RSI {r:.0f}. MACD {mh:.2f}'}
        if mdi > pdi and not above and slope < -0.3:
            return {'type':'bear','phase':'Etapa 4 — Declive [ADX fuerte]','reason':f'ADX {adxv:.0f}, DI- > DI+. Pendiente {slope:.2f}%. RSI {r:.0f}. MACD {mh:.2f}'}

    # SMA slope clear
    if not above and slope < -0.5:
        return {'type':'bear','phase':'Etapa 4 — Declive','reason':f'Bajo SMA20, pendiente {slope:.2f}%. RSI {r:.0f}. MACD hist {mh:.2f}'}
    if above and slope > 0.5:
        return {'type':'bull','phase':'Etapa 2 — Avance','reason':f'Sobre SMA20, pendiente +{slope:.2f}%. RSI {r:.0f}. MACD hist {mh:.2f}'}

    # RSI extremes as tiebreaker
    rsi_hint = ''
    if r > 60: rsi_hint = f'. RSI {r:.0f} (alcista)'
    elif r < 40: rsi_hint = f'. RSI {r:.0f} (bajista)'

    # MACD histogram direction
    macd_hint = ''
    if mh > 0: macd_hint = f'. MACD positivo ({mh:.2f})'
    elif mh < 0: macd_hint = f'. MACD negativo ({mh:.2f})'

    s40 = tf['sma40']
    if tf['sma20'] > s40:
        if above and slope > 0:
            return {'type':'bull','phase':'Etapa 2 — Avance (débil)','reason':f'SMA20 > SMA40, pendiente +{slope:.2f}%{rsi_hint}{macd_hint}'}
        return {'type':'distribution','phase':'Etapa 3 — Distribución','reason':f'SMA20 > SMA40 pero precio lateral{rsi_hint}{macd_hint}'}

    if tf['sma20'] <= s40:
        if not above and slope < 0:
            return {'type':'bear','phase':'Etapa 4 — Declive (débil)','reason':f'SMA20 < SMA40, pendiente {slope:.2f}%{rsi_hint}{macd_hint}'}
        return {'type':'accumulation','phase':'Etapa 1 — Acumulación','reason':f'SMA20 ≤ SMA40, buscando base{rsi_hint}{macd_hint}'}

    return {'type':'accumulation','phase':'Etapa 1 — Acumulación','reason':'Sin señal clara'}

# ═══════════════════════════════════════════════════════════════
# MODE: ANALYST — phases for all coins/timeframes
# ═══════════════════════════════════════════════════════════════

def run_analyst():
    prices = fetch_prices()
    results = {}
    for coin in COINS:
        results[coin] = {}
        pair = coin + 'USDT'
        price = prices.get(pair, 0)
        for tf_label, (interval, limit) in TF_MAP.items():
            try:
                df = fetch_candles(pair, interval, limit)
                if df is None: raise Exception('No data')
                phase = detect_phase(df, price)
                tf_data = analyze_tf(df)
                results[coin][tf_label] = {
                    'type': phase['type'], 'phase': phase['phase'], 'reason': phase['reason'],
                    'price': price,
                    'style': PHASE_STYLES.get(phase['type'], PHASE_STYLES['accumulation']),
                    'is_stale': False,
                    'indicators': {
                        'rsi': tf_data['rsi'] if tf_data else None,
                        'macd_hist': tf_data['macd_hist'] if tf_data else None,
                        'adx': tf_data['adx'] if tf_data else None,
                        'bb_position': tf_data['bb_position'] if tf_data else None,
                    } if tf_data else None,
                }
            except Exception as e:
                results[coin][tf_label] = {
                    'type':'accumulation','phase':'Error','reason':str(e),
                    'price':price,'style':PHASE_STYLES['accumulation'],'is_stale':True,
                }
    return {
        'calculated_at': datetime.now(timezone.utc).isoformat(),
        'coins': COINS,
        'timeframes': list(TF_MAP.keys()),
        'results': results,
        'engine': 'python',
    }

# ═══════════════════════════════════════════════════════════════
# MODE: SIGNALS — buy/sell signals
# ═══════════════════════════════════════════════════════════════

def generate_signal(tf_data, phase, price):
    score = 50; reasons = []

    # Phase
    ptype = phase['type']
    if ptype == 'bull': score += 12; reasons.append('Etapa 2 activa (alcista)')
    elif ptype == 'bear': score -= 12; reasons.append('Etapa 4 activa (bajista)')
    elif ptype == 'accumulation': score += 15; reasons.append('Etapa 1 — zona de acumulación')
    elif ptype == 'distribution': score -= 15; reasons.append('Etapa 3 — zona de distribución')

    # RSI
    if tf_data['rsi'] < 30: score += 12; reasons.append(f"RSI {tf_data['rsi']:.0f} — sobreventa fuerte")
    elif tf_data['rsi'] < 40: score += 6; reasons.append(f"RSI {tf_data['rsi']:.0f} — sobreventa")
    elif tf_data['rsi'] > 70: score -= 12; reasons.append(f"RSI {tf_data['rsi']:.0f} — sobrecompra fuerte")
    elif tf_data['rsi'] > 60: score -= 6; reasons.append(f"RSI {tf_data['rsi']:.0f} — sobrecompra")

    # MACD
    if tf_data['macd_cross'] == 'bullish': score += 10; reasons.append('MACD cruce alcista')
    elif tf_data['macd_cross'] == 'bearish': score -= 10; reasons.append('MACD cruce bajista')
    elif tf_data['macd_hist'] > 0: score += 3
    else: score -= 3

    # Bollinger
    if tf_data['bb_position'] < 15: score += 8; reasons.append('Precio en fondo de Bollinger')
    elif tf_data['bb_position'] > 85: score -= 8; reasons.append('Precio en techo de Bollinger')

    # ADX
    if tf_data['adx'] > 25:
        if tf_data['plus_di'] > tf_data['minus_di']: score += 5; reasons.append(f"ADX {tf_data['adx']:.0f} — tendencia alcista fuerte")
        else: score -= 5; reasons.append(f"ADX {tf_data['adx']:.0f} — tendencia bajista fuerte")

    # Stochastic
    if tf_data['stoch_k'] < 20 and tf_data['stoch_k'] > tf_data['stoch_d']:
        score += 6; reasons.append('Stochastic cruce alcista en sobreventa')
    elif tf_data['stoch_k'] > 80 and tf_data['stoch_k'] < tf_data['stoch_d']:
        score -= 6; reasons.append('Stochastic cruce bajista en sobrecompra')

    # SMA distance
    d = tf_data['distPct']
    if 0 < d < 2: score += 3; reasons.append('Ligeramente sobre SMA20')
    elif -2 < d < 0: score += 3; reasons.append('Cerca de cruce alcista SMA20')
    elif d < -5: score -= 5; reasons.append('Lejos bajo SMA20')
    elif d > 5: score -= 3; reasons.append('Sobreextendido sobre SMA20')

    score = max(0, min(100, score))

    if score >= 75: st = 'strong_buy'
    elif score >= 60: st = 'buy'
    elif score <= 25: st = 'strong_sell'
    elif score <= 40: st = 'sell'
    else: st = 'watch'

    # S/R
    highs, lows = find_pivots(pd.DataFrame(), 3) if False else ([], [])

    return {
        'signal_type': st, 'score': score, 'reasons': reasons,
        'sma20_distance': tf_data['distPct'],
        'nearest_support': None, 'nearest_resist': None,
        'wyckoff_pattern': None,
        'current_phase': phase['phase'],
        'phase_style': PHASE_STYLES.get(phase['type'], PHASE_STYLES['accumulation']),
        'style': SIGNAL_STYLES[st],
        'indicators': {
            'rsi': tf_data['rsi'], 'macd_hist': tf_data['macd_hist'],
            'adx': tf_data['adx'], 'bb_position': tf_data['bb_position'],
            'stoch_k': tf_data['stoch_k'],
        },
    }

def run_signals():
    prices = fetch_prices()
    signals = []
    for coin in COINS:
        pair = coin + 'USDT'; price = prices.get(pair, 0)
        if not price: continue
        for tf_label in ['Diario', '6H']:
            interval, limit = TF_MAP[tf_label]
            try:
                df = fetch_candles(pair, interval, limit)
                if df is None: continue
                phase = detect_phase(df, price)
                tf_data = analyze_tf(df)
                if tf_data is None: continue

                # S/R from this timeframe
                highs, lows = find_pivots(df, 3)
                sup = [l for l in lows if l['price'] < price]
                res = [h for h in highs if h['price'] > price]
                nearest_sup = max(sup, key=lambda x:x['price'])['price'] if sup else None
                nearest_res = min(res, key=lambda x:x['price'])['price'] if res else None

                sig = generate_signal(tf_data, phase, price)
                sig['nearest_support'] = round(nearest_sup,2) if nearest_sup else None
                sig['nearest_resist'] = round(nearest_res,2) if nearest_res else None

                if sig['signal_type'] != 'watch':
                    signals.append({
                        'coin': coin, 'timeframe': tf_label, 'price': price,
                        'created_at': datetime.now(timezone.utc).isoformat(),
                        **sig,
                    })
            except: pass
    signals.sort(key=lambda x: x['score'], reverse=True)
    return {'calculated_at': datetime.now(timezone.utc).isoformat(), 'signals': signals, 'engine': 'python'}

# ═══════════════════════════════════════════════════════════════
# MODE: DAYTRADER — intraday signal
# ═══════════════════════════════════════════════════════════════

def score_daytrader(tf6h, tf1h, tf15m, zones):
    score = 0; reasons = []

    if tf6h['aboveSma'] and tf6h['slope'] > 0.1: score += 3; reasons.append(f"6H alcista: pendiente +{tf6h['slope']:.2f}%")
    elif not tf6h['aboveSma'] and tf6h['slope'] < -0.1: score -= 3; reasons.append(f"6H bajista: pendiente {tf6h['slope']:.2f}%")
    score += 1 if tf6h['trend']=='up' else -1

    if tf1h['aboveSma'] and tf1h['slope'] > 0.1: score += 2; reasons.append(f"1H alcista: SMA20 ${tf1h['sma20']:.0f}")
    elif not tf1h['aboveSma'] and tf1h['slope'] < -0.1: score -= 2; reasons.append(f"1H bajista: SMA20 ${tf1h['sma20']:.0f}")

    if tf1h['rsi'] < 30: score += 2; reasons.append(f"1H RSI {tf1h['rsi']:.0f} — sobreventa")
    elif tf1h['rsi'] > 70: score -= 2; reasons.append(f"1H RSI {tf1h['rsi']:.0f} — sobrecompra")
    elif tf1h['rsi'] < 45: score += 1
    elif tf1h['rsi'] > 55: score -= 1

    if tf1h['macd_cross']=='bullish': score += 2; reasons.append("1H MACD cruce alcista")
    elif tf1h['macd_cross']=='bearish': score -= 2; reasons.append("1H MACD cruce bajista")
    elif tf1h['macd_hist'] > 0: score += 1
    else: score -= 1

    if tf1h['adx'] > 25:
        if tf1h['plus_di'] > tf1h['minus_di']: score += 1; reasons.append(f"1H ADX {tf1h['adx']:.0f} tendencia alcista")
        else: score -= 1; reasons.append(f"1H ADX {tf1h['adx']:.0f} tendencia bajista")

    if tf1h['bb_position'] < 10: score += 1; reasons.append("1H fondo Bollinger")
    elif tf1h['bb_position'] > 90: score -= 1; reasons.append("1H techo Bollinger")

    if tf15m['macd_cross']=='bullish': score += 2; reasons.append("15M MACD cruce alcista")
    elif tf15m['macd_cross']=='bearish': score -= 2; reasons.append("15M MACD cruce bajista")
    if tf15m['rsi'] < 30: score += 1; reasons.append(f"15M RSI {tf15m['rsi']:.0f} sobreventa")
    elif tf15m['rsi'] > 70: score -= 1; reasons.append(f"15M RSI {tf15m['rsi']:.0f} sobrecompra")
    if tf15m['stoch_k']<20 and tf15m['stoch_k']>tf15m['stoch_d']: score += 1; reasons.append("15M Stoch cruce alcista sobreventa")
    elif tf15m['stoch_k']>80 and tf15m['stoch_k']<tf15m['stoch_d']: score -= 1; reasons.append("15M Stoch cruce bajista sobrecompra")
    if tf15m['ema_cross']=='bullish': score += 1; reasons.append("15M EMA9/21 cruce alcista")
    elif tf15m['ema_cross']=='bearish': score -= 1; reasons.append("15M EMA9/21 cruce bajista")
    if tf15m['bull_candles_5']>=4: score += 1; reasons.append("15M momentum comprador")
    elif tf15m['bear_candles_5']>=4: score -= 1; reasons.append("15M momentum vendedor")

    return score, reasons

def run_daytrader(asset):
    pair = asset.upper()+'USDT'
    df6h = fetch_candles(pair,'6h',100)
    df1h = fetch_candles(pair,'1h',250)
    df15m = fetch_candles(pair,'15m',100)
    if df15m is None: raise Exception(f'No data for {pair}')

    tf6h = analyze_tf(df6h); tf1h = analyze_tf(df1h); tf15m = analyze_tf(df15m)
    if not all([tf6h,tf1h,tf15m]): raise Exception('Insufficient data')

    price = df15m['close'].iloc[-1]
    zones = find_sr(df1h, price)
    score, reasons = score_daytrader(tf6h, tf1h, tf15m, zones)

    d = None; conf = None
    if score >= 7: d,conf = 'LONG','alta'
    elif score >= 4: d,conf = 'LONG','media'
    elif score <= -7: d,conf = 'SHORT','alta'
    elif score <= -4: d,conf = 'SHORT','media'

    base = {'pair':pair,'price':round(price,2),'calculated_at':datetime.now(timezone.utc).isoformat(),'engine':'python'}

    if not d:
        lean = 'LONG' if score>0 else 'SHORT' if score<0 else 'ninguna'
        return {**base,'signal':'NO_TRADE','reason':f'Señal insuficiente (score {score}, tendencia {lean}). Mínimo ±4.','score':score,'analysis':{'tf6h':tf6h,'tf1h':tf1h,'tf15m':tf15m},'zones':zones,'reasons':reasons}

    rl = zones.get('resistances',[]); sl_l = zones.get('supports',[])
    nr = rl[0]['price'] if rl else None; ns = sl_l[0]['price'] if sl_l else None

    if d=='LONG' and nr and (nr-price)/price*100<0.3:
        return {**base,'signal':'NO_TRADE','reason':f'Resistencia muy cerca (${nr:.0f})','score':score,'analysis':{'tf6h':tf6h,'tf1h':tf1h,'tf15m':tf15m},'zones':zones,'reasons':reasons}
    if d=='SHORT' and ns and (price-ns)/price*100<0.3:
        return {**base,'signal':'NO_TRADE','reason':f'Soporte muy cerca (${ns:.0f})','score':score,'analysis':{'tf6h':tf6h,'tf1h':tf1h,'tf15m':tf15m},'zones':zones,'reasons':reasons}

    av = tf1h['atr']
    if d=='LONG':
        sl_p = price - av*1.5; tp_p = nr if nr else price + av*2.5
        if ns and ns > sl_p: sl_p = ns - av*0.2
    else:
        sl_p = price + av*1.5; tp_p = ns if ns else price - av*2.5
        if nr and nr < sl_p: sl_p = nr + av*0.2

    reward = abs(tp_p-price); risk = abs(price-sl_p)
    rr = reward/risk if risk>0 else 0
    if rr < 1.5:
        return {**base,'signal':'NO_TRADE','reason':f'R:R {rr:.2f} < 1.5','score':score,'analysis':{'tf6h':tf6h,'tf1h':tf1h,'tf15m':tf15m},'zones':zones,'reasons':reasons,'rr':round(rr,2)}

    sldp = risk/price*100
    lev = 5 if conf=='alta' and sldp>1 else 3
    liq = price*(1-0.9/lev) if d=='LONG' else price*(1+0.9/lev)

    return {**base,'signal':d,'asset':asset.upper(),'confidence':conf,'score':score,
        'entry':round(price,2),'tp':round(tp_p,2),'sl':round(sl_p,2),'rr':round(rr,2),
        'leverage':lev,'maxLeverage':lev,'liqPrice':round(liq,2),
        'slDistPct':round(sldp,2),'tpDistPct':round(reward/price*100,2),
        'maxHoldHours':6,'exitBy':datetime.now(timezone.utc).isoformat(),
        'potentialPnl':{'win':f"+{reward/price*lev*100:.1f}%",'loss':f"-{risk/price*lev*100:.1f}%"},
        'warning':f"NO usar más de x{lev}",
        'analysis':{'tf6h':tf6h,'tf1h':tf1h,'tf15m':tf15m},'zones':zones,'reasons':reasons,
        'indicators':{'1h_rsi':tf1h['rsi'],'1h_macd':tf1h['macd_hist'],'1h_adx':tf1h['adx'],'1h_bb_pos':tf1h['bb_position'],'1h_atr_pct':tf1h['atr_pct'],'15m_rsi':tf15m['rsi'],'15m_stoch':tf15m['stoch_k']},
    }

# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv)>1 else 'analyst'
    try:
        if mode == 'analyst': print(json.dumps(run_analyst()))
        elif mode == 'signals': print(json.dumps(run_signals()))
        elif mode == 'daytrader':
            asset = sys.argv[2] if len(sys.argv)>2 else 'ETH'
            print(json.dumps(run_daytrader(asset)))
        else: print(json.dumps({'error':f'Unknown mode: {mode}'}))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
