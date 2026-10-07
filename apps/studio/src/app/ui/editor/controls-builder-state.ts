import { uniformType } from '@shadergrove/shared/glsl-export';
import { UNIFORM_PREFIX, type ControlType, type ShaderControl } from '@shadergrove/shared/model';
import { LIMITS, validateControls } from '@shadergrove/shared/validate';
import { controlsToText } from '../../workspace/controls-text';
import { parseControls } from '../../workspace/state/controls-schema';

/**
 * The logic behind the Config Builder, kept apart from its template so that the
 * transitions that matter — what a form becomes, when it may be applied, what a
 * move does to the array — are one assertion away.
 *
 * The Builder owns no schema of its own. Every commit is the complete proposed
 * `ShaderControl[]`, validated by the same `validateControls` the store and the
 * server use and serialized by the same `controlsToText`, so what it writes is
 * exactly what the JSON view would have shown.
 */

/** Controls with no folder of their own are grouped under this one — the inspector's name for it too. */
export const DEFAULT_FOLDER = 'Parameters';

export const CONTROL_TYPES: readonly ControlType[] = ['number', 'boolean', 'color', 'select'];

/** The GLSL type a control's uniform is declared as. */
export function glslType(type: ControlType): string {
  return uniformType({ type } as ShaderControl);
}

export function uniformName(key: string): string {
  return UNIFORM_PREFIX + key;
}

// --- Groups and order -------------------------------------------------------

export interface GroupedControl {
  control: ShaderControl;
  /** Position in the whole array — what a reorder swaps. */
  index: number;
}

export interface ControlGroup {
  name: string;
  items: GroupedControl[];
}

/**
 * Groups in order of first occurrence, controls in array order within each —
 * the same arrangement the inspector builds, so the list and the knobs agree.
 */
export function groupControls(controls: readonly ShaderControl[]): ControlGroup[] {
  const groups = new Map<string, ControlGroup>();
  controls.forEach((control, index) => {
    const name = control.folder ?? DEFAULT_FOLDER;
    let group = groups.get(name);
    if (!group) {
      group = { name, items: [] };
      groups.set(name, group);
    }
    group.items.push({ control, index });
  });
  return [...groups.values()];
}

/** The array with a control swapped with its neighbour in the same group, or `null` at the edge. */
export function moveWithinGroup(
  controls: readonly ShaderControl[],
  index: number,
  direction: -1 | 1,
): ShaderControl[] | null {
  const control = controls[index];
  if (!control) return null;

  const group = groupControls(controls).find((candidate) =>
    candidate.items.some((item) => item.index === index),
  );
  const position = group?.items.findIndex((item) => item.index === index) ?? -1;
  const neighbour = group?.items[position + direction];
  if (!neighbour) return null;

  const next = [...controls];
  next[index] = neighbour.control;
  next[neighbour.index] = control;
  return next;
}

export function removeControl(controls: readonly ShaderControl[], index: number): ShaderControl[] {
  return controls.filter((_, at) => at !== index);
}

function usable(controls: readonly ShaderControl[], candidate: ShaderControl): boolean {
  return validateControls([...controls, candidate]).ok;
}

/** The first `base`, `base2`, `base3`… that is a legal key no control already has. */
function freshKey(
  controls: readonly ShaderControl[],
  base: string,
  template: ShaderControl,
): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : String(n);
    const key = base.slice(0, LIMITS.keyLength - suffix.length) + suffix;
    if (usable(controls, { ...template, key })) return key;
    if (n > LIMITS.controlCount + 8) return key;
  }
}

const NEW_CONTROL: Record<ControlType, () => ShaderControl> = {
  number: () => ({ key: 'value', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 }),
  boolean: () => ({ key: 'enabled', type: 'boolean', default: false }),
  color: () => ({ key: 'tint', type: 'color', default: '#ffffff' }),
  select: () => ({
    key: 'mode',
    type: 'select',
    default: 0,
    options: { 'Option 1': 0, 'Option 2': 1 },
  }),
};

