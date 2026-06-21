import os, time, requests, json
from dotenv import load_dotenv
load_dotenv('/root/tkempire/.env')

TG_TOKEN   = os.getenv('TELEGRAM_BOT_TOKEN')
TG_PRIVATE = os.getenv('TELEGRAM_PRIVATE_ID')
DERIBIT    = 'https://www.deribit.com/api/v2/public'

# ══════════════════════════════════════════════
# TK EMPIRE OPTIONS SIGNAL BOT
# Scans BTC + ETH options on Deribit
# Sends CALL/PUT signals with strike + expiry
# ══════════════════════════════════════════════

def tg(msg):
    try:
        requests.post(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            json={'chat_id': TG_PRIVATE, 'text': msg, 'parse_mode': 'HTML'},
            timeout=10)
    except Exception as e:
        print(f'TG error: {e}')

def get_price(coin):
    try:
        r = requests.get(f'{DERIBIT}/get_index_price',
            params={'index_name': f'{coin.lower()}_usd'}, timeout=10)
        return float(r.json()['result']['index_price'])
    except:
        return 0

def get_instruments(coin):
    try:
        r = requests.get(f'{DERIBIT}/get_instruments',
            params={'currency': coin, 'kind': 'option', 'expired': False},
            timeout=10)
        return r.json().get('result', [])
    except:
        return []

def get_ticker(instrument):
    try:
        r = requests.get(f'{DERIBIT}/ticker',
            params={'instrument_name': instrument}, timeout=10)
        return r.json().get('result', {})
    except:
        return {}

def get_dvol(coin):
    """Deribit Volatility Index — measures implied volatility"""
    try:
        r = requests.get(f'{DERIBIT}/get_volatility_index_data',
            params={'currency': coin, 'start_timestamp': int((time.time()-3600)*1000),
                    'end_timestamp': int(time.time()*1000), 'resolution': '60'},
            timeout=10)
        data = r.json().get('result', {}).get('data', [])
        if data:
            return float(data[-1][4])  # close
        return 0
    except:
        return 0

def find_atm_options(instruments, spot_price, coin):
    """Find at-the-money options expiring in 1-7 days"""
    now = time.time()
    candidates = []

    for inst in instruments:
        name = inst['instrument_name']
        parts = name.split('-')
        if len(parts) != 4:
            continue

        # Parse: BTC-27JUN26-65000-C
        try:
            strike = float(parts[2])
            option_type = parts[3]  # C or P
            expiry_ts = inst['expiration_timestamp'] / 1000
            days_to_expiry = (expiry_ts - now) / 86400

            # Only look at options expiring in 1-7 days
            if not (1 <= days_to_expiry <= 7):
                continue

            # Only look at strikes within 5% of spot
            pct_from_spot = abs(strike - spot_price) / spot_price * 100
            if pct_from_spot > 5:
                continue

            candidates.append({
                'name':     name,
                'strike':   strike,
                'type':     option_type,
                'days':     round(days_to_expiry, 1),
                'pct_otm':  round(pct_from_spot, 2),
            })
        except:
            continue

    return candidates

def score_option(ticker, option_type, spot, strike, dvol):
    """
    Score an options signal based on:
    - IV rank (high IV = better for selling, low IV = better for buying)
    - Delta (closer to 0.5 = more ATM)
    - Bid/ask spread (tighter = more liquid)
    - Direction alignment
    """
    score = 0
    reasons = []

    if not ticker:
        return 0, []

    # Get greeks
    greeks = ticker.get('greeks', {})
    delta  = abs(float(greeks.get('delta', 0)))
    iv     = float(ticker.get('mark_iv', 0))
    bid    = float(ticker.get('best_bid_price', 0))
    ask    = float(ticker.get('best_ask_price', 0))
    volume = float(ticker.get('stats', {}).get('volume', 0))

    # Delta score — closer to 0.4-0.6 = more ATM = higher probability
    if 0.35 <= delta <= 0.65:
        score += 25
        reasons.append(f'Delta {delta:.2f} ATM zone')
    elif 0.25 <= delta <= 0.75:
        score += 15
        reasons.append(f'Delta {delta:.2f}')

    # IV score — compare to DVOL
    if dvol > 0 and iv > 0:
        iv_rank = iv / dvol
        if iv_rank < 0.8:
            score += 20
            reasons.append(f'IV {iv:.0f}% below DVOL — cheap premium')
        elif iv_rank > 1.2:
            score += 10
            reasons.append(f'IV {iv:.0f}% elevated')

    # Liquidity — tight spread
    if bid > 0 and ask > 0:
        spread_pct = (ask - bid) / ask * 100
        if spread_pct < 5:
            score += 20
            reasons.append('Tight spread — liquid')
        elif spread_pct < 15:
            score += 10

    # Volume
    if volume > 10:
        score += 15
        reasons.append(f'Volume {volume:.0f} contracts')
    elif volume > 2:
        score += 8

    # Direction bonus
    if option_type == 'C' and spot > strike:
        score += 10
        reasons.append('ITM call — intrinsic value')
    elif option_type == 'P' and spot < strike:
        score += 10
        reasons.append('ITM put — intrinsic value')

    return score, reasons

