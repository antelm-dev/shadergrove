/**
 * Sanitizers for persisted surface layout values. Untrusted JSON in, executable
 * state out — corrupt placements fall back to kind defaults.
 */

import { finite, flag, numberIn, oneOf, type Point, type Rect, type Size } from '../geometry';
import {
  DEFAULT_BOTTOM_PANEL_TAB,
  sanitizeBottomPanelTab,
  sanitizeInspectorTab,
} from '../prefs/panel';
import { capabilitiesFor } from './capabilities';
import { sanitizeEditorLayout } from './editor-layout';
import {
  clampDockSize,
  clampFloatingRect,
  clampSurfaceMinimizedPoint,
  clampNativeBounds,
  cloneRestorePoint,
  defaultContainedPlacement,
  defaultDockSide,
  defaultDockSize,
  defaultFloatingRectFor,
  defaultRestorePoint,
  SURFACE_MIN_SIZES,
} from './placement';
import {
  asEditorGroupId,
  asSurfaceId,
  DEFAULT_EDITOR_GROUP_ID,
  DOCK_SIDES,
  editorSurfaceId,
  isDockSide,
  isSurfaceKind,
  LAYOUT_VERSION,
  SURFACE_KINDS,
  WELL_KNOWN_SURFACE_IDS,
  type DockSide,
  type NativePlacement,
  type RestorePoint,
  type SanitizedLayoutPreferences,
  type SurfaceChrome,
  type SurfaceKind,
  type SurfacePlacement,
  type SurfaceRecord,
} from './types';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeRect(value: unknown, fallback: Rect, min: Size, maxSpan = 6000): Rect {
  const input = asRecord(value);
  return {
    x: Math.round(numberIn(input['x'], fallback.x, -maxSpan, maxSpan)),
    y: Math.round(numberIn(input['y'], fallback.y, -maxSpan, maxSpan)),
    width: Math.round(numberIn(input['width'], fallback.width, min.width, maxSpan)),
    height: Math.round(numberIn(input['height'], fallback.height, min.height, maxSpan)),
  };
}

function sanitizePoint(value: unknown, fallback: Point, maxSpan = 6000): Point {
  const input = asRecord(value);
  return {
    x: Math.round(numberIn(input['x'], fallback.x, -maxSpan, maxSpan)),
    y: Math.round(numberIn(input['y'], fallback.y, -maxSpan, maxSpan)),
  };
}

function sanitizeDockSide(value: unknown, fallback: DockSide): DockSide {
  return oneOf(value, DOCK_SIDES, fallback);
}

/**
 * Reject illegal restore modes (maximized/minimized/unknown) by falling back
 * to the kind default durable placement.
 */
export function sanitizeRestorePoint(value: unknown, kind: SurfaceKind): RestorePoint {
  const input = asRecord(value);
  const mode = input['mode'];
  const fallback = defaultRestorePoint(kind);

  if (mode === 'stage') {
    if (!capabilitiesFor(kind).stage) return fallback;
    return { mode: 'stage' };
  }

  if (mode === 'docked') {
    if (!capabilitiesFor(kind).dock) return fallback;
    const side = sanitizeDockSide(input['side'], defaultDockSide(kind));
    if (!capabilitiesFor(kind).allowedDockSides.includes(side)) {
      return {
        mode: 'docked',
        side: defaultDockSide(kind),
        size: clampDockSize(kind, finite(input['size']) ?? defaultDockSize(kind)),
      };
    }
    return {
      mode: 'docked',
      side,
      size: clampDockSize(kind, finite(input['size']) ?? defaultDockSize(kind)),
    };
  }

  if (mode === 'floating') {
    if (!capabilitiesFor(kind).float && !capabilitiesFor(kind).stage) {
      // Rails with float:false still may store a floating restore from a future
      // build — fall back to dock default when dock is available.
      if (capabilitiesFor(kind).dock) {
        return {
          mode: 'docked',
          side: defaultDockSide(kind),
          size: defaultDockSize(kind),
        };
      }
    }
    return {
      mode: 'floating',
      rect: sanitizeRect(
        input['rect'],
        defaultFloatingRectFor(kind),
        SURFACE_MIN_SIZES[kind].floating,
      ),
    };
  }

  return cloneRestorePoint(fallback);
}

