// sim/narrative/engine.js
// Dynamic News, Media, and Narrative Engine.
// Manages story seeds detection, headline generation, press conferences, fan mood factions,
// and seasonal narrative arcs.

import { logger } from '../../core/logger.js';
import { EVT } from '../../core/eventBus.js';
import { INC_KEYS, EXP_KEYS } from '../finance/engine.js';

/**
 * Initialize narrative state fields (migration safety).
 */
export function initNarrativeState(state) {
  state.media = state.media || {};
  state.media.headlines = state.media.headlines || [];
  state.media.storySeeds = state.media.storySeeds || [];
  state.media.activeArcs = state.media.activeArcs || [];
  state.media.fanSentiment = state.media.fanSentiment ?? 71;
  state.media.stakesLine = state.media.stakesLine ?? 'Another crucial test for Ravensport.';

  // Track media outlet relationships (0..100 warmth)
  state.media.outletRelationships = state.media.outletRelationships || {
    'The Daily Kick': 50,
    'The Meridian Times': 60,
    'Ravensport Echo': 75,
    'Transfer Insider': 50,
    'Tactics Weekly': 55,
    'Sports Central': 55
  };

  // Expose fan factions
  state.media.factions = state.media.factions || {
    ultras: { name: 'The Ultras', mood: 71, weight: 0.25 },
    matchgoers: { name: 'The Matchgoing Regulars', mood: 71, weight: 0.50 },
    oldGuard: { name: 'The Old Guard / Traditionalists', mood: 71, weight: 0.25 }
  };
}

/**
 * Append a StorySeed to the database.
 */
export function addStorySeed(state, seed) {
  initNarrativeState(state);

  const id = 'seed_' + Date.now() + '_' + Math.floor(Math.random() * 1e4);
  const storySeed = {
    id,
    type: seed.type,
    score: seed.score ?? 50,
    metadata: seed.metadata || {},
    createdAt: state.clock.date,
    decayDays: seed.decayDays ?? 5
  };

  state.media.storySeeds.push(storySeed);

  // Keep story seeds list trimmed
  if (state.media.storySeeds.length > 50) {
    state.media.storySeeds.sort((a, b) => b.score - a.score);
    state.media.storySeeds = state.media.storySeeds.slice(0, 50);
  }

  logger.debug('narrative', 'story seed detected', storySeed);
  return storySeed;
}

/**
 * Detect StorySeeds based on current state events and attributes.
 */
export function detectStorySeeds(state, context = {}) {
  initNarrativeState(state);
  const seeds = [];

  const userClubId = state.meta.userClubId;
  const userClub = state.entities.clubs.get(userClubId);

  // 1. Scan user players for Milestones and Contract Expiries
  if (userClub) {
    for (const pid of userClub.squadIds || []) {
      const p = state.entities.players.get(pid);
      if (!p) continue;

      // Milestone Approach tracking (Kavanagh's 98-99 goals approaching 100)
      if (p.name.includes('Kavanagh') || p.careerG >= 95) {
        const goals = p.careerG || p.stats?.goals || 0;
        if (goals === 98 || goals === 99) {
          seeds.push({
            type: 'milestone_approach',
            score: 70,
            metadata: { playerId: p.id, playerName: p.name, statName: 'career goals', currentVal: goals, targetVal: 100 },
            decayDays: 14
          });
        } else if (goals >= 100 && !p._landmark100Celebrated) {
          p._landmark100Celebrated = true; // prevent double trigger
          seeds.push({
            type: 'milestone_reached',
            score: 95,
            metadata: { playerId: p.id, playerName: p.name, statName: 'career goals', currentVal: goals, targetVal: 100 },
            decayDays: 10
          });
        }
      }

      // Key injuries
      if (p.inj && p.ovr >= 80 && !p._injuryFlaggedNews) {
        p._injuryFlaggedNews = true;
        seeds.push({
          type: 'injury',
          score: 75,
          metadata: { playerId: p.id, playerName: p.name, injuryType: p.inj.type, daysLeft: p.inj.daysLeft },
          decayDays: 5
        });
      }

      // Unrest & Transfer requests
      if (p.unrest && p.ovr >= 75) {
        seeds.push({
          type: 'contract_saga',
          score: 80,
          metadata: { playerId: p.id, playerName: p.name, reason: 'unrest' },
          decayDays: 7
        });
      }
    }
  }

  // 2. Scan negotiations for transfer leaks
  if (state.negotiations) {
    for (const neg of state.negotiations) {
      if (neg.completedAt) continue;
      const targetPlayer = state.entities.players.get(neg.playerId) || state.transferTargets?.find(t => t.id === neg.playerId);
      if (!targetPlayer) continue;

      const ovr = targetPlayer.ovr || 75;
      const prng = context.prng || { next: () => Math.random() };
      const roll = prng.next();

      let leakScore = 0;
      let reason = '';

      if (neg.state === 'BID_SUBMITTED' && roll < 0.25) {
        leakScore = 60 + (ovr - 70) * 2;
        reason = 'bid_made';
      } else if (neg.state === 'PERSONAL_TERMS' && roll < 0.50) {
        leakScore = 70 + (ovr - 70) * 2;
        reason = 'personal_terms';
      } else if (neg.state === 'MEDICAL' && roll < 0.90) {
        leakScore = 85 + (ovr - 70) * 1.5;
        reason = 'medical_pending';
      }

      if (leakScore > 0) {
        seeds.push({
          type: 'transfer_leak',
          score: Math.min(95, Math.round(leakScore)),
          metadata: { playerId: targetPlayer.id, playerName: targetPlayer.n || targetPlayer.name, buyerId: neg.buyerClubId, sellerId: neg.sellerClubId, reason },
          decayDays: 3
        });
      }
    }
  }

  // Add detected seeds to database
  const createdSeeds = [];
  for (const s of seeds) {
    createdSeeds.push(addStorySeed(state, s));
  }
  return createdSeeds;
}

