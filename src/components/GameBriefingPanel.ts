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
import type { GameState, GameRegionId, GameRegionState, GovernmentType } from '@/types';

const GOV_LABELS: Record<GovernmentType, string> = {
  democracy:     '🗳️ Democracy',
  autocracy:     '👤 Autocracy',
  monarchy:      '👑 Monarchy',
  theocracy:     '🕌 Theocracy',
  communist:     '☭ Communist',
  militaryJunta: '🎖️ Junta',
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
    const thead = h('thead');
    const headRow = h('tr');
    for (const col of ['Region', 'Gov', 'Inf', 'Stab', 'Threat', 'Status']) {
      const th = h('th', { style: 'text-align:left;padding:4px 5px;border-bottom:1px solid var(--border,#333);font-size:0.88em;white-space:nowrap' }, col);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = h('tbody');
    const regionIds = Object.keys(state.regions) as GameRegionId[];
    for (const rId of regionIds) {
      const region: GameRegionState = state.regions[rId];
      const tr = h('tr');

      const nameCell = h('td', { style: 'padding:3px 5px' }, region.name);
      const govCell  = h('td', { style: 'padding:3px 5px;font-size:0.85em' }, GOV_LABELS[region.governmentType] ?? region.governmentType);
      const infCell  = h('td', { style: `padding:3px 5px;font-weight:600;color:${colorForValue(region.influence, -100, 100)}` }, String(region.influence));
      const stabCell = h('td', { style: `padding:3px 5px;font-weight:600;color:${colorForValue(region.stability, 0, 100)}` }, String(region.stability));
      const thrCell  = h('td', { style: `padding:3px 5px;font-weight:600;color:${colorForThreat(region.threatLevel)}` }, String(region.threatLevel));

      const badges: string[] = [];
      if (region.nuclearCapable)  badges.push('☢️');
      if (region.sanctioned)     badges.push('🚫');
      if (region.troopsDeployed) badges.push('🪖');
      const statusCell = h('td', { style: 'padding:3px 5px;font-size:0.9em' }, badges.join(' ') || '—');

      tr.append(nameCell, govCell, infCell, stabCell, thrCell, statusCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.bodyEl.appendChild(table);

    // Legend
    const legend = h('div', { style: 'margin-top:6px;font-size:0.8em;opacity:0.6' },
      '☢️ Nuclear  🚫 Sanctioned  🪖 Troops Deployed');
    this.bodyEl.appendChild(legend);
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
