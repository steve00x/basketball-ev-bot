// Match Betika's team names ("LA Lakers") to The Odds API's ("Los Angeles Lakers").

const STOPWORDS = new Set(['fc', 'bc', 'bk', 'kk', 'basketball', 'basket', 'club', 'the', 'team', 'and', 'of']);

// Same word, different spelling: "Indiana State" = "Indiana St", "Saint Mary's" = "St Mary's",
// "N. Florida" = "North Florida", "NY Islanders" = "New York Islanders". Values may be several words.
const TOKEN_SYNONYMS = {
  state: 'st', saint: 'st', international: 'int', intl: 'int', univ: 'university',
  olympiakos: 'olympiacos', milano: 'milan', munchen: 'munich', munich: 'munich',
  n: 'north', s: 'south', e: 'east', w: 'west', no: 'north', so: 'south',
  cent: 'central', centr: 'central', chi: 'chicago', ny: 'new york', nj: 'new jersey',
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
  // Ice hockey
  'sport': 'vaasan sport', 'vaasan': 'vaasan sport', 'vaasa sport': 'vaasan sport',
  'asvel villeurbanne': 'asvel', 'ldlc asvel': 'asvel', 'baskonia vitoria': 'baskonia', 'kosner baskonia': 'baskonia',
};

export function normaliseTeam(name) {
  const base = String(name)
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
  return ALIASES[base] ?? base;
}

/** Women's / youth / reserve markers. Two names must carry the same ones to match. */
export function qualifiers(name) {
  const s = ` ${String(name).toLowerCase().replace(/[^a-z0-9()]+/g, ' ')} `;
  const q = new Set();
  if (/\b(women|womens|ladies|female)\b|\(w\)| w /.test(s)) q.add('women');
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
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  if (inter === ta.size && inter === tb.size) return 1; // same words, any order: "Alcaraz, Carlos"
  if (inter === Math.min(ta.size, tb.size)) return 0.9;
  return inter / new Set([...ta, ...tb]).size;
}

/**
 * Find the Betika row for an Odds API event. Returns {row, swapped, score} or null.
 * `swapped` means Betika lists the teams the other way round. The match must be
 * clear: no second candidate may score close to the best one.
 */
export function findRow(event, rows, threshold = 0.75) {
  const scored = [];
  for (const row of rows) {
    const straight = Math.min(teamSimilarity(event.home_team, row.home), teamSimilarity(event.away_team, row.away));
    const swapped = Math.min(teamSimilarity(event.home_team, row.away), teamSimilarity(event.away_team, row.home));
    const best = Math.max(straight, swapped);
    if (best >= threshold) scored.push({ row, swapped: swapped > straight, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.05) return null; // ambiguous
  return scored[0];
}
