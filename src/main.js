// main.js — Bootstrap, Shell & Texture Controllers.
// Single entry point: integrates core game loops, event bus subscriptions,
// touchline overrides, day advance triggers, keyboard shortcuts,
// alongside Gaffer '26 Step 8 & 9 Shell & Texture Overlays (Boot, Setup, Resume, settings, Pause).

import { logger } from './core/logger.js';
import { bus, EVT } from './core/eventBus.js';
import { initNewGame, getState, setState, dispatch, A, sel, setSpeed } from './core/state.js';
import { load, save, listSaves } from './core/persistence.js';
import { syncLegacyGlobals, rerender } from './ui/panels.js';
import { engineKickOff } from './ui/matchOverlay.js';
import { triggerStadiumExpansion } from './sim/finance/engine.js';

import {
  initSettingsAndHistory,
  validateSaveIntegrity,
  migrateSave,
  generateSavePreview,
  exportSaveFile,
  importSaveFile,
  processEndOfSeason,
  updateJobSecurity,
  getAvailableJobs,
  processInternationalBreak,
  triggerAIClubAdministration,
  applyFestivePileupFatigue,
  clearFestivePileup
} from './sim/shell/engine.js';

import './sim/tick.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

logger.setLevel('info');
logger.info('main', 'bootstrap starting');

// Global variables for Setup Wizard and Settings
let setupStep = 1;
let setupData = {
  clubId: 'RAV',
  managerName: 'Alex Mercer',
  managerAge: 41,
  managerNat: 'ENG',
  archetype: 'Tactician',
  tacticalDiff: 50,
  marketDiff: 50,
  boardDiff: 50,
  hardcore: false,
  injuryFreq: 'normal'
};

// -------- 1. Initialise or load state --------
let state = null;
try {
  const autosave = load('autosave');
  if (autosave) {
    state = autosave;
    logger.info('main', 'loaded autosave', { saveId: state.meta.saveId });
  }
} catch (e) {
  logger.warn('main', 'autosave load failed, starting new game', { err: String(e) });
}

if (!state) {
  state = initNewGame();
  logger.info('main', 'started new game', { seed: state.meta.seed });
}
setState(state);

// -------- 2. Sync legacy globals (CLUBS, PLAYERS, STD, FIX, INBOX, etc.) --------
syncLegacyGlobals(state);

// -------- 3. Override legacy kickOff with engine-backed version --------
window.kickOff = engineKickOff;

// -------- 4. Hook Continue button to dispatch(ADVANCE_DAY) --------
const continueBtn = $('#btnContinue');
if (continueBtn) {
  continueBtn.onclick = () => {
    logger.info('main', 'Continue clicked — advancing day');
    // Disable briefly to prevent double-clicks
    continueBtn.disabled = true;
    setTimeout(() => { continueBtn.disabled = false; }, 300);
    const result = dispatch({ type: A.ADVANCE_DAY });
    // syncLegacyGlobals + rerender happens via event subscriptions below.
    // But also do an immediate sync in case events haven't fired yet.
    syncLegacyGlobals(getState());
    rerender();
    // If a matchday was reached, the user must play the match before continuing.
    // The tick engine sets state._pendingAI; the match overlay opens when the
    // user clicks KICK OFF.
    const today = getState().clock.date;
    const userClubId = getState().meta.userClubId;
    const fx = getState().competitions.league.fixtures.find(f =>
      f.status === 'scheduled' && f.date === today &&
      (f.homeId === userClubId || f.awayId === userClubId));
    if (fx) {
      if (typeof window.toast === 'function') {
        const opp = fx.homeId === userClubId ? fx.awayId : fx.homeId;
        const oppClub = getState().entities.clubs.get(opp);
        window.toast('MATCHDAY', `Today's match: ${oppClub?.name}. Click KICK OFF when ready.`, 'tl');
      }
    } else {
      // No match today — show ambient day-advance toast
      if (typeof window.toast === 'function') {
        const d = new Date(getState().clock.date);
        const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        window.toast('DAY ADVANCE', `${d.getDate()} ${months[d.getMonth()]} · Day ${getState().clock.dayNumber}`, '');
      }
    }
  };
}

// -------- 5. Subscribe to events for re-rendering --------
bus.on(EVT.STATE_BATCH, (payload) => {
  syncLegacyGlobals(getState());
  if (payload?.panel && typeof window.show === 'function') {
    // Optionally switch screens if the event suggests it
  }
  rerender();
});

