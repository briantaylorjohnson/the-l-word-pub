/**
 * Warcraft Logs' parse tiers, so a percentile reads the same here as it does
 * on the WCL site. 99 and 100 are their own tiers above the orange band.
 */
export function parseColor(percent: number): string {
  if (percent >= 100) return '#e5cc80'; // gold
  if (percent >= 99) return '#e268a8'; // pink
  if (percent >= 95) return '#ff8000'; // orange
  if (percent >= 75) return '#a335ee'; // purple
  if (percent >= 50) return '#0070ff'; // blue
  if (percent >= 25) return '#1eff00'; // green
  return '#666666'; // grey
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st — English ordinals. */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
