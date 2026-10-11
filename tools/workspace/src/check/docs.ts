/**
 * Keeps the documentation vault navigable (`pnpm check:docs`).
 *
 * Scans `docs/` (minus the planning archive and Obsidian's own folders) and the
 * root README, RELEASING and AGENTS notes, and fails on:
 *   - a relative link or image whose target does not exist, leaves the repo,
 *     uses backslashes, or differs in letter case from the file on disk (it
 *     would resolve on Windows/macOS but break on Linux CI and GitHub);
 *   - a `#fragment` on a link to a Markdown note (or within the same note)
 *     that matches none of its headings;
 *   - an Obsidian `[[wikilink]]`: the vault uses plain Markdown links so every
 *     page reads the same on GitHub;
 *   - a runbook or rule note whose front matter is missing or malformed, or
 *     whose `related` entries do not resolve;
 *   - a runbook or rule note its folder's README does not link to.
 *
 * It warns, without failing, on runbooks never verified or verified more than
 * STALE_DAYS ago, and on links to files git does not track (they work locally
 * but are broken on GitHub until committed).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { createLogger } from '../lib/logger.js';
import { root as repoRoot } from '../lib/paths.js';

export const STALE_DAYS = 90;

const SKIPPED_DIRS = ['docs/planning/archive', 'docs/.obsidian', 'docs/journal'];
const ROOT_NOTES = ['README.md', 'RELEASING.md', 'AGENTS.md'];
/** Wiki pages link to each other GitHub-wiki style, by page name without `.md`. */
const WIKI_PAGES = 'docs/wiki/pages';

export interface DocsCheckOptions {
  /** Repository root. */
  readonly root: string;
  readonly today: Date;
  /** Repo-relative POSIX paths git tracks, or null when git is unavailable. */
  readonly tracked: ReadonlySet<string> | null;
}

export interface DocsReport {
  readonly errors: string[];
  readonly warnings: string[];
  readonly notes: number;
  readonly links: number;
}

interface Link {
  readonly line: number;
  readonly target: string;
}

type FrontMatter = Record<string, unknown>;

interface NoteKind {
  readonly folder: string;
  readonly type: string;
  validate(fields: FrontMatter, note: string, report: Problems): void;
}

interface Problems {
  error(message: string): void;
  neverVerified: string[];
  stale: string[];
}

export function checkDocs(options: DocsCheckOptions): DocsReport {
  const { root } = options;
  const errors: string[] = [];
  const warnings: string[] = [];
  const problems: Problems = {
    error: (message) => errors.push(message),
    neverVerified: [],
    stale: [],
  };
  const posix = (path: string): string => relative(root, path).split(sep).join('/');
  const onDisk = exactCase(root);
  const anchors = anchorIndex();

  const notes = [
    ...collectMarkdown(root, resolve(root, 'docs')),
    ...ROOT_NOTES.map((name) => resolve(root, name)).filter((path) => existsSync(path)),
  ];
  const linksByNote = new Map<string, Set<string>>();
  let linkCount = 0;

  for (const note of notes) {
    const name = posix(note);
    const text = readNote(note);
    const prose = stripCode(text);
    const resolved = new Set<string>();
    linksByNote.set(note, resolved);

    for (const { line } of findWikilinks(prose)) {
      problems.error(`${name}:${line}: wikilink — use a relative Markdown link instead`);
    }

    for (const link of findLinks(prose)) {
      const where = `${name}:${link.line}`;
      const fragment = fragmentOf(link.target);
      if (link.target.startsWith('#')) {
        linkCount++;
        if (fragment && !anchors(note).has(fragment)) {
          problems.error(`${where}: no heading matches ${link.target}`);
        }
        continue;
      }
      const target = resolveTarget(root, note, link.target);
      if (target === null) continue;
      linkCount++;
      if (target === 'outside') {
        problems.error(`${where}: link leaves the repository: ${link.target}`);
        continue;
      }
      if (link.target.includes('\\')) {
        problems.error(`${where}: use forward slashes in links: ${link.target}`);
        continue;
      }
      const found = existing(target, name);
      if (onDisk(found ?? target) === 'case') {
        problems.error(
          `${where}: link differs in letter case from the file on disk: ${link.target}`,
        );
        continue;
      }
      if (!found) {
        problems.error(`${where}: broken link: ${link.target}`);
        continue;
      }
      if (fragment && extname(found) === '.md' && !anchors(found).has(fragment)) {
        problems.error(`${where}: no heading in ${posix(found)} matches #${fragment}`);
      }
      resolved.add(found);
      if (options.tracked && !isTracked(options.tracked, posix(found))) {
        warnings.push(`${where}: links to ${posix(found)}, which git does not track yet`);
      }
    }

    const kind = KINDS.find((candidate) => dirname(name) === candidate.folder);
    if (!kind || note.endsWith(`${sep}README.md`)) continue;

    const fields = frontMatter(text, name, problems);
    if (!fields) continue;
    if (fields['type'] !== kind.type) {
      problems.error(`${name}: front matter must set type: ${kind.type}`);
    }
    kind.validate(fields, name, problems);
    for (const entry of stringList(fields['related'])) {
      const target = resolveTarget(root, note, entry);
      const found = target === null || target === 'outside' ? null : existing(target, name);
      if (!found || onDisk(found) !== 'exact') {
        problems.error(`${name}: related entry does not resolve: ${entry}`);
      }
    }
    const verified = fields['last_verified'];
    if (kind.type === 'runbook' && verified !== null && verified !== undefined) {
      const date = parseDate(verified);
      if (!date) {
        problems.error(`${name}: last_verified must be a YYYY-MM-DD date or empty`);
      } else if (date.getTime() > options.today.getTime()) {
        problems.error(`${name}: last_verified is in the future`);
      } else if (daysBetween(date, options.today) > STALE_DAYS) {
        problems.stale.push(`${name} (${String(verified)})`);
      }
    } else if (kind.type === 'runbook') {
      problems.neverVerified.push(name);
    }
  }

  for (const kind of KINDS) {
    const folder = resolve(root, kind.folder);
    const index = join(folder, 'README.md');
    const members = notes.filter(
      (note) => dirname(note) === folder && note !== index && extname(note) === '.md',
    );
    if (members.length === 0) continue;
    const listed = linksByNote.get(index);
    if (!listed) {
      problems.error(`${kind.folder}/README.md is missing; it indexes the ${kind.type} notes`);
      continue;
    }
    for (const note of members) {
      if (!listed.has(note)) {
        problems.error(`${kind.folder}/README.md does not link to ${posix(note)}`);
      }
    }
  }

  if (problems.neverVerified.length > 0) {
    warnings.push(
      `${problems.neverVerified.length} runbook(s) never verified (empty last_verified): ${problems.neverVerified.join(', ')}`,
    );
  }
  if (problems.stale.length > 0) {
    warnings.push(
      `${problems.stale.length} runbook(s) not verified in ${STALE_DAYS} days: ${problems.stale.join(', ')}`,
    );
  }

  return { errors, warnings, notes: notes.length, links: linkCount };
}

