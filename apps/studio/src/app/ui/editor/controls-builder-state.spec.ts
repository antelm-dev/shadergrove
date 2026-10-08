import { describe, expect, it } from 'vitest';

import type { ShaderControl } from '@shadergrove/shared/model';
import { LIMITS, validateControls } from '@shadergrove/shared/validate';
import { controlsToText } from '../../workspace/controls-text';
import {
  DEFAULT_FOLDER,
  addOptionRow,
  analyzeForm,
  duplicateControl,
  formFromControl,
  glslType,
  groupControls,
  isPending,
  moveWithinGroup,
  newControl,
  openTransaction,
  planApply,
  planCommit,
  removeOptionRow,
  retypeForm,
  staleness,
  type ControlForm,
  type Snapshot,
} from './controls-builder-state';

const SPEED: ShaderControl = {
  key: 'speed',
  type: 'number',
  label: 'Speed',
  default: 1,
  min: 0,
  max: 4,
  step: 0.5,
};
const GLOW: ShaderControl = { key: 'glow', type: 'boolean', folder: 'Look', default: true };
const TINT: ShaderControl = { key: 'tint', type: 'color', folder: 'Look', default: '#ff8800' };
const MODE: ShaderControl = {
  key: 'mode',
  type: 'select',
  default: 2,
  options: { Off: 0, Soft: 1.5, Hard: 2, Inverse: -1 },
};
const CONTROLS = [SPEED, GLOW, TINT, MODE];

/** The text the JSON view would hold: the validator's own key order, not the literal's. */
function canonicalText(controls: readonly ShaderControl[]): string {
  const result = validateControls(controls);
  if (!result.ok) throw new Error(result.errors.join(' '));
  return controlsToText(result.value);
}

function snapshot(text: string, shaderId = 'waves'): Snapshot {
  return { shaderId, text };
}

/** The control a form describes, which must exist. */
function built(form: ControlForm, controls: readonly ShaderControl[], key: string): ShaderControl {
  const analysis = analyzeForm(form, controls, key);
  expect(analysis.errors).toEqual([]);
  return analysis.control!;
}

describe('groups and order', () => {
  it('lists groups by first occurrence and controls in array order, ungrouped under Parameters', () => {
    const groups = groupControls([GLOW, SPEED, TINT, MODE]);

    expect(groups.map((group) => group.name)).toEqual(['Look', DEFAULT_FOLDER]);
    expect(groups[0].items.map((item) => item.control.key)).toEqual(['glow', 'tint']);
    expect(groups[1].items.map((item) => item.control.key)).toEqual(['speed', 'mode']);
    expect(groups[1].items.map((item) => item.index)).toEqual([1, 3]);
  });

  it('puts a folder literally named Parameters with the ungrouped ones, like the inspector', () => {
    const named: ShaderControl = { ...GLOW, folder: DEFAULT_FOLDER };
    expect(groupControls([SPEED, named]).map((group) => group.items.length)).toEqual([2]);
  });

  it('swaps a control with its neighbour in the same group, past other groups', () => {
    const next = moveWithinGroup(CONTROLS, 3, -1)!;
    expect(next.map((control) => control.key)).toEqual(['mode', 'glow', 'tint', 'speed']);

    const down = moveWithinGroup(CONTROLS, 1, 1)!;
    expect(down.map((control) => control.key)).toEqual(['speed', 'tint', 'glow', 'mode']);
  });

  it('does not move a control out of its group or off either end', () => {
    expect(moveWithinGroup(CONTROLS, 0, -1)).toBeNull();
    expect(moveWithinGroup(CONTROLS, 3, 1)).toBeNull();
    expect(moveWithinGroup(CONTROLS, 2, 1)).toBeNull();
    expect(moveWithinGroup(CONTROLS, 9, 1)).toBeNull();
  });

  it('keeps the inspector grouping when controls of one group are interleaved', () => {
    const interleaved = [GLOW, SPEED, TINT];
    const next = moveWithinGroup(interleaved, 2, -1)!;
    expect(next.map((control) => control.key)).toEqual(['tint', 'speed', 'glow']);
    expect(groupControls(next).map((group) => group.name)).toEqual(['Look', DEFAULT_FOLDER]);
  });
});