bus.on(EVT.ADVANCE_DAY_END, () => {
  syncLegacyGlobals(getState());
  rerender();
});

bus.on(EVT.MATCH_REPORT, (payload) => {
  syncLegacyGlobals(getState());
  if (!payload.aiVsAi) {
    // User match — don't auto-rerender (overlay handles it)
    return;
  }
  rerender();
});

bus.on(EVT.LEAGUE_TABLE_UPDATED, () => {
  syncLegacyGlobals(getState());
  rerender();
});

bus.on(EVT.PLAYER_INJURED, (p) => {
  if (typeof window.toast === 'function') {
    const player = getState().entities.players.get(p.playerId);
    window.toast('INJURY', `${player?.name || 'Player'} — ${p.injury.type} (${p.injury.days} days)`, 'rd');
  }
});

bus.on(EVT.MEDIA_HEADLINE, (h) => {
  // Could show toast for high-importance headlines; skip for now
});

bus.on(EVT.INVARIANT_VIOLATION, (v) => {
  logger.warn('main', 'invariant violation', v);
  if (typeof window.toast === 'function') {
    window.toast('VALIDATION', `Action rejected: ${v.reason || v.rule}`, 'rd');
  }
});

// -------- 6. Wire keyboard shortcuts (mirror legacy) --------
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.querySelector('.ovl.on')) {
      // Close active overlays
      $$('.ovl').forEach(o => o.classList.remove('on'));
    } else if (document.getElementById('ovl-boot').style.display !== 'block') {
      // Toggle pause overlay
      document.getElementById('ovl-pause').classList.toggle('on');
    }
  }

  // Keyboard navigation shortcuts 1-0 for quick tab switching
  const map = { '1':'dash','2':'squad','3':'tactics','4':'match','5':'transfers','6':'club','7':'academy','8':'world','9':'manager','0':'news' };
  if (map[e.key] && !e.target.closest('input,select') && !document.querySelector('.ovl.on')) {
    if (typeof window.show === 'function') window.show(map[e.key]);
  }

  // Space to advance day Continue safely
  if (e.key === ' ' && !e.target.closest('input,select') && !document.querySelector('.ovl.on') && document.getElementById('ovl-boot').style.display !== 'block') {
    e.preventDefault();
    const btn = $('#btnContinue');
    if (btn && !btn.disabled) {
      btn.click();
    }
  }
});

// -------- 7. Save on page unload --------
window.addEventListener('beforeunload', () => {
  save(getState(), 'autosave');
});

// -------- 7b. Hook legacy inbox resolution to dispatch RESOLVE_MESSAGE --------
const originalResolveMsg = window.resolveMsg;
window.resolveMsg = (id, ci) => {
  dispatch({ type: A.RESOLVE_MESSAGE, payload: { messageId: id, choiceIndex: ci } });
  if (typeof originalResolveMsg === 'function') {
    originalResolveMsg(id, ci);
  }
};

// -------- 8. Initial render --------
if (typeof window.renderHeader === 'function') window.renderHeader();
if (typeof window.renderTicker === 'function') window.renderTicker();
if (typeof window.renderDash === 'function') window.renderDash();
if (typeof window.show === 'function') window.show('dash');

logger.info('main', 'bootstrap complete', {
  userClubId: state.meta.userClubId,
  date: state.clock.date,
  dayNumber: state.clock.dayNumber,
  nextFixture: sel.nextFixture(state)?.id || 'none'
});

// ============================================
// ====== STEP 8 — THE GAME SHELL WIRE ======
// ============================================

