-- A-005（W1）：scoring_ro 可读 withdrawal_report.bindingId（不透明 ID；scoring_ro 读不到 user_brand_binding / app_user，无法关联到人）
GRANT SELECT ("bindingId") ON "withdrawal_report" TO bydp_scoring_ro;
