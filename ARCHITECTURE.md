# ARCHITECTURE.md — GAFFER '26

## Design Principles (Architecture Guardian)

1. **Separation of concerns.** Core (infra) ↔ Domain (entities & rules) ↔ Sim (systems) ↔ UI (render). Dependencies point inward: UI → Sim → Domain → Core. Core never imports Domain.
2. **Single chokepoint.** Every state mutation goes through `dispatch(action)`. UI code never writes to `GameState` directly. This gives us validation, logging, undo, and replay in one place.
3. **Determinism.** All randomness in simulation flows through `mulberry32(saveSeed + day + matchId + eventOrdinal)`. No `Math.random()` in `src/sim/**` or `src/core/**`. UI may use `Math.random()` for non-sim cosmetics (sparkles, etc.).
4. **Event-driven UI.** The simulation emits typed events; UI panels subscribe to event types and re-render only when relevant. The simulation never touches the DOM.
5. **Surgical preservation.** Existing CSS and DOM markup are preserved. Render functions keep their signatures; only their data source changes (globals → `GameState` selectors).
6. **No magic.** No `// TODO`, no placeholders, no `console.log` left in shipped paths. Logger handles all diagnostic output.

## Layered Architecture

```
┌─────────────────────────────────────────────────────────┐
│  UI Layer (ui/panels.js, ui/matchOverlay.js)            │  reads GameState, emits actions
├─────────────────────────────────────────────────────────┤
│  Simulation Layer (sim/calendar, sim/tick, sim/match/*) │  pure functions of (state, prng) -> events
├─────────────────────────────────────────────────────────┤
│  Domain Layer (domain/entities, domain/invariants)      │  entity shapes, validation rules
├─────────────────────────────────────────────────────────┤
│  Core Layer (core/prng, core/eventBus, core/state,      │  infra: PRNG, events, dispatch, persistence
│              core/persistence, core/logger)             │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

```
User clicks "Continue"
  │
  ▼
ui.panels dispatch({type:'ADVANCE_DAY'})
  │
  ▼
core.state.dispatch
  ├─ validate(action, state)            // domain/invariants
  ├─ newState = reducer(state, action)  // pure
  ├─ events = newState.__emitted        // array of typed events
  ├─ persistence.autosave(newState)     // debounced localStorage write
  ├─ logger.info('ADVANCE_DAY', {day})  // async
  └─ bus.emit(events)                   // typed fan-out
        │
        ▼
      UI panels subscribed to relevant event types re-render
```

## GameState Shape (Authoritative)

```js
GameState = {
  meta: {
    saveId, schemaVersion, createdAt, lastPlayedAt, autosaveSlot, seed
  },
  clock: {
    date: ISO, seasonYear, matchweekPtr, phase:
      'pre-season' | 'in-season' | 'window-open' | 'window-closed' | 'off-season',
    dayNumber
  },
  entities: {
    players:   Map<UUID, Player>,
    clubs:     Map<UUID, Club>,
    staff:     Map<UUID, Staff>,         // manager, scouts, coaches
    agents:    Map<UUID, Agent>,
    facilities:Map<UUID, Facility>,
    sponsors:  Map<UUID, Sponsor>
  },
  relationships: {
    contracts:        Map<UUID, Contract>,
    negotiations:     Map<UUID, Negotiation>,
    scoutAssignments: Map<UUID, ScoutAssignment>,
    rivalries:        Array<{a, b, intensity}>
  },
  competitions: {
    league: {
      table:   Array<LeagueRow>,         // RECOMPUTABLE — never source of truth
      fixtures:Array<Fixture>,           // source of truth for schedule
      matchweek: number
    },
    cups: Array<CupCompetition>
  },
  finance: {
    balance, transferBudget, wageBudget, wageCeiling,
    transactions: Array<Transaction>,    // append-only ledger
    projections: { monthlyRevenue, monthlyWages }   // RECOMPUTABLE
  },
  inbox: Array<Message>,
  media: { headlines: Array<Headline>, fanSentiment: number },
  board: { confidence: {matches, finance, squad}, expectations, seasonTargets },
  manager: { ...PlayerManagerProfile, xp, skills, history },
  cache: {
    // Everything here is recomputable. Marked so persistence can drop it on save
    // and reconstruct on load. Never the source of truth.
    leagueTableVersion: number,
    formArraysVersion:  number
  }
}
```

## Determinism Contract

- `prng = makePRNG(seed)` — once per save.
- For each day tick: `dayPRNG = prng.fork('day-' + dayNumber)`.
- For each match: `matchPRNG = dayPRNG.fork('match-' + fixtureId)`.
- For each event within a match: `eventPRNG = matchPRNG.fork('evt-' + eventOrdinal)`.
- Forks are deterministic: same parent state + same fork path = same child sequence.
- Replaying a save from any checkpoint reproduces the entire world state.

## Extension Points (Future Features)

- **Transfers system (Step 3+):** Add `dispatch({type:'BID_SUBMITTED', payload})`. Reducer extends `relationships.negotiations`. New `sim/transfers/` module.
- **Training system:** Add `sim/training/` module emitting `TRAINING_COMPLETED` events. UI subscribes to refresh player form.
- **Multi-club AI:** `sim/ai/clubDecisions.js` runs in `middayPhase`. Each AI club has a `managerPersonality` driving transfer & contract decisions.
- **IndexedDB swap:** Replace `persistence.js` adapter; same interface.

## Adding a New Feature

1. Define the entity shape in `domain/entities.js`.
2. Define invariants in `domain/invariants.js`.
3. Add action types to `core/state.js` reducer.
4. Emit typed events from the reducer or from the sim module.
5. Subscribe UI panels to the new event types.
6. Update `PROJECT_MAP.md` — remove from `[ORPHANS & PENDING]`.

## Step 3 & 4 Module Tree

```
src/sim/
├── training/                    (Step 3.1) Weekly microcycle
│   ├── sessions.js              Session types: tactical/technical/physical/recovery/setpiece/matchprep
│   └── microcycle.js            7-day scheduler with assistant-coach auto-schedule
├── development/                 (Step 3.2–3.9) Player development
│   ├── curves.js                Position curves: GK/DEF/FB/MID/FWD peak ages & decline onset
│   ├── growth.js                Layered growth: gap × age × playing time × training × personality
│   ├── potential.js             PA as band, determination pull, late bloomers, breakout events
│   ├── form.js                  Weighted rolling form, confidence feedback, position volatility
│   ├── aging.js                 Yearly decline, adaptation layer (mental compensates physical)
│   ├── mentorship.js            Mentor pairings (28+ leadership 70+ prof 75+ → U23)
│   └── milestones.js            First-start/goal/90, OVR tier crossings, wonderkid confirmations
├── injuries/                    (Step 3.6) Injury state machine
│   ├── state.js                 Taxonomy (knock→ACL), setbacks, re-injury vulnerability
│   └── recovery.js              Sharpness axis (separate from fitness), return-to-play assessment
└── transfers/                   (Step 4) Transfer market & negotiation
    ├── valuation.js             Dynamic value (ability × age × form × contract × scarcity × market)
    ├── negotiation.js           FSM: IDLE→ENQUIRY→BID→COUNTER→ACCEPTED→TERMS→MEDICAL→ANNOUNCED
    ├── agents.js                Personalities: Greedy/Aggressive/Loyal/Patient/Famous; memory warmth
    ├── ai-clubs.js              AI behavior: needs assessment, shortlisting, recruitment identity
    ├── player-agency.js         Desire model, stance (wants_move/indifferent/wants_to_stay)
    ├── sell-side.js             Incoming bids on user players, replacement planning
    ├── loans.js                 Dry loan / loan-with-option / loan-with-obligation
    ├── free-agents.js           Unattached pool (skews 30+ veterans or U22 released youth)
    ├── bosman.js                Pre-contracts from Jan 1 for <6mo contracts
    └── deadline.js              Deadline-day compression + panic dynamics + window close
