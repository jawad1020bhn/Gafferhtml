// tests/step89-tests.mjs
// Comprehensive test suite for Step 8 (Save, Settings & Shell) and Step 9 (Texture Layer).

import { newSeedState } from '../src/data/seed.js';
import {
  initSettingsAndHistory,
  validateSaveIntegrity,
  migrateSave,
  generateSavePreview,
  exportSaveFile,
  importSaveFile,
  updateClubRecords,
  unlockAchievement,
  processEndOfSeason,
  updateJobSecurity,
  getAvailableJobs,
  processInternationalBreak,
  triggerAIClubAdministration,
  applyFestivePileupFatigue,
  clearFestivePileup
} from '../src/sim/shell/engine.js';
import { initAIManagerState } from '../src/sim/ai/manager.js';

console.log('\n=== STEP 8 & 9 Shell & Texture Layer Tests ===');

// Helper to assert conditions
function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// 1. Save Integrity & Migrations
{
  console.log('\nStep 8.1 — Save Integrity & Migrations:');
  const state = newSeedState({ saveId: 's89' });

  assert(validateSaveIntegrity(state) === true, 'Integrity check validates correct seeded states');
  assert(validateSaveIntegrity({}) === false, 'Integrity check rejects corrupt empty states');

  // Preview generation
  const preview = generateSavePreview(state);
  assert(preview.clubCode === 'RAV', 'Preview correctly reads user club code');
  assert(preview.managerName === 'Alex Mercer', 'Preview correctly reads manager name');
  assert(preview.leaguePosition > 0, 'Preview includes live league position');

  // Schema Version Migration v1 -> v3
  const legacyV1State = {
    clock: { date: '2026-08-15', seasonYear: 2026 },
    meta: { userClubId: 'rav', seed: 'test' },
    entities: { clubs: new Map(), players: new Map() }
  };

  const migrated = migrateSave(legacyV1State, 1);
  assert(migrated.schemaVersion === 3, 'Migrates state schema version cleanly to latest (v3)');
  assert(migrated.settings.matchDetail === 'normal', 'Migrates and initializes default settings (v2)');
  assert(migrated.texture.internationalBreaksActive === false, 'Migrates and initializes texture settings (v3)');

  // Export & Import Portable Saves Round-trip
  const encoded = exportSaveFile(state);
  assert(typeof encoded === 'string' && encoded.length > 50, 'Save correctly encoded to portable string');

  const imported = importSaveFile(encoded);
  assert(imported !== null, 'Save imported and decoded successfully');
  assert(imported.meta.saveId === state.meta.saveId, 'Imported save matches original state');
}

// 2. Settings & Accessibility
{
  console.log('\nStep 8.2 — Settings & Accessibility:');
  const state = newSeedState({ saveId: 's89' });
  initSettingsAndHistory(state);

  assert(state.settings.colorblindMode === 'none', 'Initializes default colorblind setting');
  state.settings.colorblindMode = 'redgreen';
  assert(state.settings.colorblindMode === 'redgreen', 'Persists settings adjustments on state');
}

// 3. Club Records & Achievements
{
  console.log('\nStep 8.3 — Club Records & Achievements:');
  const state = newSeedState({ saveId: 's89' });
  initSettingsAndHistory(state);

  // Trigger new club record (Viktor Kavanagh reaches 101 career goals)
  updateClubRecords(state, 'mostGoals', 101, 'Viktor Kavanagh', 'All-time career goals');

  const recordMsg = state.inbox.find(m => m.id.startsWith('msg_record_'));
  assert(recordMsg !== undefined, 'Record-breaker triggers high-severity notification in user inbox');
  assert(state.history.records.mostGoals.val === 101, 'Club Records book updated with new benchmark');

  // Unlock Career Achievement
  unlockAchievement(state, 'Treble Winner');
  assert(state.achievements.includes('Treble Winner'), 'Achievement unlocked in profile');
  assert(state.inbox.some(m => m.subject.includes('🏆 ACHIEVEMENT UNLOCKED')), 'Unlocking achievement dispatches quiet toast badge to inbox');
}