describe('new and duplicated controls', () => {
  it.each(['number', 'boolean', 'color', 'select'] as const)(
    'creates a valid %s control with a free key',
    (type) => {
      const first = newControl(type, []);
      expect(first.type).toBe(type);
      expect(validateControls([first]).ok).toBe(true);

      const second = newControl(type, [first]);
      expect(second.key).not.toBe(first.key);
      expect(validateControls([first, second]).ok).toBe(true);
    },
  );

  it('never picks a key the engine reserves or one already in use', () => {
    const taken = [{ ...newControl('number', []), key: 'value' }, newControl('boolean', [])];
    const created = newControl('number', taken);
    expect(taken.map((control) => control.key)).not.toContain(created.key);
    expect(validateControls([...taken, created]).ok).toBe(true);
  });

  it('copies a control right after itself with a fresh key and its own options', () => {
    const copy = duplicateControl(CONTROLS, 3, 'copy')!;

    expect(copy.controls.map((control) => control.key)).toEqual([
      'speed',
      'glow',
      'tint',
      'mode',
      copy.key,
    ]);
    expect(copy.key).not.toBe('mode');
    const duplicate = copy.controls[4] as typeof MODE;
    expect(duplicate.options).toEqual(MODE.options);
    expect(duplicate.options).not.toBe(MODE.options);
    expect(duplicate.label).toBe('mode copy');
    expect(validateControls(copy.controls).ok).toBe(true);
  });

  it('keeps a long key within the limit when copying', () => {
    const long: ShaderControl = { ...GLOW, key: 'k'.repeat(LIMITS.keyLength) };
    const copy = duplicateControl([long], 0, 'copy')!;
    expect(copy.key.length).toBeLessThanOrEqual(LIMITS.keyLength);
    expect(validateControls(copy.controls).ok).toBe(true);
  });

  it('reports the GLSL type of each control', () => {
    expect(['number', 'boolean', 'color', 'select'].map((type) => glslType(type as never))).toEqual(
      ['float', 'bool', 'vec3', 'float'],
    );
  });
});

describe('planCommit', () => {
  it('blocks anything over a buffer that is not a valid schema, however it fails', () => {
    for (const text of ['[{"key":', '{}', '[{"key":"a","type":"nope"}]']) {
      expect(planCommit(text, CONTROLS)).toEqual({ status: 'blocked' });
    }
  });

  it('is a no-op for a proposal that says what the buffer already says', () => {
    expect(planCommit(canonicalText(CONTROLS), CONTROLS)).toEqual({ status: 'noop' });
    expect(planCommit(JSON.stringify(CONTROLS), CONTROLS)).toEqual({ status: 'noop' });
    expect(planCommit('[]', [])).toEqual({ status: 'noop' });
  });

  it('serializes the validated proposal exactly as the JSON view would', () => {
    const plan = planCommit('[]', [{ ...TINT, default: '#FF8800' }]);
    const expected = [{ ...TINT, default: '#ff8800' }];
    expect(plan).toEqual({ status: 'commit', text: canonicalText(expected), controls: expected });
  });

  it('rejects a proposal over the control limit before anything is written', () => {
    const many = Array.from({ length: LIMITS.controlCount + 1 }, (_, n) => ({
      ...GLOW,
      key: `c${n}`,
    }));
    const plan = planCommit('[]', many);
    expect(plan.status).toBe('invalid');
  });
});

