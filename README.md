# GAFFER '26 — Football Management Sim (Steps 1-4)

A unified `GameState` with deterministic simulation, a real football match
engine, a player development system, and a transfer market. The original
frozen-frontend `index.html` is preserved surgically — all CSS, DOM markup,
and render functions remain. Only the data source changes: hardcoded globals
→ `GameState` synced via `src/ui/panels.js`.

## Run

```bash
cd /home/z/my-project/download/gaffer26
python3 -m http.server 8000
# open http://localhost:8000/
```

## Verify

```bash
node tests/smoke.mjs           # 23 checks (Steps 1-2)
node tests/step34-tests.mjs    # 78 checks (Steps 3-4)
```

Or open `tests/index.html` in the browser for the interactive test page.

The smoke suite verifies:
- PRNG determinism (same seed → same sequence)
- Seed state shape (18 clubs, 23-man squad, 6 inbox messages)
- League table recompute (RAV has 19 pts from 6W 1D 1L after MW8)
- Calendar (34 MWs, 306 fixtures, ≤5 three-in-7 violations, RAV/HAL derby ≥8 MW spread)
- Match determinism (same seed → identical scoreline + xG)
- Match variation (different seeds → different results)
- xG distribution sanity (50-match sample within bounds)
- ADVANCE_DAY increments dayNumber
- State round-trips through JSON and is < 1MB

## Architecture

See `ARCHITECTURE.md` for the full layered design. See `PROJECT_MAP.md`
for the living feature map.

```
src/
├── main.js                Bootstrap: wire DOM, load/save, mount UI
├── core/                  Infrastructure (no domain logic)
│   ├── prng.js            mulberry32 + helpers, forkable streams
│   ├── eventBus.js        Typed emitter + EVT registry
│   ├── logger.js          Async ring-buffered logger
│   ├── state.js           GameState, dispatch, reducer, selectors
│   └── persistence.js     Save/load/autosave/migrate
├── domain/                Entity definitions & rules
│   ├── entities.js        Player, Club, Contract, Fixture factories
│   └── invariants.js      validate(state) + recomputeLeagueTable
├── sim/                   Simulation systems
│   ├── calendar.js        34-MW fixture generator w/ constraint solver
│   ├── tick.js            Day resolution: morning → midday → evening
│   └── match/
│       ├── engine.js      Orchestrator + MatchContext
│       ├── prematch.js    Lineup lock, tactical matchup matrix, conditions
│       ├── possession.js  Possession phase model (zone progression)
│       ├── xg.js          Base xG by zone + modifiers
│       ├── shot.js        Shot resolution: goal/save/miss/block/post
│       ├── momentum.js    Driven oscillator with memory & decay
│       ├── fatigue.js     Stamina drain, threshold effects, injuries
│       ├── setpiece.js    Corner / FK / penalty / throw mini-sims
│       ├── ai.js          AI manager: tactical shifts, subs, pressing
│       ├── narrative.js   Event feed templates
│       └── postmatch.js   MatchReport + consequences
├── data/
│   └── seed.js            newGameState() — converts legacy data
└── ui/
    ├── panels.js          Syncs GameState → legacy window globals
    └── matchOverlay.js    Engine-backed match overlay
```

## How to play

1. **Continue button** (top-right, gold) — advances one day. On non-match
   days, simulates morning training, midday AI club decisions, evening
   finance accrual. On matchdays, pauses for you to play the match.

2. **KICK OFF button** (dashboard) — opens the match overlay. The engine
   runs the full 90 minutes synchronously (~50ms), then streams events
   to the feed at variable speed (180ms per minor event, 900ms per goal).

3. **Touchline shouts** (during match) — PUSH / CALM / WIDE / PRESS.
   Each dispatches a `SHOUT` action that nudges momentum and tactics.

4. **CONTINUE button** (post-match) — commits the result, runs AI-vs-AI
   fixtures for the same day, recomputes the league table, updates form
   and fitness, generates media headlines, and re-renders the dashboard.

## Determinism