// Boot Sequence: Cold start Studio card timers
window.addEventListener('DOMContentLoaded', () => {
  const bootStudio = $('#boot-studio');
  const bootTitle = $('#boot-title');

  if (bootStudio && bootTitle) {
    // Stage 1: Studio card on black for 1.2 seconds
    setTimeout(() => {
      bootStudio.style.opacity = '0';
      setTimeout(() => {
        bootStudio.style.display = 'none';
        bootTitle.style.display = 'block';
        bootTitle.style.opacity = '1';
        logger.info('shell', 'Boot flow title sequence assembled beautifully');
      }, 600);
    }, 1200);
  }

  // Continue Career slot preview check
  const btnBootContinue = $('#btnBootContinue');
  const autosave = load('autosave');
  if (autosave && btnBootContinue) {
    const preview = generateSavePreview(autosave);
    btnBootContinue.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;line-height:1.25">
        <span style="font-weight:700">CONTINUE CAREER (Slot: ${preview.clubCode})</span>
        <span class="dim" style="font-size:10px;text-transform:uppercase">${preview.managerName} · Pos: ${preview.leaguePosition} · Date: ${preview.date}</span>
      </div>
    `;
    btnBootContinue.disabled = false;
  } else if (btnBootContinue) {
    btnBootContinue.style.opacity = '0.35';
    btnBootContinue.style.pointerEvents = 'none';
    btnBootContinue.innerHTML = `<span>NO SAVE DETECTED</span>`;
  }
});

// Setup Wizard Controllers
window.GAME_SHELL = {
  openSetup() {
    setupStep = 1;
    document.getElementById('ovl-setup').classList.add('on');
    window.GAME_SHELL.renderSetupStep();
  },

  setupNext() {
    if (setupStep < 5) {
      setupStep++;
      window.GAME_SHELL.renderSetupStep();
    } else {
      window.GAME_SHELL.completeSetup();
    }
  },

  setupBack() {
    if (setupStep > 1) {
      setupStep--;
      window.GAME_SHELL.renderSetupStep();
    }
  },

  renderSetupStep() {
    const body = $('#setupBody');
    const stepNum = $('#setupStepNum');
    stepNum.textContent = setupStep;

    if (setupStep === 1) {
      // Choose club
      body.innerHTML = `
        <div class="ov gd" style="margin-bottom:12px">STEP 1: SELECT YOUR CLUB DIRECTIVE</div>
        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:16px">
          <div class="panel ${setupData.clubId === 'RAV' ? 'gold' : ''}" style="cursor:pointer;padding:16px" onclick="window.GAME_SHELL.selectClub('RAV')">
            <div style="display:flex;justify-content:center;margin-bottom:8px">
              <svg viewBox="0 0 40 46" width="46" height="52"><path d="M20 2 37 8v14c0 12-8 19-17 22C11 41 3 34 3 22V8Z" fill="#171a1c" stroke="#d8b45c" stroke-width="2"/><text x="20" y="28" text-anchor="middle" font-family="Teko" font-size="13" font-weight="600" fill="#d8b45c">RAV</text></svg>
            </div>
            <h4 class="big" style="font-size:22px;text-align:center">Ravensport FC</h4>
            <div class="dim" style="font-size:11.5px;line-height:1.4;text-align:center;margin-top:8px">"Rebuilding on a shoxygen budget. Board expects a top 4 finish, but squad is on the brink."</div>
            <div class="kv" style="margin-top:12px"><span class="k">Budget</span><span class="v">£42.5M</span></div>
            <div class="kv"><span class="k">Reputation</span><span class="v">★★★★☆</span></div>
          </div>
          <div class="panel ${setupData.clubId === 'HAL' ? 'gold' : ''}" style="cursor:pointer;padding:16px" onclick="window.GAME_SHELL.selectClub('HAL')">
            <div style="display:flex;justify-content:center;margin-bottom:8px">
              <svg viewBox="0 0 40 46" width="46" height="52"><path d="M20 2 37 8v14c0 12-8 19-17 22C11 41 3 34 3 22V8Z" fill="#12305a" stroke="#7fd1ff" stroke-width="2"/><text x="20" y="28" text-anchor="middle" font-family="Teko" font-size="13" font-weight="600" fill="#7fd1ff">HAL</text></svg>
            </div>
            <h4 class="big" style="font-size:22px;text-align:center">Halloway Athletic</h4>
            <div class="dim" style="font-size:11.5px;line-height:1.4;text-align:center;margin-top:8px">"Title challengers under a highly demanding board. Infinite funds but zero tolerance."</div>
            <div class="kv" style="margin-top:12px"><span class="k">Budget</span><span class="v">£88.0M</span></div>
            <div class="kv"><span class="k">Reputation</span><span class="v">★★★★★</span></div>
          </div>
          <div class="panel ${setupData.clubId === 'OAK' ? 'gold' : ''}" style="cursor:pointer;padding:16px" onclick="window.GAME_SHELL.selectClub('OAK')">
            <div style="display:flex;justify-content:center;margin-bottom:8px">
              <svg viewBox="0 0 40 46" width="46" height="52"><path d="M20 2 37 8v14c0 12-8 19-17 22C11 41 3 34 3 22V8Z" fill="#243d14" stroke="#b8e08f" stroke-width="2"/><text x="20" y="28" text-anchor="middle" font-family="Teko" font-size="13" font-weight="600" fill="#b8e08f">OAK</text></svg>
            </div>
            <h4 class="big" style="font-size:22px;text-align:center">Oakmont Town</h4>
            <div class="dim" style="font-size:11.5px;line-height:1.4;text-align:center;margin-top:8px">"Relegation candidates, manager on thin ice. Survival is the only word."</div>
            <div class="kv" style="margin-top:12px"><span class="k">Budget</span><span class="v">£3.0M</span></div>
            <div class="kv"><span class="k">Reputation</span><span class="v">★☆☆☆☆</span></div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:24px">
          <button class="btn gold" onclick="window.GAME_SHELL.setupNext()"><span>CONTINUE ▸</span></button>
        </div>
      `;
    } else if (setupStep === 2) {
      // Choose manager and archetype
      body.innerHTML = `
        <div class="ov gd" style="margin-bottom:12px">STEP 2: CREATE YOUR MANAGER PROFILE</div>
        <div class="grid" style="grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:16px">
          <div class="panel" style="padding:16px">
            <div class="ph" style="border:0;padding-left:0"><span class="t">PERSONAL DETAILS</span></div>
            <div style="display:flex;flex-direction:column;gap:12px">
              <div class="row"><span class="ov" style="width:100px">NAME</span><input class="inp" id="smName" style="flex:1" value="${setupData.managerName}" onchange="window.GAME_SHELL.updateField('managerName', this.value)"></div>
              <div class="row"><span class="ov" style="width:100px">AGE</span><input class="inp" id="smAge" type="number" style="flex:1" value="${setupData.managerAge}" onchange="window.GAME_SHELL.updateField('managerAge', parseInt(this.value))"></div>
              <div class="row"><span class="ov" style="width:100px">NATIONALITY</span><input class="inp" id="smNat" style="flex:1" value="${setupData.managerNat}" onchange="window.GAME_SHELL.updateField('managerNat', this.value)"></div>
            </div>
          </div>
          <div class="panel" style="padding:16px">
            <div class="ph" style="border:0;padding-left:0"><span class="t">ARCHETYPE BRANCH</span></div>
            <div class="chips">
              ${['Tactician', 'Wheeler Dealer', 'Man Manager'].map(arch => `
                <button class="chipsel ${setupData.archetype === arch ? 'on' : ''}" style="width:100%;text-align:left;height:42px" onclick="window.GAME_SHELL.updateField('archetype', '${arch}')">
                  <span style="font-weight:700">${arch.toUpperCase()}</span> — Seeds starting skill branch
                </button>
              `).join('')}
            </div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:24px">
          <button class="btn" onclick="window.GAME_SHELL.setupBack()"><span>BACK</span></button>
          <button class="btn gold" onclick="window.GAME_SHELL.setupNext()"><span>CONTINUE ▸</span></button>
        </div>
      `;
    } else if (setupStep === 3) {
      // Per-system Difficulty
      body.innerHTML = `
        <div class="ov gd" style="margin-bottom:12px">STEP 3: CONFIGURING PER-SYSTEM DIFFICULTY MULTIPLIERS</div>
        <div style="display:flex;flex-direction:column;gap:16px;margin-bottom:16px">
          <div class="panel" style="padding:16px">
            <div class="barlbl"><span class="l">TACTICAL AI READS</span><span class="r">${setupData.tacticalDiff}%</span></div>
            <input type="range" min="10" max="100" value="${setupData.tacticalDiff}" oninput="window.GAME_SHELL.updateField('tacticalDiff', parseInt(this.value))">
            <div class="dim" style="font-size:11px;margin-top:6px">Determines how sharply opponent managers read and adapt to counter your formation.</div>
          </div>
          <div class="panel" style="padding:16px">
            <div class="barlbl"><span class="l">MARKET COMPETITIVENESS</span><span class="r">${setupData.marketDiff}%</span></div>
            <input type="range" min="10" max="100" value="${setupData.marketDiff}" oninput="window.GAME_SHELL.updateField('marketDiff', parseInt(this.value))">
            <div class="dim" style="font-size:11px;margin-top:6px">Influences agent commission expectations and competitor transfer bid speeds.</div>
          </div>
          <div class="panel" style="padding:16px">
            <div class="barlbl"><span class="l">BOARD PATIENCE INDEX</span><span class="r">${setupData.boardDiff}%</span></div>
            <input type="range" min="10" max="100" value="${setupData.boardDiff}" oninput="window.GAME_SHELL.updateField('boardDiff', parseInt(this.value))">
            <div class="dim" style="font-size:11px;margin-top:6px">Dictates how rapidly the board loses trust on negative results and FFP violations.</div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:24px">
          <button class="btn" onclick="window.GAME_SHELL.setupBack()"><span>BACK</span></button>
          <button class="btn gold" onclick="window.GAME_SHELL.setupNext()"><span>CONTINUE ▸</span></button>
        </div>
      `;
    } else if (setupStep === 4) {
      // World Options
      body.innerHTML = `
        <div class="ov gd" style="margin-bottom:12px">STEP 4: WORLD CONFIGURATION</div>
        <div class="grid" style="grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:16px">
          <div class="panel" style="padding:16px">
            <div class="ph" style="border:0;padding-left:0"><span class="t">HARDCORE MODE</span></div>
            <div class="chips">
              <button class="chipsel ${setupData.hardcore ? 'on' : ''}" style="width:100%;height:38px" onclick="window.GAME_SHELL.updateField('hardcore', true)"><span>ENABLED</span></button>
              <button class="chipsel ${!setupData.hardcore ? 'on' : ''}" style="width:100%;height:38px" onclick="window.GAME_SHELL.updateField('hardcore', false)"><span>DISABLED (ALLOWS RELOAD SCUMMING)</span></button>
            </div>
          </div>
          <div class="panel" style="padding:16px">
            <div class="ph" style="border:0;padding-left:0"><span class="t">INJURY FREQUENCY</span></div>
            <div class="chips">
              ${['low', 'normal', 'high'].map(freq => `
                <button class="chipsel ${setupData.injuryFreq === freq ? 'on' : ''}" style="width:100%;height:38px" onclick="window.GAME_SHELL.updateField('injuryFreq', '${freq}')"><span>${freq.toUpperCase()}</span></button>
              `).join('')}
            </div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:24px">
          <button class="btn" onclick="window.GAME_SHELL.setupBack()"><span>BACK</span></button>
          <button class="btn gold" onclick="window.GAME_SHELL.setupNext()"><span>CONTINUE ▸</span></button>
        </div>
      `;
    } else if (setupStep === 5) {
      // Board Meeting
      body.innerHTML = `
        <div class="ov gd" style="margin-bottom:12px">STEP 5: BOARD DIRECTIVE CONTRACT BREIFING</div>
        <div class="panel" style="padding:22px;background:linear-gradient(180deg, var(--panel2), rgba(216,180,92,.02))">
          <h3 class="big" style="font-size:30px;color:var(--gold2);margin-bottom:10px">OFFICIAL OFFER: MANAGERIAL DIRECTIVE</h3>
          <p class="mut" style="font-size:13px;line-height:1.6;margin-bottom:16px">
            Attention <b>${setupData.managerName}</b>,<br><br>
            The board of directors of <b>${setupData.clubId === 'RAV' ? 'Ravensport FC' : setupData.clubId === 'HAL' ? 'Halloway Athletic' : 'Oakmont Town'}</b> hereby offers you a 2-year contract starting August 15th, 2026.
          </p>
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div class="kv"><span class="k">WAGE BUDGET</span><span class="v">£9.4M</span></div>
            <div class="kv"><span class="k">TRANSFER BUDGET</span><span class="v">${setupData.clubId === 'RAV' ? '£42.5M' : setupData.clubId === 'HAL' ? '£88.0M' : '£3.0M'}</span></div>
            <div class="kv"><span class="k">PRIMARY OBJECTIVE</span><span class="v">${setupData.clubId === 'OAK' ? 'SURVIVE RELEGATION' : 'CHAMPIONS LEAGUE QUALIFICATION'}</span></div>
            <div class="kv"><span class="k">Difficulty Multipliers</span><span class="v">T: ${setupData.tacticalDiff} · M: ${setupData.marketDiff} · B: ${setupData.boardDiff}</span></div>
          </div>
          <div class="hr"></div>
          <button class="btn gold" style="width:100%;height:44px" onclick="window.GAME_SHELL.setupNext()"><span>SIGN MANAGEMENT CONTRACT ▸</span></button>
        </div>
        <div style="display:flex;justify-content:flex-start;margin-top:24px">
          <button class="btn" onclick="window.GAME_SHELL.setupBack()"><span>BACK</span></button>
        </div>
      `;
    }
  },

  selectClub(cid) {
    setupData.clubId = cid;
    window.GAME_SHELL.renderSetupStep();
  },

  updateField(key, val) {
    setupData[key] = val;
    window.GAME_SHELL.renderSetupStep();
  },

  completeSetup() {
    logger.info('shell', 'completing setup wizard, seeding new state overrides', setupData);
    const overrides = {
      saveId: 's_shell_' + Date.now(),
      seed: 'seed_' + Math.floor(Math.random() * 1e5),
      userClubId: setupData.clubId === 'RAV' ? 'rav' : setupData.clubId === 'HAL' ? 'hal' : 'oak',
      manager: {
        name: setupData.managerName,
        age: setupData.managerAge,
        nat: setupData.managerNat,
        arch: setupData.archetype,
        wage: 25000,
        con: 2028,
        record: { g: 0, w: 0, d: 0, l: 0, tr: 0 },
        xp: 0,
        xpNext: 1000,
        lvl: 1,
        sp: 1,
        kp: 0,
        skills: []
      }
    };

    const newState = initNewGame(overrides);
    initSettingsAndHistory(newState);

    // Apply difficulty modifiers from wizard step 3
    newState.settings.difficulty = {
      tactical: setupData.tacticalDiff,
      market: setupData.marketDiff,
      board: setupData.boardDiff
    };

    setState(newState);
    syncLegacyGlobals(newState);
    rerender();

    // Close setup and boot overlays
    document.getElementById('ovl-setup').classList.remove('on');
    document.getElementById('ovl-boot').classList.remove('on');
    document.getElementById('ovl-boot').style.display = 'none';

    // Trigger Day One Onboarding briefing inside the Inbox!
    newState.inbox = newState.inbox || [];
    newState.inbox.unshift({
      id: 'msg_onboard_' + Date.now(),
      severity: 'high',
      sender: 'The Boardroom · Welcome Briefing',
      subject: 'WELCOME: Welcome to Ironworks Park',
      body: `Alex,\n\nWelcome to your new career.\n\nWe are absolutely delighted to have you on board. Our situation is clear: we expect a top 4 finish this year to secure European Champions League qualification.\n\n"The squad has potential but is carrying some early fitness load. Review your lineup rotation, lock in our tactical Gegenpress shape, and lead us forward."\n\nYour first matchday awaits on Saturday. Make us proud.`,
      choices: [],
      done: true,
      opened: false
    });

    syncLegacyGlobals(newState);
    rerender();
    toast('CAREER INITIALIZED', 'Your manager contract has been signed. Welcome to Headquarters!', 'gr');
  }
};

// "While You Were Away" Resume Briefing Cards
window.GAME_SHELL_RESUME = {
  bootContinue() {
    const autosave = load('autosave');
    if (autosave) {
      const state = autosave;
      initSettingsAndHistory(state);
      setState(state);
      syncLegacyGlobals(state);
      rerender();

      // Close boot overlay
      document.getElementById('ovl-boot').classList.remove('on');
      document.getElementById('ovl-boot').style.display = 'none';

      // Open "While You Were Away" briefing card overlay
      document.getElementById('ovl-resume').classList.add('on');
      window.GAME_SHELL_RESUME.renderResumeBriefing(state);
    }
  },

  renderResumeBriefing(state) {
    const body = $('#resumeBody');
    const table = state.competitions?.league?.table || [];
    const pos = table.findIndex(r => r.clubId === state.meta?.userClubId) + 1 || 2;
    const nextF = sel.nextFixture(state);
    const oppClub = nextF ? state.entities.clubs.get(nextF.homeId === state.meta.userClubId ? nextF.awayId : nextF.homeId) : null;

    const unreadCount = state.inbox?.filter(m => !m.done && !m.opened).length || 0;
    const stakesLine = state.media?.stakesLine || 'A crucial test of tactical consistency lies ahead.';

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="row" style="justify-content:space-between;background:var(--panel);padding:14px 18px;border:1px solid var(--line2)">
          <div class="kpi gd"><span class="v" style="font-size:32px">Day ${state.clock.dayNumber}</span><span class="k">${state.clock.date}</span></div>
          <div class="kpi"><span class="v" style="font-size:32px">Position ${pos}</span><span class="k">Premier Division</span></div>
          <div class="kpi gr"><span class="v" style="font-size:32px">${unreadCount} Unread</span><span class="k">HQ Inbox Logs</span></div>
        </div>

        <div class="panel" style="padding:16px">
          <div class="ph" style="border:0;padding-left:0"><span class="t">NEXT STAKES DIRECTIVE</span></div>
          <p class="mut" style="font-size:13px;line-height:1.6">
            Our next upcoming fixture is against <b>${oppClub?.name || 'AS Meridiana'}</b> ${nextF ? `on ${nextF.date}` : ''}.\n\n
            <span style="color:var(--gold2)">"${stakesLine}"</span>
          </p>
        </div>

        <div class="grid" style="grid-template-columns: 1fr 1fr; gap:16px">
          <div class="panel" style="padding:16px">
            <div class="ph" style="border:0;padding-left:0"><span class="t">SQUAD STATUS</span></div>
            <div class="dim" style="font-size:12px;line-height:1.55">
              Squad Vitals: Morale high. Board is fully content with match consistency. Fans are dreaming of the title parade.
            </div>
          </div>
          <div class="panel" style="padding:16px">
            <div class="ph" style="border:0;padding-left:0"><span class="t">FINANCE SHEETS</span></div>
            <div class="dim" style="font-size:12px;line-height:1.55">
              Cash on hand remains fully compliant with UEFA Financial Fair Play ratio constraints.
            </div>
          </div>
        </div>

        <div class="hr"></div>
        <button class="btn gold" style="width:100%;height:44px" onclick="closeOvl('ovl-resume')"><span>GO TO HEADQUARTERS HQ ▸</span></button>
      </div>
    `;
  }
};

// Settings & Accessibility updates
window.GAME_SHELL_SETTINGS = {
  openSettingsOvl() {
    document.getElementById('ovl-settings').classList.add('on');
    window.GAME_SHELL_SETTINGS.renderSettings();
  },

  renderSettings() {
    const body = $('#settingsBody');
    const state = getState();
    initSettingsAndHistory(state);

    const s = state.settings;

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="panel" style="padding:16px">
          <div class="ph" style="border:0;padding-left:0"><span class="t">SIMULATION SPEED DETAIL</span></div>
          <div class="chips">
            <button class="chipsel ${s.matchDetail === 'full' ? 'on' : ''}" onclick="window.GAME_SHELL_SETTINGS.saveSetting('matchDetail', 'full')"><span>FULL LIVE MATCH STREAM</span></button>
            <button class="chipsel ${s.matchDetail === 'normal' ? 'on' : ''}" onclick="window.GAME_SHELL_SETTINGS.saveSetting('matchDetail', 'normal')"><span>KEY EVENTS ONLY (NORMAL)</span></button>
            <button class="chipsel ${s.matchDetail === 'instant' ? 'on' : ''}" onclick="window.GAME_SHELL_SETTINGS.saveSetting('matchDetail', 'instant')"><span>INSTANT SILENT RESOLUTIONS</span></button>
          </div>
        </div>

        <div class="panel" style="padding:16px">
          <div class="ph" style="border:0;padding-left:0"><span class="t">ACCESSIBILITY COLORBLIND MODE</span></div>
          <div class="chips">
            <button class="chipsel ${s.colorblindMode === 'none' ? 'on' : ''}" onclick="window.GAME_SHELL_SETTINGS.saveSetting('colorblindMode', 'none')"><span>NONE (STANDARD RED/GREEN)</span></button>
            <button class="chipsel ${s.colorblindMode === 'redgreen' ? 'on' : ''}" onclick="window.GAME_SHELL_SETTINGS.saveSetting('colorblindMode', 'redgreen')"><span>RECODE FORM DOTS (W/D/L TEXT INDICATORS)</span></button>
          </div>
        </div>

        <div class="panel" style="padding:16px">
          <div class="ph" style="border:0;padding-left:0"><span class="t">UI SCALE & COMPACTNESS</span></div>
          <div class="chips">
            <button class="chipsel ${s.uiDensity === 'comfortable' ? 'on' : ''}" onclick="window.GAME_SHELL_SETTINGS.saveSetting('uiDensity', 'comfortable')"><span>COMFORTABLE UI PADDING</span></button>
            <button class="chipsel ${s.uiDensity === 'dense' ? 'on' : ''}" onclick="window.GAME_SHELL_SETTINGS.saveSetting('uiDensity', 'dense')"><span>COMPACT HIGH-DENSITY GRID</span></button>
          </div>
        </div>

        <div class="hr"></div>
        <button class="btn gold" style="width:100%" onclick="closeOvl('ovl-settings')"><span>SAVE & CLOSE</span></button>
      </div>
    `;
  },

  saveSetting(key, val) {
    const state = getState();
    state.settings[key] = val;

    // Apply colorblind mode to UI body classes if redgreen
    if (key === 'colorblindMode') {
      if (val === 'redgreen') {
        document.body.classList.add('colorblind-text');
      } else {
        document.body.classList.remove('colorblind-text');
      }
    }

    // Apply UI density compact sizing class
    if (key === 'uiDensity') {
      if (val === 'dense') {
        document.body.classList.add('ui-dense');
      } else {
        document.body.classList.remove('ui-dense');
      }
    }

    // Set speed in state machine
    if (key === 'matchDetail' && val === 'instant') {
      setSpeed('instant');
    } else if (key === 'matchDetail') {
      setSpeed('normal');
    }

    logger.info('shell', `saved setting ${key}=${val}`);
    window.GAME_SHELL_SETTINGS.renderSettings();
    syncLegacyGlobals(state);
    rerender();
  }
};

// Pause Menu archives
window.GAME_SHELL_PAUSE = {
  saveManualSlot() {
    const state = getState();
    const ok = save(state, 'manual_save_1');
    if (ok) {
      toast('SAVE SECURED', 'Game state successfully committed to slot 1 manual save!', 'gr');
    }
  },

  openLoadSlotOvl() {
    const state = getState();
    const loaded = load('manual_save_1');
    if (loaded) {
      setState(loaded);
      syncLegacyGlobals(loaded);
      rerender();
      closeOvl('ovl-pause');
      toast('LOAD RE-ANCHOR', 'Loaded manual save slot 1 successfully!', 'gr');
    } else {
      toast('LOAD FAIL', 'No manual save found in slot 1', 'rd');
    }
  },

  viewSeasonHistory() {
    const state = getState();
    initSettingsAndHistory(state);

    const historyBox = document.getElementById('ovl-clubx');
    const body = document.getElementById('clubxBody');

    const seasons = state.history.seasons || [];

    body.innerHTML = `
      <div style="padding:10px">
        <h3 class="big" style="font-size:32px;color:var(--gold2);margin-bottom:12px">HISTORICAL SEASON ARCHIVE</h3>
        ${seasons.length === 0 ? '<div class="dim">The archives are empty. Complete your first season to populate logs.</div>' : `
          <table class="tbl">
            <thead>
              <tr><th>SEASON</th><th>FINISH POSITION</th><th>VAL VALUE</th><th>TOP SCORER</th></tr>
            </thead>
            <tbody>
              ${seasons.map(s => `
                <tr>
                  <td><b>Season ${s.year}/${s.year+1}</b></td>
                  <td>Position ${s.position}</td>
                  <td>£${(s.balance/1e6).toFixed(1)}M</td>
                  <td>${s.topScorerName} (${s.topScorerGoals} goals)</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>
    `;

    closeOvl('ovl-pause');
    openOvl('ovl-clubx');
  },

  exitToTitle() {
    closeOvl('ovl-pause');
    document.getElementById('ovl-boot').style.display = 'block';
    document.getElementById('ovl-boot').classList.add('on');
    logger.info('shell', 'exited to boot title card menu');
  }
};

// Expose APIs to window.GAME for unified integration
window.GAME = window.GAME || {};
window.GAME.bootContinue = window.GAME_SHELL_RESUME.bootContinue;
window.GAME.openSetup = window.GAME_SHELL.openSetup;
window.GAME.openSettingsOvl = window.GAME_SHELL_SETTINGS.openSettingsOvl;
window.GAME.saveManualSlot = window.GAME_SHELL_PAUSE.saveManualSlot;
window.GAME.openLoadSlotOvl = window.GAME_SHELL_PAUSE.openLoadSlotOvl;
window.GAME.viewSeasonHistory = window.GAME_SHELL_PAUSE.viewSeasonHistory;
window.GAME.exitToTitle = window.GAME_SHELL_PAUSE.exitToTitle;
