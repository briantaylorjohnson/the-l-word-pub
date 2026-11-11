/**
 * Feature flags.
 *
 * Kept as plain constants rather than a runtime config table: changing one
 * is a redeploy (~3 min), which is fine for dates set well in advance, and
 * it keeps the value in version control next to the code that reads it.
 *
 * Read by `computeMetrics` in `hallOfRecords.ts`, in the browser, against the
 * viewer's clock — which is why the Hall caches raw rows rather than computed
 * numbers. See README -> "Feature flags".
 */

/**
 * Zeroes the Hall of Records "Most Deaths" standing at the start of
 * Phase 3. Deaths logged before this instant stop counting toward the
 * live record and are preserved separately as the pre-Phase-3 record.
 *
 * The instant is stored in UTC so daylight-saving never shifts it:
 * 2026-08-27 15:00 PDT (UTC-7) === 23:00 BST (UTC+1) === 22:00 UTC.
 *
 * Only the deaths standing resets — bosses slain, wipes and combat
 * minutes keep counting for all time.
 */
export const MOST_DEATHS_RESET = {
  enabled: true,
  at: '2026-08-27T22:00:00Z',
  /** Shown in the UI, so it reads as a season boundary rather than a bug. */
  label: 'Phase 3',
  /** Abbreviated form, for the cramped note under the deaths standing. */
  shortLabel: 'P3',
  /** No year: the note has to fit one line in a 240px sidebar. */
  labelDate: 'Aug 27',
};
