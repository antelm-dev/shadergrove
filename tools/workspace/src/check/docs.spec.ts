import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkDocs, findLinks, STALE_DAYS, stripCode } from './docs';

const today = new Date('2026-10-10T12:00:00Z');
let root: string | null = null;

function vault(files: Record<string, string>, tracked?: string[]): ReturnType<typeof checkDocs> {
  root = mkdtempSync(resolve(tmpdir(), 'docs-check-'));
  for (const [path, text] of Object.entries(files)) {
    const file = resolve(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return checkDocs({
    root,
    today,
    tracked: new Set(tracked ?? Object.keys(files)),
  });
}

const runbook = (fields = 'area: data\nlast_verified: 2026-10-01\nrelated: []') =>
  `---\ntype: runbook\n${fields}\n---\n\n# Runbook\n`;
const rule = (fields = 'applies_to: [all]\nenforced_by: [review]') =>
  `---\ntype: rule\n${fields}\n---\n\n# Rule\n`;
const clean = {
  'docs/README.md': '[Runbooks](runbooks/README.md) and [rules](rules/README.md)\n',
  'docs/runbooks/README.md': '[Backup](backup.md)\n',
  'docs/runbooks/backup.md': runbook(),
  'docs/rules/README.md': '[Quality](quality.md)\n',
  'docs/rules/quality.md': rule(),
};

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('checkDocs', () => {
  it('accepts a consistent vault', () => {
    const report = vault(clean);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.notes).toBe(5);
  });

  it('reports a broken relative link with its line', () => {
    const report = vault({ ...clean, 'docs/README.md': 'Intro\n\nSee [gone](gone.md).\n' });
    expect(report.errors).toContain('docs/README.md:3: broken link: gone.md');
  });

  it('follows root-relative, encoded and anchored links, and ignores URLs', () => {
    const report = vault({
      ...clean,
      'docs/My Note.md': '# Note\n',
      'docs/README.md':
        '[a](/docs/My%20Note.md#note) [b](<My Note.md>) [c](https://example.com/x.md) [d](#top)\n' +
        '[ref]: runbooks/README.md\n',
    });
    expect(report.errors).toEqual([]);
    expect(report.links).toBe(5);
  });

  it('rejects links that leave the repository', () => {
    const report = vault({ ...clean, 'docs/README.md': '[up](../../elsewhere.md)\n' });
    expect(report.errors).toContain(
      'docs/README.md:1: link leaves the repository: ../../elsewhere.md',
    );
  });

  it('ignores links and wikilinks inside code', () => {
    const report = vault({
      ...clean,
      'docs/README.md': '`[x](nope.md)` and `[[nope]]`\n\n```md\n[y](nope.md)\n[[nope]]\n```\n',
    });
    expect(report.errors).toEqual([]);
  });

  it('rejects wikilinks in prose', () => {
    const report = vault({ ...clean, 'docs/README.md': 'See [[backup]].\n' });
    expect(report.errors[0]).toMatch(/^docs\/README\.md:1: wikilink/);
  });

  it('resolves GitHub wiki page links without an extension only in the wiki', () => {
    const wiki = vault({
      ...clean,
      'docs/wiki/pages/Home.md': '[FAQ](FAQ)\n',
      'docs/wiki/pages/FAQ.md': '# FAQ\n',
    });
    expect(wiki.errors).toEqual([]);

    const elsewhere = vault({ ...clean, 'docs/README.md': '[Quality](rules/quality)\n' });
    expect(elsewhere.errors).toContain('docs/README.md:1: broken link: rules/quality');
  });

  it('skips the planning archive and Obsidian folders', () => {
    const report = vault({
      ...clean,
      'docs/planning/archive/old/plan.md': '[x](missing.md)\n',
      'docs/journal/2026-10-10.md': '[x](missing.md)\n',
    });
    expect(report.errors).toEqual([]);
  });

  it('validates runbook and rule front matter', () => {
    const report = vault({
      ...clean,
      'docs/runbooks/README.md': '[a](a.md) [b](b.md) [c](c.md)\n',
      'docs/runbooks/a.md': runbook('last_verified:\nrelated: [missing.md]'),
      'docs/runbooks/b.md': '# No front matter\n',
      'docs/runbooks/c.md': runbook('area: data\nlast_verified: 2026-13-40'),
      'docs/rules/README.md': '[Quality](quality.md)\n',
      'docs/rules/quality.md': rule('applies_to: []'),
    });
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'docs/runbooks/a.md: front matter must set a non-empty area',
        'docs/runbooks/a.md: related entry does not resolve: missing.md',
        'docs/runbooks/b.md: missing front matter',
        'docs/runbooks/c.md: last_verified must be a YYYY-MM-DD date or empty',
        'docs/rules/quality.md: front matter must set a non-empty applies_to list',
        'docs/rules/quality.md: front matter must set a non-empty enforced_by list',
      ]),
    );
  });

  it('requires the type that matches the folder', () => {
    const report = vault({ ...clean, 'docs/rules/quality.md': runbook() });
    expect(report.errors).toContain('docs/rules/quality.md: front matter must set type: rule');
  });

  it('requires every runbook and rule to be indexed by its README', () => {
    const report = vault({ ...clean, 'docs/runbooks/restore.md': runbook() });
    expect(report.errors).toContain(
      'docs/runbooks/README.md does not link to docs/runbooks/restore.md',
    );
  });

  it('warns about runbooks never verified or verified too long ago', () => {
    const old = new Date(today.getTime() - (STALE_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const report = vault({
      ...clean,
      'docs/runbooks/README.md': '[a](backup.md) [b](old.md) [c](new.md)\n',
      'docs/runbooks/old.md': runbook(`area: data\nlast_verified: ${old}`),
      'docs/runbooks/new.md': runbook('area: data\nlast_verified:'),
    });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      '1 runbook(s) never verified (empty last_verified): docs/runbooks/new.md',
      `1 runbook(s) not verified in ${STALE_DAYS} days: docs/runbooks/old.md (${old})`,
    ]);
  });

  it('rejects a last_verified date in the future', () => {
    const report = vault({
      ...clean,
      'docs/runbooks/backup.md': runbook('area: data\nlast_verified: 2026-12-01'),
    });
    expect(report.errors).toContain('docs/runbooks/backup.md: last_verified is in the future');
  });

  it('warns when a link targets a file git does not track', () => {
    const tracked = Object.keys(clean).filter((path) => path !== 'docs/runbooks/backup.md');
    const report = vault(clean, tracked);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toContain(
      'docs/runbooks/README.md:1: links to docs/runbooks/backup.md, which git does not track yet',
    );
  });
});

describe('link extraction', () => {
  it('keeps line numbers when blanking code', () => {
    const prose = stripCode('a\n```\n[x](y)\n```\n[z](w)\n');
    expect(findLinks(prose)).toEqual([{ line: 5, target: 'w' }]);
  });

  it('reads images, titles and reference definitions but not footnotes', () => {
    const links = findLinks('![img](a.png "Title") [t](<b c.md>)\n[ref]: d.md\n[^1]: Not a link\n');
    expect(links.map((link) => link.target)).toEqual(['a.png', 'b c.md', 'd.md']);
  });
});