/**
 * Generate a dynamic headline and body based on a StorySeed and a specific outlet profile.
 * Incorporates persistent biases, framing axes, and hyperbole control.
 */
export function generateHeadlineFromSeed(state, seed, outletName, prng) {
  initNarrativeState(state);
  const rand = prng ? prng.next() : Math.random();

  const userClubId = state.meta.userClubId;
  const userClub = state.entities.clubs.get(userClubId);
  const userCode = userClub?.code || 'RAV';

  let t = '';
  let b = '';
  let likes = Math.floor(1200 + rand * 3000);

  // persistent framing options
  const framings = ['hero', 'tactical', 'concern', 'narrative'];
  const framing = framings[Math.floor(rand * framings.length)];

  if (seed.type === 'match_result') {
    const { hs, as, opponentCode, homeId, isDerby, scorers } = seed.metadata;
    const isHome = homeId === userClubId;
    const userScored = isHome ? hs : as;
    const oppScored = isHome ? as : hs;
    const won = userScored > oppScored;
    const lost = userScored < oppScored;
    const draw = userScored === oppScored;

    const mainScorerName = scorers && scorers.length ? scorers[0].name : 'Kavanagh';

    if (outletName === 'The Daily Kick') {
      // Sensational, loud tabloid
      if (won) {
        t = `EUPHORIA! ${mainScorerName.toUpperCase()} MASTERCLASS DESTROYS ${opponentCode}!`;
        b = `Spectators left breathless as Ravensport FC ran riot at the ground. Tabloid sources are already speculating on championship trophy parades.`;
      } else if (lost) {
        t = `DISASTER! MERCER OUT IN THE COLD AS ${opponentCode} CONQUERS RAVENSPORT!`;
        b = `Furious fans make their voices heard after a tactical shambles. The Daily Kick asks: is Alex Mercer's tenure in immediate jeopardy?`;
      } else {
        t = `STALEMATE SHOCKER! ${userCode} CRASH IN FRUSTRATING DRAW!`;
        b = `A flat, uninspired performance leaves the base questioning the squad's ambition after shared points vs ${opponentCode}.`;
      }
    } else if (outletName === 'The Meridian Times') {
      // Measured, analytical broadsheet
      if (won) {
        t = `Measured Display Sees Ravensport Secure ${userScored}-${oppScored} Victory Over ${opponentCode}`;
        b = `Alex Mercer's structured system neutralized the opponent's counter threat. Composure in central transitions proved the decisive factor.`;
      } else if (lost) {
        t = `Ravensport Lapses Capitalized on by Efficient ${opponentCode}`;
        b = `Defensive positioning errors in the final third led to a deserved defeat. Broadsheet analysts suggest structural shifts are required.`;
      } else {
        t = `Tactical Deadlock as Points Shared in Low-Scoring Encounter`;
        b = `Neither squad managed to control key zones. The draw reflects a balanced game of high defensive discipline but low creative output.`;
      }
    } else if (outletName === 'Ravensport Echo') {
      // Local club-aligned sympathetic
      if (won) {
        t = `WE GO AGAIN! Local Hero ${mainScorerName} Fires Ravensport to Massive Victory!`;
        b = `Atmosphere was electric at Ironworks Park as the boys gave us another afternoon to remember. Local Echo editors are absolutely beaming.`;
      } else if (lost) {
        t = `Heads Up, Lads: Tough Defeat at ${opponentCode} But Fight Remains`;
        b = `A bruising match didn't go our way, but Mercer's squad showed real character till the final whistle. The local support stays 100% faithful.`;
      } else {
        t = `Tense Draw vs ${opponentCode}: A solid foundation to build upon`;
        b = `We didn't get all three points, but the defensive clean sheet elements show the training ground drills are paying off.`;
      }
    } else {
      // Default / Sports Central
      t = `${userCode} and ${opponentCode} Settle Tense ${userScored}-${oppScored} Encounter`;
      b = `Scorers: ${scorers ? scorers.map(s => s.name).join(', ') : 'None'}. Full crowd witnessed an intense matchweek fixture.`;
    }
  } else if (seed.type === 'transfer_leak') {
    const { playerName, buyerId, sellerId, reason } = seed.metadata;
    const buyerClub = state.entities.clubs.get(buyerId);
    const buyerCode = buyerClub?.code || 'RAV';

    if (outletName === 'Transfer Insider') {
      t = `EXCLUSIVE: Agents shopping ${playerName} to ambitious ${buyerCode}!`;
      b = `Sources tell Transfer Insider that formal talks have progressed rapidly. A completed bid of multi-millions is expected on completion of terms.`;
    } else if (outletName === 'The Daily Kick') {
      t = `WANTED! ${buyerCode} launch covert bid for superstar ${playerName}!`;
      b = `A massive cash-overdraft deal is reportedly in the works. Agent Ferreira was spotted in board offices yesterday.`;
    } else {
      t = `Speculation Links ${playerName} with Potential Transfer Outward`;
      b = `Reports suggest initial enquiries have been launched, though official spokespeople from both clubs have declined to comment.`;
    }
  } else if (seed.type === 'milestone_approach') {
    const { playerName, statName, currentVal, targetVal } = seed.metadata;
    t = `HISTORY IN SIGHT: ${playerName} approaches legendary ${targetVal} ${statName}!`;
    b = `With currently ${currentVal} on the sheet, every matchgoing supporter is holding their breath for the next goal.`;
  } else if (seed.type === 'milestone_reached') {
    const { playerName, statName, currentVal, targetVal } = seed.metadata;
    t = `THE CENTURY CLUB! ${playerName} reaches historic ${targetVal} ${statName}!`;
    b = `Supremely historic milestone reached. Standing ovation at Ironworks Park as teammates and fans celebrate a career defining achievement.`;
  } else if (seed.type === 'injury') {
    const { playerName, injuryType, daysLeft } = seed.metadata;
    const weeks = Math.ceil(daysLeft / 7);
    t = `INJURY CLOUD: ${playerName} sidelined for ${weeks} weeks with ${injuryType.toLowerCase()}`;
    b = `Huge setback for Alex Mercer's tactical plans. The medical centre and sports science network will be working overtime to accelerate recovery.`;
  } else if (seed.type === 'contract_saga') {
    const { playerName, reason } = seed.metadata;
    t = `CONTRACT STANDOFF: Unrest grows for ${playerName} camp`;
    b = `Dressing room sources suggest wage ratio ceilings and transfer list demands are causing major tension inside the club.`;
  } else {
    // Default feature headline
    t = `Inside the Rebuild at Ironworks Park`;
    b = `An in-depth look at facilities upgrades, training microcycles, and youth academy Wonderkid integration.`;
  }

  return {
    outlet: outletName,
    cat: seed.type.toUpperCase().replace('_', ' '),
    t,
    b,
    ago: '0h',
    likes
  };
}

