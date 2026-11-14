'use strict';

// Imperian performance-linked pricing — pure staging calculator.
// No wallet custody, billing, network, trading, database or file writes.
const LADDER = Object.freeze([
  Object.freeze({ minimum_win_rate: 0, rate_usdc: 30 }),
  Object.freeze({ minimum_win_rate: 55, rate_usdc: 49 }),
  Object.freeze({ minimum_win_rate: 60, rate_usdc: 99 }),
  Object.freeze({ minimum_win_rate: 65, rate_usdc: 199 }),
  Object.freeze({ minimum_win_rate: 70, rate_usdc: 300 }),
]);
const SOURCE = 'GENESIS_PRICING_RECONCILIATION_V1';
const DAY_MS = 86400000;
const HASH = /^[0-9a-f]{64}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const RATELIST = new Set(LADDER.map(x => x.rate_usdc));

function isRecord(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}
function validCount(x) {
  return Number.isSafeInteger(x) && x >= 0 && x <= 1000000;
}
function validRate(x) {
  return RATELIST.has(x);
}
function parseTime(x) {
  if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(x)) {
    return null;
  }
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}
function rateForWinRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new RangeError('WIN_RATE_OUT_OF_RANGE');
  }
  let result = LADDER[0].rate_usdc;
  for (const rung of LADDER) {
    if (rate >= rung.minimum_win_rate) result = rung.rate_usdc;
  }
  return result;
}

function defaultState() {
  return {
    schema_version: 1,
    current_public_rate_usdc: 30,
    last_window_end: null,
    last_reconciliation_sha256: null,
    pending_increase: null
  };
}
function validState(x) {
  if (!isRecord(x) || x.schema_version !== 1 || !validRate(x.current_public_rate_usdc) ||
      !(x.last_window_end === null || parseTime(x.last_window_end) !== null) ||
      !(x.last_reconciliation_sha256 === null || (typeof x.last_reconciliation_sha256 === 'string' &&
        HASH.test(x.last_reconciliation_sha256)))) return false;
  const p = x.pending_increase;
  return p === null || (isRecord(p) && validRate(p.target_rate_usdc) &&
    p.target_rate_usdc > x.current_public_rate_usdc &&
    p.observations === 1 && parseTime(p.last_window_end) !== null);
}

/**
 * The caller MUST authenticate a separately approved reconciliation publisher.
 * A digest in a payload is a correlation marker, NOT cryptographic authentication.
 * This checker rejects public aggregate / unverified paper PnL as billing evidence.
 * Timing, minimum sample, and risk thresholds are STAGED DEFAULTS pending release approval.
 */
function inspectEvidence(evidence, now = new Date().toISOString()) {
  const nowMs = parseTime(now);
  if (nowMs === null) return { ok: false, code: 'INVALID_CLOCK' };
  if (!isRecord(evidence) || evidence.schema_version !== 1 ||
      evidence.source !== SOURCE ||
      evidence.reconciliation_status !== 'INDEPENDENTLY_VERIFIED' ||
      evidence.execution_mode !== 'PAPER' ||
      evidence.pnl_unit !== 'USD_VERIFIED' ||
      evidence.fees_accounted !== true ||
      typeof evidence.reconciliation_sha256 !== 'string' ||
      !HASH.test(evidence.reconciliation_sha256)) {
    return { ok: false, code: 'UNVERIFIED_EVIDENCE' };
  }
  const start = parseTime(evidence.window_start);
  const end = parseTime(evidence.window_end);
  const created = parseTime(evidence.generated_at);
  if (start === null || end === null || created === null ||
      end <= start || end - start < 28 * DAY_MS || end - start > 31 * DAY_MS ||
      created < end || created - end > 2 * DAY_MS ||
      created > nowMs + 30000 || nowMs - created > 2 * DAY_MS ||
      end > nowMs + 30000) {
    return { ok: false, code: 'STALE_OR_INVALID_WINDOW' };
  }
  const { wins, losses, breakevens, closed_trades } = evidence;
  if (![wins, losses, breakevens, closed_trades].every(validCount) ||
      wins + losses + breakevens !== closed_trades || wins + losses < 100) {
    return { ok: false, code: 'INSUFFICIENT_OR_INCONSISTENT_SAMPLE' };
  }
  if (typeof evidence.net_pnl_usd !== 'number' ||
      !Number.isFinite(evidence.net_pnl_usd) ||
      Math.abs(evidence.net_pnl_usd) > 1e9 ||
      !['PASS', 'BLOCK'].includes(evidence.risk_review)) {
    return { ok: false, code: 'ACCOUNTING_OR_RISK_UNVERIFIED' };
  }
  const winRate = (100 * wins) / (wins + losses);
  return {
    ok: true,
    win_rate_pct: Number(winRate.toFixed(6)),
    rate_usdc: rateForWinRate(winRate),
    net_pnl_usd: evidence.net_pnl_usd,
    upward_qualified: evidence.net_pnl_usd > 0 && evidence.risk_review === 'PASS',
    window_end: evidence.window_end,
    reconciliation_sha256: evidence.reconciliation_sha256
  };
}

