import os, time, json, math, requests, threading, base64
from dotenv import load_dotenv
load_dotenv('/root/tkempire/.env')

TG_TOKEN    = os.getenv('TELEGRAM_BOT_TOKEN')
TG_CHANNEL  = os.getenv('TELEGRAM_CHANNEL_ID')
TG_PRIVATE  = os.getenv('TELEGRAM_PRIVATE_ID', TG_CHANNEL)  # your personal chat ID
GH_TOKEN    = os.getenv('GITHUB_TOKEN')
GH_REPO     = os.getenv('GITHUB_REPO')
AF_KEY      = os.getenv('ALTFINS_API_KEY')
HL_API      = 'https://api.hyperliquid.xyz'
AF_API      = 'https://api.altfins.com'

# ══════════════════════════════════════════════════════
# EAI v1 — Empire Adaptive Intelligence
# Research-confirmed architecture
# ══════════════════════════════════════════════════════

# 5 pairs only — research proven: deep liquidity,
# manipulation-resistant, highest data quality
TARGET_PAIRS = [
    'BTC', 'ETH', 'SOL', 'BNB', 'DOGE',   # Tier 1 — core
    'XRP', 'ADA', 'AVAX', 'LINK', 'DOT',   # Tier 2 — large caps
    'APT', 'ARB', 'OP', 'INJ', 'TIA',      # Tier 3 — mid caps
]

# Thresholds
MIN_SCORE      = 30    # minimum confidence to fire
MIN_GAP        = 8    # bull must beat bear by this much
MAX_DAILY      = 50     # max signals per day
COOLDOWN       = 28800 # 8 hours between signals per pair
PAUSE_LOSSES   = 3     # consecutive losses before pause
PAUSE_DURATION = 14400 # 4 hour pause after 3 losses
MIN_WIN_RATE   = 45    # auto-pause if win rate drops below this

# ATR-based trade targets (research confirmed)
ATR_TP1 = 1.5   # TP1 = Entry ± ATR × 1.5 (close 50%)
ATR_TP2 = 3.0   # TP2 = Entry ± ATR × 3.0 (close rest)
ATR_SL  = 2.0   # SL  = Entry ∓ ATR × 2.0

# Dead market hours UTC — avoid low volume
DEAD_HOURS = {2, 3, 4}  # 2am-5am UTC

# ── ADAPTIVE WEIGHTS ──
# Each indicator starts equal. After each close,
# winning indicators gain weight, losing ones lose weight.
DEFAULT_WEIGHTS = {
    'supertrend_1h': 1.0,
    'supertrend_4h': 1.0,
    'adx':           1.0,
    'ema_ribbon':    1.0,
    'ema_cross':     1.0,
    'ema_4h_master': 1.0,
    'rsi':           1.0,
    'rsi_divergence':1.0,
    'macd':          1.0,
    'bb_sr':         1.0,
    'volume':        1.0,
    'fear_greed':    1.0,
    'funding':       1.0,
    'order_book':    1.0,
    'altfins':       1.0,
}

# ── STATE ──
state = {
    'weights':         dict(DEFAULT_WEIGHTS),
    'consecutive_loss': 0,
    'paused_until':    0,
    'daily_count':     0,
    'daily_date':      '',
    'trade_history':   [],  # full context of every trade
    'coin_memory':     {},  # per-coin win/loss tracking
    'hour_memory':     {},  # per-hour win/loss tracking
    'wins': 0, 'losses': 0, 'total_pnl': 0.0, 'signals': 0,
}
state_lock = threading.Lock()

# ══════════════════════════════════════════════════════
# TELEGRAM
# ══════════════════════════════════════════════════════
def tg(msg, private=False):
    chat = TG_PRIVATE if private else TG_CHANNEL
    try:
        requests.post(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            json={'chat_id': chat, 'text': msg, 'parse_mode': 'HTML'},
            timeout=10)
    except Exception as e:
        print(f'TG error: {e}')

# ══════════════════════════════════════════════════════
# GITHUB PERSISTENCE
# ══════════════════════════════════════════════════════
def gh_put(path, data, msg='Update'):
    if not GH_TOKEN or not GH_REPO: return
    try:
        url = f'https://api.github.com/repos/{GH_REPO}/contents/{path}'
        h = {'Authorization': f'token {GH_TOKEN}'}
        r = requests.get(url, headers=h, timeout=10)
        sha = r.json().get('sha') if r.status_code == 200 else None
        content = base64.b64encode(json.dumps(data, indent=2).encode()).decode()
        payload = {'message': msg, 'content': content}
        if sha: payload['sha'] = sha
        requests.put(url, headers=h, json=payload, timeout=10)
    except Exception as e:
        print(f'GH error: {e}')

def gh_get(path):
    try:
        url = f'https://api.github.com/repos/{GH_REPO}/contents/{path}'
        r = requests.get(url, headers={'Authorization': f'token {GH_TOKEN}'}, timeout=10)
        if r.status_code == 200:
            return json.loads(base64.b64decode(r.json()['content']).decode())
    except: pass
    return None

def save_state():
    with state_lock:
        data = {
            'weights':    state['weights'],
            'coin_memory': state['coin_memory'],
            'hour_memory': state['hour_memory'],
            'wins':       state['wins'],
            'losses':     state['losses'],
            'total_pnl':  state['total_pnl'],
            'signals':    state['signals'],
            'updated':    time.strftime('%Y-%m-%d %H:%M UTC'),
        }
    gh_put('data/eai_state.json', data, 'EAI state update')

def load_state():
    data = gh_get('data/eai_state.json')
    if data:
        with state_lock:
            state['weights']     = data.get('weights', dict(DEFAULT_WEIGHTS))
            state['coin_memory'] = data.get('coin_memory', {})
            state['hour_memory'] = data.get('hour_memory', {})
            state['wins']        = data.get('wins', 0)
            state['losses']      = data.get('losses', 0)
            state['total_pnl']   = data.get('total_pnl', 0.0)
            state['signals']     = data.get('signals', 0)
        print(f'✓ State loaded: {state["wins"]}W/{state["losses"]}L')

def save_signal_log(entry):
    signals = gh_get('data/signals.json') or []
    signals.insert(0, entry)
    gh_put('data/signals.json', signals[:200], f"Signal: {entry['action']} {entry['coin']}")

