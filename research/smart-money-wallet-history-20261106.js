'use strict';
// One-off public wallet history research. No orders, wallet keys, VPS or Genesis mutation.
// Uses the same weekly crypto leaderboard cohort as api/smart-money-signals.js.
const { normalizeWallets } = require('../api/smart-money-core');
const ORIGIN = 'https://data-api.polymarket.com';
const MAX_PAGES = 6; // 6 * 100 max recent CLOSED position rows per wallet.
const PAGE_LIMIT = 100;
const utcNow = new Date();
const windows = [
  ['7d', 7 * 86400], ['30d', 30 * 86400], ['90d', 90 * 86400],
  ['sample', Number.POSITIVE_INFINITY]
];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, params) {
  const url = new URL(path, ORIGIN);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'GET', redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': 'TK-Empire-Wallet-History-Research/1.0' },
      signal: AbortSignal.timeout(18000),
    });
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      const ra = Math.max(1, Number(res.headers.get('Retry-After')) || (attempt + 1) * 2);
      await wait(Math.min(8000, ra * 1000));
      continue;
    }
    if (!res.ok) throw new Error('HTTP_' + res.status + ' path=' + path);
    const raw = await res.text();
    if (raw.length > 3000000) throw new Error('response_too_large');
    const doc = JSON.parse(raw);
    if (!doc || !Array.isArray(doc.data)) throw new Error('invalid_data_array');
    return doc;
  }
  throw new Error('request_exhausted');
}
function metric(rows, sinceSeconds = Number.NEGATIVE_INFINITY) {
  const sample = rows.filter(r => {
    const ts = Number(r.last_event_at);
    return Number.isFinite(ts) && ts >= sinceSeconds;
  });
  const good = sample.filter(r => typeof r.realized_pnl === 'number' && Number.isFinite(r.realized_pnl));
  const wins = good.filter(r => r.realized_pnl > 0).length;
  const losses = good.filter(r => r.realized_pnl < 0).length;
  const breakeven = good.length - wins - losses;
  const pnl = good.reduce((s,r) => s + r.realized_pnl,0);
  const winGross = good.reduce((s,r) => s + Math.max(0,r.realized_pnl),0);
  const lossGross = good.reduce((s,r) => s + Math.max(0,-r.realized_pnl),0);
  return {
    closed_positions: sample.length, evaluated: good.length, wins, losses, breakeven,
    missing_pnl: sample.length - good.length,
    win_rate_pct: wins + losses > 0 ? +(100*wins/(wins+losses)).toFixed(2) : null,
    realized_pnl_usdc: +pnl.toFixed(2),
    profit_factor: lossGross > 0 ? +(winGross/lossGross).toFixed(2) : (wins > 0 ? 'infinite' : null),
    average_win_usdc: wins ? +(winGross/wins).toFixed(2):null,
    average_loss_usdc: losses ? +(-lossGross/losses).toFixed(2):null,
  };
}
async function historyFor(w) {
  const seen = new Set(), rows = [];
  let cursor=null, pages=0, complete=false;
  for (let i=0; i<MAX_PAGES; i++) {
    const doc = await request('/v2/positions',{
      user:w.wallet,status:'CLOSED',sort_by:'TIMESTAMP',
      sort_direction:'DESC',limit:PAGE_LIMIT,cursor,
    });
    for (const r of doc.data) {
      const id=String(r.condition_id||'')+'|'+String(r.token_id||'')+'|'+String(r.outcome_index??'');
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(r);
    }
    pages++;
    const p=doc.pagination||{};
    cursor=p.next_cursor||null;
    if (!cursor || p.has_more===false) {complete=true;break}
    await wait(250);
  }
  const t=Math.floor(utcNow.getTime()/1000);
  const metrics={};
  for (const [key,days] of windows) metrics[key]=metric(rows,key==='sample'?Number.NEGATIVE_INFINITY:t-days);
  return {
    name:w.name,wallet:w.wallet,rank:w.rank,weekly_leaderboard_pnl_usdc:w.window_pnl_usdc,
    pages,history_complete:complete,cap_reached:!complete,unique_closed_rows:rows.length,
    latest_event_ts:rows.length ? Math.max(...rows.map(x=>Number(x.last_event_at)||0)):null,
    oldest_event_ts:rows.length ? Math.min(...rows.map(x=>Number(x.last_event_at)||0)):null,
    metrics,
  };
}
async function main() {
  const lb=await request('/v2/leaderboard',{time_period:'week',category:'crypto',sort_by:'PNL',limit:16});
  const wallets=normalizeWallets(lb.data,8);
  if (!wallets.length) throw new Error('no_qualified_wallets');
  console.log('COHORT_UTC='+utcNow.toISOString()+' WALLETS='+wallets.length);
  const results=[];
  for (const wallet of wallets) {
    try {
      const r=await historyFor(wallet);
      console.log('WALLET_HISTORY '+JSON.stringify(r));
      results.push(r);
    } catch(error) {
      console.log('WALLET_HISTORY_ERROR '+JSON.stringify({wallet:wallet.wallet,name:wallet.name,error:String(error.message||error)}));
    }
  }
  for (const w of ['7d','30d','90d','sample']) {
    const reliable=results.filter(r=>r.metrics[w].wins+r.metrics[w].losses>0);
    const wins=reliable.reduce((s,r)=>s+r.metrics[w].wins,0);
    const losses=reliable.reduce((s,r)=>s+r.metrics[w].losses,0);
    const totalPnl=reliable.reduce((s,r)=>s+r.metrics[w].realized_pnl_usdc,0);
    console.log('HISTORY_SUMMARY '+JSON.stringify({
      window:w, wallets_covered:results.length, wallets_with_nonzero_outcomes:reliable.length,
      closed_positions_wins:wins,closed_positions_losses:losses,
      weighted_win_rate_pct:wins+losses ? +(100*wins/(wins+losses)).toFixed(2):null,
      realized_pnl_usdc:+totalPnl.toFixed(2),
      capped_wallets:results.filter(r=>!r.history_complete).length,
      cohort:'current_weekly_crypto_pnl_leaderboard',
      note:'Observed closed-position PnL; not resolved-market accuracy or copy-trading profitability'
    }));
  }
  console.log('RESULT='+ (results.length===wallets.length?'HISTORY_RETRIEVED':'PARTIAL') );
  if (!results.length)process.exitCode=2;
}
main().catch(err => { console.error('RESULT=ERROR '+String(err.message||err));process.exitCode=1; });
