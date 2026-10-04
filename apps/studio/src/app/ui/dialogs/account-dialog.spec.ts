import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, SESSION_NOT_FRESH, type AuthSession } from '../../auth/auth.service';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages } from '../../i18n/testing/languages';
import { Preferences } from '../../prefs/preferences';
import { WorkspaceActions } from '../workspace-actions';
import { AccountDialog } from './account-dialog';

const SESSION: AuthSession = {
  id: 's1',
  createdAt: '2026-09-23T10:00:00Z',
  expiresAt: '2026-09-30T10:00:00Z',
  userAgent: 'Laptop browser',
  current: false,
};
const STALE = { ok: false, code: SESSION_NOT_FRESH, message: 'Confirm your password.' };

/**
 * Listing sessions is available immediately. Revoking them needs a recent
 * sign-in; when that action is refused, the dialog asks for the password and
 * then finishes what was asked.
 */
describe('AccountDialog', () => {
  const auth = {
    user: signal({ email: 'ada@example.test', emailVerified: true }),
    displayName: signal('Ada'),
    listSessions: vi.fn(),
    reauthenticate: vi.fn(async () => ({ ok: true })),
    revokeOtherSessions: vi.fn(),
    signOut: vi.fn(async () => ({ ok: true })),
  };
  const close = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [AccountDialog],
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        provideTestLanguages(),
        { provide: Preferences, useValue: { value: signal({ language: 'en' }) } },
        { provide: AuthService, useValue: auth },
        { provide: MatDialogRef, useValue: { close } },
        {
          provide: WorkspaceActions,
          useValue: { signOut: () => auth.signOut() },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function mount(): Promise<ComponentFixture<AccountDialog>> {
    const fixture = TestBed.createComponent(AccountDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  async function settle(fixture: ComponentFixture<AccountDialog>): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function button(fixture: ComponentFixture<AccountDialog>, label: string): HTMLButtonElement {
    const root = fixture.nativeElement as HTMLElement;
    const found = [...root.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(found, `button "${label}"`).toBeTruthy();
    return found!;
  }

  async function confirmWith(fixture: ComponentFixture<AccountDialog>, password: string) {
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(input).toBeTruthy();
    input!.value = password;
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(fixture, 'Confirm').click();
    await settle(fixture);
  }

  it('shows the browser session without asking for the password', async () => {
    auth.listSessions.mockResolvedValue({ ok: true, sessions: [SESSION] });
    const fixture = await mount();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Laptop browser');
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(auth.reauthenticate).not.toHaveBeenCalled();
  });

  it('finishes signing out everywhere once the password is confirmed', async () => {
    auth.listSessions.mockResolvedValue({ ok: true, sessions: [SESSION] });
    auth.revokeOtherSessions.mockResolvedValueOnce(STALE).mockResolvedValueOnce({ ok: true });
    const fixture = await mount();

    button(fixture, 'Sign out everywhere').click();
    await settle(fixture);
    expect(close).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();

    await confirmWith(fixture, 'correct horse battery');

    expect(auth.revokeOtherSessions).toHaveBeenCalledTimes(2);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
  });

  it('shows any other failure rather than asking for a password', async () => {
    auth.listSessions.mockResolvedValue({ ok: false, message: 'Server unavailable', sessions: [] });
    const fixture = await mount();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Server unavailable');
    expect(root.textContent).not.toContain('No other sessions.');
    expect(root.querySelector('input[type="password"]')).toBeNull();
  });
});
