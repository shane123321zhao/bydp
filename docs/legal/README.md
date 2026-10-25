# docs/legal · 法务页源文（内部说明，不渲染到网站）

- `terms-draft.md` → `/terms`；`privacy-policy-draft.md` → `/privacy-policy`（Cookie 一节锚点 `#cookies`，design-system §16）。网站在运行时直接读取这两个文件（D-021，`apps/web/src/lib/legal.ts`），**文件里的所有内容都会公开展示**，内部备注只写在本 README。
- 起草：审核会话（兼协调）2026-10-04 · HANDOVER §9 #10；隐私政策 §2 / §4 / §9 经开发按代码核对（6682da6）。
- 事实口径来源：architecture §7 / §9.2 v1.7–v1.11、`/me/privacy` 页面。口径变化时必须同步修改正文。
- 【待替换】【待定】须在上线前补齐：运营主体全称与注册地、适用法律与争议解决地、联系邮箱（privacy@主域）、服务器所在地（#15）、上线日期。
- 上线前建议请熟悉首发市场（新加坡 / 马来西亚 / 台湾）的律师过目一次。
- 简体为源文，译本定稿前以简体为准（HANDOVER §9 #11）。
- 放行前页面保持「草稿」提示 + noindex；PO #19 审定且待补项填齐后，由审核在总核对中放开。