export function sanitizeNativePlacement(
  value: unknown,
  kind: SurfaceKind,
  workArea?: Size,
): NativePlacement {
  const input = asRecord(value);
  const fallback = defaultFloatingRectFor(kind);
  const bounds = clampNativeBounds(
    sanitizeRect(input['bounds'], fallback, SURFACE_MIN_SIZES[kind].floating),
    workArea,
    SURFACE_MIN_SIZES[kind].floating,
  );

  const placement: NativePlacement = {
    host: 'native',
    bounds,
  };

  if (typeof input['displayId'] === 'string' && input['displayId'].length > 0) {
    placement.displayId = input['displayId'];
  }
  if (typeof input['maximized'] === 'boolean') {
    placement.maximized = input['maximized'];
  }
  if (typeof input['fullscreen'] === 'boolean') {
    placement.fullscreen = input['fullscreen'];
  }

  return placement;
}

export function sanitizePlacement(
  value: unknown,
  kind: SurfaceKind,
  options: { viewport?: Size; workArea?: Size } = {},
): SurfacePlacement {
  const input = asRecord(value);
  const host = input['host'];
  const caps = capabilitiesFor(kind);

  if (host === 'native' || kind === 'live-preview-output') {
    // live-preview-output is native-only in MVP; coerce corrupt contained → native.
    if (host === 'native' || kind === 'live-preview-output') {
      return sanitizeNativePlacement(
        host === 'native' ? input : { bounds: input['bounds'] ?? input['rect'] },
        kind,
        options.workArea,
      );
    }
  }

  const mode = input['mode'];

  if (mode === 'stage') {
    if (!caps.stage) return defaultContainedPlacement(kind);
    return { host: 'contained', mode: 'stage' };
  }

  if (mode === 'docked') {
    if (!caps.dock) return defaultContainedPlacement(kind);
    const side = sanitizeDockSide(input['side'], defaultDockSide(kind));
    const allowed = caps.allowedDockSides.includes(side) ? side : defaultDockSide(kind);
    return {
      host: 'contained',
      mode: 'docked',
      side: allowed,
      size: clampDockSize(kind, finite(input['size']) ?? defaultDockSize(kind)),
    };
  }

  if (mode === 'floating') {
    if (!caps.float) return defaultContainedPlacement(kind);
    return {
      host: 'contained',
      mode: 'floating',
      rect: clampFloatingRect(
        kind,
        sanitizeRect(input['rect'], defaultFloatingRectFor(kind), SURFACE_MIN_SIZES[kind].floating),
        options.viewport,
      ),
    };
  }

  if (mode === 'maximized') {
    if (!caps.maximize) return defaultContainedPlacement(kind);
    return {
      host: 'contained',
      mode: 'maximized',
      restore: sanitizeRestorePoint(input['restore'], kind),
    };
  }

  if (mode === 'minimized') {
    if (!caps.minimize) return defaultContainedPlacement(kind);
    const point =
      input['point'] !== undefined
        ? clampSurfaceMinimizedPoint(
            kind,
            sanitizePoint(input['point'], { x: 24, y: 24 }),
            options.viewport,
          )
        : undefined;
    return {
      host: 'contained',
      mode: 'minimized',
      restore: sanitizeRestorePoint(input['restore'], kind),
      ...(point ? { point } : {}),
    };
  }

  return defaultContainedPlacement(kind);
}

