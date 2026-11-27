// Match Betika's team names ("LA Lakers") to The Odds API's ("Los Angeles Lakers").

const STOPWORDS = new Set(['fc', 'bc', 'bk', 'kk', 'sk', 'sc', 'afc', 'cf', 'basketball', 'basket', 'basquet',
  'basketbol', 'club', 'the', 'team', 'and', 'of']);

// Same word, different spelling: "Indiana State" = "Indiana St", "Saint Mary's" = "St Mary's",
// "N. Florida" = "North Florida", "NY Islanders" = "New York Islanders". Values may be several words.
const TOKEN_SYNONYMS = {
  state: 'st', saint: 'st', international: 'int', intl: 'int', univ: 'university',
  olympiakos: 'olympiacos', milano: 'milan', munchen: 'munich', munich: 'munich',
  n: 'north', s: 'south', e: 'east', w: 'west', no: 'north', so: 'south',
  cent: 'central', centr: 'central', chi: 'chicago', ny: 'new york', nj: 'new jersey',
  // English-football short forms: "Sheffield Utd/Wed", "Man City", "Nott'm Forest", "West Brom"
  utd: 'united', wed: 'wednesday', weds: 'wednesday', man: 'manchester', nottm: 'nottingham', brom: 'bromwich',
  atl: 'atletico', ath: 'athletic',
  // German / other short forms seen on Betika: "1. FC Cologne", "Borussia (MG)", "NW Wildcats", "RN Lions"
  cologne: 'koln', mg: 'monchengladbach', nw: 'northwestern', rn: 'rhein neckar', lions: 'lowen',
  tenn: 'tennessee', unc: 'nc', nku: 'northern kentucky', utep: 'texas el paso',
  utsa: 'texas san antonio', uab: 'alabama birmingham', ucf: 'central florida', fiu: 'florida int',
};

// Removed from the name itself; women's / youth status is compared separately (see qualifiers).
const QUALIFIER_TOKENS = /^(women|womens|ladies|female|reserve|reserves|ii|iii|youth|academy|junior|juniors|jong|u\d{2})$/;

// Whole-name aliases (normalised form -> normalised form). Add any you see failing.
export const ALIASES = {
  'la lakers': 'los angeles lakers',
  'la clippers': 'los angeles clippers',
  'ny knicks': 'new york knicks',
  'gs warriors': 'golden st warriors',
  'okc thunder': 'oklahoma city thunder',
  'phila 76ers': 'philadelphia 76ers',
  'portland trailblazers': 'portland trail blazers',
  // NCAA
  'ole miss': 'mississippi', 'ole miss rebels': 'mississippi rebels',
  'byu': 'brigham young', 'byu cougars': 'brigham young cougars',
  'sfa lumberjacks': 'stephen austin lumberjacks', 'sfa': 'stephen austin',
  'uconn': 'connecticut', 'uconn huskies': 'connecticut huskies',
  'unlv': 'nevada las vegas', 'unlv rebels': 'nevada las vegas rebels',
  // EuroLeague
  'cz mts': 'crvena zvezda', 'crvena zvezda mts': 'crvena zvezda', 'crvena zvezda meridianbet': 'crvena zvezda',
  'red star belgrade': 'crvena zvezda',
  'olympiacos piraeus': 'olympiacos', 'olympiacos bc': 'olympiacos',
  'munich': 'bayern munich', 'bayern': 'bayern munich', 'fc bayern munich': 'bayern munich',
  'anadolu efes istanbul': 'anadolu efes', 'efes': 'anadolu efes',
  'fenerbahce beko': 'fenerbahce', 'fenerbahce beko istanbul': 'fenerbahce',
  'ea7 emporio armani milan': 'olimpia milan', 'armani milan': 'olimpia milan', 'ax armani exchange milan': 'olimpia milan',
  'zalgiris kaunas': 'zalgiris', 'partizan belgrade': 'partizan', 'virtus bologna': 'bologna',
  // Soccer
  'wolves': 'wolverhampton wanderers', 'spurs': 'tottenham hotspur', 'qpr': 'queens park rangers',
  'mk dons': 'milton keynes dons', 'psg': 'paris st germain', 'paris sg': 'paris st germain',
  'west brom': 'west bromwich albion', 'man utd': 'manchester united', 'man united': 'manchester united',
  'fenerbahce istanbul': 'fenerbahce', 'galatasaray istanbul': 'galatasaray', 'besiktas istanbul': 'besiktas',
  // NCAA
  'miami florida': 'miami hurricanes', 'miami fl': 'miami hurricanes',
  // Ice hockey
  'sport': 'vaasan sport', 'vaasan': 'vaasan sport', 'vaasa sport': 'vaasan sport',
  'asvel villeurbanne': 'asvel', 'ldlc asvel': 'asvel', 'baskonia vitoria': 'baskonia', 'kosner baskonia': 'baskonia',
};

function baseName(name) {
  return String(name)
    .replace(/\(w\)/gi, ' ')
    .replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/ß/g, 'ss').replace(/[đĐ]/g, 'd').replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/oe/g, 'o').replace(/ue/g, 'u').replace(/ae/g, 'a') // "Bodoe" = "Bodø", "Muenchen" = "München"
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !QUALIFIER_TOKENS.test(t))
    .map((t) => TOKEN_SYNONYMS[t] ?? t)
    .join(' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t)) // drops leftover initials: "B. Munich" -> "munich"
    .join(' ');
}

