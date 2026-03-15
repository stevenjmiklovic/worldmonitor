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
  attachAdvisorBriefings,
  applyEvents,
  resolveAction,
  advancePhase,
  getAvailableActions,
  computeScore,
  setBudget,
} from '@/services/game-engine';
import { generateEventsFromNews } from '@/services/game-events-ai';
import type { GameState, GameAction, GameEvent, GameBudget, GameActionCategory, GameResources } from '@/types';

type HudChangeCallback = (state: GameState) => void;

const DEFCON_COLORS: Record<number, string> = {
  5: '#44ff88', 4: '#88cc44', 3: '#ffcc44', 2: '#ff8844', 1: '#ff3333',
};

const DEFCON_LABELS: Record<number, string> = {
  5: 'Peacetime', 4: 'Elevated Alert', 3: 'Increased Readiness', 2: 'Armed Forces Ready', 1: 'Nuclear War Imminent',
};

const CATEGORY_LABELS: Record<GameActionCategory, string> = {
  diplomatic: '🤝 Diplomatic',
  economic:   '💰 Economic',
  military:   '⚔️ Military',
  covert:     '🕵️ Covert',
};

const PHASE_LABELS: Record<string, string> = {
  briefing:   'Intel Briefing',
  action:     'Command Decision',
  resolution: 'Processing Orders',
  gameOver:   'After Action Report',
};

/** Flavor lines cycled during the resolution pause (keyed by turn % length). */
const RESOLUTION_LINES = [
  'Secure channels processing your directives…',
  'Field assets confirming operational details…',
  'Encrypted cables routed through command net…',
  'Geopolitical situation assessed at all levels…',
  'Satellite feeds updating the strategic picture…',
  'Intelligence cadre briefing regional analysts…',
  'Allied embassies acknowledging your communiqué…',
  'National Security Council convened in the Situation Room…',
];