const KINDS: readonly NoteKind[] = [
  {
    folder: 'docs/runbooks',
    type: 'runbook',
    validate(fields, note, report) {
      if (typeof fields['area'] !== 'string' || fields['area'].trim() === '') {
        report.error(`${note}: front matter must set a non-empty area`);
      }
      if (fields['related'] !== undefined && fields['related'] !== null) {
        if (!Array.isArray(fields['related'])) {
          report.error(`${note}: related must be a list`);
        }
      }
    },
  },
  {
    folder: 'docs/rules',
    type: 'rule',
    validate(fields, note, report) {
      for (const key of ['applies_to', 'enforced_by']) {
        if (stringList(fields[key]).length === 0) {
          report.error(`${note}: front matter must set a non-empty ${key} list`);
        }
      }
    },
  },
];

function collectMarkdown(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const skipped = SKIPPED_DIRS.map((path) => resolve(root, path));
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !skipped.includes(path)) walk(path);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found.sort();
}

/** Reads a note as LF text without a leading byte-order mark. */
function readNote(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}

/** Blanks fenced code blocks, keeping line numbers. */
function blankFences(text: string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return '';
      }
      if (marker) {
        fence = marker;
        return '';
      }
      return line;
    })
    .join('\n');
}

/**
 * Blanks fenced code blocks, inline code spans and HTML comments, keeping line
 * numbers, so example or commented-out links and `[[` are not checked.
 */
export function stripCode(text: string): string {
  let comment = false;
  return blankFences(text)
    .split('\n')
    .map((line) => {
      let kept = '';
      let rest = line.replace(/(`+)[^`]*?\1/g, '');
      while (rest !== '') {
        if (comment) {
          const end = rest.indexOf('-->');
          if (end === -1) break;
          comment = false;
          rest = rest.slice(end + 3);
        } else {
          const start = rest.indexOf('<!--');
          if (start === -1) {
            kept += rest;
            break;
          }
          kept += rest.slice(0, start);
          comment = true;
          rest = rest.slice(start + 4);
        }
      }
      return kept;
    })
    .join('\n');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * GitHub's heading anchor (github-slugger): lowercased, punctuation dropped,
 * spaces to hyphens. Link and HTML markup is unwrapped and entities decoded first.
 */
export function slugify(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/gi, (_, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return ENTITIES[String(name).toLowerCase()] ?? '';
    })
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Every `#fragment` a note answers to: its headings, numbered like GitHub's duplicates, and HTML ids. */
export function anchorsIn(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of blankFences(text).split('\n')) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      const slug = slugify(heading);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
    for (const match of line.matchAll(/<[a-z][^>]*\s(?:id|name)=["']([^"']+)["']/gi)) {
      anchors.add((match[1] ?? '').toLowerCase());
    }
  }
  return anchors;
}

