/**
 * GameHudPanel – main heads-up display for The Great Game.
 *
 * Shows the current turn, phase, resources, objectives and available actions.
 * Manages the simulation lifecycle by calling the game-engine service.
 */

import { Panel } from './Panel';
import { h } from '@/utils/dom-utils';
import {
  createInitialState,
  generateTurnEvents,
  applyEvents,
  resolveAction,
  advancePhase,
  getAvailableActions,
  computeScore,
} from '@/services/game-engine';
import type { GameState, GameAction, GameEvent } from '@/types';

type HudChangeCallback = (state: GameState) => void;

export class GameHudPanel extends Panel {
  private state: GameState;
  private listeners: HudChangeCallback[] = [];

  // cached DOM sections
  private phaseEl!: HTMLElement;
  private turnEl!: HTMLElement;
  private resourcesEl!: HTMLElement;
  private objectivesEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private scoreEl!: HTMLElement;

  /** Last batch of world events generated for the current turn briefing. */
  private pendingEvents: GameEvent[] = [];

  constructor() {
    super({ id: 'game-hud', title: 'The Great Game — Command', trackActivity: false });

    this.state = createInitialState();
    this.buildUI();
    this.startBriefing();
  }

  /** Subscribe to state changes (used by sibling panels). */
  onChange(cb: HudChangeCallback): void {
    this.listeners.push(cb);
  }