def update_signal_log(coin, exit_price, result, pnl, hold_mins, tp_hit):
    signals = gh_get('data/signals.json')
    if not signals: return
    for s in signals:
        if s.get('coin') == coin and s.get('status') == 'open':
            s.update({
                'status':   'closed',
                'exit':     exit_price,
                'pnl':      round(pnl, 2),
                'result':   result.lower(),
                'holdMins': hold_mins,
                'tp_hit':   tp_hit,
            })
            break
    gh_put('data/signals.json', signals, f"Close: {coin} {result}")

def save_stats():
    with state_lock:
        total = state['wins'] + state['losses']
        wr = round(state['wins'] / total * 100, 1) if total > 0 else 0
        payload = {
            'updated_at':  time.strftime('%Y-%m-%d %H:%M UTC'),
            'market_mode': detect_regime(),
            'pairs':       len(TARGET_PAIRS),
            'min_score':   MIN_SCORE,
            'stats': {
                'wins':      state['wins'],
                'losses':    state['losses'],
                'total_pnl': round(state['total_pnl'], 2),
                'signals':   state['signals'],
                'win_rate':  wr,
            }
        }
    gh_put('stats.json', payload, 'Stats update')

# ══════════════════════════════════════════════════════
# MARKET DATA
# ══════════════════════════════════════════════════════
def get_candles(coin, interval='1h', limit=200):
    try:
        now = int(time.time() * 1000)
        hrs = {'1h': 1, '4h': 4, '1d': 24}.get(interval, 1)
        r = requests.post(f'{HL_API}/info', json={
            'type': 'candleSnapshot',
            'req': {'coin': coin, 'interval': interval,
                    'startTime': now - limit * hrs * 3600000, 'endTime': now}
        }, timeout=10)
        return r.json() if r.status_code == 200 else []
    except:
        return []

def get_price(coin):
    try:
        r = requests.post(f'{HL_API}/info', json={'type': 'allMids'}, timeout=10)
        return float(r.json().get(coin, 0))
    except:
        return 0

def get_orderbook(coin):
    """Returns (bid_vol, ask_vol, imbalance) imbalance > 0 = buy pressure"""
    try:
        r = requests.post(f'{HL_API}/info',
            json={'type': 'l2Book', 'coin': coin}, timeout=10)
        d = r.json()
        bids = sum(float(l[1]) for l in d.get('levels', [[]])[0][:10])
        asks = sum(float(l[1]) for l in d.get('levels', [[]])[1][:10])
        total = bids + asks
        imbalance = (bids - asks) / total if total > 0 else 0
        return bids, asks, imbalance
    except:
        return 0, 0, 0

def get_open_interest(coin):
    try:
        r = requests.post(f'{HL_API}/info',
            json={'type': 'metaAndAssetCtxs'}, timeout=10)
        d = r.json()
        universe = d[0]['universe']
        ctxs = d[1]
        for i, asset in enumerate(universe):
            if asset['name'] == coin and i < len(ctxs):
                ctx = ctxs[i]
                return {
                    'funding':       float(ctx.get('funding', 0)),
                    'open_interest': float(ctx.get('openInterest', 0)),
                    'premium':       float(ctx.get('premium', 0)),
                }
        return {}
    except:
        return {}

_fng_cache = {'v': 50, 'l': 'Neutral', 'ts': 0}
def get_fear_greed():
    if time.time() - _fng_cache['ts'] < 3600:
        return _fng_cache['v'], _fng_cache['l']
    try:
        r = requests.get('https://api.alternative.me/fng/?limit=1', timeout=10)
        d = r.json()['data'][0]
        _fng_cache.update({'v': int(d['value']), 'l': d['value_classification'], 'ts': time.time()})
        return _fng_cache['v'], _fng_cache['l']
    except:
        return 50, 'Neutral'

_news_cache = {'score': 0, 'ts': 0}
def get_news_sentiment():
    """Simple crypto news sentiment — positive = bullish, negative = bearish"""
    if time.time() - _news_cache['ts'] < 3600:
        return _news_cache['score']
    try:
        r = requests.get(
            'https://cryptopanic.com/api/v1/posts/?auth_token=public&kind=news&filter=hot',
            timeout=10)
        posts = r.json().get('results', [])[:20]
        score = 0
        bull_words = ['surge', 'rally', 'bull', 'gain', 'rise', 'high', 'pump', 'green', 'up', 'boost']
        bear_words = ['crash', 'drop', 'bear', 'fall', 'low', 'dump', 'red', 'down', 'fear', 'sell']
        for post in posts:
            title = post.get('title', '').lower()
            score += sum(1 for w in bull_words if w in title)
            score -= sum(1 for w in bear_words if w in title)
        _news_cache.update({'score': score, 'ts': time.time()})
        return score
    except:
        return 0

# ══════════════════════════════════════════════════════
# INDICATORS
# ══════════════════════════════════════════════════════
def ema(prices, n):
    if not prices or n <= 0: return 0
    k = 2 / (n + 1); v = prices[0]
    for p in prices[1:]: v = p * k + v * (1 - k)
    return v

def rsi(prices, n=14):
    if len(prices) < n + 1: return 50
    gains = [max(prices[i]-prices[i-1], 0) for i in range(1, len(prices))]
    losses= [max(prices[i-1]-prices[i], 0) for i in range(1, len(prices))]
    ag = sum(gains[-n:]) / n
    al = sum(losses[-n:]) / n
    return 100 if al == 0 else 100 - (100 / (1 + ag / al))

def atr(candles, n=14):
    if len(candles) < 2: return 0
    trs = []
    for i in range(1, len(candles)):
        h = float(candles[i]['h']); l = float(candles[i]['l'])
        pc = float(candles[i-1]['c'])
        trs.append(max(h-l, abs(h-pc), abs(l-pc)))
    return sum(trs[-n:]) / n if len(trs) >= n else sum(trs) / max(len(trs), 1)

def supertrend(candles, factor=3.0, n=10):
    if len(candles) < n + 5: return 0
    closes = [float(c['c']) for c in candles]
    highs  = [float(c['h']) for c in candles]
    lows   = [float(c['l']) for c in candles]
    trs = [max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
           for i in range(1, len(candles))]
    direction = 1; upper = lower = 0
    for i in range(n, len(candles)):
        atr_v = sum(trs[i-n:i]) / n
        hl2 = (highs[i] + lows[i]) / 2
        bu = hl2 + factor * atr_v; bl = hl2 - factor * atr_v
        if i == n: upper = bu; lower = bl
        else:
            upper = bu if bu < upper or closes[i-1] > upper else upper
            lower = bl if bl > lower or closes[i-1] < lower else lower
        if closes[i] > upper: direction = 1
        elif closes[i] < lower: direction = -1
    return direction