/** Distinctive colors per advisor for the initial badge. */
const ADVISOR_COLORS: Record<string, string> = {
  secState:    '#4488ff',
  secDef:      '#ff6644',
  ciaDirector: '#9944ff',
  econAdvisor: '#44cc88',
  jointChiefs: '#ffaa44',
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

  /** Current turn's world events shown in the briefing. */
  private currentEvents: GameEvent[] = [];
  /** Incremented each time startBriefing() is called; guards against stale async results. */
  private briefingGenId = 0;
  /** Score at the start of the current turn, used to show per-turn delta. */
  private turnStartScore = 0;

  constructor(private readonly newsProvider?: () => string[]) {
    super({ id: 'game-hud', title: 'The Great Game — Command', trackActivity: false });
    this.state = createInitialState();
    this.buildUI();
    void this.startBriefing();
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
    const statusRow = h('div', { style: 'display:flex;gap:16px;margin-bottom:6px;font-size:0.88em', 'aria-live': 'polite', 'aria-atomic': 'true' });
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

  private async startBriefing(): Promise<void> {
    const myId = ++this.briefingGenId;
    // Capture score at start of briefing generation (after events are applied it may change)
    // On turn 1 the pre-event score is 0 which would produce a misleading delta, so we
    // update turnStartScore after the first render instead.
    const isFirstTurn = this.state.turn === 1 && this.state.score === 0;
    if (!isFirstTurn) this.turnStartScore = this.state.score;

    // Show a loading placeholder immediately while the AI call is in flight.
    this.actionsEl.innerHTML = '';
    this.actionsEl.append(
      h('div', { style: 'font-weight:600;margin-bottom:4px;font-size:1.05em' }, '📡 Intelligence Briefing'),
      h('div', { style: 'opacity:0.6;font-style:italic;font-size:0.85em' }, 'Analysing current world events…'),
    );

    // Try AI-generated events from live news; fall back to deterministic templates.
    const headlines = this.newsProvider?.() ?? [];
    let events: GameEvent[] | null = null;
    if (headlines.length >= 2) {
      events = await generateEventsFromNews(this.state, headlines);
    }
    if (myId !== this.briefingGenId) return; // a newer briefing superseded this one

    this.currentEvents = events?.length ? events : generateTurnEvents(this.state);
    attachAdvisorBriefings(this.state, this.currentEvents);
    applyEvents(this.state, this.currentEvents);
    this.state.score = computeScore(this.state);
    // After first-turn events are applied, anchor the score baseline so the delta shows 0
    if (isFirstTurn) this.turnStartScore = this.state.score;
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
    this.state.score = computeScore(this.state);
    this.render(); // stays in action phase — player may take more actions
    this.notify();
  }

  private endTurn(): void {
    advancePhase(this.state); // action → resolution
    this.render();
    this.notify();

    setTimeout(() => {
      advancePhase(this.state); // resolution → briefing or gameOver
      if (this.state.phase === 'briefing') {
        void this.startBriefing();
      } else {
        this.render();
        this.notify();
      }
    }, 1200);
  }

  private restart(): void {
    this.state = createInitialState();
    this.currentEvents = [];
    void this.startBriefing();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private render(): void {
    // Top bar
    this.turnEl.textContent  = `Turn ${this.state.turn} / ${this.state.maxTurns}`;
    this.phaseEl.textContent = PHASE_LABELS[this.state.phase] ?? this.state.phase;
    const scoreDelta = this.state.score - this.turnStartScore;
    const deltaStr = scoreDelta !== 0 ? ` (${scoreDelta > 0 ? '+' : ''}${scoreDelta})` : '';
    this.scoreEl.textContent = `Score: ${this.state.score}${deltaStr}`;

    // Approval (Shadow President)
    const ap = this.state.approval;
    const apClr = ap > 50 ? '#44ff88' : ap > 25 ? '#ffcc44' : '#ff5555';
    this.approvalEl.replaceChildren(
      'Approval: ',
      h('b', { style: `color:${apClr}` }, `${ap}%`),
      ...(ap < 25 ? [h('span', { style: 'color:#ff5555;font-size:0.8em;margin-left:6px' },
        `⚠️ ${ap < 15 ? 'IMPEACHED' : 'IMPEACHMENT RISK'}`)] : []),
    );

    // DEFCON (Shadow President)
    const dcClr = DEFCON_COLORS[this.state.defcon] ?? '#ff3333';
    const dcLabel = DEFCON_LABELS[this.state.defcon] ?? '';
    this.defconEl.replaceChildren(
      'DEFCON: ',
      h('b', { style: `color:${dcClr};padding:1px 5px;background:${dcClr}22;border-radius:3px` }, String(this.state.defcon)),
      h('span', { style: 'opacity:0.7;font-size:0.9em' }, ` — ${dcLabel}`),
    );

    // Resources with progress bars
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
      const pct = Math.min(100, Math.round((val / 200) * 100));
      const barClr = pct > 50 ? '#44ff88' : pct > 25 ? '#ffcc44' : '#ff5555';
      const wrap = h('div', { style: 'margin-bottom:3px' });
      const row = h('div', { style: 'display:flex;justify-content:space-between' });
      row.append(h('span', null, label), h('span', { style: 'font-weight:600' }, `${val}`), h('span', { style: 'opacity:0.35;font-size:0.8em' }, '/200'));
      const bar = h('div', { style: `height:2px;background:${barClr};width:${pct}%;border-radius:1px;transition:width 0.4s,background 0.4s;margin-top:1px;opacity:0.8` });
      wrap.append(row, bar);
      this.resourcesEl.appendChild(wrap);
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
      this.renderResolutionPhase();
    } else if (this.state.phase === 'gameOver') {
      this.renderGameOver();
    }
  }

  // ── Resolution interstitial ─────────────────────────────────────────────
  private renderResolutionPhase(): void {
    const line = RESOLUTION_LINES[this.state.turn % RESOLUTION_LINES.length] ?? RESOLUTION_LINES[0]!;
    this.actionsEl.append(
      h('div', { style: 'font-weight:600;font-size:1.0em;margin-bottom:6px;opacity:0.9' }, '⏳ Processing Orders'),
      h('div', { style: 'opacity:0.65;font-style:italic;font-size:0.88em' }, line),
    );
  }

  // ── Budget sliders ──────────────────────────────────────────────────────
  private renderBudget(): void {
    this.budgetEl.innerHTML = '';

    const keys: (keyof GameBudget)[] = ['defense', 'intelligence', 'diplomacy', 'economy', 'technology'];
    const currentTotal = keys.reduce((s, k) => s + this.state.budget[k], 0);
    const totalEl = h('span', { style: `font-weight:600;color:${currentTotal === 100 ? '#44ff88' : '#ff5555'}` }, `${currentTotal}/100`);

    const balanceBtn = h('button', {
      style: 'font-size:0.75em;padding:1px 6px;border-radius:3px;cursor:pointer;background:var(--panel-bg,#1a1a2e);border:1px solid var(--border,#333);color:inherit',
      title: 'Scale current allocation proportionally to sum to 100',
      'aria-label': 'Balance budget to 100',
    }, 'Balance');

    // Wrap in <details> so it can be collapsed
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.style.cssText = 'cursor:pointer;font-weight:600;font-size:0.9em;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:6px;padding:2px 0';
    summary.append(document.createTextNode('Budget Allocation'), totalEl, balanceBtn);
    details.appendChild(summary);

    const labels: Record<keyof GameBudget, string> = {
      defense: '🛡️ Defense', intelligence: '🕵️ Intelligence', diplomacy: '🤝 Diplomacy',
      economy: '💰 Economy', technology: '🔬 Technology',
    };
    const labelText: Record<keyof GameBudget, string> = {
      defense: 'Defense', intelligence: 'Intelligence', diplomacy: 'Diplomacy',
      economy: 'Economy', technology: 'Technology',
    };

    const grid = h('div', { style: 'display:grid;grid-template-columns:auto 50px 1fr;gap:2px 8px;align-items:center;margin-top:4px' });
    const inputs: Record<string, HTMLInputElement> = {};
    const valSpans: Record<string, HTMLElement> = {};

    const syncTotal = () => {
      const newTotal = this.tryApplyBudget(keys, inputs);
      totalEl.textContent = `${newTotal}/100`;
      totalEl.style.color = newTotal === 100 ? '#44ff88' : '#ff5555';
    };

    for (const key of keys) {
      const lbl = h('span', null, labels[key]);
      const valSpan = h('span', { style: 'font-weight:600;text-align:right' }, String(this.state.budget[key]));
      valSpans[key] = valSpan;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '60';
      slider.value = String(this.state.budget[key]);
      slider.style.cssText = 'width:100%;cursor:pointer';
      slider.setAttribute('aria-label', `${labelText[key]} budget allocation`);
      inputs[key] = slider;

      slider.addEventListener('input', () => {
        valSpan.textContent = slider.value;
        syncTotal();
      });

      grid.append(lbl, valSpan, slider);
    }

    balanceBtn.addEventListener('click', () => {
      // Proportional rescale: scale current values so they sum to 100.
      // If all sliders are zero, distribute evenly.
      const raw = keys.map(k => parseInt(inputs[k]!.value, 10) || 0);
      const rawTotal = raw.reduce((a, b) => a + b, 0);
      const scaled = rawTotal > 0
        ? raw.map(v => Math.min(60, Math.max(0, Math.round(v * 100 / rawTotal))))
        : keys.map(() => 20);
      // Absorb rounding remainder on the largest bucket.
      const scaledTotal = scaled.reduce((a, b) => a + b, 0);
      const diff = 100 - scaledTotal;
      if (diff !== 0) {
        const maxIdx = scaled.reduce((mi, _v, i) => (scaled[i]! > scaled[mi]! ? i : mi), 0);
        scaled[maxIdx] = Math.min(60, Math.max(0, scaled[maxIdx]! + diff));
      }
      keys.forEach((k, i) => {
        inputs[k]!.value = String(scaled[i]);
        valSpans[k]!.textContent = String(scaled[i]);
      });
      syncTotal();
    });

    details.appendChild(grid);
    this.budgetEl.appendChild(details);
  }

  private tryApplyBudget(keys: (keyof GameBudget)[], inputs: Record<string, HTMLInputElement>): number {
    const budget = {} as GameBudget;
    for (const k of keys) budget[k] = parseInt(inputs[k]!.value, 10) || 0;
    const total = keys.reduce((s, k) => s + budget[k], 0);
    if (total === 100) {
      setBudget(this.state, budget);
    }
    return total;
  }

  // ── Briefing phase ──────────────────────────────────────────────────────
  private renderBriefingPhase(): void {
    const label = h('div', { style: 'font-weight:600;margin-bottom:4px;font-size:1.05em' }, '📋 Intelligence Briefing');
    this.actionsEl.appendChild(label);

    // Show only pending deadline events from PREVIOUS turns — current-turn events are
    // already shown below as normal event cards (with their own deadline badge).
    const stillPending = this.state.pendingEvents.filter(e => e.turn < this.state.turn);
    if (stillPending.length > 0) {
      const urgentHeader = h('div', { style: 'font-size:0.82em;font-weight:600;color:#ff6644;margin-bottom:4px' },
        `ACTIVE CRISES (${stillPending.length}) — Act or face escalation`);
      this.actionsEl.appendChild(urgentHeader);
      for (const pe of stillPending) {
        const turns = pe.deadline ?? 1;
        const urgentColor = turns <= 1 ? '#ff3333' : '#ff8844';
        const card = h('div', { style: `background:rgba(255,80,50,0.08);padding:5px 8px;border-radius:4px;margin-bottom:4px;font-size:0.84em;border-left:3px solid ${urgentColor}` });
        const headlineRow = h('div', { style: 'display:flex;align-items:center;gap:6px;font-weight:600' });
        headlineRow.append(
          h('span', null, pe.headline),
          h('span', {
            style: `margin-left:auto;font-size:0.8em;padding:1px 5px;border-radius:3px;background:${urgentColor}22;color:${urgentColor};font-weight:700;white-space:nowrap`,
          }, `${turns} turn${turns !== 1 ? 's' : ''} remaining`),
        );
        card.append(headlineRow, h('div', { style: 'opacity:0.65;font-size:0.88em;margin-top:1px' }, pe.description));
        this.actionsEl.appendChild(card);
      }
      this.actionsEl.appendChild(h('div', { style: 'border-top:1px solid var(--border,#333);margin:4px 0 6px' }));
    }

    for (const evt of this.currentEvents) {
      this.renderEventCard(evt);
    }

    const btn = h('button', { style: 'margin-top:6px;padding:6px 16px;border-radius:4px;cursor:pointer;background:var(--accent,#4488ff);color:#fff;border:none;font-weight:600' }, 'Proceed to Actions →');
    btn.addEventListener('click', () => this.enterActionPhase());
    this.actionsEl.appendChild(btn);
  }

  private renderEventCard(evt: GameEvent): void {
    const isAi      = evt.id.startsWith('ai-');
    const isChained = evt.isChained === true;
    const hasDeadline = evt.deadline != null;
    const deadlineTurns = evt.deadline ?? 0;
    const urgentColor = deadlineTurns <= 1 ? '#ff3333' : '#ff8844';
    const accentClr = hasDeadline ? urgentColor : isChained ? '#cc88ff' : isAi ? '#44ccff' : '#ffcc44';
    const card = h('div', { style: `background:var(--panel-bg,#1a1a2e);padding:6px 8px;border-radius:4px;margin-bottom:6px;font-size:0.85em;border-left:3px solid ${accentClr}` });

    const headlineRow = h('div', { style: 'display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:2px;flex-wrap:wrap' });
    headlineRow.append(h('span', null, evt.headline));
    if (isAi) {
      headlineRow.appendChild(h('span', {
        style: 'font-size:0.7em;padding:1px 4px;border-radius:3px;background:#44ccff22;color:#44ccff;font-weight:600;flex-shrink:0',
      }, 'AI'));
    }
    if (isChained) {
      headlineRow.appendChild(h('span', {
        style: 'font-size:0.7em;padding:1px 4px;border-radius:3px;background:#cc88ff22;color:#cc88ff;font-weight:600;flex-shrink:0',
      }, '↳ Follow-up'));
    }
    if (hasDeadline) {
      headlineRow.appendChild(h('span', {
        style: `font-size:0.78em;padding:1px 5px;border-radius:3px;background:${urgentColor}22;color:${urgentColor};font-weight:700;margin-left:auto;white-space:nowrap`,
      }, `${deadlineTurns} turn${deadlineTurns !== 1 ? 's' : ''} to act`));
    }
    card.append(
      headlineRow,
      h('div', { style: 'opacity:0.7;font-size:0.9em;margin-bottom:4px' }, evt.description),
    );

    // Advisor briefings — collapsible to keep the panel compact
    if (evt.advisorBriefings?.length) {
      const details = document.createElement('details');
      details.style.cssText = 'margin-top:4px;padding-top:4px;border-top:1px solid var(--border,#333)';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;font-size:0.82em;opacity:0.7;list-style:none;user-select:none';
      summary.textContent = `Advisory Cabinet (${evt.advisorBriefings.length})`;
      details.appendChild(summary);

      for (const ab of evt.advisorBriefings) {
        const advisor = this.state.advisors.find(a => a.id === ab.advisorId);
        const color = ADVISOR_COLORS[ab.advisorId] ?? '#888';
        const initial = (advisor?.name ?? ab.advisorId)[0]?.toUpperCase() ?? '?';

        const advisorEl = h('div', { style: 'display:flex;gap:6px;align-items:flex-start;margin-top:4px;font-size:0.85em' });
        const badge = h('span', {
          style: `display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:${color};color:#fff;font-size:0.75em;font-weight:700;flex-shrink:0;margin-top:1px`,
        }, initial);
        const body = h('div', null,
          h('span', { style: `font-weight:600;color:${color}` }, `${advisor?.title ?? ab.advisorId}: `),
          h('span', { style: 'opacity:0.85' }, ab.text),
        );
        advisorEl.append(badge, body);
        details.appendChild(advisorEl);
      }
      card.appendChild(details);
    }
    this.actionsEl.appendChild(card);
  }

  // ── Action phase (Shadow President: categorised actions) ───────────────
  private renderActionPhase(): void {
    const actionsTaken = this.state.log.filter(e => e.id.startsWith('act-') && e.turn === this.state.turn).length;
    const header = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px' });
    header.append(
      h('div', { style: 'font-weight:600;font-size:1.05em' }, '🎯 Choose Your Actions'),
      h('span', { style: 'font-size:0.82em;opacity:0.7' }, `${actionsTaken} action${actionsTaken !== 1 ? 's' : ''} taken`),
    );
    this.actionsEl.appendChild(header);

    const actions = getAvailableActions(this.state);
    const categories: GameActionCategory[] = ['diplomatic', 'economic', 'military', 'covert'];

    // Regions with active deadline crises — highlight them in action phase
    const urgentRegions = new Set(this.state.pendingEvents.filter(e => e.turn < this.state.turn).map(e => e.region));

    for (const cat of categories) {
      const catActions = actions.filter(a => a.category === cat);
      if (catActions.length === 0) continue;

      // Separate locked (tech-unlockable) from active actions
      const activeActions = catActions.filter(a => !a.locked);
      const lockedByType = new Map<string, GameAction>();
      for (const a of catActions.filter(a => a.locked)) {
        if (!lockedByType.has(a.type)) lockedByType.set(a.type, a);
      }

      const details = document.createElement('details');
      details.style.cssText = 'margin-bottom:4px';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;font-weight:600;font-size:0.9em;padding:4px 0';
      summary.textContent = `${CATEGORY_LABELS[cat]} (${activeActions.length})`;
      details.appendChild(summary);

      // Group active actions by type
      const byType = new Map<string, GameAction[]>();
      for (const a of activeActions) {
        const group = byType.get(a.type) ?? [];
        group.push(a);
        byType.set(a.type, group);
      }

      for (const [, group] of byType) {
        const first = group[0]!;
        const typeHeader = h('div', { style: 'font-size:0.82em;opacity:0.7;margin:4px 0 2px 8px' }, first.description);
        details.appendChild(typeHeader);

        for (const a of group) {
          const canAfford = this.canAfford(a);
          const riskBadge = a.risk > 0 ? ` [Risk: ${a.risk}%]` : '';
          const isUrgent = urgentRegions.has(a.targetRegion);
          const costStr = Object.entries(a.cost).map(([k, v]) => `${v} ${k}`).join(', ');
          const urgentStyle = isUrgent ? 'border-left:2px solid #ff8844;' : '';
          const btn = h('button', {
            style: `padding:3px 8px;border-radius:3px;cursor:${canAfford ? 'pointer' : 'not-allowed'};opacity:${canAfford ? '1' : '0.4'};background:var(--panel-bg,#1a1a2e);border:1px solid var(--border,#333);${urgentStyle}color:inherit;font-size:0.8em;text-align:left;width:100%;margin-bottom:1px`,
            title: `Cost: ${costStr}${a.risk > 0 ? ` | Risk: ${a.risk}%` : ''}${isUrgent ? ' | ⚠ Active crisis' : ''}`,
            'aria-disabled': canAfford ? 'false' : 'true',
          }, a.label + riskBadge + (isUrgent ? ' ⚠' : ''));
          if (canAfford) {
            btn.addEventListener('click', () => this.executeAction(a));
          }
          details.appendChild(btn);
        }
      }

      // Locked tech-unlock actions — shown once per unique type at the bottom
      if (lockedByType.size > 0) {
        const lockHeader = h('div', { style: 'font-size:0.78em;opacity:0.45;margin:6px 0 2px 8px;font-style:italic' }, 'Advanced (locked):');
        details.appendChild(lockHeader);
        for (const a of lockedByType.values()) {
          const lockEl = h('div', {
            style: 'padding:3px 8px;margin-bottom:1px;border-radius:3px;opacity:0.35;font-size:0.79em;border:1px dashed var(--border,#333);color:inherit;display:flex;gap:6px;align-items:center',
          });
          lockEl.append(
            h('span', null, `🔒 ${a.type.replace(/([A-Z])/g, ' $1').trim()}`),
            h('span', { style: 'margin-left:auto;font-size:0.85em' }, a.unlockRequirement ?? ''),
          );
          details.appendChild(lockEl);
        }
      }

      this.actionsEl.appendChild(details);
    }

    const endTurnBtn = h('button', {
      style: 'margin-top:8px;padding:6px 16px;border-radius:4px;cursor:pointer;background:var(--accent,#4488ff);color:#fff;border:none;font-weight:600',
    }, 'End Turn →');
    endTurnBtn.addEventListener('click', () => this.endTurn());
    this.actionsEl.appendChild(endTurnBtn);
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