/**
 * Generate highly context-aware social tweets in the live wire feed based on active stories.
 */
export function generateSocialTweets(state, prng) {
  initNarrativeState(state);
  const rand = prng ? prng.next() : Math.random();

  const tweets = [];
  const sentiment = state.media.fanSentiment;

  // hashtags driven by mood/sentiment
  const trendingTags = [];
  if (sentiment < 45) {
    trendingTags.push('#MercerOut', '#BoardOut');
  } else if (sentiment > 75) {
    trendingTags.push('#MercerIn', '#TitleCharge');
  } else {
    trendingTags.push('#RAV', '#MeridianPD');
  }

  const seeds = state.media.storySeeds || [];
  if (seeds.length > 0) {
    const seed = seeds[0];
    if (seed.type === 'match_result') {
      const { opponentCode, hs, as } = seed.metadata;
      tweets.push({
        h: 'Dana Whitmore', v: 1, j: 1,
        t: `Spoke to sources inside the dressing room. High spirits after that battle vs ${opponentCode}. Mercer has won over the squad. ${trendingTags[0]}`,
        l: Math.floor(4000 + rand * 3000), c: Math.floor(500 + rand * 1000)
      });
      tweets.push({
        h: 'Ironworks Roar', v: 0, j: 0,
        t: `Absolute limbs in the away end! What a performance vs ${opponentCode}. We are cooking. #UTI ${trendingTags[0]}`,
        l: Math.floor(1000 + rand * 1500), c: Math.floor(100 + rand * 500)
      });
    } else if (seed.type === 'transfer_leak') {
      const { playerName } = seed.metadata;
      tweets.push({
        h: 'Transfer Insider', v: 1, j: 1,
        t: `HEARD: Standard pre-contract negotiations are advanced for ${playerName}. Agent Ferreira is holding out for £60K+/wk. #TransferSpeculation ${trendingTags[0]}`,
        l: Math.floor(8000 + rand * 5000), c: Math.floor(1200 + rand * 1000)
      });
    } else if (seed.type === 'milestone_approach') {
      const { playerName, targetVal, statName } = seed.metadata;
      tweets.push({
        h: 'Ravensport Faith', v: 0, j: 0,
        t: `${playerName} is closing in on ${targetVal} ${statName}! Absolute club legend. Get the tifo ready! #Legend ${trendingTags[0]}`,
        l: Math.floor(2500 + rand * 1000), c: Math.floor(200 + rand * 300)
      });
    }
  }

  // Fallback default tweets if pool is thin
  if (tweets.length < 4) {
    tweets.push({
      h: 'The Tinkerman Blog', v: 0, j: 0,
      t: `Our PPDA of 8.2 says it all — the high pressing system Mercer implements is structurally superior. It's about process, not just scorelines. #Tactics ${trendingTags[0]}`,
      l: 2300, c: 190
    });
    tweets.push({
      h: 'Halloway Ultras', v: 0, j: 0,
      t: `Enjoy second place while it lasts, Ravensport. The Cathedral is ours. See you on the 31st! #Halloway #NorthbridgeDerby ${trendingTags[0]}`,
      l: 5400, c: 800
    });
    tweets.push({
      h: 'Dana Whitmore', v: 1, j: 1,
      t: `Vantage Energy representatives reportedly pleased with high exposure ratings. Renewal discussions looking extremely positive. #Vantage ${trendingTags[0]}`,
      l: 3200, c: 450
    });
  }

  state.media.socialTweets = tweets;
  return tweets;
}

