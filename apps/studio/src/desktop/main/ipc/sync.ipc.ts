import { createIpcEmitter, defineIpcEvents, defineIpcModule, handle } from 'electron-ipc-module';
import { z } from 'zod';

import type { SyncChangedEvent, SyncRemoveRequest } from '../../contracts/contracts';
import type { SyncService } from '../sync/sync-service';

type SyncEvents = { 'sync-changed': [event: SyncChangedEvent] };
export const syncEvents = defineIpcEvents<SyncEvents>();
export const syncEmitter = createIpcEmitter<SyncEvents>('sync');

export function createSyncIpc(sync: SyncService) {
  return defineIpcModule(
    'sync',
    {
      statuses: handle(() => sync.snapshot()),
      upload: handle((_event, ids: string[]) => sync.upload(ids)),
      'upload-all': handle(() => sync.uploadAll()),
      run: handle(() => sync.run()),
      remove: handle((_event, request: SyncRemoveRequest) => sync.remove(request)),
    },
    {
      eventPrefix: true,
      validate: {
        upload: z.tuple([z.array(z.string())]),
        remove: z.tuple([
          z.object({
            id: z.string(),
            mode: z.enum(['local', 'everywhere']),
            userId: z.string(),
            revision: z.int(),
          }),
        ]),
      },
    },
  );
}
