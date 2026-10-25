/** 证据原文存储（与 apps/api/src/server.ts 同口径）：R2 已配置 → 私有桶；未配置 → null（文件上传被拒，交易哈希类证据不受影响） */
import type { EvidenceStore } from '@bydp/core/complaint/write';
import { R2Client, r2ConfigFromEnv, r2EvidenceStore } from '@bydp/core/storage/r2';

let store: EvidenceStore | null | undefined;

export function evidenceStore(): EvidenceStore | null {
  if (store === undefined) {
    const cfg = r2ConfigFromEnv();
    store = cfg ? r2EvidenceStore(new R2Client(cfg), process.env.R2_BUCKET_EVIDENCE ?? 'bydp-evidence') : null;
  }
  return store;
}