function defaultChrome(kind: SurfaceKind): SurfaceChrome {
  switch (kind) {
    case 'editor':
      return { kind: 'editor', editorGroupId: DEFAULT_EDITOR_GROUP_ID };
    case 'inspector':
      return { kind: 'inspector', tab: 'controls' };
    case 'bottom-panel':
      return { kind: 'bottom-panel', tab: DEFAULT_BOTTOM_PANEL_TAB };
    case 'preview':
      return { kind: 'preview' };
    case 'shader-browser':
      return { kind: 'shader-browser' };
    case 'live-preview-output':
      return { kind: 'live-preview-output' };
  }
}

export function sanitizeChrome(value: unknown, kind: SurfaceKind): SurfaceChrome {
  const input = asRecord(value);
  switch (kind) {
    case 'editor': {
      const groupId =
        typeof input['editorGroupId'] === 'string' && input['editorGroupId'].length > 0
          ? asEditorGroupId(input['editorGroupId'])
          : DEFAULT_EDITOR_GROUP_ID;
      return { kind: 'editor', editorGroupId: groupId };
    }
    case 'inspector':
      return { kind: 'inspector', tab: sanitizeInspectorTab(input['tab']) };
    case 'bottom-panel':
      return { kind: 'bottom-panel', tab: sanitizeBottomPanelTab(input['tab']) };
    default:
      return defaultChrome(kind);
  }
}

export function defaultSurfaceId(kind: SurfaceKind, editorGroupId?: string): string {
  switch (kind) {
    case 'preview':
      return WELL_KNOWN_SURFACE_IDS.preview;
    case 'inspector':
      return WELL_KNOWN_SURFACE_IDS.inspector;
    case 'shader-browser':
      return WELL_KNOWN_SURFACE_IDS.shaderBrowser;
    case 'bottom-panel':
      return WELL_KNOWN_SURFACE_IDS.bottomPanel;
    case 'live-preview-output':
      return WELL_KNOWN_SURFACE_IDS.livePreviewOutput;
    case 'editor':
      return editorSurfaceId(asEditorGroupId(editorGroupId ?? DEFAULT_EDITOR_GROUP_ID));
  }
}

export function sanitizeSurfaceRecord(
  value: unknown,
  options: { viewport?: Size; workArea?: Size; fallbackKind?: SurfaceKind } = {},
): SurfaceRecord | null {
  const input = asRecord(value);
  const kind = isSurfaceKind(input['kind']) ? input['kind'] : (options.fallbackKind ?? null);
  if (!kind) return null;

  const chrome = sanitizeChrome(input['chrome'] ?? input, kind);
  const id =
    typeof input['id'] === 'string' && input['id'].length > 0
      ? asSurfaceId(input['id'])
      : asSurfaceId(
          defaultSurfaceId(kind, chrome.kind === 'editor' ? chrome.editorGroupId : undefined),
        );

  const placement = sanitizePlacement(input['placement'], kind, options);
  const returnPoint =
    input['returnPoint'] !== undefined
      ? sanitizeRestorePoint(
          input['returnPoint'],
          kind === 'live-preview-output' ? 'preview' : kind,
        )
      : undefined;

  return {
    id,
    kind,
    open: flag(input['open'], true),
    placement,
    chrome,
    ...(returnPoint ? { returnPoint } : {}),
  };
}

export function createDefaultSurface(
  kind: SurfaceKind,
  overrides: Partial<
    Pick<SurfaceRecord, 'open' | 'placement' | 'chrome' | 'id' | 'returnPoint'>
  > = {},
): SurfaceRecord {
  const chrome = overrides.chrome ?? defaultChrome(kind);
  const id =
    overrides.id ??
    asSurfaceId(
      defaultSurfaceId(kind, chrome.kind === 'editor' ? chrome.editorGroupId : undefined),
    );
  const placement =
    overrides.placement ??
    (kind === 'live-preview-output'
      ? {
          host: 'native' as const,
          bounds: defaultFloatingRectFor(kind),
        }
      : defaultContainedPlacement(kind));
  return {
    id,
    kind,
    open: overrides.open ?? true,
    placement,
    chrome,
    ...(overrides.returnPoint ? { returnPoint: overrides.returnPoint } : {}),
  };
}

