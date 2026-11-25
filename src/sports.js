// Per-sport settings: which Betika market settles the same way as Pinnacle's line.
//
// Betika side checked on the live site (2026-11-23): sport ids, market ids (sub_type_id),
// market titles on the match page and button labels. Comparing the wrong market (e.g.
// a regulation-time 1X2 against an overtime-inclusive moneyline) would make every
// "edge" fake, so only markets with the same settlement are listed here.
//
// Safety net: a Betika line is only compared to a Pinnacle line whose outcomes are
// identical (same names, same points). A 3-way 1X2 (with Draw) can never be
// compared with a 2-way moneyline, so a mismatch on that axis skips itself.

export const SPORTS = {
  basketball: {
    title: 'Basketball', betikaSportId: 30, oddsApiPrefixes: ['basketball_'],
    oddsMarkets: ['h2h', 'totals'],
    h2h: { subType: 219, title: 'Winner (Incl. Overtime)', draw: false },
    totals: { subType: 225, title: 'Total (Incl. Overtime)' },
    // "<TEAM> TOTAL (INCL. OVERTIME)": 227 = Betika's first-listed team, 228 = second. Model-priced.
    teamTotals: { homeSubType: 227, awaySubType: 228, titleSuffix: 'Total (Incl. Overtime)' },
    // 1st half / 1st quarter (no overtime involved): checked on Betika's NBA and NCAA pages 2026-11-25.
    // Pinnacle's prices come from The Odds API period markets (totals_h1, team_totals_h1, ...).
    periods: [
      { key: 'h1', title: '1st Half', totals: 68, teamHome: 69, teamAway: 70 },
      { key: 'q1', title: '1st Quarter', totals: 236, teamHome: 756, teamAway: 757 },
    ],
  },
  soccer: {
    // 90 minutes + stoppage time on both sides; Pinnacle soccer h2h is 3-way.
    title: 'Soccer', betikaSportId: 14, oddsApiPrefixes: ['soccer_'],
    oddsMarkets: ['h2h', 'totals'],
    h2h: { subType: 1, title: '1x2', draw: true },
    totals: { subType: 18, title: 'Total' },
    // Derived from Pinnacle's 1X2 (no extra credits): fair odds come straight from its 3-way prices.
    doubleChance: { subType: 10, title: 'Double Chance' },
    drawNoBet: { subType: 11, title: 'Who Will Win? (If Draw, Money Back)' },
    // Goals markets priced by our model from Pinnacle's 1X2 + total (src/goalModel.js); all 90 minutes.
    // Ids and button labels checked on Betika 2026-11-25. side '1'/'2' = Betika's first/second team.
    props: [
      { subType: 29, kind: 'btts' }, { subType: 19, kind: 'team_total', side: '1' }, { subType: 20, kind: 'team_total', side: '2' },
      { subType: 37, kind: 'res_total' }, { subType: 36, kind: 'total_btts' }, { subType: 35, kind: 'res_btts' },
      { subType: 547, kind: 'dc_total' }, { subType: 546, kind: 'dc_btts' }, { subType: 548, kind: 'multigoals' },
      { subType: 31, kind: 'clean_sheet', side: '1' }, { subType: 32, kind: 'clean_sheet', side: '2' },
      { subType: 33, kind: 'win_to_nil', side: '1' }, { subType: 34, kind: 'win_to_nil', side: '2' },
    ],
  },
  icehockey: {
    // Betika's hockey 1X2 and Total are regulation-only; the NHL moneyline includes OT and
    // shootout, so only "Winner (incl. overtime and penalties)" is comparable. No totals.
    title: 'Ice Hockey', betikaSportId: 29, oddsApiPrefixes: ['icehockey_'],
    oddsMarkets: ['h2h'],
    h2h: { subType: 406, title: 'Winner (Incl. Overtime And Penalties)', draw: false },
  },
  tennis: {
    title: 'Tennis', betikaSportId: 28, oddsApiPrefixes: ['tennis_'],
    oddsMarkets: ['h2h'],
    h2h: { subType: 186, title: 'Winner', draw: false },
  },
  tabletennis: {
    title: 'Table Tennis', betikaSportId: 45, oddsApiPrefixes: ['tabletennis_', 'table_tennis_'],
    oddsMarkets: ['h2h'],
    h2h: { subType: 186, title: 'Winner', draw: false },
  },
  volleyball: {
    title: 'Volleyball', betikaSportId: 35, oddsApiPrefixes: ['volleyball_'],
    oddsMarkets: ['h2h'],
    h2h: { subType: 186, title: 'Winner', draw: false },
  },
  cricket: {
    // Limited-overs only in practice: Test matches have a draw, so they never pair.
    title: 'Cricket', betikaSportId: 37, oddsApiPrefixes: ['cricket_'],
    skipKeys: /test_match/, // 3-way (draw) on Pinnacle vs Betika's 2-way: never pairs, so don't pay for it
    oddsMarkets: ['h2h'],
    h2h: { subType: 340, title: 'Winner (Incl. Super Over)', draw: false },
  },
  boxing: {
    title: 'Boxing', betikaSportId: 39, oddsApiPrefixes: ['boxing_'],
    oddsMarkets: ['h2h'],
    h2h: { subType: 186, title: 'Winner', draw: false },
  },
  handball: {
    title: 'Handball', betikaSportId: 33, oddsApiPrefixes: ['handball_'],
    oddsMarkets: ['h2h'],
    h2h: { subType: 1, title: '1x2', draw: true },
    // Derived from Pinnacle's 1X2 (no extra credits): fair odds come straight from its 3-way prices.
    doubleChance: { subType: 10, title: 'Double Chance' },
    drawNoBet: { subType: 11, title: 'Who Will Win? (If Draw, Money Back)' },
  },
  rugby: {
    // Betika only offers a regulation-time 1X2. Pairs only with 3-way Pinnacle lines.
    // Rugby league moneylines are 2-way, so they never pair with Betika's 1X2: union only.
    title: 'Rugby', betikaSportId: 41, oddsApiPrefixes: ['rugbyunion_'],
    oddsMarkets: ['h2h'],
    h2h: { subType: 1, title: '1x2', draw: true },
    // Derived from Pinnacle's 1X2 (no extra credits): fair odds come straight from its 3-way prices.
    doubleChance: { subType: 10, title: 'Double Chance' },
    drawNoBet: { subType: 11, title: 'Who Will Win? (If Draw, Money Back)' },
  },
  baseball: {
    // Betika baseball only has a 9-inning 1X2 (with draw); Pinnacle's moneyline includes
    // extra innings and has no draw, so lines never pair. Kept so the bot can tell you.
    title: 'Baseball', betikaSportId: 31, oddsApiPrefixes: ['baseball_'],
    oddsMarkets: ['h2h'],
    h2h: { subType: 1, title: '1x2', draw: true },
  },
};

