// Alert channels: console (always), Discord webhook, Telegram bot.
import { matchup, selection } from './scanner.js';

const MARKET_NAMES = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total', double_chance: 'Double Chance', draw_no_bet: 'Draw No Bet', team_totals: 'Team Total' };
const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function formatOpportunity(o) {
  const market = MARKET_NAMES[o.market] ?? titleCase(o.market);
  const tip = o.commenceTime.toUTCString().replace(/:\d\d GMT$/, ' UTC');
  const league = o.sport.replace('basketball_', '').toUpperCase();
  return [
    `${o.ev >= 0 ? '+' : '\u2212'}${Math.abs(o.ev * 100).toFixed(2)}% EV | ${league} | ${matchup(o)} (${tip})`,
    `  ${market}: ${selection(o)} @ ${o.bookTitle} ${o.decimal.toFixed(2)}`
      + (o.winningsTax ? ` (${o.effectiveDecimal.toFixed(3)} after ${Math.round(o.winningsTax * 100)}% tax)` : ''),
    ...(o.model?.kind === 'team-total' ? [`  Team total: ${o.model.team} expected ${o.model.centre.toFixed(1)} (Pinnacle) vs Betika ${o.model.centreBook.toFixed(1)} (spread ±${o.model.sigma.toFixed(1)})`] : []),
    ...(o.model?.kind === 'alt-total' ? [`  Alt line: Pinnacle main ${o.model.mainLine}, centre ${o.model.muSharp.toFixed(1)} vs Betika ${o.model.muBook.toFixed(1)} (spread ±${o.model.sigma.toFixed(1)})`] : []),
    `  Fair ${((1 - (o.pushProb ?? 0)) / o.fairProb).toFixed(2)} (win ${(o.fairProb * 100).toFixed(1)}%${o.pushProb ? `, refund ${(o.pushProb * 100).toFixed(1)}%` : ''}) via ${o.sharpBooks.join(', ')}`
      + ` | Stake ${o.stake.toFixed(2)}`,
  ].join('\n');
}


function chunks(msgs, limit) {
  const out = [];
  let cur = '';
  for (const m of msgs) {
    if (cur && cur.length + m.length + 2 > limit) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${m}` : m;
  }
  if (cur) out.push(cur);
  return out;
}

export class Notifier {
  constructor(settings, { fetchImpl = globalThis.fetch, out = console, quiet = false } = {}) {
    Object.assign(this, { s: settings, fetchImpl, out, quiet });
  }

  async sendOpportunities(opps) {
    if (!opps.length) return;
    const msgs = opps.map(formatOpportunity);
    if (!this.quiet) for (const m of msgs) this.out.log(`${m}\n`);
    await this.remote(msgs);
  }

  /** Free-text message (bet results, halts) to remote channels. */
  async sendText(text) {
    await this.remote([text]);
  }

  async remote(msgs) {
    const { discordWebhookUrl: discord, telegramBotToken: tgToken, telegramChatId: tgChat } = this.s;
    if (discord) {
      for (const c of chunks(msgs, 1900)) await this.post(discord, { content: `\`\`\`\n${c}\n\`\`\`` }, 'Discord');
    }
    if (tgToken && tgChat) {
      const url = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      for (const c of chunks(msgs, 3900)) await this.post(url, { chat_id: tgChat, text: c }, 'Telegram');
    }
  }

  async post(url, body, name) {
    try {
      const r = await this.fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      this.out.warn?.(`${name} alert failed: ${e.message}`);
    }
  }
}