/** A new control of the given type with valid defaults and a key nothing else uses. */
export function newControl(type: ControlType, controls: readonly ShaderControl[]): ShaderControl {
  const template = NEW_CONTROL[type]();
  return { ...template, key: freshKey(controls, template.key, template) };
}

/** The control, copied right after itself under a fresh key, with its own option map. */
export function duplicateControl(
  controls: readonly ShaderControl[],
  index: number,
  copySuffix: string,
): { controls: ShaderControl[]; key: string } | null {
  const source = controls[index];
  if (!source) return null;

  const copy = structuredClone(source);
  copy.key = freshKey(controls, source.key, copy);
  const label = `${source.label ?? source.key} ${copySuffix}`;
  copy.label = label.length <= LIMITS.labelLength ? label : (source.label ?? source.key);

  const next = [...controls];
  next.splice(index + 1, 0, copy);
  return { controls: next, key: copy.key };
}

// --- Committing -------------------------------------------------------------

export type CommitPlan =
  /** The buffer does not describe a valid schema: nothing may be written over it. */
  | { status: 'blocked' }
  /** The proposal is what the buffer already says. */
  | { status: 'noop' }
  | { status: 'invalid'; errors: string[] }
  | { status: 'commit'; text: string; controls: ShaderControl[] };

/**
 * Decide what writing `next` over the buffer would do. The buffer is parsed
 * here, from its text, rather than read from the store's `controls` — which
 * falls back to the last good schema when the text is invalid, and writing a
 * fallback over somebody's half-typed JSON is exactly what this must not do.
 */
export function planCommit(currentText: string, next: readonly ShaderControl[]): CommitPlan {
  const current = parseControls(currentText);
  if (!current) return { status: 'blocked' };

  const result = validateControls(next);
  if (!result.ok) return { status: 'invalid', errors: result.errors };
  if (JSON.stringify(result.value) === JSON.stringify(current)) return { status: 'noop' };

  return { status: 'commit', text: controlsToText(result.value), controls: result.value };
}

// --- The form ---------------------------------------------------------------

export interface OptionRow {
  /** Stable within a form, so a row keeps its identity as others are added and removed. */
  id: number;
  label: string;
  value: string;
}

/**
 * A control as text fields: what the user has typed, which may not be a control
 * yet. Numbers stay strings until they are applied so half-typed input is
 * never rewritten under the cursor.
 */
export interface ControlForm {
  type: ControlType;
  label: string;
  folder: string;
  /** Number and colour. */
  default: string;
  checked: boolean;
  min: string;
  max: string;
  step: string;
  options: OptionRow[];
  /** The row whose value is the select's default. */
  defaultRow: number | null;
  nextRow: number;
}

export type FormField = 'label' | 'folder' | 'default' | 'min' | 'max' | 'step' | 'options';

export type FormErrorCode = 'number' | 'optionLabel' | 'optionDuplicate' | 'optionDefault';

export interface FormError {
  field: FormField;
  /** Set for problems of one option row. */
  rowId?: number;
  /** Which row sub-field, when `rowId` is set. */
  part?: 'label' | 'value';
  code?: FormErrorCode;
  /** The validator's own wording, for anything the form did not catch itself. */
  message?: string;
}

function blankForm(type: ControlType): ControlForm {
  return {
    type,
    label: '',
    folder: '',
    default: '',
    checked: false,
    min: '',
    max: '',
    step: '',
    options: [],
    defaultRow: null,
    nextRow: 0,
  };
}

