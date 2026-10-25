/** 登录后跳回地址：只接受站内相对路径（以单个 / 开头、无反斜杠 / 空白），否则回首页（防开放跳转） */
export function safeCallback(raw: string | null | undefined): string {
  return raw && /^\/(?!\/)[^\s\\]*$/.test(raw) ? raw : '/';
}
