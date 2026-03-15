/**
 * GameBriefingPanel – regional status overview for The Great Game.
 *
 * Renders a table of all nine game regions showing influence, stability,
 * threat-level, government type, and persistent status flags (sanctions,
 * troops deployed, nuclear capability) — inspired by Shadow President's
 * per-country stat view.
 */

import { Panel } from './Panel';
import { h } from '@/utils/dom-utils';
import type { GameState, GameRegionId, GameRegionState, GovernmentType, LeaderPersonality } from '@/types';

const GOV_LABELS: Record<GovernmentType, string> = {
  democracy:     '🗳️ Democracy',
  autocracy:     '👤 Autocracy',
  monarchy:      '👑 Monarchy',
  theocracy:     '🕌 Theocracy',
  communist:     '☭ Communist',
  militaryJunta: '🎖️ Junta',
};

const PERSONALITY_COLORS: Record<LeaderPersonality, string> = {
  hawk:        '#ff6644',
  dove:        '#44ccff',
  reformist:   '#44ff88',
  pragmatist:  '#aaaaaa',
  nationalist: '#ffaa44',
  populist:    '#cc88ff',
};

export class GameBriefingPanel extends Panel {
  private bodyEl!: HTMLElement;

  constructor() {
    super({ id: 'game-briefing', title: 'The Great Game — Regional Intel', trackActivity: false });
    this.bodyEl = h('div', { style: 'padding:8px;font-size:0.85em;overflow-x:auto' });
    this.content.appendChild(this.bodyEl);
  }

  update(state: GameState): void {
    this.bodyEl.innerHTML = '';

    const table = h('table', { style: 'width:100%;border-collapse:collapse;min-width:520px' });
    const caption = h('caption', { style: 'display:none' }, 'Regional Intelligence — influence, stability, threat level and status per region');
    table.appendChild(caption);
    const thead = h('thead');
    const headRow = h('tr');
    const colHeaders: [string, string][] = [
      ['Region', 'Region name'], ['Gov', 'Government type'], ['Leader', 'Current leader and personality'],
      ['Inf', 'Influence (−100 hostile to 100 allied)'],
      ['Stab', 'Stability (0–100)'], ['Threat', 'Threat level (0–100)'], ['Status', 'Status flags'],
    ];
    for (const [label, fullLabel] of colHeaders) {
      const th = h('th', { style: 'text-align:left;padding:4px 5px;border-bottom:1px solid var(--border,#333);font-size:0.88em;white-space:nowrap', scope: 'col', title: fullLabel }, label);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = h('tbody');
    const regionIds = Object.keys(state.regions) as GameRegionId[];
    for (const rId of regionIds) {
      const region: GameRegionState = state.regions[rId];
      const isHotspot = region.threatLevel > 65;
      const isCritical = region.stability < 30;
      const rowBg = isCritical ? 'background:rgba(255,50,50,0.06)' : '';
      const tr = h('tr', { style: rowBg });

      const nameCell = h('td', { style: 'padding:3px 5px;white-space:nowrap' }, region.name);
      const govCell  = h('td', { style: 'padding:3px 5px;font-size:0.85em' }, GOV_LABELS[region.governmentType] ?? region.governmentType);

      // Leader column with personality pill
      const personality = region.leader.personality;
      const personalityColor = PERSONALITY_COLORS[personality] ?? '#888';
      const leaderCell = h('td', { style: 'padding:3px 5px;font-size:0.82em;white-space:nowrap' });
      leaderCell.append(
        h('span', null, region.leader.name + ' '),
        h('span', {
          style: `font-size:0.78em;padding:1px 4px;border-radius:3px;background:${personalityColor}22;color:${personalityColor};font-weight:600`,
          title: `Leader personality: ${personality}`,
        }, personality),
      );

      const infCell  = h('td', { style: `padding:3px 5px;font-weight:600;color:${colorForValue(region.influence, -100, 100)}` }, String(region.influence));
      const stabCell = h('td', { style: `padding:3px 5px;font-weight:600;color:${colorForValue(region.stability, 0, 100)}` }, String(region.stability));
      const threatLabel = `${region.threatLevel}${isHotspot ? ' 🔥' : ''}`;
      const thrCell  = h('td', { style: `padding:3px 5px;font-weight:600;color:${colorForThreat(region.threatLevel)}` }, threatLabel);

      const badges: string[] = [];
      if (region.nuclearCapable)  badges.push('☢️');
      if (region.sanctioned)     badges.push('🚫');
      if (region.troopsDeployed) badges.push('🪖');
      const statusCell = h('td', { style: 'padding:3px 5px;font-size:0.9em' }, badges.join(' ') || '—');

      tr.append(nameCell, govCell, leaderCell, infCell, stabCell, thrCell, statusCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.bodyEl.appendChild(table);

    // Status legend
    const legend = h('div', { style: 'margin-top:6px;font-size:0.8em;opacity:0.6' },
      '☢️ Nuclear  🚫 Sanctioned  🪖 Troops Deployed');
    this.bodyEl.appendChild(legend);

    // Personality legend
    const personalities: [string, string][] = [
      ['hawk', '#ff6644'], ['dove', '#44ccff'], ['reformist', '#44ff88'],
      ['pragmatist', '#aaaaaa'], ['nationalist', '#ffaa44'], ['populist', '#cc88ff'],
    ];
    const personalityDescriptions: Record<string, string> = {
      hawk: 'Military/covert favoured',
      dove: 'Diplomatic/economic favoured',
      reformist: 'Diplomatic/economic receptive',
      pragmatist: 'Balanced (no modifier)',
      nationalist: 'Military receptive, resists diplomacy',
      populist: 'Economic/diplomatic receptive',
    };
    const personalityLegend = h('div', { style: 'margin-top:4px;font-size:0.78em;opacity:0.55;display:flex;flex-wrap:wrap;gap:4px 10px' });
    for (const [name, color] of personalities) {
      const item = h('span', { title: personalityDescriptions[name] ?? '' });
      item.append(
        h('span', { style: `display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:3px;vertical-align:middle` }),
        document.createTextNode(name),
      );
      personalityLegend.appendChild(item);
    }
    this.bodyEl.appendChild(personalityLegend);
  }
}

function colorForValue(val: number, lo: number, hi: number): string {
  const pct = (val - lo) / (hi - lo);
  if (pct > 0.6) return '#44ff88';
  if (pct > 0.35) return '#ffcc44';
  return '#ff5555';
}

function colorForThreat(val: number): string {
  if (val < 25) return '#44ff88';
  if (val < 55) return '#ffcc44';
  return '#ff5555';
}