describe('analyzeForm', () => {
  const text = (control: ShaderControl) => formFromControl(control);

  it('rebuilds every control type from its own form unchanged', () => {
    for (const control of CONTROLS) {
      expect(built(text(control), CONTROLS, control.key)).toEqual(control);
    }
  });

  it('keeps numeric select values, fractions and negatives, and the default option', () => {
    const control = built(text(MODE), CONTROLS, 'mode') as typeof MODE;
    expect(control.options).toEqual({ Off: 0, Soft: 1.5, Hard: 2, Inverse: -1 });
    expect(control.default).toBe(2);
  });

  it('flags text that is not a number on the field that holds it', () => {
    const form = { ...text(SPEED), min: 'low', max: '', step: '1e' };
    expect(analyzeForm(form, CONTROLS, 'speed').errors).toEqual([
      { field: 'min', code: 'number' },
      { field: 'max', code: 'number' },
      { field: 'step', code: 'number' },
    ]);
  });

  it('routes the validator range, default and step messages to their fields', () => {
    const base = text(SPEED);
    const field = (form: ControlForm) => analyzeForm(form, CONTROLS, 'speed').errors;

    expect(field({ ...base, min: '5', max: '1', default: '5' }).map((e) => e.field)).toContain(
      'min',
    );
    expect(field({ ...base, default: '9' })).toEqual([
      expect.objectContaining({ field: 'default', message: expect.stringContaining('within') }),
    ]);
    expect(field({ ...base, step: '0' })).toEqual([expect.objectContaining({ field: 'step' })]);
    expect(field({ ...base, step: '-1' })).toEqual([expect.objectContaining({ field: 'step' })]);
  });

  it('rejects colours that are not #rrggbb and labels past the limit', () => {
    expect(analyzeForm({ ...text(TINT), default: 'orange' }, CONTROLS, 'tint').errors).toEqual([
      expect.objectContaining({ field: 'default' }),
    ]);
    expect(analyzeForm({ ...text(TINT), default: '#fff' }, CONTROLS, 'tint').control).toBeNull();
    expect(
      analyzeForm({ ...text(SPEED), label: 'x'.repeat(LIMITS.labelLength + 1) }, CONTROLS, 'speed')
        .errors,
    ).toEqual([expect.objectContaining({ field: 'label' })]);
  });

  it('drops an emptied label or folder instead of storing an empty string', () => {
    const control = built({ ...text(GLOW), folder: '  ' }, CONTROLS, 'glow');
    expect(control).toEqual({ key: 'glow', type: 'boolean', default: true });
  });

  it('rejects duplicate and empty option labels before they can collapse into one map key', () => {
    const base = text(MODE);
    const duplicated: ControlForm = {
      ...base,
      options: base.options.map((row, n) => (n === 1 ? { ...row, label: ' Off ' } : row)),
    };
    expect(analyzeForm(duplicated, CONTROLS, 'mode').errors).toEqual([
      { field: 'options', rowId: base.options[1].id, part: 'label', code: 'optionDuplicate' },
    ]);

    const emptied: ControlForm = {
      ...base,
      options: base.options.map((row, n) => (n === 0 ? { ...row, label: '' } : row)),
    };
    expect(analyzeForm(emptied, CONTROLS, 'mode').errors).toEqual([
      { field: 'options', rowId: base.options[0].id, part: 'label', code: 'optionLabel' },
    ]);
  });

  it('rejects an option value that is not a number and a select with no default', () => {
    const base = text(MODE);
    const bad: ControlForm = {
      ...base,
      options: base.options.map((row, n) => (n === 0 ? { ...row, value: 'x' } : row)),
    };
    expect(analyzeForm(bad, CONTROLS, 'mode').errors).toEqual([
      { field: 'options', rowId: base.options[0].id, part: 'value', code: 'number' },
    ]);
    expect(analyzeForm({ ...base, defaultRow: null }, CONTROLS, 'mode').errors).toEqual([
      { field: 'default', code: 'optionDefault' },
    ]);
  });

  it('adds and removes option rows, moving the default off a removed row', () => {
    const base = text(MODE);
    const added = addOptionRow(base);
    expect(added.options).toHaveLength(5);
    expect(new Set(added.options.map((row) => row.id)).size).toBe(5);
    expect(new Set(added.options.map((row) => row.label)).size).toBe(5);

    const removed = removeOptionRow(base, base.defaultRow!);
    expect(removed.options).toHaveLength(3);
    expect(removed.defaultRow).toBe(removed.options[0].id);

    let single = base;
    for (const row of base.options.slice(1)) single = removeOptionRow(single, row.id);
    expect(removeOptionRow(single, single.options[0].id)).toBe(single);
  });

  it('retypes a form onto the new type defaults, keeping what is common', () => {
    const labelled: ControlForm = { ...text(SPEED), label: 'Pace', folder: 'Motion' };
    for (const type of ['boolean', 'color', 'select'] as const) {
      const form = retypeForm(labelled, type);
      expect(form.type).toBe(type);
      expect(form.label).toBe('Pace');
      expect(form.folder).toBe('Motion');
      const control = built(form, CONTROLS, 'speed');
      expect(control.type).toBe(type);
      expect(control.key).toBe('speed');
    }
    expect(retypeForm(labelled, 'number')).toBe(labelled);
  });
});

