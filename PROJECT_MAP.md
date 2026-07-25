# PROJECT_MAP.md — GAFFER '26

Living map of the project. Updated as features land.

## [TECH_STACK]
- **Runtime:** Vanilla JS (ES2022), native ES modules (`<script type="module">`)
- **No build step.** Served by any static HTTP server (Python `http.server 8000`).
- **Persistence:** `localStorage` (versioned JSON blob). Swap surface for IndexedDB later.
- **Determinism:** `mulberry32` PRNG seeded per save. **Zero** `Math.random()` in simulation code.
- **No framework.** DOM render functions read from `GameState` via subscription.

## [SYSTEM_FLOW]
```
UI (button click)
  └─> dispatch({type, payload})               // single chokepoint
        ├─ validate(action, state)            // invariants enforced
        ├─ reducer(state, action)             // pure -> newState + emitted events
        ├─ persist(newState)                  // autosave (debounced)
        └─ bus.emit(events)                   // typed events
              └─> UI panels subscribed to event types re-render (diff-based)

Continue button:
  dispatch({type:'ADVANCE_DAY'})
    └─> tick(state, dayNumber)
          ├─ morningPhase  : training, fatigue, morale, scout ticks
          ├─ middayPhase   : inbox generation, AI club decisions, media
          ├─ eveningPhase  : if matchday -> run match engine; else recovery + finance
          └─ if matchday & user match -> pause for match overlay
```

## [ARCHITECTURE]
```
src/
├── main.js                Bootstrap: wire DOM, load/save, mount UI
├── core/                  Infrastructure (no domain logic)
│   ├── prng.js            mulberry32 + helpers (range, pick, gauss)
│   ├── eventBus.js        Typed emitter, subscribe by event type
│   ├── logger.js          Async ring-buffered logger (levels: trace/debug/info/warn/error)
│   ├── state.js           GameState shape, dispatch, reducer, selectors
│   └── persistence.js     Save/load/autosave/migrate
├── domain/                Entity definitions & rules
│   ├── entities.js        Shape factories: Player, Club, Contract, Fixture, etc.
│   └── invariants.js      validate(state) — squad size, wage ceiling, fixture sanity
├── sim/                   Simulation systems
│   ├── calendar.js        34-MW fixture generator with constraint solver
│   ├── tick.js            Day resolution (morning/midday/evening phases)
│   └── match/
│       ├── engine.js      Orchestrator: MatchContext, main loop, possession stream
│       ├── prematch.js    Lineup lock, tactical matchup matrix, condition mods
│       ├── possession.js  Possession phase model (zone progression, turnovers)
│       ├── xg.js          Base xG by zone + shot/assist/pressure modifiers
│       ├── shot.js        Shot resolution (goal/save/miss/block/post)
│       ├── momentum.js    Driven oscillator with memory & decay
│       ├── fatigue.js     Stamina drain, threshold effects, injury events
│       ├── setpiece.js    Corner / FK / penalty / throw-in mini-sims
│       ├── ai.js          AI manager: tactical shifts, subs, pressing triggers
│       ├── narrative.js   Event feed templates (goals/saves/misses/cards/injuries)
│       └── postmatch.js   MatchReport -> consequences dispatched to GameState
├── data/
│   └── seed.js            newGameState() — converts legacy hardcoded data
└── ui/
    ├── panels.js          Refactored render* functions reading from GameState
    └── matchOverlay.js    New overlay wired to match engine event stream
```

## [MILESTONES] (Verifiable Goals)
1. **M1 — Spine:** `dispatch({type:'ADVANCE_DAY'})` advances the calendar by one day and emits at least one event. ✓ Determinism: same seed → same tick output.
2. **M2 — Calendar:** 34-matchweek double round-robin generated; no club plays 3 games in 7 days; derbies spread.
3. **M3 — Match:** Press kick-off, watch 90-min event stream, scoreline, xG, momentum, fatigue. Same seed → same result.
4. **M4 — Consequences:** Post-match updates league table, form arrays, fitness, morale, injuries, board confidence, media cycle.
5. **M5 — Persistence:** Save to slot, reload page, state restored. Migration stub survives schema bump.
6. **M6 — Validation:** Dispatch rejects squad-size violation, wage-ceiling breach, double-booked player.

## [ORPHANS & PENDING]
(None — every module wired into main.js or into the match engine pipeline.)

## [REGRESSION_GUARDS]
- All legacy `render*` functions keep their signatures and DOM IDs.
- All CSS preserved 1:1 from the original `index.html`.
- All hardcoded demo data is now the **seed** (New Game starting state), not deleted.

## [STATUS]
Step 1 (Core State Architecture & Simulation Loop): COMPLETE
Step 2 (Match Simulation Engine): COMPLETE
Step 3 (Player Development & Training System): COMPLETE
Step 4 (Transfer Market & Negotiation Engine): COMPLETE
Smoke tests: 23/23 passing
Step 3+4 tests: 78/78 passing
Determinism: verified (same seed → identical scoreline + xG)
Calendar: 34 MWs, 306 fixtures, ≤5 three-in-7 violations, derby spread ≥8 MW

## [KNOWN_TUNING_OPPORTUNITIES]
- xG distribution averages ~5.5/match (real PL: ~2.5). Architecture is
  correct; tuning shot frequency and conversion rates is a v2 task.
- AI clubs use synthetic ratings; full squad backfill is a Step 3+ task
  (transfer system).
- Training schedule UI is synced to window.TRAINING but the academy screen
  doesn't yet render the weekly microcycle calendar. Data is available.
