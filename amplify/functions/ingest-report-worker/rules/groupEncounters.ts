/**
 * Groups a report's raw WCL fight list into "encounters" for ingestion:
 * each boss attempt (wipe or kill) stays its own row, but all trash
 * between two boss encounters collapses into a single combined-window
 * row instead of one per WCL fight.
 *
 * The tricky part: WCL only sets a nonzero `boss` id on the fight that
 * actually lands the kill. Wipe attempts on that same boss come back with
 * `boss: 0` — identical to real trash by that field alone (confirmed
 * against a live report: 3 wipes then a kill on Hydross the Unstable, all
 * four fights sharing the same name, only the 4th had boss!=0). So a run
 * of adjacent same-named fights is classified as a boss encounter if *any*
 * fight in it has boss!=0.
 *
 * Deliberately NOT falling back to RaidValidationRule.bossName for runs
 * that never show boss!=0 (e.g. a boss attempted all night but never
 * downed) — tried that and it backfired: RaidValidationRule.bossName also
 * names *trash* kill-count requirements ("Underbog Colossus", "Vashj'ir
 * Honor Guard" are both literal bossName rows there, tracking a minimum
 * trash-pack kill count for zone validation, not a discrete encounter).
 * Cross-referencing against it misclassified every one of those trash
 * packs as its own boss encounter. A boss that's wiped on all night with
 * zero kills anywhere in the report just folds into the surrounding
 * trash-gap window instead of getting its own row — a far better failure
 * mode than turning common trash into bogus boss rows.
 */

import type { WclFight } from '../../wcl-client/handler';

export interface BossEncounterGroup {
  kind: 'boss';
  name: string;
  fights: WclFight[];
}

export interface TrashEncounterGroup {
  kind: 'trash';
  name: string;
  fights: WclFight[];
}

export type EncounterGroup = BossEncounterGroup | TrashEncounterGroup;

export function groupEncounters(fights: WclFight[]): EncounterGroup[] {
  // Step 1: adjacent fights sharing a name are one "run" (one boss's wipes
  // + kill, or one trash pack's consecutive pulls).
  const runs: WclFight[][] = [];
  for (const fight of fights) {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun[0].name === fight.name) {
      lastRun.push(fight);
    } else {
      runs.push([fight]);
    }
  }

  const classifiedRuns = runs.map((run) => ({
    fights: run,
    name: run[0].name,
    isBoss: run.some((f) => !!f.boss),
  }));

  // Step 2: merge consecutive trash runs (even across different pack
  // names) into one group per gap; boss runs stay separate.
  const groups: EncounterGroup[] = [];
  let pendingTrash: WclFight[] = [];
  const flushTrash = () => {
    if (pendingTrash.length > 0) {
      groups.push({ kind: 'trash', name: '', fights: pendingTrash });
      pendingTrash = [];
    }
  };
  for (const run of classifiedRuns) {
    if (run.isBoss) {
      flushTrash();
      groups.push({ kind: 'boss', name: run.name, fights: run.fights });
    } else {
      pendingTrash.push(...run.fights);
    }
  }
  flushTrash();

  // Step 3: caption each trash group using neighboring boss context.
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.kind !== 'trash') continue;
    const nextBoss = groups.slice(i + 1).find((g): g is BossEncounterGroup => g.kind === 'boss');
    const prevBoss = groups
      .slice(0, i)
      .reverse()
      .find((g): g is BossEncounterGroup => g.kind === 'boss');
    group.name = nextBoss ? `Trash before ${nextBoss.name}` : prevBoss ? `Trash after ${prevBoss.name}` : 'Trash';
  }

  return groups;
}