describe('transactions', () => {
  const textOf = canonicalText(CONTROLS);

  it('opens clean and becomes pending once the form differs', () => {
    const tx = openTransaction(snapshot(textOf), CONTROLS, 'speed')!;
    expect(isPending(tx)).toBe(false);
    expect(isPending({ ...tx, form: { ...tx.form, max: '8' } })).toBe(true);
    expect(isPending(null)).toBe(false);
  });

  it('opens nothing for a control that is not there or a document that is not open', () => {
    expect(openTransaction(snapshot(textOf), CONTROLS, 'nope')).toBeNull();
    expect(openTransaction({ shaderId: null, text: null }, CONTROLS, 'speed')).toBeNull();
  });

  it('applies an edited form as one commit that touches only its own control', () => {
    const tx = openTransaction(snapshot(textOf), CONTROLS, 'speed')!;
    const outcome = planApply(
      { ...tx, form: { ...tx.form, max: '8', default: '6' } },
      snapshot(textOf),
    );

    const expected = [{ ...SPEED, max: 8, default: 6 }, GLOW, TINT, MODE];
    expect(outcome).toEqual({
      status: 'commit',
      text: canonicalText(expected),
      controls: expected,
    });
  });

  it('writes nothing for a form that changes nothing', () => {
    const tx = openTransaction(snapshot(textOf), CONTROLS, 'speed')!;
    expect(planApply(tx, snapshot(textOf))).toEqual({ status: 'noop' });
    expect(planApply({ ...tx, form: { ...tx.form, min: '0.0' } }, snapshot(textOf))).toEqual({
      status: 'noop',
    });
  });

  it('refuses a form whose entries are invalid', () => {
    const tx = openTransaction(snapshot(textOf), CONTROLS, 'speed')!;
    const outcome = planApply({ ...tx, form: { ...tx.form, min: '9' } }, snapshot(textOf));
    expect(outcome.status).toBe('form-invalid');
  });

  it('refuses a stale apply after the buffer changed underneath it', () => {
    const tx = openTransaction(snapshot(textOf), CONTROLS, 'speed')!;
    const edited = { ...tx, form: { ...tx.form, max: '8' } };
    const changed = canonicalText([...CONTROLS, newControl('boolean', CONTROLS)]);

    expect(staleness(edited, snapshot(changed))).toBe('text');
    expect(planApply(edited, snapshot(changed))).toEqual({ status: 'stale', reason: 'text' });
  });

  it('refuses a stale apply into a different shader, even with identical text', () => {
    const tx = openTransaction(snapshot(textOf), CONTROLS, 'speed')!;
    const edited = { ...tx, form: { ...tx.form, max: '8' } };

    expect(planApply(edited, snapshot(textOf, 'other'))).toEqual({
      status: 'stale',
      reason: 'shader',
    });
  });

  it('never writes over a buffer that stopped being valid', () => {
    const tx = openTransaction(snapshot(textOf), CONTROLS, 'speed')!;
    const edited = { ...tx, form: { ...tx.form, max: '8' } };

    expect(planApply(edited, snapshot('[{"key":'))).toEqual({ status: 'stale', reason: 'text' });

    const sameTextInvalid = { ...edited, sourceText: '[{"key":' };
    expect(planApply(sameTextInvalid, snapshot('[{"key":'))).toEqual({ status: 'blocked' });
  });
});
