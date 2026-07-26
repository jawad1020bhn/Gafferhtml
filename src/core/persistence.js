// core/persistence.js
// Save / load / autosave / migrate. localStorage adapter today,
// interface shaped so we can swap to IndexedDB or file export later.

import { logger } from './logger.js';

const SCHEMA_VERSION = 1;
const SLOT_PREFIX = 'gaffer26.save.';
const AUTOSAVE_SLOT = 'autosave';
const MANIFEST_KEY = 'gaffer26.manifest';

/** Keys whose data is recomputable and should not be persisted. */
const NON_PERSISTED_PATHS = new Set([
  'cache',
  'ui',
  'transient'
]);

/**
 * Strip recomputable cache fields before serialising.
 */
function serialise(state) {
  const slim = {
    ...state,
    entities: {
      ...state.entities,
      clubs: Object.fromEntries(state.entities.clubs || new Map()),
      players: Object.fromEntries(state.entities.players || new Map()),
      staff: Object.fromEntries(state.entities.staff || new Map()),
      agents: Object.fromEntries(state.entities.agents || new Map()),
      facilities: Object.fromEntries(state.entities.facilities || new Map()),
      sponsors: Object.fromEntries(state.entities.sponsors || new Map())
    },
    relationships: {
      ...state.relationships,
      contracts: Object.fromEntries(state.relationships.contracts || new Map()),
      negotiations: Object.fromEntries(state.relationships.negotiations || new Map()),
      scoutAssignments: Object.fromEntries(state.relationships.scoutAssignments || new Map())
    }
  };
  for (const k of NON_PERSISTED_PATHS) delete slim[k];
  return JSON.stringify(slim);
}

/**
 * Read a slot's raw payload. Returns null if missing or corrupt.
 */
function readSlot(slotName) {
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + slotName);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    logger.warn('persistence', 'failed to read slot', { slot: slotName, err: String(e) });
    return null;
  }
}

function writeSlot(slotName, payload) {
  try {
    localStorage.setItem(SLOT_PREFIX + slotName, JSON.stringify(payload));
    return true;
  } catch (e) {
    logger.error('persistence', 'failed to write slot', { slot: slotName, err: String(e) });
    return false;
  }
}

/**
 * Save the given GameState to a named slot. Wraps it with metadata.
 */
export function save(state, slotName = AUTOSAVE_SLOT) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    slot: slotName,
    savedAt: Date.now(),
    state: serialise(state)
  };
  const ok = writeSlot(slotName, payload);
  if (ok) updateManifest(slotName, payload);
  return ok;
}

/**
 * Load a slot. Returns the migrated GameState or null.
 */
export function load(slotName = AUTOSAVE_SLOT) {
  const payload = readSlot(slotName);
  if (!payload) return null;
  let state;
  try { state = JSON.parse(payload.state); }
  catch (e) {
    logger.error('persistence', 'state JSON parse failed', { slot: slotName, err: String(e) });
    return null;
  }

  // Re-hydrate Maps
  if (state.entities) {
    state.entities.clubs = new Map(Object.entries(state.entities.clubs || {}));
    state.entities.players = new Map(Object.entries(state.entities.players || {}));
    state.entities.staff = new Map(Object.entries(state.entities.staff || {}));
    state.entities.agents = new Map(Object.entries(state.entities.agents || {}));
    state.entities.facilities = new Map(Object.entries(state.entities.facilities || {}));
    state.entities.sponsors = new Map(Object.entries(state.entities.sponsors || {}));
  }
  if (state.relationships) {
    state.relationships.contracts = new Map(Object.entries(state.relationships.contracts || {}));
    state.relationships.negotiations = new Map(Object.entries(state.relationships.negotiations || {}));
    state.relationships.scoutAssignments = new Map(Object.entries(state.relationships.scoutAssignments || {}));
  }

  return migrate(state, payload.schemaVersion, SCHEMA_VERSION);
}

export function deleteSlot(slotName) {
  try { localStorage.removeItem(SLOT_PREFIX + slotName); }
  catch (_) {}
  removeFromManifest(slotName);
}

/** List all saved slots with light metadata for the load menu. */
export function listSaves() {
  const manifest = readManifest();
  return manifest.slots.slice().sort((a, b) => b.savedAt - a.savedAt);
}

/** Autosave — debounced. Will coalesce rapid calls. */
let _autosaveTimer = null;
const AUTOSAVE_DEBOUNCE_MS = 400;

export function autosave(state) {
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => {
    _autosaveTimer = null;
    save(state, AUTOSAVE_SLOT);
  }, AUTOSAVE_DEBOUNCE_MS);
}

/** Flush pending autosave immediately (used on page unload). */
export function flushAutosave(state) {
  if (_autosaveTimer) {
    clearTimeout(_autosaveTimer);
    _autosaveTimer = null;
  }
  save(state, AUTOSAVE_SLOT);
}

// ---------------- Migration ----------------

/**
 * Migrate a state object from `fromVersion` to `toVersion`.
 * Each step is a pure function (state) -> state. Empty for now (v1),
 * but the stub is here so future schema bumps don't break old saves.
 */
export function migrate(state, fromVersion, toVersion = SCHEMA_VERSION) {
  if (fromVersion === toVersion) return state;
  if (fromVersion > toVersion) {
    logger.warn('persistence', 'downgrading save version not supported', { fromVersion, toVersion });
    return state;
  }
  let s = state;
  // Future: steps[fromVersion] -> fromVersion+1, etc.
  // if (fromVersion < 2) s = migrate_v1_to_v2(s);
  // if (fromVersion < 3) s = migrate_v2_to_v3(s);
  s.__migratedFrom = fromVersion;
  s.__migratedTo = toVersion;
  logger.info('persistence', 'migrated save', { fromVersion, toVersion });
  return s;
}

export function getSchemaVersion() { return SCHEMA_VERSION; }
export function getAutosaveSlotName() { return AUTOSAVE_SLOT; }

// ---------------- Manifest ----------------

function readManifest() {
  try {
    const raw = localStorage.getItem(MANIFEST_KEY);
    if (!raw) return { slots: [] };
    return JSON.parse(raw);
  } catch (_) {
    return { slots: [] };
  }
}

function writeManifest(man) {
  try { localStorage.setItem(MANIFEST_KEY, JSON.stringify(man)); }
  catch (_) {}
}

function updateManifest(slotName, payload) {
  const man = readManifest();
  const meta = {
    slot: slotName,
    savedAt: payload.savedAt,
    schemaVersion: payload.schemaVersion,
    // Try to pull a few display-friendly fields off the state for the load menu.
    clubName: safeGet(payload, 'state', 'meta', 'clubName') ?? '—',
    date:     safeGet(payload, 'state', 'clock', 'date') ?? '—',
    phase:    safeGet(payload, 'state', 'clock', 'phase') ?? '—'
  };
  const idx = man.slots.findIndex(s => s.slot === slotName);
  if (idx >= 0) man.slots[idx] = meta; else man.slots.push(meta);
  writeManifest(man);
}

function removeFromManifest(slotName) {
  const man = readManifest();
  man.slots = man.slots.filter(s => s.slot !== slotName);
  writeManifest(man);
}

function safeGet(obj, ...path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}