export function formFromControl(control: ShaderControl): ControlForm {
  const form: ControlForm = {
    ...blankForm(control.type),
    label: control.label ?? '',
    folder: control.folder ?? '',
  };

  switch (control.type) {
    case 'number':
      form.default = String(control.default);
      form.min = String(control.min);
      form.max = String(control.max);
      form.step = control.step === undefined ? '' : String(control.step);
      break;
    case 'boolean':
      form.checked = control.default;
      break;
    case 'color':
      form.default = control.default;
      break;
    case 'select':
      for (const [label, value] of Object.entries(control.options)) {
        form.options.push({ id: form.nextRow++, label, value: String(value) });
      }
      form.defaultRow =
        form.options.find((row) => Number(row.value) === control.default)?.id ?? null;
      break;
  }
  return form;
}

/** The same label and folder as another type, with that type's own defaults. */
export function retypeForm(form: ControlForm, type: ControlType): ControlForm {
  if (form.type === type) return form;
  const fresh = formFromControl({ ...NEW_CONTROL[type](), key: 'x' });
  return { ...fresh, label: form.label, folder: form.folder };
}

export function addOptionRow(form: ControlForm): ControlForm {
  const taken = new Set(form.options.map((row) => row.label.trim()));
  const takenValues = form.options.map((row) => Number(row.value)).filter(Number.isFinite);
  let n = form.options.length + 1;
  while (taken.has(`Option ${n}`)) n++;
  const value = takenValues.length ? Math.max(...takenValues) + 1 : 0;
  const row: OptionRow = { id: form.nextRow, label: `Option ${n}`, value: String(value) };
  return {
    ...form,
    options: [...form.options, row],
    nextRow: form.nextRow + 1,
    defaultRow: form.defaultRow ?? row.id,
  };
}

export function removeOptionRow(form: ControlForm, id: number): ControlForm {
  if (form.options.length <= 1) return form;
  const options = form.options.filter((row) => row.id !== id);
  return {
    ...form,
    options,
    defaultRow: form.defaultRow === id ? (options[0]?.id ?? null) : form.defaultRow,
  };
}

