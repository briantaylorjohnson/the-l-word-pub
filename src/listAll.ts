// DynamoDB Scan+FilterExpression-backed `list()` calls cap how many items
// get *scanned* per page (the `limit` argument), not how many survive the
// filter — a page can come back with 0 matching items and a real
// `nextToken` for more. Confirmed live: querying GearIssue for one
// encounter took 5 pages (400 items scanned) before any of the 25
// matching rows showed up, once the table held rows from multiple
// ingested raids. Every list() call in this app has to follow nextToken
// to exhaustion, not just read the first page.
export async function listAll<T>(
  fetchPage: (nextToken?: string) => Promise<{ data: T[]; nextToken?: string | null }>
): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | undefined;
  do {
    const res = await fetchPage(nextToken);
    all.push(...res.data);
    nextToken = res.nextToken ?? undefined;
  } while (nextToken);
  return all;
}
