// Match Betika's team names ("LA Lakers") to The Odds API's ("Los Angeles Lakers").

const STOPWORDS = new Set(['fc', 'bc', 'bk', 'kk', 'basketball', 'basket', 'club', 'the', 'team', 'and', 'of']);

// Same word, different spelling: "Indiana State" = "Indiana St", "Saint Mary's" = "St Mary's".
const TOKEN_SYNONYMS = {
  state: 'st', saint: 'st', international: 'int', intl: 'int', univ: 'university',
  olympiakos: 'olympiacos', olimpia: 'olimpia', milano: 'milan',
};

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
  'asvel villeurbanne': 'asvel', 'ldlc asvel': 'asvel', 'baskonia vitoria': 'baskonia', 'kosner baskonia': 'baskonia',
};

export function normaliseTeam(name) {
  const base = String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t)) // drops initials: "B. Munich" -> "munich"
    .map((t) => TOKEN_SYNONYMS[t] ?? t)
    .join(' ');
  return ALIASES[base] ?? base;
}

/** Women's / youth / reserve markers. Two names must carry the same ones to match. */
export function qualifiers(name) {
  const s = ` ${String(name).toLowerCase().replace(/[^a-z0-9()]+/g, ' ')} `;
  const q = new Set();
  if (/\b(women|womens|ladies|female)\b|\(w\)| w /.test(s)) q.add('women');
  for (const m of s.matchAll(/\bu ?(\d{2})\b/g)) q.add(`u${m[1]}`);
  if (/\b(reserves?|ii|iii|youth|academy|juniors?|jong)\b/.test(s) || /\s[bc]\s$/.test(s)) q.add('reserve'); // "Jong Ajax", "Barcelona B"
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
