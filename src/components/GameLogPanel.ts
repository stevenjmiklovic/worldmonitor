/**
 * GameLogPanel – scrolling event log for The Great Game.
 *
 * Displays every event in reverse chronological order, with approval and
 * DEFCON change indicators inspired by Shadow President's event ticker.
 */

import { Panel } from './Panel';
import { h } from '@/utils/dom-utils';
import type { GameState } from '@/types';

export class GameLogPanel extends Panel {
  private bodyEl!: HTMLElement;

  constructor() {
    super({ id: 'game-log', title: 'The Great Game — Event Log', trackActivity: false });
    this.bodyEl = h('div', { style: 'padding:8px;font-size:0.83em;max-height:400px;overflow-y:auto', role: 'log', 'aria-live': 'polite', 'aria-label': 'Game event log' });
    this.content.appendChild(this.bodyEl);
  }

  update(state: GameState): void {
    this.bodyEl.innerHTML = '';

    const reversed = [...state.log].reverse();
    for (const evt of reversed) {
      const isAction = evt.id.startsWith('act-');
      const isAi     = evt.id.startsWith('ai-');
      const borderColor = isAction ? 'var(--accent,#4488ff)' : isAi ? '#44ccff' : '#ffcc44';
      const icon        = isAction ? '⚡' : isAi ? '🤖' : '🌍';
      const card = h('div', {
        style: `padding:5px 8px;margin-bottom:4px;border-radius:4px;border-left:3px solid ${borderColor};background:var(--panel-bg,#1a1a2e)`,
      });

      const metaRow = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;font-size:0.9em;opacity:0.6;margin-bottom:1px' });
      const metaLeft = h('span', null, `${icon} Turn ${evt.turn}`);
      const regionPill = h('span', {
        style: `font-size:0.8em;padding:1px 5px;border-radius:3px;background:${borderColor}22;color:${borderColor}`,
      }, evt.region);
      metaRow.append(metaLeft, regionPill);

      const headline = h('div', { style: 'font-weight:600' }, evt.headline);
      const desc = h('div', { style: 'opacity:0.7;font-size:0.9em' }, evt.description);

      card.append(metaRow, headline, desc);

      // Shadow President-style delta badges
      const badges: string[] = [];
      if (evt.approvalDelta != null && evt.approvalDelta !== 0) {
        const sign = evt.approvalDelta > 0 ? '+' : '';
        badges.push(`Approval ${sign}${evt.approvalDelta}`);
      }
      if (evt.defconDelta != null && evt.defconDelta !== 0) {
        const sign = evt.defconDelta > 0 ? '+' : '';
        badges.push(`DEFCON ${sign}${evt.defconDelta}`);
      }
      if (badges.length > 0) {
        const badgeEl = h('div', { style: 'font-size:0.8em;margin-top:2px;opacity:0.6;font-style:italic' }, badges.join(' · '));
        card.appendChild(badgeEl);
      }

      this.bodyEl.appendChild(card);
    }

    if (reversed.length === 0) {
      this.bodyEl.appendChild(h('div', { style: 'opacity:0.5;font-style:italic' }, 'No events yet.'));
    }
  }
}