All simulation randomness flows through `mulberry32`, forked per:
- save seed → day PRNG → match PRNG → event PRNG
- Same save replayed = same world. Replaying a match with the same seed
  produces the same scoreline, xG, and event sequence.

UI code may use `Math.random()` for non-sim cosmetics only.

## What's new vs the legacy single-file build

**Step 1 (spine):**
- Unified `GameState` object (meta / clock / entities / relationships /
  competitions / finance / inbox / media / board / manager / transient /
  cache). All scattered globals (`S`, `PLAYERS`, `STD`, `INBOX`, `FIX`,
  `FIN`, etc.) are now derived from this single source of truth.
- Single `dispatch(action)` chokepoint with validation, autosave, and
  event emission. No UI code writes to state directly.
- Calendar engine generates 34 MWs of fixtures with constraint solver
  (no 3-in-7, derby spread, balanced home/away, TV slots).
- Day tick resolves morning (training, fatigue, scout ticks), midday
  (AI club decisions, media), evening (match or recovery + finance).
- Event bus with 30+ typed events (`GOAL_SCORED`, `MATCH_REPORT`,
  `LEAGUE_TABLE_UPDATED`, etc.). UI subscribes per event type.
- Persistence: localStorage with autosave (debounced 400ms), schema
  versioning, migration stub for future schema bumps.
- Invariants: squad size 16-25, wage ceiling, transfer budget, no
  double-booked players, fixture result ↔ table consistency.

**Step 2 (match engine):**
- Pre-match: lineup lock (formation validation, fitness thresholds,
  out-of-position penalty with Tinkerman skill reduction), tactical
  matchup matrix (5 axes: width/tempo/line height/set piece/transition),
  condition modifiers (home advantage, derby intensity, weather, pitch).
- Possession model: ball moves through def → mid → final → box with
  turnover probabilities at each transition. Counter-attacks triggered
  off turnovers. Possession outcomes: shot (35%) / cross (15%) / recycle
  (40%) / foul won (5%) / turnover (5%).
- xG model: base by zone (six_box 0.55-0.85, central 0.25-0.45, wide
  0.12-0.25, edge 0.06-0.14, long 0.02-0.06), with shot type / assist /
  pressure / composure / weak-foot modifiers (capped relative to base).
- Shot resolution: goal probability = xG (modified); non-goals split
  into save (55%) / miss (25%) / block (15%) / post (5%). Rebounds on
  saves (30% chance, 0.15 xG follow-up).
- Momentum: driven oscillator, range -1..+1. Drivers: goal (+0.35),
  big chance missed (+0.12), save (+0.08), red card (-0.30 sustained),
  crowd roar (+0.15 home), tactical sub (+0.10), conceding after lead
  (-0.20). Decay 0.02/min. Threshold effects at |m|>0.5 (press +15%)
  and |m|>0.7 (siege mode, final-third entries +25%).
- Fatigue: per-minute drain by position (CB 0.18, fullback 0.35, box-to-
  box mid 0.40). Threshold effects at 70% / 50% / 30% stamina. Injury
  risk spikes below 30% (8%/min). Medical facility reduces base risk.
- Set pieces: corners (delivery × aerial duel), free kicks (direct vs
  wide), penalties (76% base, elite taker +8%, elite keeper -6%).
