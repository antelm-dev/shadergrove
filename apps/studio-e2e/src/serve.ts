// Started by playwright.config.ts's webServer: `ng serve` for apps/studio on a
// throwaway SQLite store that is removed once the server stops. Arguments are
// forwarded to `ng serve`. Run directly by Node, so: erasable TypeScript only.
//
// Windows offers no graceful stop (Playwright force-kills the process tree), so
// the store is also wiped on start: a run that was killed leaves at most one.
//
// Without SMTP the server prints each email's link as `[auth] <url>`; those
// links are also copied to `mailLog`, which auth-links.spec.ts reads as its mailbox.
import { spawn } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const studio = resolve(import.meta.dirname, '../../studio');
const ng = createRequire(join(studio, 'package.json')).resolve('@angular/cli/bin/ng.js');
const dataDir = join(tmpdir(), 'shadergrove-e2e');
const mailLog = join(tmpdir(), 'shadergrove-e2e-mail.log');
const wipe = () => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  rmSync(mailLog, { force: true, maxRetries: 5 });
};

wipe();
const server = spawn(process.execPath, [ng, 'serve', ...process.argv.slice(2)], {
  cwd: studio,
  env: { ...process.env, SHADER_DATA_DIR: dataDir },
  stdio: ['inherit', 'pipe', 'inherit'],
});
server.stdout.pipe(process.stdout);
server.stdout.on('data', (chunk: Buffer) => {
  for (const [, link] of String(chunk).matchAll(/^\[auth\] (http\S+)$/gm)) {
    appendFileSync(mailLog, `${link}\n`);
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code) => {
  wipe();
  process.exit(code ?? 0);
});
