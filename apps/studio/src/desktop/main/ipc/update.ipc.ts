import {
  createIpcEmitter,
  defineIpcEvents,
  defineIpcModule,
  handle,
  listen,
} from 'electron-ipc-module';

import type { UpdateState } from '../../contracts/contracts';
import type { UpdateController } from '../core/updater';

type UpdateEvents = { 'update-state-changed': [state: UpdateState] };
export const updateEvents = defineIpcEvents<UpdateEvents>();
export const updateEmitter = createIpcEmitter<UpdateEvents>('update');

export function createUpdateIpc(controller: UpdateController) {
  return defineIpcModule(
    'update',
    {
      state: handle(() => controller.current()),
      check: handle(() => controller.check()),
      install: listen(() => void controller.update()),
    },
    { eventPrefix: true },
  );
}