- AI manager: tactical shifts (chase game when losing after 60', park
  bus when winning after 70', settle for point when drawing away after
  75'), fatigue-based subs (60-70'), attacking subs (75-85'), pressing
  intensity tied to momentum.
- Narrative: 12+ event templates with contextual slots (tap-in / screamer
  / against the run of play / seals it / consolation). Derby tone shifts.
- Post-match: MatchReport with scoreline, scorers, xG, full event log,
  player ratings (base 6.0, ±per goal/assist/cs/card, MOTM). Consequences
  dispatched to GameState: league table, form arrays, fitness, morale,
  injuries, suspensions (5Y = 1 match, red = 3 matches), matchday revenue,
  board confidence, manager XP, media headlines.

## Known limitations (v1)

- xG distribution averages ~5.5 total per match (real PL: ~2.5). The
  architecture is correct; tuning the shot frequency, zone distribution,
  and conversion rates is a v2 task. The determinism guarantee holds.
- AI clubs don't have full 23-man squads — they use synthetic ratings
  derived from club atk/def. The match engine handles both real and
  synthetic players transparently. A future transfer system would
  backfill full AI squads.
- Transfer/training/academy systems are stubbed: the seed data is
  preserved for UI display, but no simulation logic runs for them yet.
  These are Step 3+ features.
- Page reload restores state, but the active screen reverts to the
  dashboard. UI tab state is not persisted.

## Step 3 — Player Development & Training System

**3.1 Weekly Training Microcycle** (`src/sim/training/`)
- 6 session types: Tactical, Technical, Physical, Recovery, Set Pieces, Match Prep
- Each has fatigue cost, attribute gain multipliers, and intensity
- Auto-schedule AI: high fatigue → Recovery; matchday-1 → Match Prep; otherwise rotate Technical/Physical
- Tension: title chasers play Match Prep + Recovery; rebuilders play Technical + Physical

**3.2 Attribute Growth Model** (`src/sim/development/growth.js`)
- Layered multipliers: gap × age × playing time × training × personality × late bloomer
- No flat "+1 per season" — growth decelerates as CA approaches PA
- Playing time matters: <25% minutes = 0.5× multiplier (stagnation)

**3.3 Position-Specific Curves** (`src/sim/development/curves.js`)
- GK peaks 28-32, latest decline (33+)
- CB peaks 26-30
- FB peaks 23-27 (pace-dependent, earliest decline at 29)
- MID peaks 25-29
- ST peaks 24-28
- Each curve has growth shape, decline onset, and attribute-category profile

**3.4 Potential Realization** (`src/sim/development/potential.js`)
- PA is a *band*, not a number. Scouting reveals the range.
- Determination (primary) decides where in the band the player lands
- Professionalism gates weekly training efficiency
- Early injuries (before 23) reduce effective PA by 1-3 each
- Late bloomers (~8% of prospects) get +40% growth at ages 24-26
- Breakout events: big-match MOTM, mentorship completion, heavy-minute loan

**3.5 Form & Confidence** (`src/sim/development/form.js`)
- Weighted rolling average of last 6 match ratings (weights: 30/22/17/13/10/8%)
- Form ≥ 8.0: +4% decisions, +3% composure
- Form ≤ 5.8: -5% decisions, hesitancy in one-on-ones
- Morale × form interaction: high-form + low morale = 2× form decay
- Position volatility: strikers streaky (±1.5), GKs most stable (±0.3)

**3.6 Injury State Machine** (`src/sim/injuries/`)
- Taxonomy: Knock (3-7d) → Muscle strain (2-5w) → Ligament (2-8w) → Fracture (6-12w) → ACL (6-9mo)
- Recovery modifiers: medical facility -20%, sports science -12%, age 30+ 15-25% slower
- Setback mechanic: 6% weekly chance, adds 25-50% to remaining time
- Re-injury vulnerability: 3× risk for 4 weeks after returning
- Sharpness axis (separate from fitness): +8 per 90' played, -3 per week without

**3.7 Aging & Decline** (`src/sim/development/aging.js`)
- Pace drops first (-2 to -4 per year after onset)
- Stamina follows; strength declines slowly
- Mental attributes (vision, positioning, composure) can still grow into early 30s
- Adaptation: high-mental veterans compensate (effective decline = raw × 0.85-1.0)
- Sell-high window flagged 18 months before decline becomes obvious

**3.8 Mentorship** (`src/sim/development/mentorship.js`)
- Mentor: 28+, leadership 70+, professionalism 75+. Mentee: U23.
- One mentor, up to two mentees
- Mentee gains +10-15% mental attribute growth
- Determination pulled upward (up to +8 over a season) — only way to raise determination
- Personality clash (temperament gap > 30) reverses gains
- Completion after ~36 weeks → one-time mental bump + mentor legacy flag

**3.9 Milestones** (`src/sim/development/milestones.js`)
- First start / goal / assist / 90 minutes
- OVR tier crossings (70, 75, 80, 85)
- International call-up (high form + 75+ OVR + 28 or younger)
- Wonderkid confirmed (effective PA ≥ 85 at age 21 or younger)
- Quarterly development report cards from academy director
- Stagnation intervention after 8+ weeks at <25% minutes

## Step 4 — Transfer Market & Negotiation Engine

**4.1 Dynamic Valuation** (`src/sim/transfers/valuation.js`)
- Base: ability × age × potential premium
- Form modifier ±15% (rolling 8-match form)
- Contract-length modifier: 4+ years ×1.25, <12 months ×0.45 (Bosman looming)
- Position scarcity: ST ×1.25, LB ×1.20, GK ×1.15
- Provenance: homegrown +10%, international +5%, league reputation
- Market conditions: transfer inflation + TV rights growth
- Distress discount: 20-40% off for FFP/relegation crises
- Scouted range width: FullyKnown ±2%, Rumored ±30%

**4.2 AI Club Behavior** (`src/sim/transfers/ai-clubs.js`)
- Each AI club has a recruitment identity: developer / contender / opportunist
- Weekly needs assessment: no starter, thin depth, aging, contract run-down
- Shortlists targets from the global pool filtered by budget + identity
- AI-vs-AI transfers complete silently and shift the competitive balance
- The AI remembers if you repeatedly buy from one club (Ravensport tax)

**4.3 Negotiation State Machine** (`src/sim/transfers/negotiation.js`)
- States: IDLE → ENQUIRY → BID_SUBMITTED → {ACCEPTED | COUNTER_OFFERED | REJECTED | WITHDRAWN}
- COUNTER_OFFERED → {ACCEPT | COUNTER_BACK | WITHDRAW} (max 4 rounds, 2 on deadline day)
- ACCEPTED → PERSONAL_TERMS → {AGREED | COLLAPSED}
- AGREED → MEDICAL → {ANNOUNCED | COLLAPSED}
- Acceptance driven by bid/asking ratio, willingness, patience decay, rival bids
- Structure levers: add-ons, sell-on clauses, loan-to-buy, installments

**4.4 Agent Behavior** (`src/sim/transfers/agents.js`)
- 5 personalities: Greedy (Ferreira), Aggressive (Raggi), Loyal (Byrne), Patient (Okonkwo), Famous (Hansen)
- Each has distinct opening mult, patience, commission, pressure tactics
- Memory warmth persists: fair_deal +5, lowball -10, broken_promise -20
- Warm agents (70+) reduce opening by 8%; cold agents (30-) inflate by 20%

**4.5 Player Agency** (`src/sim/transfers/player-agency.js`)
- Desire model: ambition vs club status, playing time vs expectation, contract situation, loyalty
- Stance: wants_move (fast terms, pushes seller) / indifferent / wants_to_stay (wage +30%)
- Mishandled players escalate: happy → unhappy → unsettled → formal_transfer_request

**4.6 Sell Side** (`src/sim/transfers/sell-side.js`)
- AI clubs bid on your players based on form (hot streak = more approaches)
- Response options: accept, reject, counter, stall
- Replacement planning: flags holes you can't fill
- Rejecting a wanted move can trigger player unrest

**4.7 Loans & Free Agents** (`src/sim/transfers/loans.js`, `free-agents.js`)
- Loan types: dry loan, loan with option to buy, loan with obligation
- Free agents available year-round (outside windows too)
- Free agent pool skews 30+ veterans or U22 released youth
- No transfer fee, but high wage demands + signing-on bonuses

**4.8 Bosman & Pre-Contracts** (`src/sim/transfers/bosman.js`)
- From Jan 1, players with <6 months on contract can sign pre-contracts
- Your expiring players (Okafor 2026, Bergström 2026) are live Bosman targets
- Conversely, you can Bosman-poach from other clubs
- Acceptance driven by wage uplift, club reputation, ambition, loyalty

**4.9 Deadline Day** (`src/sim/transfers/deadline.js`)
- Counter rounds compressed from 4 to 2
- Panic dynamics: AI clubs with unmet needs overpay up to +30%
- Distress sales accept -30%
- Loan market spikes
- At window close, all open negotiations collapse or complete
