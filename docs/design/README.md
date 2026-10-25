# docs/design — 交互设计阶段（P1）

交付物与顺序（HANDOVER 第 6 节第 4 步）：
1. `fixtures/*.json` — mock 数据，字段对应架构 §7
2. `wireframes/` — 低保真线框（含全状态）
3. `components.md` — 组件清单与设计系统
4. `field-mapping.md` — 逐页字段 → 实体.字段 ✅
5. `api-contract.yaml` — OpenAPI 3.1 草案 ✅
6. `hifi/` — 高保真稿（P1 七页完成，待冻结）；`design-system.md` — 设计标准 ✅

## 在线画板
高保真稿发布在 Claude Design 画板「BYDP 高保真设计稿 P1」：https://claude.ai/artifact/1RXfg7eFx4TdNHcRRX5b63
`hifi/` 为其源码归档（.dc.html + canvas.json），**本地不可打开**，看图请用画板；文件说明见 `hifi/README.md`。

## prototype/ — 投资人可点原型（可直接双击打开）
- `prototype/bydp-prototype.html`：单文件、无依赖（仅 Google 字体），手机壳内 P1 七页全部可点、可跳转，右侧附演示脚本。数据为 fixtures 演示样本。
- 与 `hifi/*.dc.html`（画布源码，本地不可开）不同，这是唯一一个本地可直接查看的 HTML。
- `prototype/bydp-prototype-radar.html`（2026-09-24）：方向 R「暗夜雷达」全套可点原型，与 F2 版同数据同页面清单，供投资人二选一。`*-site.zip` 为 Cloudflare Pages 上传包。