// Alias targets go through the same spelling rules as the names they're compared with
// (otherwise "queens park rangers" and the spelling-normalised "quens park rangers" differ).
const NORMAL_ALIASES = Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [baseName(k), baseName(v)]));

export function normaliseTeam(name) {
  const base = baseName(name);
  return NORMAL_ALIASES[base] ?? base;
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// Two-letter words that are words in their own right, never short for a longer one.
const SHORT_WORDS = new Set(['st', 'nc', 'uc', 'sv', 'ac', 'as', 'ae', 'sg', 'cd', 'sc', 'rc', 'fk', 'nk', 'ud', 'ad', 'us', 'ss', 'ca', 'cs', 'sd', 'de', 'la', 'le', 'el']);

/**
 * Same word, allowing the short forms books use: a shortened word ("fr" = "frankfurt", "west" =
 * "western", "hamburg" = "hamburger") or a near-identical spelling ("psuchikou" = "psychikou").
 */
export function sameToken(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (/\d/.test(s) || /\d/.test(l)) return false; // "76ers", "u21": numbers must be exact
  if (s.length >= 3 && l.startsWith(s)) return true;
  if (s.length === 2 && !SHORT_WORDS.has(s) && l.length >= 5 && l.startsWith(s)) return true;
  if (s.length >= 5 && editDistance(a, b) <= (s.length >= 7 ? 2 : 1)) return true;
  return false;
}

/** Women's / youth / reserve markers. Two names must carry the same ones to match. */
export function qualifiers(name) {
  // accents first ("Kraków" -> "krakow"), else "krak w" would look like a women's "W" side
  const plain = String(name).replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/ß/g, 'ss').replace(/[đĐ]/g, 'd').replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const s = ` ${plain.toLowerCase().replace(/[^a-z0-9()]+/g, ' ')} `;
  const q = new Set();
  // "Team W" at the end is a women's side; "W. Kentucky" (W at the start) is Western Kentucky
  if (/\b(women|womens|ladies|female)\b|\(w\)|\sw\s$/.test(s)) q.add('women');
  // U21 / U23 / Reserves / II / Jong / "B" sides: one class, since books label them differently
  // ("Everton U21" on The Odds API is "Everton Reserves" on Betika). Never the first team.
  if (/\bu ?\d{2}\b/.test(s) || /\b(reserves?|ii|iii|youth|academy|juniors?|jong)\b/.test(s) || /\s[bc]\s$/.test(s)) q.add('youth');
  return [...q].sort().join(',');
}

/** 1 = identical, 0.9 = one name contains the other's words, else Jaccard overlap. */
export function teamSimilarity(a, b) {
  if (qualifiers(a) !== qualifiers(b)) return 0; // "Arsenal" is never "Arsenal (W)" or "Arsenal U21"
  const na = normaliseTeam(a), nb = normaliseTeam(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = [...new Set(na.split(' '))], B = [...new Set(nb.split(' '))];
  // each word pairs with at most one word of the other name: exact words first, then short forms
  const doneA = new Set(), usedB = new Set();
  let inter = 0;
  for (const same of [(x, y) => x === y, sameToken]) {
    A.forEach((t, i) => {
      if (doneA.has(i)) return;
      const k = B.findIndex((u, j) => !usedB.has(j) && same(t, u));
      if (k >= 0) { doneA.add(i); usedB.add(k); inter++; }
    });
  }
  if (inter === A.length && inter === B.length) return 1; // same words, any order: "Alcaraz, Carlos"
  if (inter === Math.min(A.length, B.length)) return 0.9;
  return inter / (A.length + B.length - inter);
}

/**
 * Find the Betika row for an Odds API event. Returns {row, swapped, score} or null.
 * `swapped` means Betika lists the teams the other way round. The match must be
 * clear: no second candidate may score close to the best one.
 */
export function findRow(event, rows, threshold = 0.75) {
  const scored = [];
  const start = event.commence_time ? +new Date(event.commence_time) : null;
  for (const row of rows) {
    const pair = (h, a) => [teamSimilarity(event.home_team, h), teamSimilarity(event.away_team, a)];
    const sides = [[pair(row.home, row.away), false], [pair(row.away, row.home), true]];
    let best = null;
    for (const [[x, y], swapped] of sides) {
      let score = Math.min(x, y);
      // A team can't play two games at once: one clearly matching team, the other sharing a word
      // ("JSU Gamecocks" = "Jacksonville St Gamecocks") and the same kick-off is the same game.
      if (score < threshold && Math.max(x, y) >= 0.9 && Math.min(x, y) >= 0.2
          && start != null && row.start && Math.abs(+new Date(row.start) - start) <= 15 * 60_000) score = -(threshold + 0.01);
      const loose = score < 0;
      score = Math.abs(score);
      if (!best || score > best.score) best = { score, swapped, loose };
    }
    if (best.score >= threshold) scored.push({ row, swapped: best.swapped, score: best.score, loose: best.loose });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.05) return null; // ambiguous
  return scored[0];
}
