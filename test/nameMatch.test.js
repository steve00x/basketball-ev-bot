import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachBetikaOdds } from '../src/betika/odds.js';
import { findRow, teamSimilarity } from '../src/teamMatch.js';

const T = '2026-11-27T19:30:00Z';
const now = new Date('2026-11-27T12:00:00Z');

test('names from a real scan log that used to be missed now match (2026-11-27)', () => {
  const cases = [ // Odds API home, away | Betika home, away
    ['UC Davis Aggies', 'Jacksonville St Gamecocks', 'UC Davis', 'JSU Gamecocks'],
    ['Pacific Tigers', 'Omaha Mavericks', 'Pacific', 'Nebraska-Omaha'],
    ['Illinois Fighting Illini', 'Western Kentucky Hilltoppers', 'Illinois', 'W. Kentucky'],
    ['Northwestern Wildcats', 'Northeastern Huskies', 'NW Wildcats', 'Northeastern'],
    ['Queens Park Rangers', 'Sheffield United', 'QPR', 'Sheffield Utd'],
    ['Werder Bremen', 'Borussia Monchengladbach', 'Werder Bremen', 'Borussia (MG)'],
    ['1. FC Köln', 'Elversberg', '1. FC Cologne', 'Elversberg'],
    ['Hamburger SV', 'Bayern Munich', 'Hamburg', 'Bayern Munich'],
    ['VfB Stuttgart', 'Eintracht Frankfurt', 'Stuttgart', 'Eintracht Fr'],
    ['Rhein-Neckar Löwen', 'SG BBM Bietigheim', 'RN Lions', 'BBM Bietigheim'],
    ['Gas Komotini', 'Asa Koroivos', 'Gas Komotini', 'Koroivos Amaliadas'],
    ['Paneruthraikos AS', 'AE Psuchikou', 'Paneruthraikos AS', 'AE Psychikou'],
  ];
  for (const [h, a, bh, ba] of cases) {
    assert.ok(findRow({ home_team: h, away_team: a, commence_time: T }, [{ home: bh, away: ba, start: new Date(T) }]), `${a} @ ${h} vs ${bh} v ${ba}`);
  }
});

test('different teams never match', () => {
  for (const [x, y] of [['Manchester United', 'Manchester City'], ['Arsenal', 'Arsenal U21'], ['Arsenal', 'Arsenal W'], ['Miami Heat', 'Miami Hurricanes'],
    ['Real Madrid', 'Real Betis'], ['Inter Milan', 'AC Milan'], ['Philadelphia 76ers', 'Philadelphia 77ers']]) {
    assert.ok(teamSimilarity(x, y) < 0.75, `${x} / ${y}: ${teamSimilarity(x, y)}`);
  }
  // one team + kick-off is only trusted when the prices look like the same game
  const pin = { id: 'x', sport_key: 'soccer_epl', home_team: 'Manchester United', away_team: 'Chelsea', commence_time: T,
    bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Manchester United', price: 2.6 }, { name: 'Chelsea', price: 2.7 }, { name: 'Draw', price: 3.5 }] }] }] };
  const other = { sport: 'soccer', parentMatchId: '1', home: 'Manchester City', away: 'Chelsea', start: new Date(T), competition: 'Premier League', winner: [1.5, 6.0], draw: 4.5, totals: [] };
  attachBetikaOdds([pin], [other], now);
  assert.equal(pin.betikaRef, undefined);
});

test('accented names never look like women\'s teams ("Kraków" is not "Krak W")', () => {
  assert.equal(teamSimilarity('Wisła Kraków', 'Wisla Krakow'), 1);
  assert.equal(teamSimilarity('Bodø/Glimt', 'Bodo Glimt'), 1);
  assert.equal(teamSimilarity('Arsenal W', 'Arsenal'), 0);   // a real women's side still never matches
  assert.ok(findRow({ home_team: 'Wisła Kraków', away_team: 'Motor Lublin', commence_time: T }, [{ home: 'Wisla Krakow', away: 'LKP Motor Lublin', start: new Date(T) }]));
});
