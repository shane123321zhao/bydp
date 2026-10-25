'use server';
/**
 * 「我的」页退出（D-010 口径）：普通退出只清本设备 cookie；「退出所有设备」先把会话纪元 +1（其他设备的 token 立即失效），再清本机。
 */
import { revokeAllSessions } from '@bydp/core/identity/auth';
import { auth, signOut } from '../../../auth';
import { db } from '../../../lib/db';

export async function signOutHere() {
  await signOut({ redirectTo: '/' });
}

export async function signOutEverywhere() {
  const uid = (await auth())?.user?.id;
  if (uid) await revokeAllSessions(db(), uid);
  await signOut({ redirectTo: '/login' });
}
