/**
 * 排除期公开页显示层门控（D-019 第 2 项 · M3 登记项）：已登录且处于自我排除期的用户，公开页隐藏优惠列表、优惠 / 领码入口与「前往官网」。
 * 公开页均为 force-dynamic（无静态缓存），故在服务端组件按会话判定，不经客户端二次请求、无闪现；未登录不受影响；领码等服务端拒绝已有（tracking）。
 */
import { cache } from 'react';
import { getSelfExclusion, type SelfExclusionState } from '@bydp/core/identity/self-exclusion';
import { auth } from '../auth';
import { db } from './db';

/** 同一请求内多处（根 layout / 品牌 layout / 页面）只查一次 */
export const viewerSelfExclusion = cache(async (): Promise<SelfExclusionState | null> => {
  const uid = (await auth())?.user?.id;
  return uid ? getSelfExclusion(db(), uid) : null;
});

/** 排除期提示文案（不展示优惠时统一用） */
export function exclusionNotice(ex: SelfExclusionState): string {
  return ex.endsAt ? `你处于自我排除期（至 ${ex.endsAt.slice(0, 10)}），期间不展示优惠与前往官网入口。` : '你已永久自我排除，不展示优惠与前往官网入口。';
}
