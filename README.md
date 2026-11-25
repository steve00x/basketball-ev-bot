# Basketball +EV Bot (Pinnacle → Betika)

A Node.js bot that:

1. pulls **Pinnacle** basketball odds (moneyline and totals) from [The Odds API](https://the-odds-api.com),
2. removes Pinnacle's margin to get the **fair** win probability,
3. reads **Betika's** odds from its public API: *Winner (incl. OT)* and *Total (incl. OT)*, every line,
4. counts Kenya's **20% tax on winnings**, then flags Betika prices that still beat fair by at least `MIN_EV`,
5. **places the bet with Puppeteer** on Betika's match page, re-checking odds, stake and payout first, within daily limits.

```
+5.06% EV | NBA | Boston Celtics @ Los Angeles Lakers (Mon, 23 Nov 2026 17:37 UTC)
  Moneyline: Los Angeles Lakers @ Betika 2.62 (2.296 after 20% tax)
  Fair 2.19 (win 45.8%) via pinnacle | Stake 195.27
INFO  Betika DRY_RUN: Los Angeles Lakers (...) stake KES 195 @ 2.62 (min 2.537)
```

## What has been checked on the live site (23 Nov 2026)

| Part | Status |
|---|---|
| Betika odds API (`api.betika.com/v1/uo/matches`, basketball = sport 30, markets 219/225) | ✅ verified, real responses in `test/fixtures/` |
| Match page `/en-ke/m/{parent_match_id}`, market and outcome buttons | ✅ verified |
| Bet slip: one selection, market check, stake box, Place Bet `amount`/`totalodds`, Final Payout | ✅ verified (`npm run check` passed) |
| "Remove All" asks a native *"Are you sure you want to clear the betslip?"*, which the bot accepts (any other popup is dismissed) | ✅ verified (it used to freeze the page) |
| Login form fields and logged-out detection | ✅ verified (form fields; a real login wasn't attempted) |
| What Betika's **bet API returns** after *Place Bet* | ⚠️ not seen yet: needs a logged-in bet (see "First live bet") |
| Balance selector | ⚠️ unverified: the bot skips the balance check if it can't read it |

## Read this first

- **The tax decides everything.** 20% of net winnings is withheld, so 2.32 really pays 2.056. Betika's margin
  plus this tax means real edges against Pinnacle are **rare**, so expect few bets. Betika's own "Final Payout"
  is checked before every bet, so a higher real tax is caught.
- **It starts in dry-run mode.** `BETIKA_LIVE=false` fills the slip but never clicks *Place Bet*.
- **Automated betting almost certainly breaks Betika's terms**, and books limit or close winning accounts.
  Keep a small balance. 18+ only, and bet only what you can afford to lose.

## Setup (on your own computer)

```bash
npm install                     # also downloads Puppeteer's Chrome
cp .env.example .env            # add ODDS_API_KEY, BETIKA_PHONE, BETIKA_PASSWORD
npm test                        # 33 tests, incl. a real browser against a mock page
npm run demo                    # whole pipeline on sample data, no key and no browser
node bin/ev-bot.js odds         # live Betika basketball odds
node bin/ev-bot.js check        # live self-test: fills a real slip, never places it
node bin/ev-bot.js login        # visible browser: log in once, solve any OTP; the session is saved
node bin/ev-bot.js scan --once  # one real scan, dry run
node bin/ev-bot.js scan         # keep scanning every POLL_SECONDS
```

### First live bet

1. Run `node bin/ev-bot.js discover`, log in in the window that opens, and **place one small bet by hand**
   (KES 10). Then close the window. `discover/` now holds Betika's API traffic, with tokens and passwords redacted.
2. Find the `POST` file for the bet and check its URL matches `betApi` in `src/betika/selectors.json`, and that its
   response reads as success (`classifyBetResponse` in `src/betika/client.js`). Send it to me if unsure.
3. Then set `BETIKA_LIVE=true` with `BETIKA_MAX_STAKE=50`, and watch the first few bets in your Betika history.

## Safety checks on every bet

1. Not already bet, stake within KES `BETIKA_MIN_STAKE`–`BETIKA_MAX_STAKE`, under the daily count and stake limits.
2. It opens the match page and re-reads the price. If it's below the lowest price that still clears `MIN_EV`
   after tax, it stops (`price_moved`).
3. The slip must hold exactly one selection, in the right market, at an acceptable price.
4. The stake box and the Place Bet button's `amount` must equal the stake exactly, and `totalodds` must still clear the floor.
5. Final Payout ÷ stake (Betika's own after-tax figure) must clear the floor (`payout_too_low`).
6. After clicking, it waits for Betika's bet API reply. With no clear reply the bet is logged as
   `unknown`: that match is treated as possibly placed (never retried, counts toward the daily limits),
   you get an alert to check your bet history, and the bot carries on with other matches.
7. A failed bet never stops the others. After an error the browser is restarted (and logged back in if
   needed). After 3 errors in a row, betting pauses `BETIKA_ERROR_PAUSE_MINUTES` (15) and then resumes.
   Only a stake mismatch (Betika confirming a different stake) stops betting; scanning continues.

Every attempt is logged to `ev-bot-store.json`.

## Sports

Every Betika market below was checked on the live site. It's compared only with a Pinnacle
line that settles the same way.

| Sport | Betika market used | Notes |
|---|---|---|
| Basketball | Winner (incl. OT), Total (incl. OT) incl. alternate lines | NBA, NCAAB, EuroLeague. Alternate total lines are priced from Pinnacle's main line with the spread measured from Betika's own ladder (`ALT_TOTALS`, stricter `ALT_TOTALS_MIN_EV`). Team totals are priced from Pinnacle's total + spread (`TEAM_TOTALS`, +1 credit per league). Betika has no basketball handicap market |
| Soccer | 1X2 (with draw), Total | both are 90 minutes, like Pinnacle. `soccer` = top 8 leagues, `soccer_small` = ~40 lower/mid leagues (League One/Two, 2. Bundesliga, Serie B, Eredivisie, Scotland, Scandinavia, MLS, J-League, ...), `soccer_all` = everything in season. `MARKETS_SOCCER=h2h` halves the cost |
| Ice hockey | Winner (incl. overtime and penalties) | Betika's hockey 1X2/Total are regulation-only, so not used |
| Tennis, table tennis, volleyball, boxing | Winner | |
| Cricket | Winner (incl. super over) | limited overs; Test matches (with draw) never pair |
| Handball, rugby | 1X2 (with draw) | pairs only with a 3-way Pinnacle line |
| Soccer, handball, rugby (extra) | Double Chance, Draw No Bet | priced from Pinnacle's 3-way 1X2, no extra credits; Draw No Bet EV counts the refund on a draw |
| Baseball | (none comparable) | Betika has only a 9-inning 1X2 with draw; Pinnacle's moneyline includes extra innings |

A Betika line is only compared with a Pinnacle line that has exactly the same outcomes, so a
3-way market can never be compared with a 2-way one. Women's, youth and reserve teams
("(W)", "U21", "Jong", " B") never match first teams.

**The Odds API decides what's possible.** It covers far fewer events than Betika (no Challengers,
UTR, KHL, Indian domestic cricket, and maybe no handball, volleyball or table tennis at all). Run:

```bash
node bin/ev-bot.js sports
```

It lists, per sport, the leagues The Odds API has in season, how many Betika matches exist, and the
credits per scan. Sports it doesn't cover are reported and skipped.

## Key settings (`.env`)

`MIN_EV` (after tax) · `BETIKA_WINNINGS_TAX` (0.20) · `BANKROLL` (KES) · `KELLY_FRACTION` · `BETIKA_MAX_STAKE` ·
`BETIKA_DAILY_STAKE_LIMIT` · `BETIKA_MAX_BETS_PER_DAY` · `SPORTS` (`basketball_nba`, `basketball_ncaab`,
`basketball_wnba`, `basketball_euroleague`) · `MARKETS` (`h2h,totals`). Every scan costs 1 Odds API credit
per sport per market. NBA h2h+totals every 5 minutes is about 580 credits a day, so you need a paid plan.

## Layout

```
bin/ev-bot.js            CLI (scan, check, odds, login, balance, discover)
src/oddsMath.js          conversions, de-vig, EV, Kelly, tax
src/oddsApi.js           The Odds API client
src/scanner.js           line matching and after-tax EV detection
src/teamMatch.js         Betika ↔ Odds API team names
src/betika/api.js        Betika odds API (verified)
src/betika/odds.js       match Betika games to sharp events (competition, ±90 min, names)
src/betika/client.js     Puppeteer: login, place bet, discover
src/betika/executor.js   limits, price floors, bet log, halting
src/betika/selectors.json  match page / slip / login selectors (verified)
```

## Deriv trading bot (`deriv-bot`)

A separate bot in this repo that trades **Rise/Fall** contracts on [Deriv](https://deriv.com) through Deriv's
official **WebSocket API** (`wss://ws.derivws.com/websockets/v3`). It needs no extra packages: Node 22's
built-in WebSocket is enough.

```
node bin/deriv-bot.js symbols     # markets open now
node bin/deriv-bot.js backtest    # replay the strategy on the last 5000 ticks with Deriv's real payout
node bin/deriv-bot.js run         # trade (paper by default); Ctrl+C stops it
node bin/deriv-bot.js report      # win rate vs break-even win rate, profit, ROI
node bin/deriv-bot.js balance     # needs DERIV_API_TOKEN
```

How it works: it loads 300 recent ticks, subscribes to new ones, and asks the strategy (`ema-cross`: a 5/20 EMA
crossover filtered by RSI, or `momentum`: follow N ticks in a row) for a signal. On a signal it checks the risk
limits, gets a real Deriv quote (`proposal`), refuses quotes paying under `DERIV_MIN_PAYOUT_RATIO`, then:

- **paper** (`DERIV_LIVE=false`, the default) settles the trade on the real ticks that follow, the way Deriv does
  (entry = the next tick, exit = `DERIV_DURATION_TICKS` later, equal prices lose);
- **live** buys at no more than the quoted price (`buy`) and follows the contract (`proposal_open_contract`) until
  Deriv settles it.

Every trade goes to `deriv-trades.jsonl`. The connection is kept alive with pings and comes back after a drop,
and a live contract that was open when it dropped is followed to the end.

**Risk limits** (all in `.env`): fixed stake with no martingale; a daily loss limit, checked *before* each trade
so the next loss can't pass it; a daily trade cap; an optional daily profit target; and a pause after N losses in
a row. Live trading on a real-money account is refused unless `DERIV_ALLOW_REAL=true`.

**Before you go live:**
1. Paper-trade, then run `report`. A win rate at or below the **break-even win rate** (1 / payout ratio,
   about 51-52% at a 1.95x payout) means the strategy loses money.
2. Then go live on a **demo** account: use a token from your virtual (VRTC) account with *Read* and *Trade* scopes.
3. Register your own app id at api.deriv.com instead of the public test id 1089.

**Be realistic.** Deriv's synthetic indices (Volatility 10-100 etc.) are generated by a random number generator.
No indicator predicts the next ticks, and the payout below 2x means every Rise/Fall trade has a small negative
expected value. These limits control *how much* you can lose. They do not create an edge.

**About the API version.** Deriv has launched a newer API (`api.derivws.com`, with OTP-authenticated
WebSockets and new app ids from developers.deriv.com). This bot uses the long-standing v3 protocol, which the
official `@deriv/deriv-api` package also uses. If Deriv retires v3, only `src/deriv/client.js` (connection and
login) should need to change.