/**
 * Generate an interactive pre-match press conference inside the inbox.
 */
export function triggerPreMatchPressConference(state, fixture) {
  initNarrativeState(state);

  const oppClub = state.entities.clubs.get(fixture.homeId === state.meta.userClubId ? fixture.awayId : fixture.homeId);
  const oppName = oppClub?.name || 'Opponent';

  const msgId = 'press_pre_' + Date.now();
  state.inbox = state.inbox || [];
  state.inbox.unshift({
    id: msgId,
    severity: 'md',
    sender: 'Press Corps · Media Room',
    subject: `Pre-Match Press Conference: Facing ${oppName}`,
    body: `Reporters have gathered for your pre-match press conference. Broadsheets and tabloids alike are asking about your preparation and tactical confidence vs ${oppName}.`,
    choices: [
      {
        label: 'BACK THE PLAYERS AND TACTICS',
        note: 'Back the unit: Morale +5 for all, Fan mood +3, Echo relationship +10',
        action: { kind: 'press-defend' }
      },
      {
        label: 'DEFLECT STAKES SAFELY',
        note: 'Diplomatic deflection. No morale or sentiment changes.',
        action: { kind: 'press-deflect' }
      },
      {
        label: 'GO ON THE ATTACK AGAINST CRITICS',
        note: 'Go on the offensive: Fan mood +10, Morale -5, Broadsheet relationship -10',
        action: { kind: 'press-attack' }
      }
    ],
    done: false,
    opened: false
  });

  logger.info('narrative', 'triggered pre-match press conference', { msgId });
}

