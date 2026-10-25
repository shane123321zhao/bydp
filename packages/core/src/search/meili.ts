/**
 * Meilisearch 最小客户端（D-019 · 架构 §16）：只用 HTTP API，不引 SDK；仅内网访问（compose 不暴露端口），密钥只来自环境变量，不记日志。
 * 查询超时 1.5 秒；任何失败由调用方降级为 Postgres（search.ts），不向用户报错。
 */
export type MeiliConfig = { url: string; key: string; fetchImpl?: typeof fetch; timeoutMs?: number };

export class MeiliError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'MeiliError';
  }
}

export type IndexSettings = {
  searchableAttributes: string[];
  filterableAttributes?: string[];
  displayedAttributes?: string[];
  synonyms?: Record<string, string[]>;
};

/**
 * 查询侧（web / api / tg-bot）用只读搜索 key（MEILI_SEARCH_KEY，只能 search brands / cases）；写侧（worker）用 master key。
 * MEILI_URL + 对应 key 都有才启用；否则 null（调用方走 Postgres）。
 */
export function meiliFromEnv(env: Record<string, string | undefined> = process.env, role: 'search' | 'write' = 'search'): Meili | null {
  const url = env.MEILI_URL?.trim();
  const key = (role === 'write' ? env.MEILI_MASTER_KEY : env.MEILI_SEARCH_KEY)?.trim();
  return url && key ? new Meili({ url, key }) : null;
}

/** 只读搜索 key 的固定 uid（bootstrap 按 Meili 规则 key = HMAC-SHA256(master, uid) 派生同值写入 MEILI_SEARCH_KEY） */
export const SEARCH_KEY_UID = '6f0c9f2e-5b1d-4c39-9a57-bd1a9e0c4d21';

export class Meili {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly cfg: MeiliConfig) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.f = cfg.fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = this.cfg.timeoutMs ?? 1500): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.cfg.key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new MeiliError(`Meilisearch 不可达：${(e as Error).name}`);
    }
    if (!res.ok) {
      // 只取错误码，不回显请求内容
      const code = ((await res.json().catch(() => null)) as { code?: string } | null)?.code ?? '';
      throw new MeiliError(`Meilisearch ${method} ${path.split('?')[0]} → HTTP ${res.status} ${code}`.trim(), res.status);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<boolean> {
    try {
      return (await this.req<{ status: string }>('GET', '/health')).status === 'available';
    } catch {
      return false;
    }
  }

  /** 等待异步任务完成（写操作用；失败抛错） */
  async wait(taskUid: number, timeoutMs = 60_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const t = await this.req<{ status: string; error?: { code?: string } }>('GET', `/tasks/${taskUid}`, undefined, 5000);
      if (t.status === 'succeeded') return;
      if (t.status === 'failed' || t.status === 'canceled') throw new MeiliError(`Meilisearch 任务 ${taskUid} ${t.status} ${t.error?.code ?? ''}`.trim());
      if (Date.now() > until) throw new MeiliError(`Meilisearch 任务 ${taskUid} 超时`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private async task(method: string, path: string, body?: unknown): Promise<void> {
    const t = await this.req<{ taskUid: number }>(method, path, body, 10_000);
    await this.wait(t.taskUid);
  }

  /** 索引是否存在（增量同步前判断：不存在时须全量重建，不建残缺索引） */
  async exists(uid: string): Promise<boolean> {
    try {
      await this.req('GET', `/indexes/${uid}`, undefined, 5000);
      return true;
    } catch (e) {
      if (e instanceof MeiliError && e.status === 404) return false;
      throw e;
    }
  }

  /** 建只读搜索 key（worker 以 master 调用；已存在则跳过）。key 值由 uid + master 派生，不在此返回或记录 */
  async ensureSearchKey(uid: string, indexes: string[]): Promise<void> {
    try {
      await this.req('GET', `/keys/${uid}`, undefined, 5000);
      return;
    } catch (e) {
      if (!(e instanceof MeiliError && e.status === 404)) throw e;
    }
    await this.req('POST', '/keys', { uid, name: 'bydp-search', description: 'web / api 只读搜索', actions: ['search'], indexes, expiresAt: null }, 5000);
  }

  async ensureIndex(uid: string, settings: IndexSettings): Promise<void> {
    try {
      await this.req('GET', `/indexes/${uid}`, undefined, 5000);
    } catch (e) {
      if (!(e instanceof MeiliError && e.status === 404)) throw e;
      await this.task('POST', '/indexes', { uid, primaryKey: 'id' });
    }
    await this.task('PATCH', `/indexes/${uid}/settings`, settings);
  }

  upsert(uid: string, docs: object[]): Promise<void> {
    return docs.length ? this.task('POST', `/indexes/${uid}/documents?primaryKey=id`, docs) : Promise.resolve();
  }

  remove(uid: string, ids: string[]): Promise<void> {
    return ids.length ? this.task('POST', `/indexes/${uid}/documents/delete-batch`, ids) : Promise.resolve();
  }

  /** 全量重建：写入临时索引后与正式索引原子交换，再删临时索引（重建期间查询不受影响） */
  async rebuild(uid: string, settings: IndexSettings, docs: object[]): Promise<void> {
    const tmp = `${uid}_rebuild`;
    await this.req('DELETE', `/indexes/${tmp}`, undefined, 5000)
      .then((t) => this.wait((t as { taskUid: number }).taskUid))
      .catch(() => {});
    await this.ensureIndex(uid, settings);
    await this.ensureIndex(tmp, settings);
    for (let i = 0; i < docs.length; i += 1000) await this.upsert(tmp, docs.slice(i, i + 1000));
    await this.task('POST', '/swap-indexes', [{ indexes: [uid, tmp] }]);
    await this.task('DELETE', `/indexes/${tmp}`);
  }

  async searchIds(uid: string, q: string, opts: { filter?: string; limit?: number } = {}): Promise<string[]> {
    const r = await this.req<{ hits: { id: string }[] }>('POST', `/indexes/${uid}/search`, {
      q,
      limit: opts.limit ?? 20,
      attributesToRetrieve: ['id'],
      ...(opts.filter ? { filter: opts.filter } : {}),
    });
    return r.hits.map((h) => h.id);
  }
}
