// Decides whether an opportunity may be bet on, places it on Betika and records the result.
import { beforeTax, minAcceptableOdds } from '../oddsMath.js';
import { dedupeKey, matchup, selection } from '../scanner.js';
import { betikaPick } from './odds.js';

// Statuses that may have taken money: these count toward the daily limits.
const LIVE_STATUSES = new Set(['placed', 'unknown']);

export class BetikaExecutor {
  constructor(settings, client, store, { log = console, notify = async () => {} } = {}) {
    Object.assign(this, { s: settings, client, store, log, notify });
    this.halted = false;         // only for a stake mismatch: scanning continues, betting stops
    this.consecutiveErrors = 0;
    this.pausedUntil = 0;        // after repeated errors, betting pauses briefly, then resumes
  }

  get pauseMs() { return (this.s.betikaErrorPauseMinutes ?? 15) * 60_000; }

  /** Returns a reason string if the bet must be skipped, else null. */
  check(opp, stake) {
    if (this.halted) return 'halted';
    if (Date.now() < this.pausedUntil) return 'paused_after_errors';
    if (opp.book !== 'betika') return 'not_betika';
    if (!opp.betikaRef || !betikaPick(opp)) return 'unsupported_market';
    if (this.store.hasBet(dedupeKey(opp))) return 'already_bet';
    if (stake < this.s.betikaMinStake) return 'stake_too_small';
    const today = this.store.liveBetsToday(LIVE_STATUSES);
    if (today.length >= this.s.betikaMaxBetsPerDay) return 'daily_bet_limit';
    if (today.reduce((a, b) => a + b.stake, 0) + stake > this.s.betikaDailyStakeLimit) return 'daily_stake_limit';
    return null;
  }

  async execute(opp) {
    // BETIKA_FIXED_STAKE: same stake on every bet (ignores the Kelly size and BETIKA_MAX_STAKE).
    const stake = this.s.betikaFixedStake > 0
      ? Math.floor(this.s.betikaFixedStake)
      : Math.floor(Math.min(opp.stake, this.s.betikaMaxStake));
    const skip = this.check(opp, stake);
    if (skip) {
      if (!['not_betika', 'already_bet'].includes(skip)) this.log.info?.(`betika: skip ${selection(opp)} (${skip})`);
      return { status: 'skipped', reason: skip };
    }
    // Lowest after-tax price that still clears MIN_EV, and the posted price that gives it.
    const minEffective = minAcceptableOdds(opp.fairProb, this.s.minEv);
    const minOdds = Math.max(beforeTax(minEffective, opp.winningsTax ?? 0), this.s.minDecimalOdds);
    const round3 = (x) => Math.ceil(x * 1000) / 1000;
    const bet = {
      parentMatchId: opp.betikaRef.parentMatchId, ...betikaPick(opp),
      minOdds: round3(minOdds), minEffectiveOdds: round3(minEffective),
      stake, live: this.s.betikaLive,
    };

    let result;
    try {
      result = await this.client.placeBet(bet);
      this.consecutiveErrors = 0;
    } catch (e) {
      result = { status: 'error', message: e.message };
      // A crashed or stuck browser is the usual cause: start a fresh one for the next bet.
      await this.client.close?.().catch(() => {});
      if (++this.consecutiveErrors >= 3) {
        this.consecutiveErrors = 0;
        this.pausedUntil = Date.now() + this.pauseMs;
        const mins = Math.round(this.pauseMs / 60_000);
        this.log.warn?.(`betika: 3 errors in a row - pausing bets for ${mins} min, then resuming`);
        this.notify(`Betika bot: 3 errors in a row, betting paused ${mins} min (last: ${e.message})`).catch(() => {});
      }
    }

    this.store.recordBet({
      key: dedupeKey(opp), at: new Date().toISOString(), matchup: matchup(opp),
      selection: selection(opp), stake, minOdds: bet.minOdds, expectedOdds: opp.decimal,
      fairProb: opp.fairProb, ev: opp.ev, live: bet.live, ...result,
    });

    const ticket = result.betId ? ` ticket ${result.betId}` : '';
    const bal = result.balanceAfter != null ? ` | balance KES ${result.balanceAfter}` : '';
    const msg = `Betika ${result.status.toUpperCase()}${ticket}: ${selection(opp)} (${matchup(opp)}) `
      + `stake KES ${stake} @ ${result.odds ?? '?'} (min ${bet.minOdds})${bal}${result.message && result.status !== 'placed' ? ` - ${result.message}` : ''}`;
    this.log.info?.(msg);
    // Phone/Discord alerts only for outcomes that matter; price moves etc. retry quietly next scan.
    if (['placed', 'unknown', 'rejected', 'error', 'not_logged_in', 'insufficient_balance'].includes(result.status)) {
      await this.notify(msg);
    }
    // An unconfirmed click may have placed the bet. It's recorded as possibly placed, so this
    // match is never bet again and it counts toward the daily limits; other matches continue.
    if (result.status === 'unknown') {
      this.log.warn?.(`betika: no confirmation for ${selection(opp)} - treating it as possibly placed, check your bet history`);
      await this.notify(`Betika: check your bet history - no confirmation seen for ${selection(opp)} (${matchup(opp)}), KES ${stake}`).catch(() => {});
    }
    if (result.stakeMismatch) this.halt(`Betika confirmed stake KES ${result.confirmedStake}, expected ${stake} - check ticket ${result.betId}`);
    return result;
  }

  halt(reason) {
    this.halted = true;
    this.log.error?.(`betika: HALTED - ${reason}`);
    this.notify(`Betika bot halted: ${reason}`).catch(() => {});
  }
}
