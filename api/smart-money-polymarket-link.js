'use strict';

/* Navigate from a public Smart Money market condition to its verified
 * Polymarket event. No orders, wallet connections, or credentials. */
const GAMMA = 'https://gamma-api.polymarket.com/markets';
const HEX_CONDITION = /^0x[0-9a-f]{64}$/i;
const SAFE_EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BYTES = 750000;

function fallback(res, status, message) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polymarket market unavailable | TK Empire</title>'
    + '<style>body{font:16px/1.6 system-ui;background:#0b1220;color:#edf3ff;max-width:580px;padding:45px 20px;margin:auto}a{color:#a9dcff}h1{font-size:24px}</style>'
    + '<h1>Polymarket market link unavailable</h1><p>'+message+'</p><p>No alternate market has been substituted.</p>'
    + '<p><a href="https://polymarket.com">Visit Polymarket</a> · <a href="/smart-money-flow.html">Back to Smart Money flow</a></p></html>';
  return res.status(status).send(html);
}
async function readMarkets(condition, fetcher = fetch) {
  const endpoint = GAMMA + '?condition_ids=' + encodeURIComponent(condition) + '&limit=5';
  const response = await fetcher(endpoint, {
    method:'GET', redirect:'error',
    headers:{Accept:'application/json'},
    signal:AbortSignal.timeout(8500)
  });
  if (!response.ok) throw new Error('gamma_unavailable');
  const declared=Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('gamma_oversize');
  const body=await response.text();
  if (Buffer.byteLength(body,'utf8') > MAX_BYTES) throw new Error('gamma_oversize');
  const markets=JSON.parse(body);
  if (!Array.isArray(markets)) throw new Error('gamma_bad_schema');
  return markets;
}
function exactEventSlug(markets, condition) {
  if (!Array.isArray(markets)) return null;
  const exact=markets.find(m => m && typeof m==='object' && m.conditionId?.toLowerCase() === condition.toLowerCase());
  if (!exact || !Array.isArray(exact.events)) return null;
  const event=exact.events.find(e=>e && typeof e.slug === 'string' && e.slug.length <= 160 && SAFE_EVENT_SLUG.test(e.slug));
  return event ? event.slug : null;
}
module.exports = async function handler(req,res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow','GET');
    return fallback(res,405,'Only GET requests are supported.');
  }
  const condition=req.query?.condition;
  if (typeof condition !== 'string' || !HEX_CONDITION.test(condition)) {
    return fallback(res,400,'This market has no valid public condition identifier.');
  }
  try {
    const markets=await readMarkets(condition.toLowerCase());
    const slug=exactEventSlug(markets,condition);
    if (!slug) return fallback(res,404,'An exact Polymarket market/event match could not be verified. It may be archived or unavailable.');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Location','https://polymarket.com/event/'+slug);
    return res.status(302).end();
  } catch {
    return fallback(res,503,'The Polymarket market directory is unavailable right now. Please retry from the Flow Map.');
  }
};
module.exports._test={readMarkets, exactEventSlug};