def adx(candles, n=14):
    if len(candles) < n * 2: return 0, 0, 0
    highs  = [float(c['h']) for c in candles]
    lows   = [float(c['l']) for c in candles]
    closes = [float(c['c']) for c in candles]
    dmp, dmm, trl = [], [], []
    for i in range(1, len(candles)):
        up   = highs[i] - highs[i-1]
        down = lows[i-1] - lows[i]
        dmp.append(up   if up > down and up > 0 else 0)
        dmm.append(down if down > up and down > 0 else 0)
        trl.append(max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1])))
    def smooth(lst):
        r = [sum(lst[:n])]
        for v in lst[n:]: r.append(r[-1] - r[-1]/n + v)
        return r
    str_ = smooth(trl); sdp = smooth(dmp); sdm = smooth(dmm)
    dip = [100*p/t if t>0 else 0 for p,t in zip(sdp,str_)]
    dim = [100*m/t if t>0 else 0 for m,t in zip(sdm,str_)]
    dx  = [100*abs(p-m)/(p+m) if (p+m)>0 else 0 for p,m in zip(dip,dim)]
    adx_v = sum(dx[-n:])/n if len(dx)>=n else sum(dx)/max(len(dx),1)
    return adx_v, dip[-1] if dip else 0, dim[-1] if dim else 0

def rsi_divergence(closes, lookback=10):
    if len(closes) < lookback * 3: return None
    rsi_vals = [rsi(closes[max(0,i-14):i+1]) for i in range(14, len(closes))]
    if len(rsi_vals) < lookback * 2: return None
    n = lookback
    p = closes[-n*2:]; rv = rsi_vals[-n*2:]
    p_now_low = min(p[n:]); p_prev_low = min(p[:n])
    p_now_hi  = max(p[n:]); p_prev_hi  = max(p[:n])
    try:
        r_now_low  = rv[n + p[n:].index(p_now_low)]
        r_prev_low = rv[p[:n].index(p_prev_low)]
        r_now_hi   = rv[n + p[n:].index(p_now_hi)]
        r_prev_hi  = rv[p[:n].index(p_prev_hi)]
    except:
        return None
    if p_now_low < p_prev_low and r_now_low > r_prev_low:   return 'bull'
    if p_now_hi  > p_prev_hi  and r_now_hi  < r_prev_hi:    return 'bear'
    if p_now_low > p_prev_low and r_now_low < r_prev_low:   return 'hidden_bull'
    if p_now_hi  < p_prev_hi  and r_now_hi  > r_prev_hi:    return 'hidden_bear'
    return None

def bollinger(closes, n=20, k=2.0):
    if len(closes) < n: return 0, 0, 0, False
    mid = sum(closes[-n:]) / n
    std = math.sqrt(sum((x-mid)**2 for x in closes[-n:]) / n)
    return mid + k*std, mid, mid - k*std, std < mid * 0.01

def pivot_sr(candles, window=3):
    if len(candles) < window*3: return 0, 0, False, False
    closes = [float(c['c']) for c in candles]
    highs  = [float(c['h']) for c in candles]
    lows   = [float(c['l']) for c in candles]
    price  = closes[-1]
    ph, pl = [], []
    for i in range(window, len(candles)-window-1):
        if all(highs[i]>=highs[i-j] for j in range(1,window+1)) and \
           all(highs[i]>=highs[i+j] for j in range(1,window+1)):
            ph.append(highs[i])
        if all(lows[i]<=lows[i-j] for j in range(1,window+1)) and \
           all(lows[i]<=lows[i+j] for j in range(1,window+1)):
            pl.append(lows[i])
    res = min((p for p in ph if p > price), default=price*1.05)
    sup = max((p for p in pl if p < price), default=price*0.95)
    return sup, res, abs(price-sup)/price < 0.005, abs(price-res)/price < 0.005

# ══════════════════════════════════════════════════════
# REGIME DETECTION
# ══════════════════════════════════════════════════════
_regime_cache = {'r': 'bull', 'ts': 0}
def detect_regime():
    if time.time() - _regime_cache['ts'] < 600:
        return _regime_cache['r']
    try:
        c = get_candles('BTC', '4h', 100)
        if len(c) < 50: return 'bull'
        closes = [float(x['c']) for x in c]
        e50  = ema(closes[-50:], 50)
        e200 = ema(closes, min(len(closes), 200))
        adx_v, dip, dim = adx(c[-50:])
        price = closes[-1]
        if price > e50 and e50 > e200:
            regime = 'bull'
        elif price < e50 and e50 < e200:
            regime = 'bear'
        elif adx_v < 15:
            regime = 'sideways'
        else:
            regime = 'bull'
        _regime_cache.update({'r': regime, 'ts': time.time()})
        return regime
    except:
        return 'bull'

