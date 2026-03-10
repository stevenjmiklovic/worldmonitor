/**
 * GameLogPanel – scrolling event log for The Great Game.
 *
 * Displays every event that has occurred during the simulation in reverse
 * chronological order.  Subscribes to state changes from GameHudPanel.
 */

import { Panel } from './Panel';
import { h } from '@/utils/dom-utils';
import type { GameState } from '@/types';

export class GameLogPanel extends Panel {
  private bodyEl!: HTMLElement;

  constructor() {
    super({ id: 'game-log', title: 'The Great Game — Event Log', trackActivity: false });
    this.bodyEl = h('div', { style: 'padding:8px;font-size:0.83em;max-height:400px;overflow-y:auto' });
    this.content.appendChild(this.bodyEl);
  }

  /** Called by GameHudPanel whenever the game state changes. */
  update(state: GameState): void {
    this.bodyEl.innerHTML = '';

    const reversed = [...state.log].reverse();
    for (const evt of reversed) {
      const isAction = evt.id.startsWith('act-');
      const card = h('div', {
        style: `padding:5px 8px;margin-bottom:4px;border-radius:4px;border-left:3px solid ${isAction ? 'var(--accent,#4488ff)' : '#ffcc44'};background:var(--panel-bg,#1a1a2e)`,
      });
      card.append(
        h('div', { style: 'display:flex;justify-content:space-between;font-size:0.9em;opacity:0.6' },
          h('span', null, `Turn ${evt.turn}`),
          h('span', null, evt.region),
        ),
        h('div', { style: 'font-weight:600' }, evt.headline),
        h('div', { style: 'opacity:0.7;font-size:0.9em' }, evt.description),
      );
      this.bodyEl.appendChild(card);
    }

    if (reversed.length === 0) {
      this.bodyEl.appendChild(h('div', { style: 'opacity:0.5;font-style:italic' }, 'No events yet.'));
    }
  }
}