  getState(): GameState {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // UI construction
  // ---------------------------------------------------------------------------

  private buildUI(): void {
    this.content.innerHTML = '';
    this.content.style.padding = '8px';

    const topBar = h('div', { className: 'game-hud-top', style: 'display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap' });
    this.turnEl  = h('span', { style: 'font-weight:600' });
    this.phaseEl = h('span', { style: 'opacity:0.8' });
    this.scoreEl = h('span', { style: 'margin-left:auto;font-weight:600;color:var(--accent,#4488ff)' });
    topBar.append(this.turnEl, this.phaseEl, this.scoreEl);

    this.resourcesEl  = h('div', { className: 'game-hud-resources', style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:4px 12px;margin-bottom:8px;font-size:0.85em' });
    this.objectivesEl = h('div', { className: 'game-hud-objectives', style: 'margin-bottom:8px;font-size:0.85em' });
    this.actionsEl    = h('div', { className: 'game-hud-actions', style: 'display:flex;flex-direction:column;gap:4px' });

    this.content.append(topBar, this.resourcesEl, this.objectivesEl, this.actionsEl);
  }

  // ---------------------------------------------------------------------------
  // Phase flow
  // ---------------------------------------------------------------------------

  private notify(): void {
    for (const cb of this.listeners) cb(this.state);
  }

  private startBriefing(): void {
    this.pendingEvents = generateTurnEvents(this.state);
    applyEvents(this.state, this.pendingEvents);
    this.state.score = computeScore(this.state);
    this.render();
    this.notify();
  }

  private enterActionPhase(): void {
    advancePhase(this.state); // briefing → action
    this.render();
    this.notify();
  }

  private executeAction(action: GameAction): void {
    resolveAction(this.state, action);
    advancePhase(this.state); // action → resolution
    this.state.score = computeScore(this.state);
    this.render();
    this.notify();

    // auto-advance after short delay
    setTimeout(() => {
      advancePhase(this.state); // resolution → next briefing (or gameOver)
      if (this.state.phase === 'briefing') {
        this.startBriefing();
      } else {
        this.render();
        this.notify();
      }
    }, 1200);
  }

  private restart(): void {
    this.state = createInitialState();
    this.pendingEvents = [];
    this.startBriefing();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private render(): void {
    // top bar
    this.turnEl.textContent  = `Turn ${this.state.turn}/${this.state.maxTurns}`;
    this.phaseEl.textContent = `  Phase: ${this.state.phase}`;
    this.scoreEl.textContent = `Score: ${this.state.score}`;

    // resources
    this.resourcesEl.innerHTML = '';
    const res = this.state.resources;
    const entries: [string, number][] = [
      ['🏛️ Political Capital', res.politicalCapital],
      ['🕵️ Intelligence',      res.intelligenceAssets],
      ['⚔️ Military',          res.militaryReadiness],
      ['💰 Economic',          res.economicInfluence],
      ['🔬 Technology',        res.technologyLevel],
    ];
    for (const [label, val] of entries) {
      const row = h('div', { style: 'display:flex;justify-content:space-between' });
      row.append(h('span', null, label), h('span', { style: 'font-weight:600' }, String(val)));
      this.resourcesEl.appendChild(row);
    }

    // objectives
    this.objectivesEl.innerHTML = '';
    const objHeader = h('div', { style: 'font-weight:600;margin-bottom:2px' }, 'Objectives');
    this.objectivesEl.appendChild(objHeader);
    for (const obj of this.state.objectives) {
      const mark = obj.completed ? '✅' : '⬜';
      this.objectivesEl.appendChild(h('div', { style: 'padding-left:4px' }, `${mark} ${obj.description}`));
    }

    // actions area
    this.actionsEl.innerHTML = '';

    if (this.state.phase === 'briefing') {
      const label = h('div', { style: 'font-weight:600;margin-bottom:4px' }, 'Intelligence Briefing');
      this.actionsEl.appendChild(label);
      for (const evt of this.pendingEvents) {
        const card = h('div', { style: 'background:var(--panel-bg,#1a1a2e);padding:6px 8px;border-radius:4px;margin-bottom:4px;font-size:0.85em' });
        card.append(
          h('div', { style: 'font-weight:600' }, evt.headline),
          h('div', { style: 'opacity:0.7;font-size:0.9em' }, evt.description),
        );
        this.actionsEl.appendChild(card);
      }
      const btn = h('button', { style: 'margin-top:6px;padding:6px 16px;border-radius:4px;cursor:pointer;background:var(--accent,#4488ff);color:#fff;border:none;font-weight:600' }, 'Proceed to Actions →');
      btn.addEventListener('click', () => this.enterActionPhase());
      this.actionsEl.appendChild(btn);
    } else if (this.state.phase === 'action') {
      const label = h('div', { style: 'font-weight:600;margin-bottom:4px' }, 'Choose Your Action');
      this.actionsEl.appendChild(label);
      const actions = getAvailableActions(this.state);
      // group by action type for readability
      const byType = new Map<string, GameAction[]>();
      for (const a of actions) {
        const group = byType.get(a.type) ?? [];
        group.push(a);
        byType.set(a.type, group);
      }
      for (const [, group] of byType) {
        const first = group[0];
        const header = h('div', { style: 'font-weight:600;margin-top:6px;font-size:0.85em' }, first.description);
        this.actionsEl.appendChild(header);
        for (const a of group) {
          const canAfford = this.canAfford(a);
          const btn = h('button', {
            style: `padding:4px 10px;border-radius:4px;cursor:${canAfford ? 'pointer' : 'not-allowed'};opacity:${canAfford ? '1' : '0.4'};background:var(--panel-bg,#1a1a2e);border:1px solid var(--border,#333);color:inherit;font-size:0.82em;text-align:left;width:100%`,
          }, a.label);
          if (canAfford) {
            btn.addEventListener('click', () => this.executeAction(a));
          }
          this.actionsEl.appendChild(btn);
        }
      }
    } else if (this.state.phase === 'resolution') {
      this.actionsEl.appendChild(h('div', { style: 'opacity:0.7;font-style:italic' }, 'Resolving action…'));
    } else if (this.state.phase === 'gameOver') {
      this.actionsEl.appendChild(h('div', { style: 'font-weight:700;font-size:1.1em;margin-bottom:8px' }, `Game Over — Final Score: ${this.state.score}`));
      for (const obj of this.state.objectives) {
        const mark = obj.completed ? '✅' : '❌';
        this.actionsEl.appendChild(h('div', null, `${mark} ${obj.description}`));
      }
      const btn = h('button', { style: 'margin-top:10px;padding:6px 16px;border-radius:4px;cursor:pointer;background:var(--accent,#4488ff);color:#fff;border:none;font-weight:600' }, 'New Game');
      btn.addEventListener('click', () => this.restart());
      this.actionsEl.appendChild(btn);
    }
  }

  private canAfford(action: GameAction): boolean {
    for (const [k, v] of Object.entries(action.cost) as [keyof GameResources, number][]) {
      if ((this.state.resources[k] ?? 0) < v) return false;
    }
    return true;
  }
}
