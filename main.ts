// Token Radar v1 — entry radar-2 (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the model in lib/model.ts, writes the ranked board to /output/board.json, and
// copies this repository's dashboard/ and screenshots/ to /output. Last, it writes /output/dossier.json,
// the summary the judge reads, with the vendored make.fun library.
//
// Model radar-2, in one line: implied = TVL x 0.22 x growth(0.8 up / 1.0 down,
// capped -50/+80%, unreported growth counts as -5%) x
// maturity(0.55 + 0.45 x (1 - exp(-age/540d))) x breadth(1 + 0.03 per extra chain, max 1.15).
// No protocol name is special-cased; the dashboard recomputes every row with the same function.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, type Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** A calendar day in YYYY-MM-DD form that really exists: 2026-02-30 parses but never happened. */
function isRealDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === text;
}

/**
 * The snapshot's own checks, past the shape parseSnapshot already demands. Each refusal
 * names the protocol or the field at fault, so a broken input says exactly what to fix
 * instead of failing somewhere deep in the scoring. Returns null when the snapshot is
 * one this program can score.
 */
function validateInputs(snapshot: Snapshot): string | null {
  // parseSnapshot already demands the YYYY-MM-DD shape, but a shape is not a day:
  // 2026-02-30 matches the pattern and never happened, and a snapshot dated on a
  // day that never happened would age every protocol wrong.
  if (!isRealDay(snapshot.as_of)) {
    return `as_of is ${snapshot.as_of}: the snapshot's date must be a real YYYY-MM-DD day`;
  }
  if (typeof snapshot.source !== 'string' || snapshot.source.trim().length === 0) {
    return 'source is empty: the snapshot must name where its figures came from';
  }
  // The watchlist floor is the line the early radar reads against: a missing or
  // non-positive floor leaves the board with no floor at all.
  if (!Number.isSafeInteger(snapshot.floor_usd) || snapshot.floor_usd <= 0) {
    return `floor_usd is ${snapshot.floor_usd}: the watchlist floor must be a positive whole number of dollars`;
  }
  // A snapshot with no protocols scores nothing; failing here beats writing an
  // empty board and letting the gate refuse it later.
  if (snapshot.protocols.length === 0) {
    return 'protocols is empty: a snapshot with no protocols scores nothing';
  }
  // Slugs are the board's identity: a slug that appears twice would give two rows
  // the same name, and the gate refuses a board with a repeated slug.
  const seen = new Set<string>();
  for (const p of snapshot.protocols) {
    if (seen.has(p.slug)) return `duplicate slug ${p.slug}: every protocol must appear once`;
    seen.add(p.slug);
  }
  // The watchlist is the floor the board must cover; an empty one means the house
  // kept nothing, and a board built on it covers nothing either.
  if (snapshot.watchlist.length === 0) {
    return 'watchlist is empty: the board must cover at least one protocol';
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist names ${slug}, which is not among the snapshot's protocols`;
  }
  // Every protocol's own figures, one at a time, so the first bad field stops the
  // run with the slug attached instead of poisoning the ranking silently.
  for (const p of snapshot.protocols) {
    // A slug names a row and is looked up by the watchlist, so it holds no spaces
    // and is never empty; a name is what the board shows, so it is never blank.
    if (typeof p.slug !== 'string' || p.slug.length === 0 || /\s/.test(p.slug)) {
      return `protocol slug ${JSON.stringify(p.slug)} is empty or carries whitespace: slugs name rows and hold no spaces`;
    }
    if (typeof p.name !== 'string' || p.name.trim().length === 0) {
      return `protocol ${p.slug} has an empty name: every row carries a name to show`;
    }
    // The token fields decide pre-token or live, so each is either absent or a
    // string; a number or an object here would sort the protocol wrong.
    if (p.category !== null && typeof p.category !== 'string') {
      return `protocol ${p.slug} has a category that is not a string or null`;
    }
    if (p.gecko_id !== null && typeof p.gecko_id !== 'string') {
      return `protocol ${p.slug} has a gecko_id that is not a string or null`;
    }
    if (p.symbol !== null && typeof p.symbol !== 'string') {
      return `protocol ${p.slug} has a symbol that is not a string or null`;
    }
    if (p.change_7d !== null && !Number.isFinite(p.change_7d)) {
      return `protocol ${p.slug} has change_7d ${p.change_7d}: a seven-day change must be null or a finite number of per cent`;
    }
    if (!Number.isFinite(p.tvl_usd) || p.tvl_usd < 0) {
      return `protocol ${p.slug} has tvl_usd ${p.tvl_usd}: TVL must be a finite number of dollars, zero or more`;
    }
    // DefiLlama writes -1 where it has no market-cap figure, the same "no figure"
    // null means elsewhere: -1 is a missing value, not a negative value, so the
    // check takes null, -1, or a finite number of dollars, zero or more.
    if (p.mcap_usd !== null && p.mcap_usd !== -1 && (!Number.isFinite(p.mcap_usd) || p.mcap_usd < 0)) {
      return `protocol ${p.slug} has mcap_usd ${p.mcap_usd}: a market cap must be null, -1 for unreported, or a finite number of dollars, zero or more`;
    }
    if (p.listed_at !== null) {
      if (!isRealDay(p.listed_at)) {
        return `protocol ${p.slug} has listed_at ${p.listed_at}: the listing day must be null or a real YYYY-MM-DD date`;
      }
      if (p.listed_at > snapshot.as_of) {
        return `protocol ${p.slug} has listed_at ${p.listed_at}, after the snapshot's as_of ${snapshot.as_of}: a protocol cannot be listed in the future`;
      }
    }
    if (!Array.isArray(p.chains) || p.chains.some((c) => typeof c !== 'string')) {
      return `protocol ${p.slug} has chains that are not an array of chain names`;
    }
  }
  return null;
}

/**
 * One line saying what a valid snapshot holds: how many protocols it carries, how
 * many still record no token, how many of the watchlist it covers, and the TVL
 * range the board will rank across. Only ever called on a snapshot that passed
 * validateInputs, so every figure it reads is already known good.
 */
function snapshotSummary(snapshot: Snapshot): string {
  let preToken = 0;
  let unreportedGrowth = 0;
  let smallestTvl = Number.POSITIVE_INFINITY;
  let largestTvl = 0;
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null && p.gecko_id === null && p.symbol === null) preToken++;
    if (p.change_7d === null) unreportedGrowth++;
    if (p.tvl_usd < smallestTvl) smallestTvl = p.tvl_usd;
    if (p.tvl_usd > largestTvl) largestTvl = p.tvl_usd;
  }
  const live = snapshot.protocols.length - preToken;
  return (
    `${snapshot.protocols.length} protocols (${preToken} pre-token, ${live} live), ` +
    `${snapshot.watchlist.length} on the watchlist, floor $${snapshot.floor_usd}, ` +
    `TVL $${smallestTvl} to $${largestTvl}, ${unreportedGrowth} without a seven-day change, as of ${snapshot.as_of}`
  );
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const invalid = validateInputs(snapshot);
if (invalid !== null) {
  process.stderr.write(`token radar: invalid snapshot: ${invalid}\n`);
  process.exit(2);
}
// A check-only run: say what the snapshot holds and stop before writing anything,
// so a broken input can be diagnosed without touching the outputs.
if (process.argv.includes('--validate-only')) {
  process.stdout.write(`token radar: snapshot valid: ${snapshotSummary(snapshot)}\n`);
  process.exit(0);
}
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
