import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { defineIpcModule, handle } from 'electron-ipc-module';

import {
  PLUGIN_BOOTSTRAP_MAX_BYTES,
  PLUGIN_LIMITS,
  isDataOnlyPackage,
  parsePluginPackage,
  sanitizeBootstrapState,
  type PluginBootstrapState,
} from '@shadergrove/shared';
import type { StoredPlugin } from '../../contracts/contracts';

/**
 * Installed local plugins, one file each under `<userData>/plugins`.
 *
 * The renderer never names a path: a file's name is a hash of the package id
 * the main process read out of the package itself, which also keeps an id like
 * `con` clear of Windows' reserved device names. What is stored is the package
 * text as picked plus the user's switch; the renderer revalidates the text on
 * every load, so a file edited or corrupted on disk comes back disabled rather
 * than trusted.
 */
/**
 * The largest file a valid record can make: package text of at most `packageBytes`
 * UTF-16 units — up to 3 UTF-8 bytes each, doubled again by JSON escaping — plus its
 * few other fields. Anything bigger was not written here and is not read.
 */
const MAX_RECORD_BYTES = PLUGIN_LIMITS.packageBytes * 6 + 4096;

export function createPluginFiles(dir: string) {
  const fileFor = (id: string) =>
    join(dir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`);

  // Writes run one at a time, so a compare-and-delete reads and deletes with nothing between.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };

  const readRecord = async (id: string): Promise<StoredPlugin | null> => {
    const record = await readFile(fileFor(id), 'utf8')
      .then((text) => (text.length <= MAX_RECORD_BYTES ? (JSON.parse(text) as unknown) : null))
      .catch(() => null);
    return isStoredPlugin(record) && record.id === id ? record : null;
  };

  return {
    async list(): Promise<StoredPlugin[]> {
      const names = await readdir(dir).catch(() => [] as string[]);
      const stored: StoredPlugin[] = [];
      for (const name of names.filter((entry) => /^[0-9a-f]{32}\.json$/.test(entry))) {
        const path = join(dir, name);
        const record = await stat(path)
          .then((info) =>
            info.isFile() && info.size <= MAX_RECORD_BYTES ? readFile(path, 'utf8') : null,
          )
          .then((text) => (text === null ? null : (JSON.parse(text) as unknown)))
          .catch(() => null);
        // A record whose id does not hash to its own file could not be removed by that id —
        // removing it would delete another package's file instead.
        if (isStoredPlugin(record) && fileFor(record.id).endsWith(name)) stored.push(record);
      }
      return stored;
    },

    /** Stores a package under the id its own manifest declares; refuses one that does not validate. */
    put(record: StoredPlugin): Promise<string> {
      return serial(() => write(record));
    },

    remove(id: string): Promise<void> {
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
        return Promise.reject(new Error('Not a plugin id'));
      }
      return serial(() => rm(fileFor(id), { force: true }));
    },

    /**
     * Deletes the record of `expected.id` only if it is still exactly `expected` —
     * same text, switch and install time — and says whether it did. Read and
     * deleted within one serialized write, so nothing written meanwhile is lost.
     */
    removeIf(expected: StoredPlugin): Promise<boolean> {
      if (!isStoredPlugin(expected)) return Promise.reject(new Error('Not a plugin record'));
      return serial(async () => {
        const stored = await readRecord(expected.id);
        if (!stored || !sameRecord(stored, expected)) return false;
        await rm(fileFor(expected.id), { force: true });
        return true;
      });
    },
  };

  async function write(record: StoredPlugin): Promise<string> {
    if (!isStoredPlugin(record)) throw new Error('Not a plugin record');
    const parsed = parsePluginPackage(record.text);
    if (!parsed.ok) throw new Error(`Invalid plugin package: ${parsed.errors.join('; ')}`);
    const id = parsed.value.manifest.id;
    if (record.id !== id) throw new Error('The record id does not match its package');
    await mkdir(dir, { recursive: true });
    const path = fileFor(id);
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(record));
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return id;
  }
}

/** The same install, unchanged: what a compare-and-delete compares. */
function sameRecord(a: StoredPlugin, b: StoredPlugin): boolean {
  return (
    a.id === b.id && a.text === b.text && a.enabled === b.enabled && a.installedAt === b.installedAt
  );
}

/**
 * What the app remembers of the default packages (see `PluginBootstrapState`):
 * one small JSON file beside — not inside — the plugins folder, so it is never
 * mistaken for a package record. Read with a size bound and sanitized; written
 * whole, through a temporary file renamed over it, so a crash leaves the old
 * state or the new one, never half of either.
 */
export function createPluginBootstrapFile(path: string) {
  return {
    async read(): Promise<PluginBootstrapState> {
      const text = await stat(path)
        .then((info) =>
          info.isFile() && info.size <= PLUGIN_BOOTSTRAP_MAX_BYTES ? readFile(path, 'utf8') : null,
        )
        .catch(() => null);
      try {
        return sanitizeBootstrapState(text === null ? null : JSON.parse(text));
      } catch {
        return sanitizeBootstrapState(null);
      }
    },

    async write(state: PluginBootstrapState): Promise<void> {
      const text = JSON.stringify(sanitizeBootstrapState(state));
      if (text.length > PLUGIN_BOOTSTRAP_MAX_BYTES) throw new Error('Plugin state is too large');
      const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temp, text);
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

function isStoredPlugin(value: unknown): value is StoredPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const { id, text, enabled, installedAt } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 64 &&
    typeof text === 'string' &&
    text.length <= PLUGIN_LIMITS.packageBytes &&
    typeof enabled === 'boolean' &&
    typeof installedAt === 'string' &&
    installedAt.length <= 40
  );
}

/**
 * `isMainWindow` gates every write: output and satellite windows render
 * shaders, they do not get to install, remove or seed anything. They may read
 * the data-only packages — themes and languages — so they dress and speak like
 * the main window; no package with code is ever handed to them.
 */
export function createPluginsIpc(
  dir: string,
  bootstrapPath: string,
  isMainWindow: (sender: WebContents) => boolean,
) {
  const files = createPluginFiles(dir);
  const bootstrap = createPluginBootstrapFile(bootstrapPath);
  const guard = (sender: WebContents) => {
    if (!isMainWindow(sender)) throw new Error('Plugins are managed from the main window only');
  };

  return defineIpcModule('plugins', {
    // Any window may read: the others see only the data-only packages, so their theme and
    // language follow the main window's without any plugin code reaching them.
    list: handle(async (event): Promise<StoredPlugin[]> => {
      const stored = await files.list();
      if (isMainWindow(event.sender)) return stored;
      return stored.filter((record) => {
        const parsed = parsePluginPackage(record.text);
        return (
          parsed.ok && parsed.value.manifest.id === record.id && isDataOnlyPackage(parsed.value)
        );
      });
    }),
    put: handle(async (event, record: StoredPlugin): Promise<string> => {
      guard(event.sender);
      return files.put(record);
    }),
    remove: handle(async (event, id: string): Promise<void> => {
      guard(event.sender);
      await files.remove(id);
    }),
    removeIf: handle(async (event, expected: StoredPlugin): Promise<boolean> => {
      guard(event.sender);
      return files.removeIf(expected);
    }),
    // `null` elsewhere: only the main window seeds the defaults.
    bootstrap: handle(
      async (event): Promise<PluginBootstrapState | null> =>
        isMainWindow(event.sender) ? bootstrap.read() : null,
    ),
    saveBootstrap: handle(async (event, state: PluginBootstrapState): Promise<void> => {
      guard(event.sender);
      await bootstrap.write(state);
    }),
  });
}