/**
 * Generate a scout analysis alert briefing if the upcoming rival manager has adapted their tactics to counter you.
 */
export function triggerScoutPreMatchReport(state, fixture) {
  const userClubId = state.meta.userClubId;
  const oppClubId = fixture.homeId === userClubId ? fixture.awayId : fixture.homeId;
  const oppClub = state.entities.clubs.get(oppClubId);
  if (!oppClub) return;

  const rivalMgr = state.entities.staff.get(oppClub.managerId);
  if (!rivalMgr) return;

  const mem = state.managerTacticalMemory?.[rivalMgr.id];
  if (!mem || !mem.lastUserFormation) return;

  const userClub = state.entities.clubs.get(userClubId);
  const userFormation = userClub?.tactics?.formation || '4-3-3';
  const adaptedFormation = oppClub.tactics?.formation || '4-4-2';

  // If high rivalry and they adapted formation from their standard preference
  if (mem.rivalryRating >= 25 && adaptedFormation !== rivalMgr.preferredFormation) {
    const msgId = 'scout_brief_' + Date.now();
    state.inbox = state.inbox || [];
    state.inbox.unshift({
      id: msgId,
      severity: 'high',
      sender: 'Chief Scout · Analytics Room',
      subject: `TACTICAL ALERT: ${oppClub.code} countering our ${userFormation}!`,
      body: `Alex,\n\nOur pre-match opposition analysis on ${oppClub.name} has flagged a major tactical adjustment.\n\nTheir manager, ${rivalMgr.name}, has adjusted their standard lineup to deploy an adapted ${adaptedFormation} formation designed specifically to counter our preferred ${userFormation} shape.\n\n"They have analyzed our last matchweek layout and are setting a trap. I strongly suggest shifting our starting formation or tactical tempo to keep them guessing and regain structural advantage."`,
      choices: [],
      done: true,
      opened: false
    });
    logger.info('narrative', 'triggered scout pre-match adaptation alert', { msgId });
  }
}

/**
 * Generate an interactive post-match press conference inside the inbox.
 */
export function triggerPostMatchPressConference(state, fixture, report) {
  initNarrativeState(state);

  const oppClubId = fixture.homeId === state.meta.userClubId ? fixture.awayId : fixture.homeId;
  const oppClub = state.entities.clubs.get(oppClubId);
  const oppName = oppClub?.name || 'Opponent';

  const userClubId = state.meta.userClubId;
  const isHome = fixture.homeId === userClubId;
  const userScored = isHome ? report.score.hs : report.score.as;
  const oppScored = isHome ? report.score.as : report.score.hs;
  const won = userScored > oppScored;

  const msgId = 'press_post_' + Date.now();
  state.inbox = state.inbox || [];
  state.inbox.unshift({
    id: msgId,
    severity: 'md',
    sender: 'Press Corps · Post-Match Interview',
    subject: `Post-Match Press Conference: ${userScored}-${oppScored} vs ${oppName}`,
    body: `Following the full-time whistle, reporters are asking for your thoughts on the performance and the tactical execution.`,
    choices: [
      {
        label: won ? 'PRAISE TEAM PERFORMANCE' : 'TAKE FULL RESPONSIBILITY',
        note: 'Morale +5 for all, Fan mood +3, Echo relationship +10',
        action: { kind: 'press-defend' }
      },
      {
        label: 'DEFLECT QUESTION POLITELY',
        note: 'Diplomatic deflection. No morale or sentiment changes.',
        action: { kind: 'press-deflect' }
      },
      {
        label: won ? 'RECALL TACTICAL SUPERIORITY' : 'CRITICIZE REFEREE DECISIONS',
        note: 'Fan mood +10, Morale -5, Broadsheet relationship -10',
        action: { kind: 'press-attack' }
      }
    ],
    done: false,
    opened: false
  });

  logger.info('narrative', 'triggered post-match press conference', { msgId });
}

