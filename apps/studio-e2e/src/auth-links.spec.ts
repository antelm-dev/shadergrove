import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';

import { expect, test } from './fixtures';

// serve.ts copies every link the server would have emailed into this file.
const MAIL_LOG = join(tmpdir(), 'shadergrove-e2e-mail.log');

// Its own account: a reset revokes every session, and the shared E2E user's is
// the one every other test signs in with.
const EMAIL = 'reset-link@example.test';
const OLD_PASSWORD = 'old-reset-link-password';
const NEW_PASSWORD = 'new-reset-link-password';

function mailbox(): string[] {
  try {
    return readFileSync(MAIL_LOG, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The first link that arrives after `seen`, matching `pattern`. */
async function nextLink(seen: number, pattern: RegExp): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(
      () =>
        (found = mailbox()
          .slice(seen)
          .find((link) => pattern.test(link))),
    )
    .toBeTruthy();
  return found!;
}

/** A browser that has never seen this app: what someone opening their email has. */
async function freshPage(browser: Browser, baseURL: string, errors: Error[]): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error));
  return page;
}

test.use({ storageState: { cookies: [], origins: [] } });

test('emailed verification and password-reset links work end to end', async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  const origin = { origin: baseURL! };
  const errors: Error[] = [];
  let seen = mailbox().length;
  const signUp = await request.post('/api/auth/sign-up/email', {
    headers: origin,
    data: { name: 'Reset link', email: EMAIL, password: OLD_PASSWORD },
  });
  expect(signUp.ok(), await signUp.text()).toBe(true);

  // Verification: the link confirms the address and signs that browser in.
  const verify = await nextLink(seen, /\/api\/auth\/verify-email\?token=/);
  const verifier = await freshPage(browser, baseURL!, errors);
  await verifier.goto(verify);
  await expect(verifier).toHaveURL(`${baseURL}/`);
  const session = await verifier.request.get('/api/auth/get-session');
  expect((await session.json())?.user).toMatchObject({ email: EMAIL, emailVerified: true });
  await verifier.context().close();

  // Asking for a reset, through the dialog a signed-out visitor is shown.
  await page.goto('/');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Forgot your password?' }).click();
  await dialog.getByLabel('Email').fill(EMAIL);
  seen = mailbox().length;
  await dialog.getByRole('button', { name: 'Send reset link' }).click();
  await expect(dialog.getByRole('status')).toContainText('a reset link is on its way');

  // The reset link, opened where the email is read: it must reach the dialog
  // with its token, and the token must not stay in the address bar.
  const reset = await nextLink(seen, /\/api\/auth\/reset-password\/[^/?]+\?callbackURL=/);
  const reader = await freshPage(browser, baseURL!, errors);
  await reader.goto(reset);
  const resetDialog = reader.getByRole('dialog');
  await expect(resetDialog.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await expect(reader).toHaveURL(`${baseURL}/`);
  await resetDialog.getByLabel('New password').fill(NEW_PASSWORD);
  await resetDialog.getByRole('button', { name: 'Save password' }).click();
  await expect(resetDialog.getByRole('status')).toContainText('Password changed');

  // The dialog is back on sign-in; the new password works and the old one does not.
  await resetDialog.getByLabel('Email').fill(EMAIL);
  await resetDialog.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await resetDialog.getByRole('button', { name: 'Log in' }).click();
  await expect(resetDialog).toBeHidden();
  const signedIn = await reader.request.get('/api/auth/get-session');
  expect((await signedIn.json())?.user).toMatchObject({ email: EMAIL });
  await reader.context().close();

  const stale = await request.post('/api/auth/sign-in/email', {
    headers: origin,
    data: { email: EMAIL, password: OLD_PASSWORD },
  });
  expect(stale.status()).toBe(401);
  expect(errors, 'uncaught errors in the fresh browsers').toEqual([]);
});