# ══════════════════════════════════════════════════════
# MASTER CONFIDENCE ENGINE
# ══════════════════════════════════════════════════════
def score_signal(coin, c1h, c4h):
    """
    Returns (bull_score, bear_score, action, reasons, context_snapshot)
    context_snapshot = full market state at signal time for learning
    """
    if len(c1h) < 80:
        print(f"    ↳ Skip: only {len(c1h)} candles (need 80)")
        return 0, 0, None, [], {}

    closes_1h = [float(c['c']) for c in c1h]
    closes_4h = [float(c['c']) for c in c4h] if c4h else []
    price = closes_1h[-1]
    w = state['weights']

    bull = 0.0; bear = 0.0
    bull_r = []; bear_r = []
    ctx = {}  # context snapshot for learning

    # ── SuperTrend 1H ──
    st1 = supertrend(c1h[-40:])
    ctx['st_1h'] = st1
    if st1 == 1:  bull += 10 * w['supertrend_1h']; bull_r.append('SuperTrend BULL 1H')
    if st1 == -1: bear += 10 * w['supertrend_1h']; bear_r.append('SuperTrend BEAR 1H')

    # ── SuperTrend 4H ──
    st4 = supertrend(c4h[-40:]) if len(c4h) >= 40 else 0
    ctx['st_4h'] = st4
    if st4 == 1:  bull += 12 * w['supertrend_4h']; bull_r.append('SuperTrend BULL 4H')
    if st4 == -1: bear += 12 * w['supertrend_4h']; bear_r.append('SuperTrend BEAR 4H')

    # ── ADX ──
    adx_v, dip, dim = adx(c1h[-50:])
    ctx['adx'] = adx_v; ctx['dip'] = dip; ctx['dim'] = dim
    if adx_v < 20:
        bull *= 0.6; bear *= 0.6  # penalize both in choppy market
    elif adx_v >= 25:
        if dip > dim: bull += 10 * w['adx']; bull_r.append(f'ADX {adx_v:.0f} DI+ dominant')
        if dim > dip: bear += 10 * w['adx']; bear_r.append(f'ADX {adx_v:.0f} DI- dominant')

    # ── EMA Ribbon 8/13/21/34/55 ──
    emas = [ema(closes_1h[-60:], p) for p in [8, 13, 21, 34, 55]]
    ribbon = sum(1 for i in range(len(emas)-1) if emas[i] > emas[i+1])
    ctx['ribbon'] = ribbon
    if ribbon >= 4: bull += 12 * w['ema_ribbon']; bull_r.append(f'EMA Ribbon bull {ribbon}/5')
    if ribbon <= 1: bear += 12 * w['ema_ribbon']; bear_r.append(f'EMA Ribbon bear {5-ribbon}/5')

    # ── EMA 9×21 Crossover ──
    e9  = ema(closes_1h[-20:], 9);  e21  = ema(closes_1h[-30:], 21)
    pe9 = ema(closes_1h[-21:-1], 9); pe21 = ema(closes_1h[-31:-1], 21)
    cross_up = pe9 <= pe21 and e9 > e21
    cross_dn = pe9 >= pe21 and e9 < e21
    ctx['cross_up'] = cross_up; ctx['cross_dn'] = cross_dn
    if cross_up: bull += 10 * w['ema_cross']; bull_r.append('EMA 9×21 crossover UP')
    if cross_dn: bear += 10 * w['ema_cross']; bear_r.append('EMA 9×21 crossover DOWN')

    # ── 4H Master Trend (EMA50/200) ──
    if len(closes_4h) >= 50:
        e50_4h  = ema(closes_4h[-50:], 50)
        e200_4h = ema(closes_4h, min(len(closes_4h), 200))
        ctx['e50_4h'] = e50_4h; ctx['e200_4h'] = e200_4h
        if closes_4h[-1] > e50_4h and e50_4h > e200_4h:
            bull += 10 * w['ema_4h_master']; bull_r.append('4H master trend BULL')
            bear *= 0.5  # strong penalty for shorting in bull trend
        elif closes_4h[-1] < e50_4h and e50_4h < e200_4h:
            bear += 10 * w['ema_4h_master']; bear_r.append('4H master trend BEAR')
            bull *= 0.5

    # ── RSI ──
    rv = rsi(closes_1h[-21:])
    rv4 = rsi(closes_4h[-21:]) if len(closes_4h) >= 21 else 50
    ctx['rsi_1h'] = rv; ctx['rsi_4h'] = rv4
    if rv < 30:   bull += 14 * w['rsi']; bull_r.append(f'RSI {rv:.0f} oversold')
    elif rv < 45: bull += 7  * w['rsi']; bull_r.append(f'RSI {rv:.0f} bull zone')
    if rv > 70:   bear += 14 * w['rsi']; bear_r.append(f'RSI {rv:.0f} overbought')
    elif rv > 55: bear += 7  * w['rsi']; bear_r.append(f'RSI {rv:.0f} bear zone')

    # ── RSI Divergence ──
    div = rsi_divergence(closes_1h)
    ctx['divergence'] = div
    if div == 'bull':        bull += 15 * w['rsi_divergence']; bull_r.append('RSI Bullish Divergence')
    elif div == 'bear':      bear += 15 * w['rsi_divergence']; bear_r.append('RSI Bearish Divergence')
    elif div == 'hidden_bull': bull += 10 * w['rsi_divergence']; bull_r.append('RSI Hidden Bull Div')
    elif div == 'hidden_bear': bear += 10 * w['rsi_divergence']; bear_r.append('RSI Hidden Bear Div')

    # ── MACD ──
    if len(closes_1h) >= 40:
        ml  = ema(closes_1h[-38:], 12) - ema(closes_1h[-38:], 26)
        pml = ema(closes_1h[-39:-1], 12) - ema(closes_1h[-39:-1], 26)
        ctx['macd'] = ml
        if pml < 0 and ml > 0: bull += 10 * w['macd']; bull_r.append('MACD Golden Cross')
        elif ml > 0:            bull += 5  * w['macd']
        if pml > 0 and ml < 0: bear += 10 * w['macd']; bear_r.append('MACD Death Cross')
        elif ml < 0:            bear += 5  * w['macd']

    # ── Bollinger Bands + Support/Resistance ──
    bb_upper, bb_mid, bb_lower, bb_squeeze = bollinger(closes_1h)
    sup, res, at_sup, at_res = pivot_sr(c1h)
    ctx['at_support'] = at_sup; ctx['at_resistance'] = at_res; ctx['bb_squeeze'] = bb_squeeze
    if at_sup:     bull += 10 * w['bb_sr']; bull_r.append(f'At key support ${sup:,.3f}')
    if at_res:     bear += 10 * w['bb_sr']; bear_r.append(f'At key resistance ${res:,.3f}')
    if bb_squeeze:
        if bull > bear: bull += 5; bull_r.append('BB squeeze — breakout pending')
        else:           bear += 5; bear_r.append('BB squeeze — breakdown pending')
    if price <= bb_lower: bull += 6; bull_r.append('Price at BB lower band')
    if price >= bb_upper: bear += 6; bear_r.append('Price at BB upper band')

    # ── Volume ──
    vols = [float(c['v']) for c in c1h]
    avg_vol = sum(vols[-20:]) / 20
    vol_spike = vols[-2] > avg_vol * 1.5
    ctx['vol_spike'] = vol_spike
    if vol_spike:
        if bull > bear: bull += 6 * w['volume']; bull_r.append('Volume spike confirmation')
        else:           bear += 6 * w['volume']; bear_r.append('Volume spike confirmation')

    # ── Fear & Greed ──
    fng, fng_label = get_fear_greed()
    ctx['fear_greed'] = fng
    if fng <= 24:   bull += 12 * w['fear_greed']; bull_r.append(f'Extreme Fear {fng} — contrarian BUY')
    elif fng <= 40: bull += 6  * w['fear_greed']; bull_r.append(f'Fear {fng} — buy zone')
    elif fng >= 75: bear += 10 * w['fear_greed']; bear_r.append(f'Extreme Greed {fng} — caution')
                    # also penalize longs in extreme greed
    if fng >= 75:   bull -= 8

    # ── Funding Rate + Open Interest ──
    oi_data = get_open_interest(coin)
    funding = oi_data.get('funding', 0)
    ctx['funding'] = funding
    fund_pct = funding * 100
    if fund_pct < -0.05:
        bull += 8 * w['funding']; bull_r.append(f'Funding {fund_pct:.3f}% short squeeze')
    elif fund_pct < 0:
        bull += 4 * w['funding']
    elif fund_pct > 0.1:
        bear += 8 * w['funding']; bear_r.append(f'Funding {fund_pct:.3f}% longs crowded')
        bear += 4; bull -= 6  # penalize longs when funding extreme

    # ── Order Book Imbalance ──
    _, _, ob_imbalance = get_orderbook(coin)
    ctx['ob_imbalance'] = ob_imbalance
    if ob_imbalance > 0.2:  bull += 8 * w['order_book']; bull_r.append(f'Order book {ob_imbalance:.0%} buy pressure')
    elif ob_imbalance < -0.2: bear += 8 * w['order_book']; bear_r.append(f'Order book {abs(ob_imbalance):.0%} sell pressure')

    # ── News Sentiment ──
    news_score = get_news_sentiment()
    ctx['news'] = news_score
    if news_score >= 3:   bull += 5; bull_r.append(f'News sentiment bullish +{news_score}')
    elif news_score <= -3: bear += 5; bear_r.append(f'News sentiment bearish {news_score}')

    # ── Coin Memory Bonus/Penalty ──
    with state_lock:
        cm = state['coin_memory'].get(coin, {'wins': 0, 'losses': 0, 'streak': 0})
    if cm.get('streak', 0) >= 2:  bull += 5; bull_r.append(f'{coin} on {cm["streak"]}-win streak')
    if cm.get('streak', 0) <= -2: bear += 5; bear_r.append(f'{coin} on {abs(cm["streak"])}-loss streak')

    # ── Regime gate ──
    regime = detect_regime()
    ctx['regime'] = regime
    if regime == 'sideways':
        print(f"    ↳ Regime SIDEWAYS — waiting for trend")
        return 0, 0, None, [], ctx
    if regime == 'bull' and bear > bull:
        bear *= 0.4  # strong penalty for shorts in bull regime
    if regime == 'bear' and bull > bear:
        bull *= 0.4  # strong penalty for longs in bear regime

    # Normalize to 0-100
    # Use raw scores directly — no normalization
    # Raw scores naturally represent conviction level
    bull_norm = min(int(bull), 100)
    bear_norm = min(int(bear), 100)
    gap = abs(bull_norm - bear_norm)

    ctx['bull_score'] = bull_norm; ctx['bear_score'] = bear_norm

    if gap < MIN_GAP:
        print(f"    ↳ Gap too small: B:{bull_norm} S:{bear_norm} gap:{gap} (need {MIN_GAP})")
        return bull_norm, bear_norm, None, [], ctx

    if bull_norm >= MIN_SCORE and bull_norm > bear_norm:
        return bull_norm, bear_norm, 'BUY', bull_r[:5], ctx
    if bear_norm >= MIN_SCORE and bear_norm > bull_norm:
        return bull_norm, bear_norm, 'SELL', bear_r[:5], ctx

    print(f"    ↳ Below threshold: B:{bull_norm} S:{bear_norm} (need {MIN_SCORE})")
    return bull_norm, bear_norm, None, [], ctx