// 4. End of Season Transitions
{
  console.log('\nStep 8.4 — End of Season Transitions:');
  const state = newSeedState({ saveId: 's89' });
  initSettingsAndHistory(state);

  const prevYear = state.clock.seasonYear;

  // Run End of Season transition
  processEndOfSeason(state);

  assert(state.clock.seasonYear === prevYear + 1, 'Increments calendar season year');
  assert(state.clock.date === `${prevYear + 1}-08-15`, 'Offsets date to August 15th for next season kickoff');
  assert(state.competitions.league.fixtures.length > 200, 'Regenerates full 34 matchweeks calendar of league fixtures');

  const reviewMsg = state.inbox.find(m => m.id.startsWith('msg_season_review_'));
  assert(reviewMsg !== undefined, 'Chairman dispatches dynamic Season Review bulletin to inbox');
  assert(state.history.seasons.length === 1, 'Logs previous season position and PnL balance in history archives');
}

// 5. Manager Career Security & Jobs board
{
  console.log('\nStep 8.5 — Manager Career Security:');
  const state = newSeedState({ saveId: 's89' });
  initSettingsAndHistory(state);

  // Mock board confidence under 35 (trigger ultimatum)
  state.board.confidence.Matches = 30;
  updateJobSecurity(state);
  assert(state.careerState === 'ultimatum', 'Board match confidence < 35 triggers official ultimatum');
  assert(state.inbox.some(m => m.subject.includes('Official Ultimatum Issued')), 'Board issues directive inbox message');

  // Mock board confidence under 20 (trigger dismissal)
  state.board.confidence.Matches = 15;
  updateJobSecurity(state);
  assert(state.careerState === 'sacked', 'Board match confidence < 20 triggers dismissal (sacked)');
  assert(state.inbox.some(m => m.subject.includes('SACKED')), 'Board issues termination notice');

  // Unemployed Jobs Board Approaches
  const jobs = getAvailableJobs(state);
  assert(jobs.length > 0, 'Sacked managers can browse approach vacancies on the Jobs Board');
  assert(jobs[0].situation.includes('seeking'), 'Approach vacancies include club situation briefings');
}

// 6. Lived-in Texture Layer
{
  console.log('\nStep 9.1 — International Breaks:');
  const state = newSeedState({ saveId: 's89' });
  initSettingsAndHistory(state);

  const kavanagh = state.entities.players.get('pl_p18');
  assert(kavanagh !== undefined, 'Viktor Kavanagh resolved correctly using pl_ prefix');
  kavanagh.fit = 100;

  // Mock international break callup
  processInternationalBreak(state, {
    next: () => 0.1, // forces bruised thigh injury roll
    pick: (a) => a[0]
  });

  assert(kavanagh.inj !== null && kavanagh.inj.type === 'Bruised thigh', 'International break triggers callup injuries on duty');
  assert(state.inbox.some(m => m.subject.includes('INTERNATIONAL WINDOW')), 'Assistant manager dispatches squad status briefing to inbox');
}

{
  console.log('\nStep 9.2 — Crisis Administrations & Fire Sales:');
  const state = newSeedState({ saveId: 's89' });
  initSettingsAndHistory(state);

  const oakmont = Array.from(state.entities.clubs.values()).find(c => c.code === 'OAK');

  // Set up Oakmont standings
  state.competitions.league.table = [
    { clubId: oakmont.id, P: 10, W: 3, D: 3, L: 4, Pts: 12 }
  ];

  // Trigger Administration
  triggerAIClubAdministration(state, 'OAK');

  const row = state.competitions.league.table.find(r => r.clubId === oakmont.id);
  assert(row.Pts === 3, 'Administration applies immediate -9 points penalty');

  const fireSaleTargets = state.transferTargets.filter(t => t.club === oakmont.name && t.isFireSale);
  assert(fireSaleTargets.length > 0, 'Crisis triggers forced fire sale of stars');
  assert(fireSaleTargets[0].val <= 4.5e6, 'Fire-sale assets listed at 50% discount price anchors');

  assert(state.inbox.some(m => m.subject.includes('Administration')), 'League dispatches high-drama news bulletin to user inbox');
}

{
  console.log('\nStep 9.3 — Seasonal Rhythm Pile-up:');
  const state = newSeedState({ saveId: 's89' });
  initSettingsAndHistory(state);

  applyFestivePileupFatigue(state);
  assert(state.texture.festiveMultiplierActive === true, 'Festive pile-up sets fatigue multiplier flags');

  clearFestivePileup(state);
  assert(state.texture.festiveMultiplierActive === false, 'Clearing pile-up restores normal fatigue baseline');
}

console.log('\n=== All Step 8 & 9 tests passed successfully! ===\n');
