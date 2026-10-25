/**
 * W2#010：测试站 Cookie 门禁。UAT 启动时直接注入 bydp_gate Cookie（不走口令页）；值来自 .env.local 的 STAGING_GATE_TOKEN，
 * 由 scripts/uat.sh 只传给子进程（UAT_GATE_TOKEN），不打印。Cookie 只对测试站域名生效，不会随请求发往第三方。
 */
export function gateStorageState(baseURL: string, token = process.env.UAT_GATE_TOKEN) {
  if (!token) return undefined;
  const { hostname } = new URL(baseURL);
  return {
    cookies: [{ name: 'bydp_gate', value: token, domain: hostname, path: '/', expires: Math.floor(Date.now() / 1000) + 24 * 3600, httpOnly: true, secure: true, sameSite: 'Lax' as const }],
    origins: [],
  };
}
