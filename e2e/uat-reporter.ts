/**
 * 每条用例一行「✅ 通过 ｜ … / ❌ 失败 ｜ …（截图）」，末行汇总；有失败退出码非 0（Playwright 自身决定）。
 * W2#006 口径：纯网络原因（net::ERR_* / 取信超时）单列为「🌐 网络」——该轮作废重跑，不算全绿，也不算功能失败。
 * W2#019 口径：React #418（已知 F6，用例附件 known-f6）单列「⚠️ 已知 F6」并如实计数、列出页面，不判用例失败；一轮内 ≥ 3 次判整轮失败。
 */
const F6_LIMIT = 3;
const NETWORK = /net::ERR_|(?:^|Error: )网络：|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Connection closed by|Connection reset by|kex_exchange_identification/;
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { relative } from 'node:path';

export default class UatReporter implements Reporter {
  private pass = 0;
  private fail = 0;
  private net = 0;
  private f6: string[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    const project = test.parent.project()?.name ?? '';
    const title = `${project} · ${test.titlePath().slice(3).join(' › ')}`;
    for (const a of result.attachments.filter((x) => x.name === 'known-f6' && x.body))
      for (const page of a.body!.toString().split('\n').filter(Boolean)) {
        this.f6.push(`${title} @ ${page}`);
        console.log(`⚠️ 已知 F6 ｜ ${title}：React #418 @ ${page}`);
      }
    if (result.status === 'passed') {
      this.pass++;
      console.log(`✅ 通过 ｜ ${title}`);
    } else if (result.status === 'skipped') {
      const why = test.annotations.map((a) => a.description).filter(Boolean).join('；');
      console.log(`⚠️ 跳过 ｜ ${title}${why ? `：${why}` : ''}`);
    } else {
      const shot = result.attachments.find((a) => a.name === 'screenshot' && a.path)?.path;
      const msg = (result.error?.message ?? result.status).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '').split('\n').find((l) => l.trim()) ?? '';
      // 一条用例可有多个错误（如超时 + 控制台里的 net::ERR_CONNECTION_RESET）：任一为网络类即归「🌐 网络」
      const all = [result.error?.message ?? '', ...(result.errors ?? []).map((e) => e.message ?? '')].join('\n');
      const net = NETWORK.test(msg) || NETWORK.test(all);
      if (net) this.net++;
      else this.fail++;
      console.log(`${net ? '🌐 网络' : '❌ 失败'} ｜ ${title}：${msg.slice(0, 200)}${shot ? `（截图 ${relative(process.cwd(), shot)}）` : ''}`);
    }
  }
  onEnd(result: FullResult): { status?: FullResult['status'] } | void {
    const f6Over = this.f6.length >= F6_LIMIT;
    console.log(
      `—— 浏览器验收：${this.pass} 通过 · ${this.fail} 失败 · ${this.net} 网络中断 · 已知 F6 ${this.f6.length} 次（${f6Over ? 'failed' : result.status}）${this.net ? '；有网络中断，本轮作废重跑' : ''}${f6Over ? `；已知 F6 达 ${F6_LIMIT} 次，判本轮失败` : ''}`,
    );
    if (f6Over) return { status: 'failed' };
  }
}
