import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { ingestReport } from '../functions/ingest-report/resource';
import { deleteReport } from '../functions/delete-report/resource';

/*
 * Every model here is public-read (any visitor, signed in or not) and
 * admin-write (Cognito "admins" group). Actual writes happen through
 * custom, Lambda-backed mutations (ingestReport today; deleteReport
 * later). Those functions don't go through this GraphQL authorization
 * layer at all — this installed Amplify Data version strips `.resource()`
 * out of the `allow` builder at model level (confirmed: `ModelType.mjs`
 * does `const { resource: _, ...rest } = allow` before invoking the
 * authorization callback), so function-to-model access is granted the
 * same way the seed scripts already do it: direct DynamoDB IAM
 * permissions wired in backend.ts, bypassing AppSync entirely.
 *
 * `allow.authenticated()` does NOT fix reads for a signed-in admin on
 * this installed Amplify Data version — tried it, redeployed, and
 * inspected the actual deployed resolver's authorization VTL
 * (`aws appsync get-function` on e.g. QuerylistReportsauth0Function): the
 * generated IAM-auth branch only ever compares the caller's role ARN
 * against `$ctx.stash.unauthRole`. There's no matching `authRole` stash
 * check for `allow.authenticated()` to hook into — it silently compiles
 * to nothing useful for this resolver, confirmed by testing a signed-in
 * request against the real deployed API (still `Unauthorized`) even
 * after adding it. Left out entirely rather than kept as a no-op that
 * would mislead a future reader into thinking this is where the fix
 * lives — see `src/readAuthMode.ts` for where it actually lives.
 */
const publicReadAdminWrite = (allow: any) => [
  allow.guest().to(['read']),
  allow.group('admins'),
];