/**
 * Sanitize a versioned layout document. Drops invalid executable surface
 * records; preserves unknown future top-level keys via passthrough helper.
 */
export function sanitizeLayoutPreferences(
  value: unknown,
  options: { viewport?: Size; workArea?: Size } = {},
): SanitizedLayoutPreferences {
  const input = asRecord(value);

  const rawSurfaces = Array.isArray(input['surfaces']) ? input['surfaces'] : [];
  const surfaces: SurfaceRecord[] = [];
  const seenIds = new Set<string>();
  const seenSingletons = new Set<SurfaceKind>();

  for (const entry of rawSurfaces) {
    const record = sanitizeSurfaceRecord(entry, options);
    if (!record) continue;
    if (seenIds.has(record.id)) continue;

    const caps = capabilitiesFor(record.kind);
    if (caps.singleton) {
      if (seenSingletons.has(record.kind)) continue;
      seenSingletons.add(record.kind);
    }

    seenIds.add(record.id);
    surfaces.push(record);
  }

  // Ensure required workspace singletons exist (closed if absent from input).
  for (const kind of SURFACE_KINDS) {
    if (kind === 'editor') continue;
    if (kind === 'live-preview-output') {
      // Optional until opened; do not force into layout.
      continue;
    }
    if (!surfaces.some((s) => s.kind === kind)) {
      const created = createDefaultSurface(kind, {
        open: kind === 'preview',
      });
      if (kind === 'preview') {
        surfaces.unshift(created);
      } else {
        surfaces.push(created);
      }
    }
  }

  if (!surfaces.some((s) => s.kind === 'editor')) {
    surfaces.push(createDefaultSurface('editor', { open: false }));
  }

  const zOrderRaw = Array.isArray(input['zOrder']) ? input['zOrder'] : [];
  const idSet = new Set(surfaces.map((s) => s.id));
  const zOrder = zOrderRaw
    .filter((id): id is string => typeof id === 'string' && idSet.has(asSurfaceId(id)))
    .map(asSurfaceId);

  for (const surface of surfaces) {
    if (!zOrder.includes(surface.id)) zOrder.push(surface.id);
  }

  // Version 1 (no split tree) and corrupt trees both repair to leaves over the
  // contained editor surfaces; the output is always the current version.
  const defaultEditorId = asSurfaceId(defaultSurfaceId('editor'));
  const editors = surfaces.filter((s) => s.kind === 'editor' && s.placement.host === 'contained');
  const editorLayout = sanitizeEditorLayout(input['editorLayout'], {
    known: editors.map((s) => s.id),
    required: editors.filter((s) => s.open).map((s) => s.id),
    fallback:
      editors.find((s) => s.id === defaultEditorId)?.id ?? editors[0]?.id ?? defaultEditorId,
  });

  return { version: LAYOUT_VERSION, surfaces, zOrder, editorLayout };
}

/** Strip non-executable unknown fields from a surface while keeping known shape. */
export function stripInvalidExecutableState(record: SurfaceRecord): SurfaceRecord {
  const placement = sanitizePlacement(record.placement, record.kind);
  const chrome = sanitizeChrome(record.chrome, record.kind);
  const returnPoint = record.returnPoint
    ? sanitizeRestorePoint(
        record.returnPoint,
        record.kind === 'live-preview-output' ? 'preview' : record.kind,
      )
    : undefined;

  // Discard illegal stage on non-preview, etc. already handled by sanitizePlacement.
  return {
    id: record.id,
    kind: record.kind,
    open: record.open,
    placement,
    chrome,
    ...(returnPoint ? { returnPoint } : {}),
  };
}

export function isDockSideAllowed(kind: SurfaceKind, side: unknown): side is DockSide {
  return isDockSide(side) && capabilitiesFor(kind).allowedDockSides.includes(side);
}
