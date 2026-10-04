import { sanitizeBootstrapState, type PluginBootstrapState } from '@shadergrove/shared/plugin';
import type { StoredPlugin } from '../../desktop/contracts/contracts';

export type { StoredPlugin };

/**
 * Where installed plugins live between sessions. The text kept is the package
 * file as picked; `PluginInstallations` revalidates it on every load.
 */
export interface PluginStore {
  list(): Promise<StoredPlugin[]>;
  /** Keyed by `record.id`, the id from the package's own manifest. */
  put(record: StoredPlugin): Promise<void>;
  /**
   * Writes `record` only if no record has its id, in one step where the store
   * allows it; whether it wrote. What seeding uses, so it never replaces an
   * install made meanwhile — in this window or another.
   */
  add(record: StoredPlugin): Promise<boolean>;
  /**
   * Writes `record` only over a record of its id, in one step where the store
   * allows it; whether it wrote. A change to an installed package — switching
   * it — so a window still showing a package another one removed cannot
   * bring it back.
   */
  replace(record: StoredPlugin): Promise<boolean>;
  remove(id: string): Promise<void>;
  /**
   * What this profile remembers of the default packages, kept apart from the
   * packages themselves; `null` where defaults are never seeded.
   */
  readBootstrap(): Promise<PluginBootstrapState | null>;
  writeBootstrap(state: PluginBootstrapState): Promise<void>;
}

/**
 * The browser's: one IndexedDB database per profile — a signed-in account or
 * the anonymous session — so one account never sees, or runs, packages another
 * installed on the same machine.
 */
export class IndexedDbPluginStore implements PluginStore {
  private db: Promise<IDBDatabase> | null = null;
  private bootstrapDb: Promise<IDBDatabase> | null = null;

  /**
   * The bootstrap state lives in a companion database (`<name>:bootstrap`): the
   * packages' own database keeps its schema and version, so an older release
   * still opens it after a downgrade.
   */
  constructor(private readonly name: string) {}

  async readBootstrap(): Promise<PluginBootstrapState> {
    const db = await (this.bootstrapDb ??= openDatabase(`${this.name}:bootstrap`, 'state'));
    return new Promise((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').get('bootstrap');
      request.onsuccess = () => resolve(sanitizeBootstrapState(request.result));
      request.onerror = () => reject(request.error);
    });
  }

  async writeBootstrap(state: PluginBootstrapState): Promise<void> {
    const db = await (this.bootstrapDb ??= openDatabase(`${this.name}:bootstrap`, 'state'));
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite');
      transaction.objectStore('state').put(sanitizeBootstrapState(state), 'bootstrap');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  }

  /**
   * Each record under its own string key, whatever it holds: a value damaged outside
   * the app comes back with an empty text — listed as invalid, removable by that
   * key — instead of failing the whole list.
   */
  async list(): Promise<StoredPlugin[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const records: StoredPlugin[] = [];
      const request = db.transaction('plugins', 'readonly').objectStore('plugins').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(records);
        if (typeof cursor.key !== 'string') return cursor.continue();
        const value = cursor.value as Partial<StoredPlugin> | null;
        records.push({
          id: cursor.key,
          text: typeof value?.text === 'string' ? value.text : '',
          enabled: value?.enabled === true,
          installedAt: typeof value?.installedAt === 'string' ? value.installedAt : '',
        });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async put(record: StoredPlugin): Promise<void> {
    await this.request('readwrite', (store) => store.put(record, record.id));
  }

  async add(record: StoredPlugin): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('plugins', 'readwrite');
      const request = transaction.objectStore('plugins').add(record, record.id);
      let added = true;
      request.onerror = (event) => {
        // The id is taken: not a failure, and not one that may abort the transaction.
        if (request.error?.name !== 'ConstraintError') return;
        added = false;
        event.preventDefault();
      };
      transaction.oncomplete = () => resolve(added);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  }

  async replace(record: StoredPlugin): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      // Read and written in one transaction: no delete can land between the two.
      const transaction = db.transaction('plugins', 'readwrite');
      const store = transaction.objectStore('plugins');
      let replaced = false;
      const existing = store.getKey(record.id);
      existing.onsuccess = () => {
        if (existing.result === undefined) return;
        replaced = true;
        store.put(record, record.id);
      };
      transaction.oncomplete = () => resolve(replaced);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async remove(id: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(id));
  }

  private open(): Promise<IDBDatabase> {
    return (this.db ??= openDatabase(this.name, 'plugins'));
  }

  private async request(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      // Settled by the transaction, not the request: a write is only saved once it commits,
      // and a commit can still abort (quota, disk) after the request succeeded.
      const transaction = db.transaction('plugins', mode);
      const request = run(transaction.objectStore('plugins'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  }
}

/** One object store, version 1. */
function openDatabase(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** The desktop app's: files under `<userData>/plugins`, written by the main process. */
export class DesktopPluginStore implements PluginStore {
  list(): Promise<StoredPlugin[]> {
    return window.electron.bridge.plugins.list();
  }

  async put(record: StoredPlugin): Promise<void> {
    // The main process checks the id against the package itself.
    await window.electron.bridge.plugins.put(record);
  }

  /** Checked, then written: only the main window writes here, one operation at a time. */
  async add(record: StoredPlugin): Promise<boolean> {
    if ((await this.list()).some((stored) => stored.id === record.id)) return false;
    await this.put(record);
    return true;
  }

  async replace(record: StoredPlugin): Promise<boolean> {
    if (!(await this.list()).some((stored) => stored.id === record.id)) return false;
    await this.put(record);
    return true;
  }

  async remove(id: string): Promise<void> {
    await window.electron.bridge.plugins.remove(id);
  }

  async readBootstrap(): Promise<PluginBootstrapState | null> {
    const state = await window.electron.bridge.plugins.bootstrap();
    return state === null ? null : sanitizeBootstrapState(state);
  }

  async writeBootstrap(state: PluginBootstrapState): Promise<void> {
    await window.electron.bridge.plugins.saveBootstrap(state);
  }
}

/** Where there is nowhere to keep anything: the server, or a browser without IndexedDB. */
export class NoPluginStore implements PluginStore {
  async list(): Promise<StoredPlugin[]> {
    return [];
  }
  async put(): Promise<void> {
    throw new Error('Plugins cannot be installed here');
  }
  async add(): Promise<boolean> {
    throw new Error('Plugins cannot be installed here');
  }
  async replace(): Promise<boolean> {
    throw new Error('Plugins cannot be installed here');
  }
  async remove(): Promise<void> {}
  async readBootstrap(): Promise<null> {
    return null;
  }
  async writeBootstrap(): Promise<void> {}
}