function toNumber(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const FIELD_PATTERN = /^controls\[\d+\]\.(label|folder|default|min|max|step|options)\b/;

export interface FormAnalysis {
  /** The control the form describes, when it describes one. */
  control: ShaderControl | null;
  errors: FormError[];
}

/**
 * Turn a form back into a control and say what is wrong with it.
 *
 * Only what a form can get wrong that a control cannot — text that is not a
 * number, option labels that would collapse into one key of the options map —
 * is checked here. Ranges, defaults, steps, colours, lengths and limits are the
 * validator's to judge, run over the whole proposed array, and its messages are
 * routed to the field they name.
 */
export function analyzeForm(
  form: ControlForm,
  controls: readonly ShaderControl[],
  key: string,
): FormAnalysis {
  const errors: FormError[] = [];
  const index = controls.findIndex((control) => control.key === key);
  const base = {
    key,
    ...(form.label.trim() ? { label: form.label } : {}),
    ...(form.folder.trim() ? { folder: form.folder } : {}),
  };
  const number = (field: 'default' | 'min' | 'max' | 'step', text: string): number => {
    const value = toNumber(text);
    if (value === null) errors.push({ field, code: 'number' });
    return value ?? 0;
  };

  let control: ShaderControl;
  switch (form.type) {
    case 'number': {
      const min = number('min', form.min);
      const max = number('max', form.max);
      const def = number('default', form.default);
      const step = form.step.trim() === '' ? undefined : number('step', form.step);
      control = {
        ...base,
        type: 'number',
        default: def,
        min,
        max,
        ...(step === undefined ? {} : { step }),
      };
      break;
    }
    case 'boolean':
      control = { ...base, type: 'boolean', default: form.checked };
      break;
    case 'color':
      control = { ...base, type: 'color', default: form.default.trim() };
      break;
    case 'select': {
      const options: Record<string, number> = {};
      const seen = new Set<string>();
      let def: number | null = null;
      for (const row of form.options) {
        const label = row.label.trim();
        const value = toNumber(row.value);
        if (label === '') {
          errors.push({ field: 'options', rowId: row.id, part: 'label', code: 'optionLabel' });
        } else if (seen.has(label)) {
          errors.push({ field: 'options', rowId: row.id, part: 'label', code: 'optionDuplicate' });
        }
        seen.add(label);
        if (value === null) {
          errors.push({ field: 'options', rowId: row.id, part: 'value', code: 'number' });
        } else {
          options[label] = value;
          if (row.id === form.defaultRow) def = value;
        }
      }
      if (form.defaultRow === null || !form.options.some((row) => row.id === form.defaultRow)) {
        errors.push({ field: 'default', code: 'optionDefault' });
      }
      control = { ...base, type: 'select', default: def ?? 0, options };
      break;
    }
  }

  if (errors.length > 0 || index < 0) return { control: null, errors };

  const proposal = [...controls];
  proposal[index] = control;
  const result = validateControls(proposal);
  if (result.ok) return { control: result.value[index], errors };

  for (const message of result.errors) {
    if (!message.startsWith(`controls[${index}]`)) continue;
    const field = FIELD_PATTERN.exec(message)?.[1] as FormField | undefined;
    errors.push({
      field: field ?? 'default',
      message: message.replace(/^controls\[\d+\]\./, ''),
    });
  }
  return { control: null, errors };
}

// --- The transaction --------------------------------------------------------

/**
 * One control being edited: the form, and the document it was read from.
 *
 * The shader's identity and the buffer's text are captured when the form opens.
 * An Apply that finds either changed is a stale write — over a JSON edit, an
 * agent's patch or a different shader altogether — and is refused.
 */
export interface Transaction {
  shaderId: string;
  sourceText: string;
  key: string;
  original: ShaderControl;
  baseline: ControlForm;
  form: ControlForm;
}

export interface Snapshot {
  shaderId: string | null;
  text: string | null;
}

export function openTransaction(
  snapshot: Snapshot,
  controls: readonly ShaderControl[],
  key: string,
): Transaction | null {
  const original = controls.find((control) => control.key === key);
  if (!original || snapshot.shaderId === null || snapshot.text === null) return null;

  const form = formFromControl(original);
  return {
    shaderId: snapshot.shaderId,
    sourceText: snapshot.text,
    key,
    original: structuredClone(original),
    baseline: form,
    form,
  };
}

export function isPending(transaction: Transaction | null): boolean {
  return (
    transaction !== null &&
    JSON.stringify(transaction.form) !== JSON.stringify(transaction.baseline)
  );
}

export type Staleness = 'shader' | 'text' | null;

export function staleness(transaction: Transaction, snapshot: Snapshot): Staleness {
  if (transaction.shaderId !== snapshot.shaderId) return 'shader';
  if (transaction.sourceText !== snapshot.text) return 'text';
  return null;
}

export type ApplyOutcome =
  | { status: 'stale'; reason: 'shader' | 'text' }
  | { status: 'form-invalid'; errors: FormError[] }
  | CommitPlan;

/** What applying the form would do. Pure: the caller writes the result and rebases the form. */
export function planApply(transaction: Transaction, snapshot: Snapshot): ApplyOutcome {
  const reason = staleness(transaction, snapshot);
  if (reason) return { status: 'stale', reason };

  const controls = parseControls(snapshot.text ?? '');
  if (!controls) return { status: 'blocked' };

  const analysis = analyzeForm(transaction.form, controls, transaction.key);
  if (!analysis.control) {
    // The key vanished from a buffer that otherwise matches — cannot happen
    // while the text is unchanged, but a missing control must never be invented.
    return analysis.errors.length > 0
      ? { status: 'form-invalid', errors: analysis.errors }
      : { status: 'stale', reason: 'text' };
  }

  return planCommit(
    snapshot.text ?? '',
    controls.map((control) => (control.key === transaction.key ? analysis.control! : control)),
  );
}