/**
 * Model three fan factions (Ultras, Matchgoers, Old Guard) with unique sensitivities
 * and update the collective fan sentiment index.
 */
export function updateFanSentimentFromFactions(state, context = {}) {
  initNarrativeState(state);

  const factions = state.media.factions;
  const { isWin, isDerby, isLoss, ticketPrice } = context;

  // 1. Update Ultras (loyalty, fight, derby weight)
  let ultrasDelta = -0.5; // slow baseline drift down
  if (isDerby) {
    ultrasDelta = isWin ? 15.0 : isLoss ? -15.0 : 0;
  } else {
    ultrasDelta = isWin ? 3.0 : isLoss ? -3.0 : 0;
  }
  factions.ultras.mood = Math.max(0, Math.min(100, factions.ultras.mood + ultrasDelta));

  // 2. Update Matchgoers (ticket pricing, regular match outcomes)
  let matchgoersDelta = -0.3;
  if (isWin) {
    matchgoersDelta = 4.0;
  } else if (isLoss) {
    matchgoersDelta = -4.0;
  }
  // pricing penalty: standard price is £28
  const pr = ticketPrice || state.stadium?.ticket || 28;
  if (pr > 28) {
    matchgoersDelta -= (pr - 28) * 0.45; // pricing tension penalty
  } else if (pr < 28) {
    matchgoersDelta += 1.0;
  }
  factions.matchgoers.mood = Math.max(0, Math.min(100, factions.matchgoers.mood + matchgoersDelta));

  // 3. Update Old Guard (conduct, academy graduations)
  let oldGuardDelta = -0.2;
  if (isWin) {
    oldGuardDelta = 2.0;
  } else if (isLoss) {
    oldGuardDelta = -2.0;
  }
  factions.oldGuard.mood = Math.max(0, Math.min(100, factions.oldGuard.mood + oldGuardDelta));

  // 4. Compute aggregate fanSentiment
  const totalSentiment =
    (factions.ultras.mood * factions.ultras.weight) +
    (factions.matchgoers.mood * factions.matchgoers.weight) +
    (factions.oldGuard.mood * factions.oldGuard.weight);

  state.media.fanSentiment = Math.round(totalSentiment);
  logger.info('narrative', 'updated fan sentiment from factions', { fanSentiment: state.media.fanSentiment });
}

/**
 * Update and track season-long narrative arcs (Title Race, Relegation, Hot Seat, Player Sagas)
 * and generate stakes framing before matches.
 */