/**
 * Produces a proposed public price change and next state; NEVER charges members.
 * Downward: one verified review. Upward: two distinct reviews ~7 days apart,
 * with independently verified positive net PnL and approved risk on both.
 * No valid evidence => current published rate and state are unchanged.
 */
function assessPricing(evidence, state = defaultState(), now = new Date().toISOString()) {
  if (!validState(state)) throw new TypeError('INVALID_DURABLE_STATE');
  const report = inspectEvidence(evidence, now);
  if (!report.ok) {
    return { status: 'HOLD', reason: report.code,
      current_public_rate_usdc: state.current_public_rate_usdc,
      next_state: structuredClone(state) };
  }
  if ((state.last_window_end !== null &&
        parseTime(report.window_end) <= parseTime(state.last_window_end)) ||
      report.reconciliation_sha256 === state.last_reconciliation_sha256) {
    return { status: 'HOLD', reason: 'REPLAY_OR_NONADVANCING_EVIDENCE',
      current_public_rate_usdc: state.current_public_rate_usdc,
      next_state: structuredClone(state) };
  }
  const next = {
    schema_version: 1,
    current_public_rate_usdc: state.current_public_rate_usdc,
    last_window_end: report.window_end,
    last_reconciliation_sha256: report.reconciliation_sha256,
    pending_increase: null
  };
  const candidate = report.rate_usdc;
  const base = { win_rate_pct: report.win_rate_pct,
    candidate_public_rate_usdc: candidate,
    evidence_sha256: report.reconciliation_sha256,
    period_end: report.window_end };
  if (candidate < state.current_public_rate_usdc) {
    next.current_public_rate_usdc = candidate;
    return { status: 'LOWER_PROPOSED', reason: 'VERIFIED_WIN_RATE_DECLINE',
      ...base, current_public_rate_usdc: candidate, next_state: next };
  }
  if (candidate === state.current_public_rate_usdc) {
    return { status: 'UNCHANGED', reason: 'SAME_PRICE_BAND',
      ...base, current_public_rate_usdc: candidate, next_state: next };
  }
  if (!report.upward_qualified) {
    return { status: 'HOLD', reason: 'UNPROFITABLE_OR_RISK_NOT_APPROVED',
      ...base, current_public_rate_usdc: state.current_public_rate_usdc, next_state: next };
  }
  const pending = state.pending_increase;
  const gap = pending === null ? null :
    parseTime(report.window_end) - parseTime(pending.last_window_end);
  if (pending !== null && pending.target_rate_usdc === candidate &&
      gap >= 6 * DAY_MS && gap <= 9 * DAY_MS) {
    next.current_public_rate_usdc = candidate;
    return { status: 'RAISE_PROPOSED', reason: 'TWO_VERIFIED_WEEKLY_REVIEWS',
      ...base, current_public_rate_usdc: candidate, next_state: next };
  }
  next.pending_increase = {
    target_rate_usdc: candidate, observations: 1, last_window_end: report.window_end
  };
  return { status: 'HOLD', reason: 'AWAITING_SECOND_VERIFIED_REVIEW',
    ...base, current_public_rate_usdc: state.current_public_rate_usdc, next_state: next };
}

/**
 * Server-side pricing quote; membership/wallet ownership and stored member record
 * authentication are responsibilities of a future protected membership service.
 */
function quoteRenewal(member, publishedState) {
  if (!validState(publishedState) || !isRecord(member) ||
      typeof member.wallet_address !== 'string' || !WALLET.test(member.wallet_address) ||
      member.status !== 'ACTIVE' || !validRate(member.locked_max_rate_usdc)) {
    return { status: 'NOT_ELIGIBLE', reason: 'INVALID_OR_INACTIVE_MEMBERSHIP' };
  }
  return { status: 'QUOTE_ONLY',
    wallet_address: member.wallet_address.toLowerCase(),
    locked_max_rate_usdc: member.locked_max_rate_usdc,
    published_rate_usdc: publishedState.current_public_rate_usdc,
    next_renewal_usdc: Math.min(member.locked_max_rate_usdc,
      publishedState.current_public_rate_usdc)
  };
}

module.exports = { LADDER, SOURCE, rateForWinRate, defaultState, inspectEvidence,
  assessPricing, quoteRenewal };
