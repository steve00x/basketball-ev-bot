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
6. After clicking, it waits for Betika's bet API reply. If no clear reply comes, the status is `unknown` and **the bot stops**,
   because the bet may have gone through. It also stops after 3 errors in a row.

Every attempt is logged to `ev-bot-store.json`.

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
