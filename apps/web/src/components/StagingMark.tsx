/**
 * 测试环境水印（D-009）：BYDP_ENV=staging 时常驻顶部，提示数据为演示、功能未完成。页面多为构建期静态生成，
 * 故 BYDP_ENV 须在构建时即设置（deploy/Dockerfile 以 build-arg 传入）。正式 / 本地不渲染。
 */
export const IS_STAGING = process.env.BYDP_ENV === 'staging';

export function StagingMark() {
  if (!IS_STAGING) return null;
  return (
    <div className="staging-mark" role="note">
      测试环境 · 演示数据 · 功能未完成，请勿外传
    </div>
  );
}