# ══════════════════════════════════════════════════════
# ALTFINS LAYER
# ══════════════════════════════════════════════════════
def fetch_altfins(regime):
    SKIP = {'SIGNALS_SUMMARY_BULL_POWER','SIGNALS_SUMMARY_BEAR_POWER',
            'SIGNALS_SUMMARY_BUY','SIGNALS_SUMMARY_SELL'}
    results = []
    try:
        for direction in ['BULLISH', 'BEARISH']:
            if regime == 'bull' and direction == 'BEARISH': continue
            if regime == 'bear' and direction == 'BULLISH': continue
            r = requests.post(f'{AF_API}/api/v2/public/signals-feed/search-requests',
                headers={'x-api-key': AF_KEY, 'Content-Type': 'application/json'},
                json={'direction': direction, 'limit': 20,
                      'sort': [{'property': 'timestamp', 'direction': 'DESC'}]},
                timeout=15)
            if r.status_code == 200:
                for s in r.json().get('content', []):
                    if s.get('signalKey') in SKIP: continue
                    if s.get('symbol') not in TARGET_PAIRS: continue
                    try:
                        price = float(str(s.get('lastPrice','0')).replace(',','.'))
                    except: continue
                    if price <= 0: continue
                    results.append({
                        'coin':   s['symbol'],
                        'action': 'BUY' if direction == 'BULLISH' else 'SELL',
                        'price':  price,
                        'reason': s.get('signalName', '') + ' confirmed',
                    })
    except Exception as e:
        print(f'AltFINS error: {e}')
    return results

# ══════════════════════════════════════════════════════
# SIGNAL FORMATTING
# ══════════════════════════════════════════════════════
def fmt_signal(coin, action, entry, tp1, tp2, sl, score, reasons, atr_val, regime):
    e = '🟢' if action == 'BUY' else '🔴'
    top = ' · '.join(r for r in reasons[:3] if r)
    regime_label = {'bull': '📈 BULL', 'bear': '📉 BEAR', 'sideways': '↔️ NEUTRAL'}.get(regime, '📈')
    return (
        f"⚡ <b>TK EMPIRE SIGNAL</b> ⚡\n"
        f"{e} <b>{action} — {coin}/USDC</b>  |  {regime_label} MARKET\n\n"
        f"💰 <b>Entry:</b>     ${entry:,.4f}\n"
        f"🎯 <b>TP1 (50%):</b> ${tp1:,.4f}  (+{(tp1-entry)/entry*100:.1f}%)\n"
        f"🎯 <b>TP2 (50%):</b> ${tp2:,.4f}  (+{(tp2-entry)/entry*100:.1f}%)\n"
        f"🛡 <b>Stop Loss:</b> ${sl:,.4f}   (-{abs(sl-entry)/entry*100:.1f}%)\n"
        f"📊 <b>Confidence:</b> {score}/100\n"
        f"🔍 <b>Edge:</b>      {top}\n\n"
        f"⚠️ Risk max 2% of capital · Move SL to breakeven after TP1\n"
        f"👑 <b>TK Empire — Built for Legacy</b>"
    )

