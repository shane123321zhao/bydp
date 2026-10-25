import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '../../../i18n/routing';
import { alternates } from '../../../lib/seo';
import { TrustPage } from '../../../components/TrustPage';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: '认证标准 · 不收费不可购买', alternates: alternates(locale as Locale, '/certification') };
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <TrustPage locale={locale} title="认证标准" sub="门槛公开 · 保证金账目分离">
      <p>认证不收费、不可购买。门槛为评分阈值 + 仲裁履约阈值 + 实测 + 保证金；细则于 P2 前公布。</p>
      <h2>先行赔付保障</h2>
      <p>认证商家违约或跑路时，BYDP 先行赔付用户；资金主来源为运营商保证金，链上储备公示。对外称「先行赔付保障」。</p>
      <h2>保证金账目分离</h2>
      <p>保证金分「用户赔付准备金」与「超额部分」两个账目。用户赔付绝对优先；佣金担保只可动用超额部分；运营商同时欠佣欠赔时先赔用户。</p>
      <h2>赔付资格</h2>
      <p>须为认证品牌，且在纠纷发生前已完成绑定（核验等级为回传确认或运营商确认）。</p>
    </TrustPage>
  );
}