/** Top soccer leagues when SPORTS says "soccer" (each league costs credits). */
export const DEFAULT_SOCCER_LEAGUES = [
  'soccer_epl', 'soccer_efl_champ', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
];

/**
 * Lower and mid-tier leagues for SPORTS=soccer_small. Betika is more likely to lag behind
 * Pinnacle here than in the top leagues. Keys that are out of season (or that The Odds API
 * names differently) are simply not used: only keys it lists as active are scanned.
 */
export const SMALL_SOCCER_LEAGUES = [
  // England / Scotland / Ireland
  'soccer_england_league1', 'soccer_england_league2', 'soccer_england_efl_cup', 'soccer_fa_cup',
  'soccer_spl', 'soccer_league_of_ireland',
  // Second tiers of the big five
  'soccer_germany_bundesliga2', 'soccer_germany_liga3', 'soccer_italy_serie_b',
  'soccer_spain_segunda_division', 'soccer_france_ligue_two',
  // Rest of Europe
  'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga', 'soccer_belgium_first_div',
  'soccer_austria_bundesliga', 'soccer_switzerland_superleague', 'soccer_turkey_super_league',
  'soccer_greece_super_league', 'soccer_denmark_superliga', 'soccer_norway_eliteserien',
  'soccer_sweden_allsvenskan', 'soccer_sweden_superettan', 'soccer_finland_veikkausliiga',
  'soccer_poland_ekstraklasa', 'soccer_uefa_europa_conference_league',
  // Americas / Asia / Oceania
  'soccer_brazil_campeonato', 'soccer_brazil_serie_b', 'soccer_argentina_primera_division',
  'soccer_chile_campeonato', 'soccer_mexico_ligamx', 'soccer_usa_mls',
  'soccer_conmebol_copa_libertadores', 'soccer_conmebol_copa_sudamericana',
  'soccer_japan_j_league', 'soccer_korea_kleague1', 'soccer_china_superleague',
  'soccer_australia_aleague', 'soccer_saudi_arabia_pro_league',
];