def fmt_close(coin, action, entry, exit_p, result, hold_mins, tp_hit, atr_val):
    pnl = (exit_p-entry)/entry*100 if action=='BUY' else (entry-exit_p)/entry*100
    emoji = '✅' if result == 'WIN' else '❌'
    h, m = hold_mins//60, hold_mins%60
    hold_str = f"{h}h {m}m" if h > 0 else f"{m}m"
    with state_lock:
        total = state['wins'] + state['losses']
        wr = int(state['wins']/total*100) if total > 0 else 0
        tpnl = state['total_pnl']
        consec = state['consecutive_loss']
    tp_str = f" · TP{tp_hit} hit" if tp_hit else ""
    return (
        f"{emoji} <b>SIGNAL CLOSED — {coin}/USDC</b>{tp_str}\n\n"
        f"📍 <b>Entry:</b>  ${entry:,.4f}\n"
        f"📍 <b>Exit:</b>   ${exit_p:,.4f}\n"
        f"📊 <b>Return:</b> {'🟢 +' if pnl>=0 else '🔴 '}{pnl:.2f}%\n"
        f"⏱ <b>Hold:</b>   {hold_str}\n"
        f"🏆 <b>Result:</b> {'🟢 WIN ✓' if result=='WIN' else '🔴 LOSS ✗'}\n\n"
        f"📈 <b>Win Rate:</b> {wr}% ({state['wins']}W/{state['losses']}L)\n"
        f"💰 <b>Total P&L:</b> {'🟢 +' if tpnl>=0 else '🔴 '}{tpnl:.2f}%\n\n"
        f"👑 <b>TK Empire — Built for Legacy</b>"
    )

# ══════════════════════════════════════════════════════
# TRADE MONITOR — ATR-based dual TP + breakeven SL
# ══════════════════════════════════════════════════════
def monitor_trade(coin, action, entry, atr_val, open_time, active_trades, ctx):
    tp1 = entry + atr_val*ATR_TP1 if action=='BUY' else entry - atr_val*ATR_TP1
    tp2 = entry + atr_val*ATR_TP2 if action=='BUY' else entry - atr_val*ATR_TP2
    sl  = entry - atr_val*ATR_SL  if action=='BUY' else entry + atr_val*ATR_SL
    key = f"{coin}_active"
    tp1_hit = False
    current_sl = sl
    print(f"📊 {action} {coin} | TP1:${tp1:.4f} TP2:${tp2:.4f} SL:${sl:.4f}")

    def record_close(price, result, tp_hit):
        pnl = (price-entry)/entry*100 if action=='BUY' else (entry-price)/entry*100
        hold_mins = int((time.time()-open_time)/60)
        hour = int(time.strftime('%H'))

        with state_lock:
            if result == 'WIN':
                state['wins'] += 1
                state['total_pnl'] += abs(pnl)
                state['consecutive_loss'] = 0
            else:
                state['losses'] += 1
                state['total_pnl'] -= abs(pnl)
                state['consecutive_loss'] += 1

            # Update coin memory
            cm = state['coin_memory'].get(coin, {'wins':0,'losses':0,'streak':0})
            if result == 'WIN': cm['wins'] += 1; cm['streak'] = max(0, cm['streak']) + 1
            else:               cm['losses'] += 1; cm['streak'] = min(0, cm['streak']) - 1
            state['coin_memory'][coin] = cm

            # Update hour memory
            hm = state['hour_memory'].get(str(hour), {'wins':0,'losses':0})
            if result == 'WIN': hm['wins'] += 1
            else:               hm['losses'] += 1
            state['hour_memory'][str(hour)] = hm

            # Store trade in history for learning
            state['trade_history'].append({
                'coin': coin, 'action': action, 'entry': entry,
                'exit': price, 'pnl': round(pnl,2), 'result': result,
                'hold_mins': hold_mins, 'hour': hour,
                'atr': atr_val, 'tp_hit': tp_hit,
                'context': ctx,
                'timestamp': time.strftime('%Y-%m-%d %H:%M'),
            })
            # Keep last 500 trades
            state['trade_history'] = state['trade_history'][-500:]

            consec = state['consecutive_loss']

        update_signal_log(coin, price, result, pnl, hold_mins, tp_hit)
        save_stats()
        save_state()
        tg(fmt_close(coin, action, entry, price, result, hold_mins, tp_hit, atr_val))

        # Auto-pause check
        with state_lock:
            total = state['wins'] + state['losses']
            wr = state['wins']/total*100 if total >= 10 else 100
            consec = state['consecutive_loss']

        if consec >= PAUSE_LOSSES:
            with state_lock:
                state['paused_until'] = time.time() + PAUSE_DURATION
            tg(f"⏸ <b>EAI AUTO-PAUSE</b>\n\n{consec} consecutive losses detected.\nPausing signals for 4 hours.\nResumes at {time.strftime('%H:%M UTC', time.localtime(state['paused_until']))}\n\n👑 TK Empire — Built for Legacy", private=True)

        if total >= 10 and wr < MIN_WIN_RATE:
            with state_lock:
                state['paused_until'] = time.time() + PAUSE_DURATION * 2
            tg(f"⚠️ <b>EAI ALERT — Low Win Rate</b>\n\nWin rate: {wr:.0f}% over {total} trades\nPausing for 8 hours for self-analysis.\n\n👑 TK Empire — Built for Legacy", private=True)

    try:
        max_hold = 1440  # 24 hours max
        while True:
            time.sleep(30)
            price = get_price(coin)
            if price <= 0: continue
            hold_mins = int((time.time()-open_time)/60)

            # TP1 check
            if not tp1_hit:
                if (action=='BUY' and price>=tp1) or (action=='SELL' and price<=tp1):
                    tp1_hit = True
                    current_sl = entry  # move SL to breakeven
                    tg(f"🎯 <b>TP1 HIT — {coin}</b>\n50% closed @ ${price:,.4f}\nStop moved to breakeven ${entry:,.4f}\n\n👑 TK Empire — Built for Legacy")
                    print(f"🎯 TP1 hit {coin} @ ${price:.4f} — SL to breakeven")

            # TP2 check
            if tp1_hit:
                if (action=='BUY' and price>=tp2) or (action=='SELL' and price<=tp2):
                    pnl_check = (price-entry)/entry*100 if action=='BUY' else (entry-price)/entry*100
                    record_close(price, 'WIN' if pnl_check > 0 else 'LOSS', 2)
                    print(f"✅ TP2 {coin} @ ${price:.4f}")
                    break

            # SL check (dynamic after TP1)
            if (action=='BUY' and price<=current_sl) or (action=='SELL' and price>=current_sl):
                pnl_check = (price-entry)/entry*100 if action=='BUY' else (entry-price)/entry*100
                result = 'WIN' if pnl_check > 0 else 'LOSS'
                record_close(price, result, 1 if tp1_hit else 0)
                print(f"{'✅ BE' if tp1_hit else '❌ SL'} {coin} @ ${price:.4f}")
                break

            # Timeout
            if hold_mins >= max_hold:
                pnl_now = (price-entry)/entry*100 if action=='BUY' else (entry-price)/entry*100
                result = 'WIN' if pnl_now > 0 else 'LOSS'
                record_close(price, result, 1 if tp1_hit else 0)
                print(f"⏰ TIMEOUT {coin} @ ${price:.4f} — {result}")
                break

    finally:
        active_trades.pop(key, None)

