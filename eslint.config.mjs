// 根 ESLint（flat config）。各包 `eslint .` 向上解析到本文件。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// D-003：绑定写入只走 createBinding()；与 apps/web 字面颜色规则合并（flat config 同名规则后者覆盖前者）
const BINDING_WRITE_SELECTORS = [
  { selector: "MemberExpression[property.name='userBrandBindings']", message: 'D-003：绑定写入只走 @bydp/core createBinding()；读取请在 core 内封装查询' },
  { selector: "ImportSpecifier[imported.name='userBrandBindings']", message: 'D-003：绑定写入只走 @bydp/core createBinding()' },
  { selector: 'Literal[value=/insert\\s+into\\s+"?user_brand_binding/i]', message: 'D-003：禁止裸 SQL 写 user_brand_binding' },
  { selector: 'TemplateElement[value.raw=/insert\\s+into\\s+"?user_brand_binding/i]', message: 'D-003：禁止裸 SQL 写 user_brand_binding' },
  // A-007 自检 S5：裸 SQL 改 / 删绑定同样只允许在 core bindings 内
  { selector: 'Literal[value=/(update|delete\\s+from)\\s+"?user_brand_binding/i]', message: 'D-003：禁止裸 SQL 改 / 删 user_brand_binding' },
  { selector: 'TemplateElement[value.raw=/(update|delete\\s+from)\\s+"?user_brand_binding/i]', message: 'D-003：禁止裸 SQL 改 / 删 user_brand_binding' }
];

// A-009：identity / verification_token 写入只走 core identity/auth.ts（盲索引 + 行绑定密文一致性）；identity.userId 只能经账号合并用例改（写 AuditLog）
const IDENTITY_WRITE_SELECTORS = [
  { selector: "MemberExpression[property.name=/^(identities|verificationTokens)$/]", message: 'A-009：身份 / 登录令牌只经 @bydp/core/identity/auth 读写' },
  { selector: "ImportSpecifier[imported.name=/^(identities|verificationTokens)$/]", message: 'A-009：身份 / 登录令牌只经 @bydp/core/identity/auth 读写' },
  { selector: 'Literal[value=/(insert\\s+into|update|delete\\s+from)\\s+("?public"?\\.)?"?(identity|verification_token)("|\\s|$)/i]', message: 'A-009：禁止裸 SQL 写 identity / verification_token' },
  { selector: 'TemplateElement[value.raw=/(insert\\s+into|update|delete\\s+from)\\s+("?public"?\\.)?"?(identity|verification_token)("|\\s|$)/i]', message: 'A-009：禁止裸 SQL 写 identity / verification_token' },
];

// 审核 A-017 条件 3：外部抓取文本（proposal 等）一律按纯文本渲染，禁止 dangerouslySetInnerHTML（apps/admin 等；apps/web 见下方说明）
const NO_RAW_HTML = { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'A-017：外部文本只按纯文本渲染，禁止 dangerouslySetInnerHTML' };

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.turbo/**', '**/migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
  {
    // ADR-0006：scoring 不得依赖 tracking / 商业域用例（与 .dependency-cruiser.cjs 双保险）
    files: ['packages/scoring/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['@bydp/tracking', '@bydp/tracking/*'], message: 'ADR-0006：scoring 不得依赖 tracking' },
        { group: ['@bydp/core/commerce', '@bydp/core/commerce/*', '@bydp/core/api', '@bydp/core/api/*'], message: 'ADR-0006：scoring 不得依赖商业域' },
        { group: ['@bydp/core', '@bydp/core/*', '@bydp/db', '@bydp/db/*'], message: 'A-003 C4：scoring 不依赖 core / db，只经 bydp_scoring_ro 读库' },
      ] }],
    },
  },
  {
    // ADR-0006：所有 apps（含 api / worker，PO 裁定 #12）不直连 db，走 packages/core
    files: ['apps/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['@bydp/db', '@bydp/db/*'], message: 'ADR-0006：apps 不得直连 db，请走 @bydp/core' },
      ] }],
    },
  },
  {
    // D-003 M1 首项 2：绑定写入只走 packages/core 的 createBinding()（HMAC 盲索引一致性）
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'],
    ignores: ['packages/db/**', 'packages/core/src/identity/bindings.ts', 'packages/core/src/identity/auth.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...BINDING_WRITE_SELECTORS, ...IDENTITY_WRITE_SELECTORS, NO_RAW_HTML],
    },
  },
  // 各写入口只豁免自己那张表（flat config 同名规则后者覆盖前者，故分块）
  { files: ['packages/core/src/identity/bindings.ts'], rules: { 'no-restricted-syntax': ['error', ...IDENTITY_WRITE_SELECTORS] } },
  { files: ['packages/core/src/identity/auth.ts'], rules: { 'no-restricted-syntax': ['error', ...BINDING_WRITE_SELECTORS] } },
  {
    // design-system §13：apps/web 组件禁止字面颜色，一律 var(--token)；token 只定义在 tokens.css
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      // web 的 dangerouslySetInnerHTML 仅用于自有 JSON-LD / 主题脚本 / SVG 图标（不渲染外部或 Agent 文本），不套 NO_RAW_HTML
      'no-restricted-syntax': ['error', ...BINDING_WRITE_SELECTORS, ...IDENTITY_WRITE_SELECTORS,
        { selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(/]', message: 'design-system §13：禁止字面颜色，改用 var(--token)' },
        { selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(/]', message: 'design-system §13：禁止字面颜色，改用 var(--token)' },
      ],
    },
  },
  {
    // 审核 A-017 条件 1：Agent 只能经 safe-fetch 出网（SSRF 防护单一入口）；safe-fetch.ts 本身豁免。
    // 自检 I1：除 fetch 与 http 模块外，同时禁 globalThis.fetch / 动态 import / createRequire / http2 / child_process / ws / WebSocket 等全部出网方式
    files: ['packages/agents/src/**/*.ts'],
    ignores: ['packages/agents/src/safe-fetch.ts'],
    rules: {
      'no-restricted-globals': ['error',
        ...['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Request'].map((name) => ({ name, message: 'A-017：Agent 出网只经 @bydp/agents/safe-fetch' })),
      ],
      'no-restricted-properties': ['error',
        ...['globalThis', 'window', 'self', 'global'].map((object) => ({ object, property: 'fetch', message: 'A-017：Agent 出网只经 @bydp/agents/safe-fetch' })),
      ],
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:child_process', 'node:worker_threads', 'node:module',
          'http', 'https', 'http2', 'net', 'tls', 'dgram', 'child_process', 'worker_threads', 'module', 'undici', 'axios', 'node-fetch', 'got', 'ws', 'cross-fetch'],
          message: 'A-017：Agent 出网只经 @bydp/agents/safe-fetch' },
      ] }],
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression', message: 'A-017：Agent 代码禁止动态 import（防绕过出网限制）' },
        { selector: "CallExpression[callee.name='require']", message: 'A-017：Agent 代码禁止 require（防绕过出网限制）' },
        { selector: "ImportSpecifier[imported.name='safeFetchWithTestHooks']", message: '审核 D-016 ②：测试注入入口只能在测试中引用' },
        { selector: "ImportDeclaration[source.value=/safe-fetch$/] > ImportNamespaceSpecifier", message: '审核 D-016 ②：safe-fetch 只能具名导入（防经命名空间调用测试入口）' },
      ],
    },
  },
);
