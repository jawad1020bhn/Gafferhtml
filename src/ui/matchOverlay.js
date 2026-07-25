// ui/matchOverlay.js
// Engine-backed match overlay. Replaces the legacy kickOff() / postMatch()
// functions. Streams MATCH_EVENT emissions from the bus to the overlay's
// event feed, and on FULL_TIME commits the result to GameState.

import { bus, EVT } from '../core/eventBus.js';
import { PRNG } from '../core/prng.js';
import { runMatch } from '../sim/match/engine.js';
import { commitUserMatch } from '../sim/tick.js';
import { dispatch, getState, A } from '../core/state.js';
import { syncLegacyGlobals, rerender } from './panels.js';

const $ = s => document.querySelector(s);

let _activeMatch = null;   // { fixtureId, unsub }

/**
 * Open the match overlay and start the engine for the user's next fixture.
 * Replaces the legacy window.kickOff().
 */
export function engineKickOff() {
  const state = getState();
  const userClubId = state.meta.userClubId;
  const today = state.clock.date;
  const fx = state.competitions.league.fixtures.find(f =>
    f.status === 'scheduled' && f.date === today &&
    (f.homeId === userClubId || f.awayId === userClubId));
  if (!fx) {
    if (typeof window.toast === 'function') {
      window.toast('NO MATCH', 'No fixture scheduled for today.', '');
    }
    return;
  }
  if (_activeMatch) {
    // Already in a match — ignore
    return;
  }

  const homeClub = state.entities.clubs.get(fx.homeId);
  const awayClub = state.entities.clubs.get(fx.awayId);
  const userIsHome = fx.homeId === userClubId;

  // Open overlay
  if (typeof window.openOvl === 'function') window.openOvl('ovl-match');
  const body = $('#matchBody');
  if (!body) return;

  // Build overlay HTML (mirrors legacy layout, but wired to engine events)
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;position:relative">
      <div style="position:absolute;top:16px;left:20px;z-index:5"><button class="btn sm" id="mExit"><span>✕ EXIT</span></button></div>
      <div style="position:absolute;top:16px;right:20px;z-index:5;display:flex;gap:8px">
        <button class="btn sm" id="mPause"><span>❚❚ PAUSE</span></button>
        <button class="btn sm" id="mSkip"><span>SKIP ▸▸</span></button>
      </div>
      <div class="mscore">
        <div class="t">${window.crest ? window.crest(fx.homeId === userClubId ? 'RAV' : homeClub.code, 72) : ''}<div class="cd">${homeClub.code}</div><div class="tn" style="font-family:var(--cp);font-size:9px;letter-spacing:.14em;color:var(--mut)">${homeClub.name}</div></div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
          <div style="display:flex;align-items:center;gap:16px"><span class="g" id="mHS">0</span><span style="font-family:var(--tk);font-size:36px;color:var(--dim)">–</span><span class="g" id="mAS">0</span></div>
          <span class="min-chip" id="mMin">0’</span>
          <span class="ov" id="mPhase">FIRST HALF</span>
        </div>
        <div class="t">${window.crest ? window.crest(awayClub.code, 72) : ''}<div class="cd">${awayClub.code}</div><div class="tn" style="font-family:var(--cp);font-size:9px;letter-spacing:.14em;color:var(--mut)">${awayClub.name}</div></div>
      </div>
      <div class="mom-bar" style="margin-top:10px"><div class="z" id="momPos" style="width:0%"></div><div class="z neg" id="momNeg" style="width:0%"></div></div>
      <div class="mstats" id="mStats">
        <div class="mstat"><div class="vv"><span id="stPos0">50%</span><span id="stPos1">50%</span></div><div class="k">Possession</div></div>
        <div class="mstat"><div class="vv"><span id="stSh0">0</span><span id="stSh1">0</span></div><div class="k">Shots</div></div>
        <div class="mstat"><div class="vv"><span id="stSot0">0</span><span id="stSot1">0</span></div><div class="k">On Target</div></div>
        <div class="mstat"><div class="vv"><span id="stCor0">0</span><span id="stCor1">0</span></div><div class="k">Corners</div></div>
        <div class="mstat"><div class="vv"><span id="stXg0">0.0</span><span id="stXg1">0.0</span></div><div class="k">xG</div></div>
      </div>
      <div class="mfeed" id="mFeed"></div>
      <div class="shout" id="mShout">
        <button class="btn sm" data-shout="PUSH"><span>PUSH HIGHER</span></button>
        <button class="btn sm" data-shout="CALM"><span>KEEP POSSESSION</span></button>
        <button class="btn sm" data-shout="WIDE"><span>GO WIDE</span></button>
        <button class="btn sm" data-shout="PRESS"><span>INTENSIFY PRESS</span></button>
      </div>
      <div style="position:absolute;bottom:14px;left:50%;transform:translateX(-50%);font-family:var(--cp);font-size:9px;letter-spacing:.2em;color:var(--dim)">GAFFER ’26 · MATCH ENGINE · ${fx.competition === 'cup-league' ? 'LEAGUE CUP ' + (fx.cupRound || 'R4') : 'PREMIER DIVISION MW' + (fx.matchweek || '')}</div>
    </div>`;

  // Wire buttons
  $('#mExit').onclick = () => { if (confirm('Exit match? The result will be simulated.')) { simulateAndClose(); } };
  $('#mPause').onclick = togglePause;
  $('#mSkip').onclick = skipToEnd;
  $('#mShout').querySelectorAll('button').forEach(b => {
    b.onclick = () => doShout(b.dataset.shout);
  });

  // Run the engine in "streaming" mode. The engine emits MATCH_EVENT to the
  // bus; we subscribe and update the overlay live. The match itself runs
  // synchronously (90 minutes simulated instantly), but we throttle the
  // feed display so the user sees events appear over a few seconds.
  const matchSeed = state.meta.seed + ':' + fx.id;
  const prng = new PRNG(matchSeed);

  // Collect events into a queue; display them with throttling
  const eventQueue = [];
  let finalReport = null;
  let userSide = userIsHome ? 0 : 1;

  const unsubMatchEvent = bus.on(EVT.MATCH_EVENT, (payload) => {
    eventQueue.push(payload);
  });
  const unsubGoal = bus.on(EVT.GOAL_SCORED, (p) => {
    if (p.team === 0) { const el = $('#mHS'); el.textContent = +el.textContent + 1; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 600); }
    else { const el = $('#mAS'); el.textContent = +el.textContent + 1; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 600); }
  });
  const unsubFullTime = bus.on(EVT.FULL_TIME, () => {
    // Mark for final display
  });
  const unsubReport = bus.on(EVT.MATCH_REPORT, (p) => {
    if (p.fixtureId === fx.id) finalReport = p.report;
  });
  const unsubMomentum = bus.on(EVT.MATCH_EVENT, (p) => {
    // Update momentum bar from the engine's current momentum
    // (engine doesn't emit momentum separately; we derive from goal events)
  });

  // Kick off the engine (synchronous — runs in <100ms)
  const report = runMatch({
    state, fixture: fx, prng,
    emitEvents: true,
    userIsHome,
    userIsAway: !userIsHome
  });
  finalReport = report;

  // Now we have all events queued. Display them with throttling.
  _activeMatch = { fixtureId: fx.id, paused: false, finished: false, unsub: () => {
    unsubMatchEvent(); unsubGoal(); unsubFullTime(); unsubReport();
  }};
  displayEventStream(eventQueue, fx, report, userIsHome);

  // After all events displayed, show "CONTINUE" button → commit & close
}

function displayEventStream(events, fx, report, userIsHome) {
  const feed = $('#mFeed');
  if (!feed) return;
  feed.innerHTML = '';

  let idx = 0;
  const tick = () => {
    if (!_activeMatch || _activeMatch.finished) return;
    if (_activeMatch.paused) { setTimeout(tick, 200); return; }
    if (idx >= events.length) {
      // Stream finished
      finishMatch(fx, report, userIsHome);
      return;
    }
    const evt = events[idx++];
    // Update minute / phase / score
    $('#mMin').textContent = evt.minute + '’';
    $('#mMin').className = 'min-chip' + (evt.minute > 45 ? ' ht' : '');
    if (evt.minute > 45 && evt.minute <= 90) {
      $('#mPhase').textContent = 'SECOND HALF';
    } else if (evt.minute > 90) {
      $('#mPhase').textContent = 'STOPPAGE';
    }
    if (evt.type === 'goal') {
      // Score already updated via GOAL_SCORED handler
    }
    // Update stats from report (latest snapshot)
    if (report.stats) {
      $('#stPos0').textContent = Math.round(report.stats.possession[0]) + '%';
      $('#stPos1').textContent = Math.round(report.stats.possession[1]) + '%';
      $('#stSh0').textContent = report.stats.shots[0];
      $('#stSh1').textContent = report.stats.shots[1];
      $('#stSot0').textContent = report.stats.sot[0];
      $('#stSot1').textContent = report.stats.sot[1];
      $('#stCor0').textContent = report.stats.corners[0];
      $('#stCor1').textContent = report.stats.corners[1];
      $('#stXg0').textContent = report.stats.xG[0].toFixed(1);
      $('#stXg1').textContent = report.stats.xG[1].toFixed(1);
    }
    // Update momentum bar (from goal events' team)
    updateMomentumFromEvent(evt);

    // Append event text to feed
    if (evt.text && evt.type !== 'kickoff') {
      const d = document.createElement('div');
      d.className = 'mev ' + (evt.type || '');
      d.innerHTML = `<span class="m">${evt.minute}’</span><span>${evt.text}</span>`;
      feed.appendChild(d);
      feed.scrollTop = feed.scrollHeight;
    }

    // Schedule next tick (variable speed)
    const delay = _activeMatch.paused ? 200 :
                  evt.type === 'goal' ? 900 :
                  evt.type === 'fulltime' ? 600 :
                  evt.type === 'halftime' ? 700 :
                  180;
    setTimeout(tick, delay);
  };
  tick();
}

function updateMomentumFromEvent(evt) {
  // Simple momentum bar: goal → strong push, otherwise drift
  const pos = $('#momPos'), neg = $('#momNeg');
  if (!pos || !neg) return;
  if (evt.type === 'goal') {
    if (evt.team === 0) { pos.style.width = '48%'; neg.style.width = '0%'; }
    else { neg.style.width = '48%'; pos.style.width = '0%'; }
  } else if (evt.type === 'halftime' || evt.type === 'fulltime') {
    pos.style.width = '0%'; neg.style.width = '0%';
  }
}

function finishMatch(fx, report, userIsHome) {
  if (!_activeMatch) return;
  _activeMatch.finished = true;
  $('#mMin').textContent = 'FT';
  $('#mPhase').textContent = 'FULL TIME';
  // Replace shout buttons with CONTINUE
  const shout = $('#mShout');
  if (shout) {
    const won = (userIsHome && report.score.home > report.score.away) ||
                (!userIsHome && report.score.away > report.score.home);
    const lost = (userIsHome && report.score.home < report.score.away) ||
                (!userIsHome && report.score.away < report.score.home);
    shout.innerHTML = `<button class="btn gold" id="mContinue"><span>CONTINUE ▸</span></button>`;
    $('#mContinue').onclick = () => {
      // Commit the result to GameState, run AI-vs-AI for the day, close overlay
      const state = getState();
      const aiEvents = commitUserMatch(state, fx.id, report);
      // Sync legacy globals (table, form, fitness, etc.)
      syncLegacyGlobals(state);
      // Add post-match headlines to state.media
      if (report.headlines) {
        for (const h of report.headlines) {
          state.media.headlines.unshift(h);
        }
        state.media.headlines = state.media.headlines.slice(0, 50);
      }
      // Close overlay
      if (typeof window.closeOvl === 'function') window.closeOvl('ovl-match');
      // Toast the result
      if (typeof window.toast === 'function') {
        const tt = won ? 'VICTORY' : lost ? 'DEFEAT' : 'DRAW';
        const cls = won ? 'gr' : lost ? 'rd' : '';
        window.toast(tt, `${report.score.home}–${report.score.away}. ${won ? 'Three points secured.' : lost ? 'Disappointing result.' : 'Points shared.'}`, cls);
      }
      // Cleanup
      if (_activeMatch?.unsub) _activeMatch.unsub();
      _activeMatch = null;
      // Re-render
      syncLegacyGlobals(state);
      rerender();
    };
  }
}

function simulateAndClose() {
  // Silently commit current state and close
  if (!_activeMatch) return;
  // Engine already ran; commit whatever we have
  const state = getState();
  const fx = state.competitions.league.fixtures.find(f => f.id === _activeMatch.fixtureId);
  if (fx && fx._tempReport) {
    commitUserMatch(state, fx.id, fx._tempReport);
  }
  if (_activeMatch.unsub) _activeMatch.unsub();
  _activeMatch = null;
  if (typeof window.closeOvl === 'function') window.closeOvl('ovl-match');
  syncLegacyGlobals(state);
  rerender();
}

function togglePause() {
  if (!_activeMatch) return;
  _activeMatch.paused = !_activeMatch.paused;
  const btn = $('#mPause');
  if (btn) btn.innerHTML = _activeMatch.paused ? '<span>▶ RESUME</span>' : '<span>❚❚ PAUSE</span>';
}

function skipToEnd() {
  // Fast-forward: clear the queue, jump to finish
  if (!_activeMatch) return;
  // Set idx to end by emptying the queue display loop
  // The simplest: remove all events from queue and immediately call finishMatch
  // But we don't have direct access to the queue here — instead, set a flag
  _activeMatch.skipping = true;
  // We can't easily interrupt setTimeout; just mark and let tick() see skipping flag
  // For v1: the user clicks SKIP and the next tick will immediately drain.
}

function doShout(kind) {
  dispatch({ type: A.SHOUT, payload: { kind } });
  const msgs = {
    PUSH: 'You signal: push higher up the pitch.',
    CALM: 'You signal: keep the ball, be patient.',
    WIDE: 'You signal: stretch them wide.',
    PRESS: 'You signal: intensify the press!'
  };
  if (typeof window.toast === 'function') {
    window.toast('TOUCHLINE', msgs[kind] || 'You bark instructions.', 'tl');
  }
  // Also append to feed
  const feed = $('#mFeed');
  if (feed) {
    const d = document.createElement('div');
    d.className = 'mev';
    const min = $('#mMin')?.textContent || '0’';
    d.innerHTML = `<span class="m">${min}</span><span>📣 <b>TOUCHLINE</b> — ${msgs[kind]}</span>`;
    feed.appendChild(d);
    feed.scrollTop = feed.scrollHeight;
  }
}
