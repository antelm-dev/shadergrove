import { Component, computed, inject, signal } from '@angular/core';
import { FormField, form, maxLength, requiredError, validate } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shadergrove/shared/validate';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { PluginCommands } from '../../plugins/plugin-commands';
import { ProjectRecipes } from '../../plugins/tools/recipes';
import type { MenuCommand } from '../menu-commands';

/** A name to create, or the plugin importer to start instead. */
export type NewShaderDialogResult =
  | { action: 'create'; name: string }
  | { action: 'plugin'; command: MenuCommand };

interface NewShaderModel {
  name: string;
}

@Component({
  selector: 'app-new-shader-dialog',
  imports: [
    FormField,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'dialog.newShader' | translate }}</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="field">
        <mat-label>{{ 'dialog.name' | translate }}</mat-label>
        <input matInput cdkFocusInitial [formField]="form.name" (keyup.enter)="create()" />
        <mat-hint>{{ 'dialog.newShaderHint' | translate }}</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.cancel' | translate }}</button>
      <!-- The active plugins' importers, if any: none is offered without its plugin. -->
      @for (command of imports(); track command.id) {
        <button
          matButton
          type="button"
          [attr.data-testid]="'new-shader-' + command.id"
          (click)="importWith(command)"
        >
          <mat-icon>{{ command.icon() }}</mat-icon>
          {{ command.label() }}
        </button>
      }
      <button matButton="filled" type="button" [disabled]="form().invalid()" (click)="create()">
        {{ 'action.create' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .field {
      width: min(460px, 72vw);
    }
  `,
})
export class NewShaderDialog {
  private readonly dialogRef =
    inject<MatDialogRef<NewShaderDialog, NewShaderDialogResult>>(MatDialogRef);
  private readonly pluginImports = inject(PluginCommands).imports;
  private readonly recipeCommands = inject(ProjectRecipes).commands;
  /** The active plugins' importers, then "New from a recipe…" while any recipe is active. */
  protected readonly imports = computed(() => [...this.pluginImports(), ...this.recipeCommands()]);

  protected readonly model = signal<NewShaderModel>({ name: '' });
  protected readonly form = form(this.model, (path) => {
    maxLength(path.name, LIMITS.nameLength);
    validate(path.name, ({ value }) => (value().trim().length > 0 ? undefined : requiredError()));
  });

  create(): void {
    if (this.form().invalid()) return;
    this.dialogRef.close({ action: 'create', name: this.model().name.trim() });
  }

  importWith(command: MenuCommand): void {
    this.dialogRef.close({ action: 'plugin', command });
  }
}
