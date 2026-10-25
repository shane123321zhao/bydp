/** 操作结果提示（server action → 回跳页面）：短时 httpOnly cookie，按回跳路径匹配显示 */
export const FLASH_COOKIE = 'bydp_admin_flash';
export type Flash = { tone: 'ok' | 'bad'; text: string; code?: string; path: string };