const schema = a.schema({
  // --- Reference tables (admin-seeded from the source spreadsheets) ---

  ItemSocket: a
    .model({
      itemId: a.integer().required(),
      sockets: a.integer().required(),
    })
    .identifier(['itemId'])
    .authorization(publicReadAdminWrite),

  ShadowResistanceItem: a
    .model({
      itemId: a.integer().required(),
      srValue: a.integer().required(),
    })
    .identifier(['itemId'])
    .authorization(publicReadAdminWrite),

  // Shadow Resistance granted by a gear *enhancement* rather than the item
  // itself. enchantId is the SpellItemEnchantment id WCL reports as
  // `permanentEnchant`. srValue is the TBC value, which is NOT what WCL's
  // `permanentEnchantName` says — that string is the modern retail name and
  // has been rescaled (retail calls the +20 Glyph of Shadow Warding "+6
  // Shadow Resistance"), so the numbers here are sourced from TBC item
  // tooltips instead. Enchants granting "resistance to all magic schools"
  // are stored at their face value, since shadow is one of those schools.
  //
  // A table rather than a constant so a newly-used enchant (e.g. the Shadow
  // Armor Kit, which nobody has applied yet and whose enchantId therefore
  // can't be observed) can be added without a redeploy.
  // Character race, for the TBC racial resistances (Draenei and Forsaken
  // +10 Shadow, Blood Elf +5 to all schools). WCL supplies no race data
  // anywhere in its v1 API -- playerDetails carries class, server, region
  // and faction only -- so this is maintained by hand. An absent character
  // contributes 0, which is the pre-existing behaviour, so a partial roster
  // is safe.
  CharacterRace: a
    .model({
      characterName: a.string().required(),
      race: a.string().required(),
    })
    .identifier(['characterName'])
    .authorization(publicReadAdminWrite),

  ShadowResistanceEnchant: a
    .model({
      enchantId: a.integer().required(),
      srValue: a.integer().required(),
      name: a.string().required(),
    })
    .identifier(['enchantId'])
    .authorization(publicReadAdminWrite),

  // enchantId is the enchant's spell ID as it appears on a character's gear.
  // Most enchants are slot-unambiguous (weapon oils, ring/trinket procs), but
  // some (e.g. armor kits) apply the same enchantId across multiple gear
  // slots, so the source data disambiguates with a WCL 0-indexed gear-slot
  // number appended in brackets — e.g. "930 [9]" means enchantId 930 only
  // means what `label` says when found in slot 9 (Hands). Slot -1 is the
  // sentinel for "unambiguous, no slot needed" (identifier fields can't be
  // null in Amplify Data).
  SuboptimalEnchant: a
    .model({
      enchantId: a.integer().required(),
      slot: a.integer().required(),
      label: a.string().required(),
    })
    .identifier(['enchantId', 'slot'])
    .authorization(publicReadAdminWrite),

  // Vanity/proc items (fishing poles, holiday/quest rewards, etc.) that
  // carry passive stats but aren't real gear-slot upgrades — gearIssues
  // should skip these instead of flagging them as missing an enchant.
  ExcludedGearItem: a
    .model({
      itemId: a.integer().required(),
      itemName: a.string().required(),
    })
    .identifier(['itemId'])
    .authorization(publicReadAdminWrite),

  // Static TBC gem reference (id -> quality tier, name, socket color).
  // gearIssues.ts uses quality to flag "weak gem" (below Rare); the Gear
  // Listing tab uses name for tooltips and color for the gem pips. WCL's
  // gem data carries none of this, so it's sourced externally — see
  // scripts/seed/scrape_gem_qualities.py for provenance.
  GemQuality: a
    .model({
      itemId: a.integer().required(),
      quality: a.string().required(), // 'Common' | 'Uncommon' | 'Rare' | 'Epic'
      name: a.string(),
      color: a.string(), // 'Red' | 'Yellow' | 'Blue' | 'Orange' | 'Green' | 'Purple' | 'Meta' | 'Prismatic'
    })
    .identifier(['itemId'])
    .authorization(publicReadAdminWrite),

  // Enchant effect id -> TBC display name. WCL v1's permanentEnchantName is
  // the modern-retail name for the effect id (wrong numbers, wrong words for
  // TBC) — the ids are right, so the UI resolves names through this table
  // instead. See scripts/seed/scrape_enchant_names.py for provenance.
  EnchantName: a
    .model({
      enchantId: a.integer().required(),
      name: a.string().required(),
    })
    .identifier(['enchantId'])
    .authorization(publicReadAdminWrite),

  // Item id -> name, for the reports where WCL omits `name` on gear
  // entirely (see scripts/seed/scrape_item_names.py). The ingest worker
  // backfills missing names from this so a whole raid night's gear
  // analysis isn't lost to a gap in WCL's own data.
  ItemName: a
    .model({
      itemId: a.integer().required(),
      name: a.string().required(),
    })
    .identifier(['itemId'])
    .authorization(publicReadAdminWrite),

  // Outcome of the last ingest run for a report. The trigger returns
  // immediately (AppSync's 30s resolver cap) and the worker finishes
  // asynchronously, so without this a half-ingested raid reports success
  // and silently goes missing from the list — exactly how three raid
  // nights were lost to the gear-name marshalling bug. The admin screen
  // polls this after kicking off an ingest.
  IngestStatus: a
    .model({
      reportCode: a.string().required(),
      finishedAt: a.string(),
      encountersTotal: a.integer(),
      encountersFailed: a.integer(),
      errors: a.json(),
    })
    .identifier(['reportCode'])
    .authorization(publicReadAdminWrite),

  RaidValidationRule: a
    .model({
      zone: a.string().required(),
      bossName: a.string().required(),
      npcIds: a.string().required(),
      minKills: a.integer().required(),
    })
    .identifier(['zone', 'bossName'])
    .authorization(publicReadAdminWrite),

  // Buff-aura spell IDs by consumable category, from the reference
  // workbook's "buffConsumables" tab. `note` carries the scroll class tag
  // (e.g. "Agi") where present.
  ConsumableBuff: a
    .model({
      spellId: a.integer().required(),
      category: a.string().required(),
      note: a.string(),
    })
    .identifier(['spellId', 'category'])
    .authorization(publicReadAdminWrite),

  // --- Per-report analysis results (written by the ingestReport Lambda) ---

  Report: a
    .model({
      reportCode: a.string().required(),
      fightId: a.string().required(),
      title: a.string(),
      zone: a.string(),
      fightDate: a.datetime(),
      durationSeconds: a.integer(),
      sourceUrl: a.string(),
      // For a boss encounter: the boss's name (e.g. "Hydross the
      // Unstable"). For a trash row: a combined-window label like "Trash
      // before Hydross the Unstable" — all trash between two boss
      // encounters is ingested as ONE row, not one per WCL fight (WCL fight
      // names for trash are the enemy pack engaged, not literally "Trash").
      encounterName: a.string(),
      // True for boss attempts (wipes included — see below), false for a
      // combined trash-gap row.
      isBossEncounter: a.boolean(),
      // Only meaningful when isBossEncounter is true. WCL only sets a
      // nonzero `boss` id on the fight that actually lands the kill — wipe
      // attempts on that same boss come back as boss:0, identical to real
      // trash by that field alone (confirmed live: 3 wipes + 1 kill on
      // Hydross all shared the same fight name, only the kill had boss!=0).
      // Grouping runs by name (not the boss flag) is what tells a wipe run
      // apart from trash; kill is false for a wipe, true for the kill.
      kill: a.boolean(),
      // Shared across every attempt on the same boss (wipes + the kill),
      // so the frontend can group multiple attempts under one collapsible
      // row instead of listing each wipe as an unrelated encounter. Null
      // for trash rows, which are already one row per gap.
      encounterGroupKey: a.string(),
    })
    .identifier(['reportCode', 'fightId'])
    .authorization(publicReadAdminWrite),

  // One row per ingested report. Two readers: the Raid Reports list, which pages
  // through these 15 at a time newest first, and the sidebar's Hall of Records,
  // which sums the per-raid record fields below instead of scanning whole tables.
  // Derived from the per-encounter rows (see functions/_shared/raidNight.ts) and
  // never edited by hand, except the WCL-sourced crit records, which are carried
  // forward across recomputes. `listKey` is a constant that gives the date index
  // a single partition to sort within.
  RaidNight: a
    .model({
      reportCode: a.string().required(),
      listKey: a.string().required(),
      title: a.string(),
      zone: a.string(),
      fightDate: a.datetime(),
      bossCount: a.integer(),
      killedCount: a.integer(),
      searchText: a.string(),
      // --- Hall of Records rollup: this raid's own contribution to each record,
      // summed client-side by the sidebar (see functions/_shared/raidNight.ts).
      killAttempts: a.integer(),
      wipeAttempts: a.integer(),
      bossSeconds: a.integer(),
      firstFightDate: a.datetime(),
      // { [characterName]: (epochSeconds | null)[] } — every death, boss and trash.
      deathEvents: a.json(),
      // { [characterName]: class } for colouring names.
      classes: a.json(),
      // Per-fight best crit { [fightId]: { damage?, healing? } } — from WCL, so it
      // cannot be rebuilt from the database; the sidebar does not read it.
      critByFight: a.json(),
      // Derived from critByFight: { name, amount, ability, boss, fightId, at }.
      topCritDamage: a.json(),
      topCritHeal: a.json(),
    })
    .identifier(['reportCode'])
    .secondaryIndexes((index) => [index('listKey').sortKeys(['fightDate']).queryField('raidNightsByDate')])
    .authorization(publicReadAdminWrite),

  // Also carries the character's class/spec/role (from WCL's summary-table
  // playerDetails) — the frontend joins these onto every other per-character
  // table client-side rather than duplicating them across five models.
  GearListing: a
    .model({
      reportCode: a.string().required(),
      fightId: a.string().required(),
      characterName: a.string().required(),
      gear: a.json(),
      characterClass: a.string(),
      spec: a.string(),
      role: a.string(), // 'tank' | 'healer' | 'dps'
    })
    .identifier(['reportCode', 'fightId', 'characterName'])
    .authorization(publicReadAdminWrite),

  GearIssue: a
    .model({
      reportCode: a.string().required(),
      fightId: a.string().required(),
      characterName: a.string().required(),
      issues: a.json(),
    })
    .identifier(['reportCode', 'fightId', 'characterName'])
    .authorization(publicReadAdminWrite),

  ConsumableScore: a
    .model({
      reportCode: a.string().required(),
      fightId: a.string().required(),
      characterName: a.string().required(),
      score: a.float(),
      battleElixir: a.float(),
      guardianElixir: a.float(),
      flask: a.float(),
      food: a.float(),
      scroll: a.float(),
      weaponEnhancement: a.float(),
      notes: a.json(),
      // Straight from WCL's summary-table playerDetails — counts of combat
      // potion and healthstone uses during the fight window.
      potionUse: a.integer(),
      healthstoneUse: a.integer(),
    })
    .identifier(['reportCode', 'fightId', 'characterName'])
    .authorization(publicReadAdminWrite),

  // One row per character who died during a fight, from the summary
  // table's deathEvents. `deaths` is a list (battle-rez means a character
  // can die more than once per pull): [{timeMs, abilityName}].
  DeathRecord: a
    .model({
      reportCode: a.string().required(),
      fightId: a.string().required(),
      characterName: a.string().required(),
      deaths: a.json(),
    })
    .identifier(['reportCode', 'fightId', 'characterName'])
    .authorization(publicReadAdminWrite),

  DrumStat: a
    .model({
      reportCode: a.string().required(),
      fightId: a.string().required(),
      characterName: a.string().required(),
      totalDrums: a.integer(),
      buffsPerDrum: a.float(),
      weightedScore: a.integer(),
      pointlessCasts: a.integer(),
    })
    .identifier(['reportCode', 'fightId', 'characterName'])
    .authorization(publicReadAdminWrite),

  // Per-boss-encounter damage. totalDamage is everything a player dealt to
  // any hostile in the fight window (bosses and adds alike, pets folded into
  // the owner by WCL). parsePercent is WCL's ranking percentile and is
  // null for wipes and for kills WCL has not ranked (yet).
  DamageStat: a
    .model({
      reportCode: a.string().required(),
      fightId: a.string().required(),
      characterName: a.string().required(),
      totalDamage: a.integer(),
      dps: a.float(),
      activeTimeMs: a.integer(),
      pctOfRaid: a.float(),
      parsePercent: a.float(),
    })
    .identifier(['reportCode', 'fightId', 'characterName'])
    .authorization(publicReadAdminWrite),

  // Log validity is a property of the WHOLE raid night (enough boss/trash
  // kills across every fight in the report), not any single encounter —
  // one row per reportCode, shared by every Report row under it.
  ValidationResult: a
    .model({
      reportCode: a.string().required(),
      zone: a.string(),
      isValid: a.boolean(),
      bossesRequired: a.integer(),
      bossesKilled: a.integer(),
      details: a.json(),
    })
    .identifier(['reportCode'])
    .authorization(publicReadAdminWrite),

  ShadowResistanceResult: a
    .model({
      reportCode: a.string().required(),
      fightId: a.string().required(),
      characterName: a.string().required(),
      srFromGear: a.integer(),
      srFromBuffsAndRace: a.integer(),
      srTotal: a.integer(),
      gearNotes: a.json(),
      // Enchants WCL labelled as resistance-granting that aren't in
      // ShadowResistanceEnchant, so a gap surfaces as data instead of
      // silently under-counting. See shadowResistance.ts.
      unmappedResistEnchants: a.json(),
    })
    .identifier(['reportCode', 'fightId', 'characterName'])
    .authorization(publicReadAdminWrite),

  IngestReportSummary: a.customType({
    title: a.string(),
    zone: a.string(),
    fightCount: a.integer().required(),
  }),

  // Ingests every fight in the report (bosses and trash alike) — not just
  // one. AppSync's Lambda-resolver timeout is a hard 30s, far too short for
  // a full raid night (a live 51-fight report needs well over a thousand
  // WarcraftLogs calls to fully process), so this mutation's handler is
  // only a fast trigger: it fetches the fight list and fires the actual
  // work at ingest-report-worker asynchronously, then returns immediately.
  // Encounters appear in the Reports list progressively as the worker
  // finishes each one, rather than all at once.
  ingestReport: a
    .mutation()
    .arguments({
      reportCode: a.string().required(),
      baseUrl: a.string(),
    })
    .returns(a.ref('IngestReportSummary'))
    .authorization((allow) => [allow.group('admins')])
    .handler(a.handler.function(ingestReport)),

  DeleteReportResult: a.customType({
    success: a.boolean().required(),
  }),

  // Amplify auto-generates a `deleteReport` mutation for the Report
  // model's standard CRUD (create/update/delete<ModelName>) — this custom
  // one needs a different name to avoid colliding with it.
  deleteReportCascade: a
    .mutation()
    .arguments({
      reportCode: a.string().required(),
      fightId: a.string().required(),
    })
    .returns(a.ref('DeleteReportResult'))
    .authorization((allow) => [allow.group('admins')])
    .handler(a.handler.function(deleteReport)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'identityPool',
  },
});
