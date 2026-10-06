import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Design-token guard (docs/BOT_IMPLEMENTATION_PLAN.md §18.5).
 *
 * Scans the app and component trees for colour literals and fails with file/line output.
 * The rule only survives contact with a large feature if it is a build failure rather than
 * a convention, which is what this script makes it.
 *
 * Two exemptions, both explicit and justified:
 *   - `app/globals.css` **is** the token system; it is the one file allowed to contain the
 *     palette's hex values.
 *   - A small allow-list of pre-existing literals outside the token system (the sidebar
 *     logo, the switch knob, the two auth-page logos, the AI Lab icon, and the two
 *     `bg-black/40` dialog backdrops). These predate the feature; the rule is "introduce no
 *     NEW literal", so they are recorded rather than silently permitted.
 *
 * A deliberate literal anywhere else exits 1.
 */

const ROOTS = ['app', 'components'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.css']);
const SKIP_FILES = new Set(['app/globals.css']);

const PATTERN =
  /(?:#[0-9a-fA-F]{3,8}\b)|\brgba?\(|\bhsla?\(|\bbg-(?:white|black)\b|\btext-(?:white|black)\b/;

/** Pre-existing literals, exempted by file and exact token. Keep this list narrow. */
const ALLOWLIST = [
  { file: 'components/ui/switch.tsx', token: 'bg-white' },
  { file: 'components/sidebar.tsx', token: 'text-white' },
  { file: 'components/sidebar.tsx', token: 'bg-black/40' },
  { file: 'components/ui/dialog.tsx', token: 'bg-black/40' },
  { file: 'app/login/page.tsx', token: 'text-white' },
  { file: 'app/register/page.tsx', token: 'text-white' },
  { file: 'app/platform/ai-lab/page.tsx', token: 'text-white' },
];

function walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(full, files);
    } else if (EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) {
      files.push(full);
    }
  }
}

const files = [];
for (const root of ROOTS) walk(join(process.cwd(), root), files);

const findings = [];
for (const full of files) {
  const rel = relative(process.cwd(), full).split(sep).join('/');
  if (SKIP_FILES.has(rel)) continue;

  const lines = readFileSync(full, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!PATTERN.test(line)) return;
    const allowed = ALLOWLIST.some(
      (entry) => entry.file === rel && line.includes(entry.token),
    );
    if (!allowed) {
      findings.push(`${rel}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (findings.length > 0) {
  console.error('Hard-coded colours found. Use a token from app/globals.css instead:\n');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(`\n${findings.length} finding(s).`);
  process.exit(1);
}

console.log('Design-token check passed: no new hard-coded colours.');