export function updateNarrativeArcs(state) {
  initNarrativeState(state);

  const activeArcs = [];
  const table = state.competitions.league.table || [];
  const userClubId = state.meta.userClubId;
  const userPosition = table.findIndex(r => r.clubId === userClubId) + 1 || 2;

  // 1. Title Race Arc (Top 3)
  if (userPosition <= 3) {
    activeArcs.push({
      type: 'title_race',
      name: 'The Meridian Premier Title Run-In',
      urgency: 90,
      description: `Ravensport is currently in ${userPosition} position, fighting tooth and nail against Halloway and Duncairn for the title.`
    });
  }

  // 2. Relegation Battle Arc (Bottom 3)
  const isRelegationScare = userPosition >= 16;
  if (isRelegationScare) {
    activeArcs.push({
      type: 'relegation_battle',
      name: 'Survival Fight: Avoid the Drop',
      urgency: 95,
      description: `Sinking into ${userPosition} place has triggered panic. Fans are demanding survival fight spirit.`
    });
  }

  // 3. Manager Sacking Hot Seat Arc ( board match confidence < 50 )
  const boardMatchConf = state.board?.confidence?.Matches ?? 74;
  if (boardMatchConf < 50) {
    activeArcs.push({
      type: 'manager_hot_seat',
      name: 'Mercer on the Brink',
      urgency: 85,
      description: `Board confidence in matches has collapsed to ${boardMatchConf}%. Sacking odds are rising across tabloids.`
    });
  }

  // 4. Player saga countdown (Kavanagh 100 goals)
  const userClub = state.entities.clubs.get(userClubId);
  if (userClub) {
    const kavanagh = userClub.squadIds
      .map(id => state.entities.players.get(id))
      .find(p => p && p.name.includes('Kavanagh'));
    if (kavanagh && (kavanagh.careerG === 98 || kavanagh.careerG === 99)) {
      activeArcs.push({
        type: 'player_saga',
        name: "Kavanagh's Countdown to 100",
        urgency: 70,
        description: `Viktor Kavanagh is sitting on ${kavanagh.careerG} career goals, eagerly chasing his 100th landmark.`
      });
    }
  }

  state.media.activeArcs = activeArcs;

  // 5. Generate Stakes Framing Line
  let stakes = 'Another crucial matchday for Ravensport.';
  if (activeArcs.some(a => a.type === 'manager_hot_seat')) {
    stakes = 'Alex Mercer is under intense pressure. Defeat today could trigger a boarding ultimatum.';
  } else if (activeArcs.some(a => a.type === 'title_race')) {
    stakes = `A massive run-in test. Ravensport sits in ${userPosition === 1 ? '1st' : userPosition + 'nd'} place, where every goal is critical to the crown.`;
  } else if (activeArcs.some(a => a.type === 'relegation_battle')) {
    stakes = 'Six-pointer alert: Ravensport must fight for every ball to survive the drop zone.';
  } else if (activeArcs.some(a => a.type === 'player_saga')) {
    stakes = 'Eyes are on Viktor Kavanagh as he pursues a historic 100-goal club milestone.';
  }

  state.media.stakesLine = stakes;
  logger.info('narrative', 'updated active narrative arcs', { activeArcsCount: activeArcs.length, stakes });

  return activeArcs;
}

/**
 * Handle entire post-match narrative director cycle.
 * Computes fan faction mood shifts, detects story seeds, generates headlines from multiple outlets,
 * triggers post-match press conferences, and updates social tweets.
 */
export function processPostMatchNarrative(state, fixture, report) {
  initNarrativeState(state);
  const userClubId = state.meta.userClubId;
  const userIsHome = fixture.homeId === userClubId;
  const oppClubId = userIsHome ? fixture.awayId : fixture.homeId;
  const oppClub = state.entities.clubs.get(oppClubId);
  const oppCode = oppClub?.code || 'OPP';

  const userScored = userIsHome ? report.score.hs : report.score.as;
  const oppScored = userIsHome ? report.score.as : report.score.hs;
  const won = userScored > oppScored;
  const lost = userScored < oppScored;

  // 1. Update fan mood factions
  updateFanSentimentFromFactions(state, {
    isWin: won,
    isLoss: lost,
    isDerby: fixture.isDerby,
    ticketPrice: state.stadium?.ticket || 28
  });

  // 2. Build story seed
  const resultSeed = addStorySeed(state, {
    type: 'match_result',
    score: fixture.isDerby ? 90 : 70,
    metadata: {
      hs: report.score.hs,
      as: report.score.as,
      opponentCode: oppCode,
      homeId: fixture.homeId,
      isDerby: fixture.isDerby,
      scorers: report.scorers
    },
    decayDays: 5
  });

  // 3. Generate headlines from multiple outlets
  const outlets = ['The Daily Kick', 'The Meridian Times', 'Ravensport Echo'];
  for (const out of outlets) {
    const hl = generateHeadlineFromSeed(state, resultSeed, out, null);
    state.media.headlines.unshift(hl);
  }

  // Keep headlines database trimmed to 50
  if (state.media.headlines.length > 50) {
    state.media.headlines = state.media.headlines.slice(0, 50);
  }

  // 4. Trigger Post-Match press conference
  triggerPostMatchPressConference(state, fixture, report);

  // 5. Update arcs and social tweets
  updateNarrativeArcs(state);
  generateSocialTweets(state, null);
}
