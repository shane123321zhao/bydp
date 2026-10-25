import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '../../../i18n/routing';
import { alternates } from '../../../lib/seo';
import { TrustPage } from '../../../components/TrustPage';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: '评分方法 · 规则公开', alternates: alternates(locale as Locale, '/methodology') };
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <TrustPage locale={locale} title="评分方法" sub="规则公开 · 每日重算 · 与商业隔离">
      <p>每个品牌有一个互斥的信任状态（认证 / 观察 / 黑名单），牌照只是标签。评分规则公开、算法版本化、每日 02:00 重算。</p>
      <h2>五个因子与权重（算法 v0.4 · 2026-09-27 定稿）</h2>
      <table>
        <tbody>
          <tr><th>出款表现（到账时长、拒付率）</th><td>30%</td></tr>
          <tr><th>仲裁履约（解决率、响应时长）</th><td>25%</td></tr>
          <tr><th>平台硬指标（支付方式、限额、客服、游戏商）</th><td>20%</td></tr>
          <tr><th>玩家评价（可信权重加权）</th><td>15%</td></tr>
          <tr><th>经营稳定性（运营年限、域名稳定、关联风险）</th><td>10%</td></tr>
        </tbody>
      </table>
      <h2>样本门槛与冷启动</h2>
      <p>出款、仲裁、评价只统计近 180 天。出款须来自 ≥ 20 个不同的绑定用户（每个绑定 30 天内最多计 3 条，防止单账号刷量），超过 72 小时仍未到账按拒付计；仲裁须 ≥ 5 件已结案案件；评价按可信权重累计有效样本 ≥ 30。</p>
      <p>不足门槛的因子不计入，权重按可用因子归一化，并标注置信度（低 / 中 / 高）。出款、仲裁、评价三项履约因子全部不足时显示「暂无评分」，不仅凭平台自报属性给分。</p>
      <h2>隔离</h2>
      <p>评分与排序引擎读不到任何佣金或付费数据（代码级与数据库权限级隔离）。赞助位为独立组件、明确标注，不参与排序。黑名单不计分。</p>
    </TrustPage>
  );
}