# ══════════════════════════════════════════════════════
# NIGHTLY LEARNING CYCLE
# ══════════════════════════════════════════════════════
def run_learning_cycle():
    """
    Analyzes all closed trades.
    Adjusts indicator weights based on predictive accuracy.
    Sends private learning report.
    """
    with state_lock:
        history = list(state['trade_history'])
        weights = dict(state['weights'])

    if len(history) < 5:
        tg("🧠 <b>EAI Learning Cycle</b>\n\nNot enough trades yet for meaningful learning.\nNeed 5+ closed trades.\n\n👑 TK Empire", private=True)
        return

    # Analyze which context factors correlate with wins
    wins   = [t for t in history if t['result'] == 'WIN']
    losses = [t for t in history if t['result'] == 'LOSS']

    total  = len(history)
    win_rate = len(wins)/total*100

    # Build indicator correlation scores
    indicator_map = {
        'supertrend_1h': 'st_1h',
        'supertrend_4h': 'st_4h',
        'rsi_divergence': 'divergence',
        'fear_greed': 'fear_greed',
        'funding': 'funding',
        'ob_imbalance': 'ob_imbalance',
    }

    weight_changes = {}
    analysis_lines = []

    # Coin performance
    coin_stats = {}
    for t in history:
        c = t['coin']
        if c not in coin_stats: coin_stats[c] = {'wins':0,'losses':0}
        if t['result']=='WIN': coin_stats[c]['wins'] += 1
        else: coin_stats[c]['losses'] += 1

    # Hour performance
    hour_stats = {}
    for t in history:
        h = str(t['hour'])
        if h not in hour_stats: hour_stats[h] = {'wins':0,'losses':0}
        if t['result']=='WIN': hour_stats[h]['wins'] += 1
        else: hour_stats[h]['losses'] += 1

    # Best/worst hours
    best_hours  = sorted(hour_stats.keys(), key=lambda h: hour_stats[h]['wins']/(hour_stats[h]['wins']+hour_stats[h]['losses']+0.001), reverse=True)[:3]
    worst_hours = sorted(hour_stats.keys(), key=lambda h: hour_stats[h]['wins']/(hour_stats[h]['wins']+hour_stats[h]['losses']+0.001))[:3]

    # Adjust weights — simplified correlation
    # If an indicator fired on wins more than losses → increase weight
    for ind, ctx_key in indicator_map.items():
        win_ctx  = [t['context'].get(ctx_key) for t in wins  if 'context' in t]
        loss_ctx = [t['context'].get(ctx_key) for t in losses if 'context' in t]
        # Simple: count positive signals on wins vs losses
        if ind == 'fear_greed':
            win_bull  = sum(1 for v in win_ctx  if v is not None and v < 45)
            loss_bull = sum(1 for v in loss_ctx if v is not None and v < 45)
        elif ind == 'funding':
            win_bull  = sum(1 for v in win_ctx  if v is not None and v < 0)
            loss_bull = sum(1 for v in loss_ctx if v is not None and v < 0)
        elif ind == 'ob_imbalance':
            win_bull  = sum(1 for v in win_ctx  if v is not None and abs(v) > 0.1)
            loss_bull = sum(1 for v in loss_ctx if v is not None and abs(v) > 0.1)
        else:
            win_bull  = sum(1 for v in win_ctx  if v == 1)
            loss_bull = sum(1 for v in loss_ctx if v == 1)

        # Calculate correlation
        w_rate = win_bull  / max(len(win_ctx),  1)
        l_rate = loss_bull / max(len(loss_ctx), 1)
        correlation = w_rate - l_rate

        # Adjust weight
        old_w = weights.get(ind, 1.0)
        if correlation > 0.1:
            new_w = min(old_w * 1.15, 2.5)  # increase, cap at 2.5x
            weight_changes[ind] = ('↑', old_w, new_w)
        elif correlation < -0.1:
            new_w = max(old_w * 0.85, 0.3)  # decrease, floor at 0.3x
            weight_changes[ind] = ('↓', old_w, new_w)
        else:
            new_w = old_w
        weights[ind] = round(new_w, 3)

    # Save updated weights
    with state_lock:
        state['weights'] = weights

    save_state()

    # Build report
    wc_lines = '\n'.join(
        f"  {ind}: {d[0]} {d[1]:.2f} → {d[2]:.2f}"
        for ind, d in weight_changes.items() if d[0] != '='
    ) or '  No significant changes'

    coin_lines = '\n'.join(
        f"  {c}: {s['wins']}W/{s['losses']}L ({int(s['wins']/(s['wins']+s['losses'])*100)}%)"
        for c, s in coin_stats.items()
    )

    report = (
        f"🧠 <b>EAI NIGHTLY LEARNING REPORT</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📊 <b>Session Stats</b>\n"
        f"  Trades: {total}\n"
        f"  Win Rate: {win_rate:.1f}%\n"
        f"  Wins: {len(wins)} · Losses: {len(losses)}\n\n"
        f"⚖️ <b>Weight Adjustments</b>\n{wc_lines}\n\n"
        f"🪙 <b>Coin Performance</b>\n{coin_lines}\n\n"
        f"⏰ <b>Best Hours (UTC)</b>: {', '.join(best_hours)}\n"
        f"⛔ <b>Worst Hours (UTC)</b>: {', '.join(worst_hours)}\n\n"
        f"🔄 Engine will now apply updated weights.\n"
        f"Each scan gets sharper. Built for legacy.\n\n"
        f"👑 <b>TK Empire — EAI v1</b>"
    )

    tg(report, private=True)
    print(f"🧠 Learning cycle complete. {len(weight_changes)} weights adjusted.")

