/** 评分隔离（ADR-0006）：scoring 不得依赖 tracking / 任何商业数据模块；所有 apps（含 api / worker，PO 裁定 #12）不得直接依赖 db（走 core）。 */
module.exports = {
  forbidden: [
    { name: 'scoring-no-tracking', severity: 'error', from: { path: '^packages/scoring' }, to: { path: '^packages/tracking' } },
    { name: 'scoring-no-commerce-core', severity: 'error', from: { path: '^packages/scoring' }, to: { path: '^packages/core/src/(commerce|api)' } },
    // 传递依赖也拦：经 @bydp/core 根入口等桶文件间接触达商业域 / tracking 同样违规
    // A-003 C4：scoring 只经 bydp_scoring_ro 读库，不得依赖 @bydp/db（业务连接）与 @bydp/core
    { name: 'scoring-no-db-or-core', severity: 'error', from: { path: '^packages/scoring' }, to: { path: '^packages/(db|core)/' } },
    { name: 'scoring-no-commerce-reachable', severity: 'error', from: { path: '^packages/scoring' }, to: { path: '^packages/(tracking|core/src/(commerce|api))', reachable: true } },
    // 解析不到的依赖会让上面的路径规则静默失效
    { name: 'no-unresolvable', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'apps-no-direct-db', severity: 'error', from: { path: '^apps/' }, to: { path: '^packages/db' } }
  ],
  options: {
    tsPreCompilationDeps: true,
    // workspace 包以 exports 指向 TS 源码（./src/index.ts）
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'], extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'] }, doNotFollow: { path: 'node_modules' }, exclude: { path: '(^|/)(node_modules|dist|\\.next|\\.turbo)/|next-env\\.d\\.ts$' } }
};
