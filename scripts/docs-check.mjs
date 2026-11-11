// Asserts the facts stated in README.md and docs/*.md against the code, so the docs
// cannot silently drift. Run with `npm run docs:check`; exits non-zero on any mismatch.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: this folder's name contains spaces, which pathname leaves percent-encoded.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const readme = read('README.md');
const arch = read('docs/ARCHITECTURE.md');
const api = read('docs/API.md');
const ops = read('docs/OPERATIONS.md');
const allDocs = { 'README.md': readme, 'docs/ARCHITECTURE.md': arch, 'docs/API.md': api, 'docs/OPERATIONS.md': ops };

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// --- data models ------------------------------------------------------------
const schema = read('amplify/data/resource.ts');
const models = [...schema.matchAll(/^ {2}(\w+): a\s*\n\s*\.model\(/gm)].map((m) => m[1]);
check(models.length > 0, 'could not find any models in amplify/data/resource.ts');
check(readme.includes(`**${models.length} DynamoDB models**`), `README should say "${models.length} DynamoDB models"`);
check(arch.includes(`DynamoDB - ${models.length} tables`), `ARCHITECTURE.md diagram should say "DynamoDB - ${models.length} tables"`);
check(api.includes(`(${models.length} models)`), `API.md should say "(${models.length} models)"`);
for (const m of models) {
  check(readme.includes(`\`${m}\``), `README data model does not mention model ${m}`);
}

// --- report tabs --------------------------------------------------------------
const detail = read('src/ReportDetail.tsx');
const tabLabels = [...detail.matchAll(/\{ id: '\w+', label: '([^']+)' \}/g)].map((m) => m[1]);
check(tabLabels.length > 0, 'could not find tabs in ReportDetail.tsx');
const tabSection = readme.slice(readme.indexOf('## Report detail tabs'), readme.indexOf('## Hall of Records'));
for (const label of tabLabels) check(tabSection.includes(`| ${label} |`), `README "Report detail tabs" is missing the "${label}" tab`);
check(!tabLabels.includes('Log Validation'), 'Log Validation is a tab again — update the README note that it is hidden');
check(tabLabels[0] === 'Damage', `README says Damage is the first tab but ReportDetail.tsx starts with "${tabLabels[0]}"`);

// --- Lambda actions and worker modes ------------------------------------------
const wcl = read('amplify/functions/wcl-client/handler.ts');
const actions = [...wcl.matchAll(/action: '(\w+)'/g)].map((m) => m[1]);
check(actions.length > 0, 'could not find wcl-client actions');
for (const a of new Set(actions)) {
  check(readme.includes(`\`${a}\``), `README does not document wcl-client action ${a}`);
  check(api.includes(`\`${a}\``), `API.md does not document wcl-client action ${a}`);
}
const worker = read('amplify/functions/ingest-report-worker/handler.ts');
for (const mode of ['parsesOnly', 'raidNightOnly', 'critsOnly']) {
  check(worker.includes(`event.${mode}`), `worker no longer implements ${mode} — update the docs`);
  check(readme.includes(mode) && api.includes(mode) && ops.includes(mode), `${mode} is not documented in README, API.md and OPERATIONS.md`);
}

// --- secrets, operations, flags -----------------------------------------------
const secrets = [...read('amplify/functions/wcl-client/resource.ts').matchAll(/secret\('(\w+)'\)/g)].map((m) => m[1]);
check(secrets.length > 0, 'could not find secrets in wcl-client/resource.ts');
for (const s of secrets) check(readme.includes(`\`${s}\``), `README does not document secret ${s}`);

const ops_ = [...schema.matchAll(/^ {2}(\w+): a\s*\n\s*\.mutation\(\)/gm)].map((m) => m[1]);
const queryFields = [...schema.matchAll(/\.queryField\('(\w+)'\)/g)].map((m) => m[1]);
for (const o of [...ops_, ...queryFields]) check(api.includes(`\`${o}\``) || api.includes(o), `API.md does not document ${o}`);

check(readme.includes('MOST_DEATHS_RESET') && read('src/featureFlags.ts').includes('MOST_DEATHS_RESET'), 'MOST_DEATHS_RESET is not documented or no longer exists');
const pageSize = read('src/ReportsList.tsx').match(/const PAGE_SIZE = (\d+)/)?.[1];
check(pageSize && readme.includes(`**${pageSize} per request**`), `README should say the list loads ${pageSize} raids per request`);

// --- stale phrases that must not come back ---------------------------------------
check(!/\b11 DynamoDB models\b/.test(readme), 'README still says "11 DynamoDB models"');
check(!readme.includes('~/.claude/plans'), 'README points at a machine-local plan file');

// --- diagrams and links ---------------------------------------------------------
const fences = (arch.match(/^```/gm) ?? []).length;
check(fences % 2 === 0, 'docs/ARCHITECTURE.md has an unbalanced code fence');
check((arch.match(/^```mermaid/gm) ?? []).length >= 4, 'docs/ARCHITECTURE.md should contain at least 4 Mermaid diagrams');
for (const [name, text] of Object.entries(allDocs)) {
  const base = name.includes('/') ? 'docs' : '.';
  for (const m of text.matchAll(/\]\(((?!https?:|#|mailto:)[^)#\s]+)(#[^)]*)?\)/g)) {
    const target = resolve(root, base, m[1]);
    check(existsSync(target), `${name}: broken link to ${m[1]}`);
  }
}

if (failures.length > 0) {
  console.error(`docs-check: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `docs-check: OK — ${models.length} models, ${tabLabels.length} tabs, ${new Set(actions).size} wcl-client actions, ` +
    `${secrets.length} secrets, ${(arch.match(/^```mermaid/gm) ?? []).length} diagrams`
);