function anchorIndex(): (path: string) => Set<string> {
  const cache = new Map<string, Set<string>>();
  return (path) => {
    let anchors = cache.get(path);
    if (!anchors) {
      anchors = anchorsIn(readNote(path));
      cache.set(path, anchors);
    }
    return anchors;
  };
}

/** The decoded, lowercased `#fragment` of a link target, or null without one. */
function fragmentOf(target: string): string | null {
  const hash = target.indexOf('#');
  if (hash === -1 || hash === target.length - 1) return null;
  const raw = target.slice(hash + 1);
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Whether a path exists below the repository root with exactly this letter
 * case ('exact'), only with different case ('case'), or not at all. Windows and
 * macOS resolve any case; Linux CI and GitHub do not, so 'case' is reported the
 * same on every platform.
 */
function exactCase(root: string): (path: string) => 'exact' | 'case' | 'missing' {
  const listings = new Map<string, string[]>();
  const list = (dir: string): string[] => {
    let names = listings.get(dir);
    if (!names) {
      try {
        names = readdirSync(dir);
      } catch {
        names = [];
      }
      listings.set(dir, names);
    }
    return names;
  };
  return (path) => {
    let current = root;
    let result: 'exact' | 'case' = 'exact';
    for (const segment of relative(root, path).split(sep).filter(Boolean)) {
      const names = list(current);
      if (names.includes(segment)) {
        current = join(current, segment);
        continue;
      }
      const variant = names.find((name) => name.toLowerCase() === segment.toLowerCase());
      if (!variant) return 'missing';
      result = 'case';
      current = join(current, variant);
    }
    return result;
  };
}

export function findLinks(prose: string): Link[] {
  const links: Link[] = [];
  prose.split('\n').forEach((line, index) => {
    const inline = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
    for (const match of line.matchAll(inline)) {
      links.push({ line: index + 1, target: unwrap(match[1] ?? '') });
    }
    // Reference definitions (`[label]: target`), not footnotes (`[^1]: text`).
    const definition = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (definition) links.push({ line: index + 1, target: unwrap(definition[1] ?? '') });
  });
  return links;
}

function findWikilinks(prose: string): { line: number }[] {
  return prose
    .split('\n')
    .flatMap((line, index) => (/\[\[[^\]\n]+\]\]/.test(line) ? [{ line: index + 1 }] : []));
}

function unwrap(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

/**
 * Resolves a link target to an absolute path. Returns null for links this
 * check does not follow (URLs, mail, in-page anchors) and 'outside' for a path
 * that escapes the repository.
 */
function resolveTarget(root: string, note: string, target: string): string | null | 'outside' {
  if (target === '' || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  let path = target.replace(/[?#].*$/, '');
  if (path === '') return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path; a malformed escape is then reported as broken.
  }
  const absolute = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(dirname(note), path);
  const fromRoot = relative(root, absolute);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) return 'outside';
  return absolute;
}

/** The file or folder a resolved link points at, if it exists. */
function existing(target: string, note: string): string | null {
  if (existsSync(target)) return target;
  const wikiPage = note.startsWith(`${WIKI_PAGES}/`) && extname(target) === '';
  if (wikiPage && existsSync(`${target}.md`)) return `${target}.md`;
  return null;
}

function isTracked(tracked: ReadonlySet<string>, path: string): boolean {
  if (tracked.has(path)) return true;
  const prefix = `${path}/`;
  for (const file of tracked) if (file.startsWith(prefix)) return true;
  return false;
}

function frontMatter(text: string, note: string, report: Problems): FrontMatter | null {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) {
    report.error(`${note}: missing front matter`);
    return null;
  }
  try {
    const parsed: unknown = parseYaml(match[1] ?? '');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FrontMatter;
    }
    report.error(`${note}: front matter must be a mapping`);
  } catch (error) {
    report.error(`${note}: invalid front matter: ${(error as Error).message.split('\n')[0]}`);
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function trackedFiles(root: string): Set<string> | null {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    return new Set(output.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const log = createLogger('docs');
  const report = checkDocs({ root: repoRoot, today: new Date(), tracked: trackedFiles(repoRoot) });
  for (const warning of report.warnings) log.warn(warning);
  if (report.errors.length > 0) {
    log.error(
      `docs check failed (${report.errors.length}):\n${report.errors.map((line) => `  - ${line}`).join('\n')}`,
    );
    process.exit(1);
  }
  log.info(`docs ok — ${report.notes} notes, ${report.links} links`);
}
