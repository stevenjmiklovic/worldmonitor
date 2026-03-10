/**
 * GameBriefingPanel – regional status overview for The Great Game.
 *
 * Renders a table of all nine game regions with their current influence,
 * stability, and threat-level values.  Subscribes to GameHudPanel state
 * updates via the onChange callback.
 */

import { Panel } from './Panel';
import { h } from '@/utils/dom-utils';
import type { GameState, GameRegionId, GameRegionState } from '@/types';

export class GameBriefingPanel extends Panel {
  private bodyEl!: HTMLElement;

  constructor() {
    super({ id: 'game-briefing', title: 'The Great Game — Regional Intel', trackActivity: false });
    this.bodyEl = h('div', { style: 'padding:8px;font-size:0.85em' });
    this.content.appendChild(this.bodyEl);
  }

  /** Called by GameHudPanel whenever the game state changes. */
  update(state: GameState): void {
    this.bodyEl.innerHTML = '';

    const table = h('table', { style: 'width:100%;border-collapse:collapse' });
    const thead = h('thead');
    const headRow = h('tr');
    for (const col of ['Region', 'Influence', 'Stability', 'Threat']) {
      const th = h('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--border,#333);font-size:0.9em' }, col);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = h('tbody');
    const regionIds = Object.keys(state.regions) as GameRegionId[];
    for (const rId of regionIds) {
      const region: GameRegionState = state.regions[rId];
      const tr = h('tr');

      const nameCell = h('td', { style: 'padding:3px 6px' }, region.name);
      const infCell  = h('td', { style: `padding:3px 6px;font-weight:600;color:${colorForValue(region.influence, -100, 100)}` }, String(region.influence));
      const stabCell = h('td', { style: `padding:3px 6px;font-weight:600;color:${colorForValue(region.stability, 0, 100)}` }, String(region.stability));
      const thrCell  = h('td', { style: `padding:3px 6px;font-weight:600;color:${colorForThreat(region.threatLevel)}` }, String(region.threatLevel));

      tr.append(nameCell, infCell, stabCell, thrCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.bodyEl.appendChild(table);
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
