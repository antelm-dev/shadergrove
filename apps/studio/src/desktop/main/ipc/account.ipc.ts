import {
  createIpcEmitter,
  defineIpcEvents,
  defineIpcModule,
  handle,
  listen,
} from 'electron-ipc-module';

import type { AccountState } from '../../contracts/contracts';
import type { DesktopAccountSession } from '../account/account-session';

type AccountEvents = { 'account-changed': [state: AccountState] };
export const accountEvents = defineIpcEvents<AccountEvents>();
const accountEmitter = createIpcEmitter<AccountEvents>('account');

/** The renderer sees the account's state and nothing else: never the token. */
export function createAccountIpc(account: DesktopAccountSession) {
  return defineIpcModule(
    'account',
    {
      state: handle(() => account.state()),
      'sign-in': handle(() => account.signIn()),
      'sign-out': handle(() => account.signOut()),
      'open-account-page': listen(() => account.openAccountPage()),
    },
    {
      eventPrefix: true,
      ready: () => account.onChange((state) => accountEmitter.emit('account-changed', state)),
    },
  );
}