/** "soccer_epl" -> "soccer", "tennis_atp_paris" -> "tennis", unknown -> null */
export function sportGroup(oddsApiKey) {
  for (const [group, spec] of Object.entries(SPORTS)) {
    if (spec.oddsApiPrefixes.some((p) => oddsApiKey.startsWith(p))) return group;
  }
  return null;
}

/**
 * Turn SPORTS entries (groups like "soccer", "soccer_small", "tennis", "soccer_all", or exact keys like
 * "soccer_epl") into the active Odds API sport keys. `active` is The Odds API /v4/sports
 * list (free to call). Returns { keys, missing: [groups with nothing active] }.
 */
export function resolveSportKeys(entries, active) {
  const activeKeys = active.filter((x) => x.active !== false && !x.has_outrights).map((x) => x.key);
  const keys = new Set();
  const missing = [];
  for (const raw of entries) {
    const e = raw.trim().toLowerCase();
    if (e === 'soccer' || e === 'soccer_small') {
      const ks = (e === 'soccer' ? DEFAULT_SOCCER_LEAGUES : SMALL_SOCCER_LEAGUES).filter((k) => activeKeys.includes(k));
      ks.forEach((k) => keys.add(k));
      if (!ks.length) missing.push(e);
    } else if (e === 'soccer_all' || SPORTS[e]) {
      const spec = SPORTS[e === 'soccer_all' ? 'soccer' : e];
      const ks = activeKeys.filter((k) => spec.oddsApiPrefixes.some((p) => k.startsWith(p)) && !spec.skipKeys?.test(k));
      ks.forEach((k) => keys.add(k));
      if (!ks.length) missing.push(e);
    } else if (activeKeys.includes(e)) {
      keys.add(e);
    } else if (sportGroup(e)) {
      missing.push(e); // a real key, but not in season right now
    } else {
      missing.push(e);
    }
  }
  return { keys: [...keys], missing };
}

/** Betika competition filter for an Odds API sport key (women's, youth, doubles etc. stay apart). */
export function competitionFilter(oddsApiKey) {
  const NBA_LIKE = {
    basketball_nba: (c) => c === 'NBA',
    basketball_wnba: (c) => c === 'WNBA',
    basketball_ncaab: (c) => /^NCAA(, |$)/.test(c) && !/women/i.test(c),
    basketball_wncaab: (c) => /^NCAA/.test(c) && /women/i.test(c),
    basketball_euroleague: (c) => /euroleague/i.test(c),
  };
  if (NBA_LIKE[oddsApiKey]) return NBA_LIKE[oddsApiKey];
  const womenKey = /women|wta|_w_|nwsl|wnba/.test(oddsApiKey);
  const exclude = /\b(u\d{2}|youth|reserve|reserves|esoccer|ebasketball|srl|simulated|virtual|utr|itf|doubles)\b/i;
  return (c) => {
    if (exclude.test(c)) return false;
    if (oddsApiKey.startsWith('tennis_')) {
      if (womenKey) return /women/i.test(c);
      return /\bmen\b/i.test(c) && !/women/i.test(c);
    }
    return womenKey ? /women/i.test(c) : !/women/i.test(c);
  };
}