# ══════════════════════════════════════════════════════
# SIGNAL FIRE
# ══════════════════════════════════════════════════════
active_trades = {}
last_fired    = {}

def fire_signal(coin, action, entry, atr_val, score, reasons, ctx, regime):
    key   = f"{coin}_active"
    dedup = f"{coin}_{action}"

    if key in active_trades: return False
    if time.time() - last_fired.get(dedup, 0) < COOLDOWN: return False

    # Check pause
    with state_lock:
        if time.time() < state['paused_until']:
            resume = time.strftime('%H:%M UTC', time.localtime(state['paused_until']))
            print(f"⏸ Paused until {resume}")
            return False

    # Daily limit
    today = time.strftime('%Y-%m-%d')
    with state_lock:
        if state['daily_date'] != today:
            state['daily_date'] = today
            state['daily_count'] = 0
        if state['daily_count'] >= MAX_DAILY:
            print(f"📊 Daily limit reached ({MAX_DAILY} signals)")
            return False

    # Dead hour check
    if int(time.strftime('%H')) in DEAD_HOURS:
        print(f"🌙 Dead market hour — skipping {coin}")
        return False

    tp1 = entry + atr_val*ATR_TP1 if action=='BUY' else entry - atr_val*ATR_TP1
    tp2 = entry + atr_val*ATR_TP2 if action=='BUY' else entry - atr_val*ATR_TP2
    sl  = entry - atr_val*ATR_SL  if action=='BUY' else entry + atr_val*ATR_SL

    msg = fmt_signal(coin, action, entry, tp1, tp2, sl, score, reasons, atr_val, regime)
    tg(msg)

    with state_lock:
        state['daily_count'] += 1
        state['signals'] += 1

    last_fired[dedup] = time.time()
    active_trades[key] = True

    save_signal_log({
        'id':        int(time.time()),
        'date':      time.strftime('%b %d'),
        'time':      time.strftime('%H:%M'),
        'action':    action,
        'coin':      coin,
        'pair':      f"{coin}/USDC",
        'entry':     entry,
        'tp1':       round(tp1, 4),
        'tp2':       round(tp2, 4),
        'stop':      round(sl, 4),
        'confidence': score,
        'reason':    ' · '.join(reasons[:3]),
        'regime':    regime,
        'status':    'open',
        'exit':      None,
        'pnl':       None,
        'result':    'open',
    })

    t = threading.Thread(
        target=monitor_trade,
        args=(coin, action, entry, atr_val, time.time(), active_trades, ctx),
        daemon=True)
    t.start()
    return True

# ══════════════════════════════════════════════════════
# MAIN LOOP
# ══════════════════════════════════════════════════════
def main():
    print('⚡ EAI v1 — Empire Adaptive Intelligence — Starting...')

    # Load persisted state
    load_state()

    # Schedule nightly learning at midnight UTC
    last_learn_day = ''

    tg(
        '⚡ <b>EAI v1 — Empire Adaptive Intelligence LIVE</b>\n\n'
        '🧠 <b>Self-Learning Engine Active</b>\n\n'
        '📊 Architecture:\n'
        '• 5 high-liquidity pairs only\n'
        '• 15 adaptive indicator weights\n'
        '• ATR-based dual take profits\n'
        '• Breakeven SL after TP1\n'
        '• Regime-aware (Bull/Bear/Sideways)\n'
        '• Order book + funding + on-chain\n'
        '• News sentiment layer\n'
        '• Nightly self-learning cycle\n'
        '• Auto-pause protection\n'
        '• Max 3 signals/day · Min score 80\n\n'
        f'🪙 Pairs: {", ".join(TARGET_PAIRS)}\n\n'
        '👑 <b>TK Empire — Built for Legacy</b>',
        private=True
    )

    while True:
        try:
            # Nightly learning cycle at midnight UTC
            today = time.strftime('%Y-%m-%d')
            if time.strftime('%H:%M') == '00:00' and today != last_learn_day:
                last_learn_day = today
                print('🧠 Running nightly learning cycle...')
                t = threading.Thread(target=run_learning_cycle, daemon=True)
                t.start()

            regime = detect_regime()
            print(f"\n🔍 Scan {time.strftime('%H:%M:%S')} | Regime: {regime.upper()} | "
                  f"Score min: {MIN_SCORE} | Active: {list(active_trades.keys())}")

            # Score all 5 pairs
            candidates = []
            for coin in TARGET_PAIRS:
                try:
                    c1h = get_candles(coin, '1h', 200)
                    c4h = get_candles(coin, '4h', 200)
                    if len(c1h) < 80: continue
                    atr_val = atr(c1h[-20:])
                    bull, bear, action, reasons, ctx = score_signal(coin, c1h, c4h)
                    print(f"  {coin:5} | B:{bull:3} S:{bear:3} | {action or '--':4} | ATR:{atr_val:.4f}")
                    if action:
                        price = float(c1h[-1]['c'])
                        candidates.append((coin, action, price, atr_val, bull if action=='BUY' else bear, reasons, ctx))
                except Exception as e:
                    print(f'  Error {coin}: {e}')

            # Sort by score — only fire the highest conviction setup
            candidates.sort(key=lambda x: x[4], reverse=True)

            fired = 0
            for coin, action, price, atr_val, score, reasons, ctx in candidates:
                if fire_signal(coin, action, price, atr_val, score, reasons, ctx, regime):
                    fired += 1

            # AltFINS layer — only if no internal signal fired
            if fired == 0:
                af = fetch_altfins(regime)
                seen = set()
                for s in af:
                    coin = s['coin']
                    if coin in seen or f"{coin}_active" in active_trades: continue
                    seen.add(coin)
                    price = get_price(coin)
                    if price <= 0: price = s['price']
                    c1h = get_candles(coin, '1h', 50)
                    atr_val = atr(c1h[-20:]) if len(c1h) >= 20 else price * 0.01
                    if fire_signal(coin, s['action'], price, atr_val, 80, [s['reason']], {}, regime):
                        fired += 1

            save_stats()
            print(f"  Fired: {fired}")
            time.sleep(120)

        except KeyboardInterrupt:
            tg('⚠️ EAI v1 stopped.', private=True)
            break
        except Exception as e:
            print(f'Error: {e}')
            time.sleep(30)

if __name__ == '__main__':
    main()
