/**
 * Profile and active sessions — the two things a signed-in user needs that are
 * not editing a shader.
 *
 * "Sign out everywhere" is the useful half of this dialog: it is what someone
 * reaches for after losing a laptop, and it has to work without knowing which
 * row that laptop is.
 */

import { Component, inject, signal, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import {
  AuthService,
  SESSION_NOT_FRESH,
  type AuthResult,
  type AuthSession,
} from '../../auth/auth.service';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { WorkspaceActions } from '../workspace-actions';

@Component({
  selector: 'app-account-dialog',
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'auth.accountTitle' | translate }}</h2>

    @if (busy()) {
      <mat-progress-bar mode="indeterminate" [attr.aria-label]="'auth.working' | translate" />
    }

    <mat-dialog-content>
      <section class="profile" [attr.aria-label]="'auth.profile' | translate">
        <span class="mark" aria-hidden="true"><mat-icon>person</mat-icon></span>
        <div>
          <p class="name">{{ auth.displayName() }}</p>
          <p class="email">{{ auth.user()?.email }}</p>
        </div>
      </section>

      @if (auth.user(); as user) {
        @if (!user.emailVerified) {
          <p class="notice" role="status">{{ 'auth.unverifiedNotice' | translate }}</p>
        }
      }

      <h3>{{ 'auth.sessionsTitle' | translate }}</h3>
      <p class="hint">{{ 'auth.sessionsSubtitle' | translate }}</p>

      @if (message(); as text) {
        <p class="notice" role="status" aria-live="polite">{{ text }}</p>
      }

      @if (retry()) {
        <!-- Session management needs a recent sign-in: ask, then carry on. -->
        <p class="hint">{{ 'auth.reauthHint' | translate }}</p>
        <mat-form-field appearance="outline" class="reauth">
          <mat-label>{{ 'auth.password' | translate }}</mat-label>
          <input
            matInput
            required
            cdkFocusInitial
            type="password"
            autocomplete="current-password"
            [value]="password()"
            (input)="password.set($any($event.target).value)"
            (keyup.enter)="confirmPassword()"
          />
        </mat-form-field>
        <button
          matButton="filled"
          type="button"
          [disabled]="busy() || !password()"
          (click)="confirmPassword()"
        >
          {{ 'auth.confirmPassword' | translate }}
        </button>
      } @else if (listed()) {
        <ul class="sessions">
          @for (session of sessions(); track session.id) {
            <li>
              <mat-icon aria-hidden="true">devices</mat-icon>
              <div>
                <p class="device">{{ session.userAgent || ('auth.unknownDevice' | translate) }}</p>
                <p class="dates">
                  {{ 'auth.sessionStarted' | translate }}
                  {{ i18n.formatDate(session.createdAt, sessionDate) }} ·
                  {{ 'auth.sessionExpires' | translate }}
                  {{ i18n.formatDate(session.expiresAt, sessionDate) }}
                </p>
              </div>
            </li>
          } @empty {
            <li class="dates">{{ 'auth.noSessions' | translate }}</li>
          }
        </ul>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.close' | translate }}</button>
      <button matButton type="button" [disabled]="busy()" (click)="signOutEverywhere()">
        {{ 'auth.signOutEverywhere' | translate }}
      </button>
      <button matButton="filled" type="button" [disabled]="busy()" (click)="signOut()">
        {{ 'auth.signOut' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(460px, 80vw);
    }

    .profile {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 20px;
    }

    .mark {
      display: grid;
      flex: 0 0 auto;
      width: 42px;
      height: 42px;
      place-items: center;
      border-radius: 50%;
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }

    .name {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }

    .email,
    .hint,
    .dates {
      margin: 2px 0 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    h3 {
      margin: 0;
      font: var(--mat-sys-title-small);
    }

    .notice {
      margin: 12px 0;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-body-small);
    }

    .sessions {
      margin: 12px 0 0;
      padding: 0;
      list-style: none;
    }

    .sessions li {
      display: flex;
      gap: 10px;
      padding: 8px 0;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }

    .device {
      margin: 0;
      overflow-wrap: anywhere;
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class AccountDialog implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly workspace = inject(WorkspaceActions);
  protected readonly i18n = inject(I18n);
  protected readonly sessionDate: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'medium',
  };
  private readonly ref = inject(MatDialogRef<AccountDialog>);

  protected readonly sessions = signal<AuthSession[]>([]);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  /** False until the list really loaded, so a failure never reads as "no sessions". */
  protected readonly listed = signal(false);
  /** Set while a password is needed; the action to resume once it is confirmed. */
  protected readonly retry = signal<(() => Promise<void>) | null>(null);
  protected readonly password = signal('');

  ngOnInit(): Promise<void> {
    return this.loadSessions();
  }

  protected async confirmPassword(): Promise<void> {
    const resume = this.retry();
    if (!resume || !this.password()) return;
    this.busy.set(true);
    const result = await this.auth.reauthenticate(this.password());
    this.password.set('');
    if (!this.settle(result)) return;
    this.retry.set(null);
    this.message.set(null);
    await resume();
  }

  private async loadSessions(): Promise<void> {
    this.busy.set(true);
    const result = await this.auth.listSessions();
    if (!this.settle(result, () => this.loadSessions())) return;
    this.sessions.set(result.sessions);
    this.listed.set(true);
  }

  protected async signOut(): Promise<void> {
    this.busy.set(true);
    await this.signOutHere();
  }

  protected async signOutEverywhere(): Promise<void> {
    this.busy.set(true);
    // Revoking the others first, then this one, so a failure part-way through
    // leaves the user signed out of the devices they were worried about. Any
    // failure keeps the dialog open: this is the incident-response button, and
    // closing it would read as "done" while the other sessions still work.
    if (!this.settle(await this.auth.revokeOtherSessions(), () => this.signOutEverywhere())) {
      return;
    }
    this.busy.set(true);
    await this.signOutHere();
  }

  /**
   * Through the workspace, so unsaved work is asked about before the library
   * closes. Choosing to stay keeps the dialog open, signed in.
   */
  private async signOutHere(): Promise<void> {
    const result = await this.workspace.signOut();
    if (!result) this.busy.set(false);
    else if (this.settle(result)) this.ref.close();
  }

  /**
   * Re-enables the buttons and, on failure, either asks for the password (when
   * the sign-in is too old and `again` can resume the action) or shows the
   * error. True when the step succeeded.
   */
  private settle(result: AuthResult, again?: () => Promise<void>): boolean {
    this.busy.set(false);
    if (result.ok) return true;
    if (result.code === SESSION_NOT_FRESH && again) {
      this.retry.set(again);
    } else {
      this.message.set(result.message ?? this.i18n.t('auth.genericError'));
    }
    return false;
  }
}