```

## Step 3 — Development Architecture

Growth is layered: `weeklyGrowth = gapMult × ageMult × playingTimeMult × trainingMult × profMult × ambMult × lateBloomerMult`

- `gapMult` (potential.js): linear from 0.1 (at ceiling) to 1.6 (15+ points below PA)
- `ageMult` (curves.js): position-specific. FB peaks 23-27, GK peaks 28-32, ST peaks 24-28
- `playingTimeMult`: 0.5 (underplayed) → 1.15 (75%+ minutes), with burnout risk
- `trainingMult`: derived from session contributions, capped at 1.5
- `profMult` / `ambMult`: ±15% from personality hidden attributes
- `lateBloomerMult`: 1.4× at ages 24-26 if flagged (8% of prospects)

Form (form.js) is a weighted rolling average of last 6 match ratings:
weights = [0.30, 0.22, 0.17, 0.13, 0.10, 0.08] (most recent first)

Sharpness (recovery.js) is separate from fitness:
- +8 per 90' played, +4 per 45', +2 per U21 appearance
- -3 per week without minutes
- Rusty player (sharp <30): -15% effective attributes

## Step 4 — Transfer Market Architecture

Valuation (valuation.js) is computed internally; the user only sees a scouted
range whose width depends on scouting confidence:
- FullyKnown: ±2%, WellKnown: ±8%, Scouted: ±15%, Rumored: ±30%

Negotiation FSM (negotiation.js):
```
IDLE → ENQUIRY → BID_SUBMITTED → {ACCEPTED | COUNTER_OFFERED | REJECTED | WITHDRAWN}
                                       ↓
COUNTER_OFFERED → {ACCEPT | COUNTER_BACK | WITHDRAW}  (max 4 rounds, 2 on deadline day)
                                       ↓
                                  ACCEPTED → PERSONAL_TERMS → {AGREED | COLLAPSED}
                                                                   ↓
                                                              AGREED → MEDICAL → {ANNOUNCED | COLLAPSED}
```

Agent personalities (agents.js) drive personal-terms difficulty:
- Greedy: opens +35%, patience 4, commission 10%, plays phantom-rival tactics
- Aggressive: opens +20%, patience 2 (hard deadlines), press leaks
- Loyal: opens +5%, patience 6, values playing-time guarantees
- Patient: opens +10%, patience 8, wants release clauses
- Famous: opens +25%, patience 5, commission 12%, elite access

Agent memory warmth persists across deals: fair_deal +5, lowball -10, broken_promise -20.

AI club behavior (ai-clubs.js): each AI club has a recruitment identity
(developer/contender/opportunist) derived from rep + budget. They scan squad
needs weekly, shortlist targets from the global pool, and bid against you.
AI-vs-AI transfers complete silently and update the activity feed.
