// Match Betika's team names ("LA Lakers") to The Odds API's ("Los Angeles Lakers").

const STOPWORDS = new Set(['fc', 'bc', 'bk', 'kk', 'basketball', 'basket', 'club', 'the', 'team']);

// Extend with any names you see mismatching (normalised form -> normalised form).
export const ALIASES = {
  'la lakers': 'los angeles lakers',
  'la clippers': 'los angeles clippers',
  'ny knicks': 'new york knicks',
  'gs warriors': 'golden state warriors',
  'okc thunder': 'oklahoma city thunder',
  'philadelphia 76ers': 'philadelphia 76ers',
  'phila 76ers': 'philadelphia 76ers',
  'portland trailblazers': 'portland trail blazers',
};

export function normaliseTeam(name) {
  const base = String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t))
    .join(' ');
  return ALIASES[base] ?? base;
}

/** 1 = identical, 0.9 = one name contains the other's words, else Jaccard overlap. */
export function teamSimilarity(a, b) {
  const na = normaliseTeam(a), nb = normaliseTeam(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
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
