/**
 * GameHudPanel – main heads-up display for The Great Game.
 *
 * Inspired by Shadow President (1993), the HUD shows:
 *   • Turn / phase / score
 *   • Domestic approval rating (impeachment at <15)
 *   • DEFCON level (nuclear war at 1)
 *   • Budget allocation sliders (5 departments)
 *   • Resources
 *   • Objectives
 *   • Advisor briefings during the briefing phase
 *   • Categorised actions (diplomatic / economic / military / covert)
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
  setBudget,
} from '@/services/game-engine';
import type { GameState, GameAction, GameEvent, GameBudget, GameActionCategory, GameResources } from '@/types';

type HudChangeCallback = (state: GameState) => void;

const DEFCON_COLORS: Record<number, string> = {
  5: '#44ff88', 4: '#88cc44', 3: '#ffcc44', 2: '#ff8844', 1: '#ff3333',
};

const CATEGORY_LABELS: Record<GameActionCategory, string> = {
  diplomatic: '🤝 Diplomatic',
  economic:   '💰 Economic',
  military:   '⚔️ Military',
  covert:     '🕵️ Covert',
};

export class GameHudPanel extends Panel {
  private state: GameState;
  private listeners: HudChangeCallback[] = [];

  private phaseEl!: HTMLElement;
  private turnEl!: HTMLElement;
  private approvalEl!: HTMLElement;
  private defconEl!: HTMLElement;
  private resourcesEl!: HTMLElement;
  private budgetEl!: HTMLElement;
  private objectivesEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private scoreEl!: HTMLElement;

  private pendingEvents: GameEvent[] = [];

  constructor() {
    super({ id: 'game-hud', title: 'The Great Game — Command', trackActivity: false });
    this.state = createInitialState();
    this.buildUI();
    this.startBriefing();
  }

  onChange(cb: HudChangeCallback): void { this.listeners.push(cb); }
  getState(): GameState { return this.state; }

  // ---------------------------------------------------------------------------
  // UI construction
  // ---------------------------------------------------------------------------

  private buildUI(): void {
    this.content.innerHTML = '';
    this.content.style.padding = '8px';

    // ── Top bar ──
    const topBar = h('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap' });
    this.turnEl     = h('span', { style: 'font-weight:600' });
    this.phaseEl    = h('span', { style: 'opacity:0.8;font-size:0.9em' });
    this.scoreEl    = h('span', { style: 'margin-left:auto;font-weight:600;color:var(--accent,#4488ff)' });
    topBar.append(this.turnEl, this.phaseEl, this.scoreEl);

    // ── Approval + DEFCON row ──
    const statusRow = h('div', { style: 'display:flex;gap:16px;margin-bottom:6px;font-size:0.88em' });
    this.approvalEl = h('span');
    this.defconEl   = h('span');
    statusRow.append(this.approvalEl, this.defconEl);

    // ── Resources ──
    this.resourcesEl = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:3px 10px;margin-bottom:6px;font-size:0.85em' });

    // ── Budget ──
    this.budgetEl = h('div', { style: 'margin-bottom:6px;font-size:0.85em' });

    // ── Objectives ──
    this.objectivesEl = h('div', { style: 'margin-bottom:8px;font-size:0.85em' });

    // ── Actions / briefings ──
    this.actionsEl = h('div', { style: 'display:flex;flex-direction:column;gap:4px' });

    this.content.append(topBar, statusRow, this.resourcesEl, this.budgetEl, this.objectivesEl, this.actionsEl);
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
    advancePhase(this.state);
    this.render();
    this.notify();
  }

  private executeAction(action: GameAction): void {
    resolveAction(this.state, action);
    advancePhase(this.state);
    this.state.score = computeScore(this.state);
    this.render();
    this.notify();

    setTimeout(() => {
      advancePhase(this.state);
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
    // Top bar
    this.turnEl.textContent  = `Turn ${this.state.turn}/${this.state.maxTurns}`;
    this.phaseEl.textContent = `Phase: ${this.state.phase}`;
    this.scoreEl.textContent = `Score: ${this.state.score}`;

    // Approval (Shadow President)
    const apClr = this.state.approval > 50 ? '#44ff88' : this.state.approval > 25 ? '#ffcc44' : '#ff5555';
    this.approvalEl.innerHTML = `Approval: <b style="color:${apClr}">${this.state.approval}%</b>`;

    // DEFCON (Shadow President)
    const dcClr = DEFCON_COLORS[this.state.defcon] ?? '#ff3333';
    this.defconEl.innerHTML = `DEFCON: <b style="color:${dcClr}">${this.state.defcon}</b>`;

    // Resources
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

    // Budget (Shadow President)
    this.renderBudget();

    // Objectives
    this.objectivesEl.innerHTML = '';
    const objHeader = h('div', { style: 'font-weight:600;margin-bottom:2px' }, 'Objectives');
    this.objectivesEl.appendChild(objHeader);
    for (const obj of this.state.objectives) {
      const mark = obj.completed ? '✅' : '⬜';
      this.objectivesEl.appendChild(h('div', { style: 'padding-left:4px' }, `${mark} ${obj.description}`));
    }

    // Main actions area
    this.actionsEl.innerHTML = '';

    if (this.state.phase === 'briefing') {
      this.renderBriefingPhase();
    } else if (this.state.phase === 'action') {
      this.renderActionPhase();
    } else if (this.state.phase === 'resolution') {
      this.actionsEl.appendChild(h('div', { style: 'opacity:0.7;font-style:italic' }, 'Resolving action…'));
    } else if (this.state.phase === 'gameOver') {
      this.renderGameOver();
    }
  }

  // ── Budget sliders ──────────────────────────────────────────────────────
  private renderBudget(): void {
    this.budgetEl.innerHTML = '';
    const header = h('div', { style: 'font-weight:600;margin-bottom:2px' }, 'Budget Allocation (must total 100)');
    this.budgetEl.appendChild(header);

    const keys: (keyof GameBudget)[] = ['defense', 'intelligence', 'diplomacy', 'economy', 'technology'];
    const labels: Record<keyof GameBudget, string> = {
      defense: '🛡️ Defense', intelligence: '🕵️ Intelligence', diplomacy: '🤝 Diplomacy',
      economy: '💰 Economy', technology: '🔬 Technology',
    };

    const grid = h('div', { style: 'display:grid;grid-template-columns:auto 50px 1fr;gap:2px 8px;align-items:center' });
    const inputs: Record<string, HTMLInputElement> = {};

    for (const key of keys) {
      const lbl = h('span', null, labels[key]);
      const valSpan = h('span', { style: 'font-weight:600;text-align:right' }, String(this.state.budget[key]));
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '60';
      slider.value = String(this.state.budget[key]);
      slider.style.cssText = 'width:100%;cursor:pointer';
      inputs[key] = slider;

      slider.addEventListener('input', () => {
        valSpan.textContent = slider.value;
        this.tryApplyBudget(keys, inputs);
      });

      grid.append(lbl, valSpan, slider);
    }
    this.budgetEl.appendChild(grid);
  }

  private tryApplyBudget(keys: (keyof GameBudget)[], inputs: Record<string, HTMLInputElement>): void {
    const budget = {} as GameBudget;
    for (const k of keys) budget[k] = parseInt(inputs[k].value, 10) || 0;
    const total = keys.reduce((s, k) => s + budget[k], 0);
    if (total === 100) {
      setBudget(this.state, budget);
    }
  }

  // ── Briefing phase ──────────────────────────────────────────────────────
  private renderBriefingPhase(): void {
    const label = h('div', { style: 'font-weight:600;margin-bottom:4px;font-size:1.05em' }, '📋 Intelligence Briefing');
    this.actionsEl.appendChild(label);

    for (const evt of this.pendingEvents) {
      const card = h('div', { style: 'background:var(--panel-bg,#1a1a2e);padding:6px 8px;border-radius:4px;margin-bottom:6px;font-size:0.85em;border-left:3px solid #ffcc44' });
      card.append(
        h('div', { style: 'font-weight:600' }, evt.headline),
        h('div', { style: 'opacity:0.7;font-size:0.9em;margin-bottom:4px' }, evt.description),
      );

      // Advisor briefings (Shadow President)
      if (evt.advisorBriefings?.length) {
        const advisorSection = h('div', { style: 'margin-top:4px;padding-top:4px;border-top:1px solid var(--border,#333)' });
        for (const ab of evt.advisorBriefings) {
          const advisor = this.state.advisors.find(a => a.id === ab.advisorId);
          const advisorEl = h('div', { style: 'font-size:0.85em;opacity:0.85;margin-bottom:2px;padding-left:8px;border-left:2px solid var(--accent,#4488ff)' });
          advisorEl.append(
            h('span', { style: 'font-weight:600;font-size:0.9em' }, `${advisor?.title ?? ab.advisorId}: `),
            h('span', null, ab.text),
          );
          advisorSection.appendChild(advisorEl);
        }
        card.appendChild(advisorSection);
      }
      this.actionsEl.appendChild(card);
    }

    const btn = h('button', { style: 'margin-top:6px;padding:6px 16px;border-radius:4px;cursor:pointer;background:var(--accent,#4488ff);color:#fff;border:none;font-weight:600' }, 'Proceed to Actions →');
    btn.addEventListener('click', () => this.enterActionPhase());
    this.actionsEl.appendChild(btn);
  }

  // ── Action phase (Shadow President: categorised actions) ───────────────
  private renderActionPhase(): void {
    const label = h('div', { style: 'font-weight:600;margin-bottom:4px;font-size:1.05em' }, '🎯 Choose Your Action');
    this.actionsEl.appendChild(label);

    const actions = getAvailableActions(this.state);
    const categories: GameActionCategory[] = ['diplomatic', 'economic', 'military', 'covert'];

    for (const cat of categories) {
      const catActions = actions.filter(a => a.category === cat);
      if (catActions.length === 0) continue;

      const details = document.createElement('details');
      details.style.cssText = 'margin-bottom:4px';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;font-weight:600;font-size:0.9em;padding:4px 0';
      summary.textContent = `${CATEGORY_LABELS[cat]} (${catActions.length})`;
      details.appendChild(summary);

      // Group by action type
      const byType = new Map<string, GameAction[]>();
      for (const a of catActions) {
        const group = byType.get(a.type) ?? [];
        group.push(a);
        byType.set(a.type, group);
      }

      for (const [, group] of byType) {
        const first = group[0];
        const typeHeader = h('div', { style: 'font-size:0.82em;opacity:0.7;margin:4px 0 2px 8px' }, first.description);
        details.appendChild(typeHeader);

        for (const a of group) {
          const canAfford = this.canAfford(a);
          const riskBadge = a.risk > 0 ? ` [Risk: ${a.risk}%]` : '';
          const btn = h('button', {
            style: `padding:3px 8px;border-radius:3px;cursor:${canAfford ? 'pointer' : 'not-allowed'};opacity:${canAfford ? '1' : '0.4'};background:var(--panel-bg,#1a1a2e);border:1px solid var(--border,#333);color:inherit;font-size:0.8em;text-align:left;width:100%;margin-bottom:1px`,
          }, a.label + riskBadge);
          if (canAfford) {
            btn.addEventListener('click', () => this.executeAction(a));
          }
          details.appendChild(btn);
        }
      }
      this.actionsEl.appendChild(details);
    }
  }

  // ── Game over ──────────────────────────────────────────────────────────
  private renderGameOver(): void {
    let reason = 'Your term has ended.';
    if (this.state.approval < 15) reason = '⚖️ You have been IMPEACHED. Domestic support collapsed.';
    else if (this.state.defcon <= 1) reason = '☢️ DEFCON 1 — Nuclear war has begun. Civilisation ends.';

    this.actionsEl.appendChild(h('div', { style: 'font-weight:700;font-size:1.1em;margin-bottom:4px;color:#ff5555' }, 'GAME OVER'));
    this.actionsEl.appendChild(h('div', { style: 'margin-bottom:8px;font-style:italic' }, reason));
    this.actionsEl.appendChild(h('div', { style: 'font-weight:600;margin-bottom:6px' }, `Final Score: ${this.state.score}`));

    for (const obj of this.state.objectives) {
      const mark = obj.completed ? '✅' : '❌';
      this.actionsEl.appendChild(h('div', null, `${mark} ${obj.description}`));
    }

    const btn = h('button', { style: 'margin-top:10px;padding:6px 16px;border-radius:4px;cursor:pointer;background:var(--accent,#4488ff);color:#fff;border:none;font-weight:600' }, 'New Game');
    btn.addEventListener('click', () => this.restart());
    this.actionsEl.appendChild(btn);
  }

  private canAfford(action: GameAction): boolean {
    for (const [k, v] of Object.entries(action.cost) as [keyof GameResources, number][]) {
      if ((this.state.resources[k] ?? 0) < v) return false;
    }
    return true;
  }
}