def fmt_signal(coin, option_type, instrument, strike, spot, days,
               score, reasons, ticker):
    direction = 'CALL 📈' if option_type == 'C' else 'PUT 📉'
    mark = float(ticker.get('mark_price', 0))
    iv   = float(ticker.get('mark_iv', 0))
    delta = abs(float(ticker.get('greeks', {}).get('delta', 0)))
    otm_pct = abs(strike - spot) / spot * 100
    itm = (option_type == 'C' and spot > strike) or (option_type == 'P' and spot < strike)
    moneyness = 'ITM' if itm else 'OTM'

    top_reasons = ' · '.join(reasons[:3])

    return (
        f"🎯 <b>TK EMPIRE OPTIONS SIGNAL</b>\n\n"
        f"{'🟢' if option_type == 'C' else '🔴'} <b>{direction} — {coin}</b>\n\n"
        f"📍 <b>Spot Price:</b>  ${spot:,.2f}\n"
        f"🎯 <b>Strike:</b>      ${strike:,.0f} ({moneyness})\n"
        f"📅 <b>Expiry:</b>      {days} days\n"
        f"📊 <b>Mark Price:</b>  ${mark:.4f}\n"
        f"📈 <b>IV:</b>          {iv:.1f}%\n"
        f"⚖️ <b>Delta:</b>       {delta:.2f}\n"
        f"🔥 <b>Confidence:</b>  {score}/100\n"
        f"🔍 <b>Edge:</b>        {top_reasons}\n\n"
        f"📋 <b>Instrument:</b> {instrument}\n\n"
        f"⚠️ Options carry significant risk. Paper trade first.\n"
        f"👑 <b>TK Empire — Built for Legacy</b>"
    )

def scan():
    print(f"\n🔍 Options scan {time.strftime('%H:%M:%S')}")
    signals_fired = []

    for coin in ['BTC', 'ETH']:
        spot = get_price(coin)
        if spot <= 0:
            print(f"  {coin}: price error")
            continue

        dvol = get_dvol(coin)
        instruments = get_instruments(coin)
        candidates = find_atm_options(instruments, spot, coin)

        print(f"  {coin} @ ${spot:,.2f} | DVOL: {dvol:.0f}% | Candidates: {len(candidates)}")

        # Score each candidate
        scored = []
        for c in candidates:
            ticker = get_ticker(c['name'])
            if not ticker:
                continue
            score, reasons = score_option(ticker, c['type'], spot,
                                         c['strike'], dvol)
            if score >= 40:
                scored.append({**c, 'score': score, 'reasons': reasons,
                               'ticker': ticker, 'spot': spot, 'coin': coin})

        # Sort by score — fire top 2 per coin
        scored.sort(key=lambda x: x['score'], reverse=True)

        for s in scored[:2]:
            print(f"    🎯 {s['name']} | Score: {s['score']} | {s['type']}")
            msg = fmt_signal(
                s['coin'], s['type'], s['name'],
                s['strike'], s['spot'], s['days'],
                s['score'], s['reasons'], s['ticker'])
            tg(msg)
            signals_fired.append(s['name'])
            time.sleep(2)

    return len(signals_fired)

def main():
    print('🎯 TK Empire Options Bot — Starting...')
    tg(
        '🎯 <b>TK EMPIRE OPTIONS BOT LIVE</b>\n\n'
        '📊 Scanning BTC + ETH options on Deribit\n'
        '⏱ Scans every 30 minutes\n'
        '🎯 ATM options · 1-7 day expiry\n'
        '📈 CALL/PUT signals with strike + IV\n\n'
        '⚠️ For personal use only. Paper trade first.\n'
        '👑 TK Empire — Built for Legacy'
    )

    last_fired = {}
    COOLDOWN = 7200  # 2 hours per instrument

    while True:
        try:
            # Remove expired cooldowns
            now = time.time()
            last_fired = {k: v for k, v in last_fired.items()
                         if now - v < COOLDOWN}

            scan()
            print(f"  Sleeping 30 minutes...")
            time.sleep(1800)

        except KeyboardInterrupt:
            tg('⚠️ Options bot stopped.')
            break
        except Exception as e:
            print(f'Error: {e}')
            time.sleep(60)

if __name__ == '__main__':
    main()
