/**
 * D-027：生成品牌导入模板与 15 家模拟品牌（`pnpm db:brand-template`）。输出（可重复生成，内容确定）：
 * - docs/ops/brand-import-template.xlsx：空模板（PO #27 填写首批真实品牌）
 * - docs/ops/brand-import-mock.xlsx：15 家虚构品牌（名称带「示例」、域名 .invalid），只用于测试站验证导入链路与 UAT 数据
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildWorkbook } from './brand-xlsx';

const OUT = resolve(import.meta.dirname, '../../../../docs/ops');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** 确定性的「看起来像」TRC20 地址（虚构，仅满足格式） */
const trc20 = (seed: string) => 'T' + [...createHash('sha512').update(seed).digest()].slice(0, 33).map((b) => B58[b % 58]).join('');

const OPS = [
  ['示例星河娱乐集团有限公司', 'PH', '2016', '否'],
  ['示例蓝湾互动有限公司', 'CW', '2019', '否'],
  ['示例金冠科技有限公司', 'MT', '2014', '否'],
  ['示例东岸游戏有限公司', 'PH', '2021', '否'],
  ['示例南洋网络有限公司', 'CW', '2020', '否'],
  ['示例北辰数字有限公司', 'PH', '2017', '否'],
  ['示例海风控股有限公司', 'CW', '2022', '否'],
  ['示例合作方有限公司', 'PH', '2023', '是'],
] as const;

// [slug, 简体, 繁体, 英文, 运营商序号, 市场, 状态]
const BRANDS = [
  ['shili-xinghe', '示例星河娱乐', '示例星河娛樂', 'Sample Galaxy', 0, 'MY、SG', '观察'],
  ['shili-xingyue', '示例星月娱乐', '示例星月娛樂', 'Sample Starmoon', 0, 'MY', '观察'],
  ['shili-lanwan', '示例蓝湾国际', '示例藍灣國際', 'Sample Blue Bay', 1, 'SG、PH', '观察'],
  ['shili-jinguan', '示例金冠体育', '示例金冠體育', 'Sample Crown Sports', 2, 'MY、TH', '观察'],
  ['shili-jinguan-live', '示例金冠真人', '示例金冠真人', 'Sample Crown Live', 2, 'MY', '观察'],
  ['shili-dongan', '示例东岸电子', '示例東岸電子', 'Sample East Shore', 3, 'PH', '观察'],
  ['shili-nanyang', '示例南洋娱乐', '示例南洋娛樂', 'Sample Nanyang', 4, 'MY、SG', '观察'],
  ['shili-beichen', '示例北辰棋牌', '示例北辰棋牌', 'Sample Polaris', 5, 'TH', '观察'],
  ['shili-haifeng', '示例海风娱乐', '示例海風娛樂', 'Sample Sea Breeze', 6, 'VN', '观察'],
  ['shili-hezuo', '示例合作娱乐', '示例合作娛樂', 'Sample Partner', 7, 'MY', '观察'],
  ['shili-yunding', '示例云顶体育', '示例雲頂體育', 'Sample Summit', 4, 'SG', '观察'],
  ['shili-heiyu', '示例黑羽娱乐', '示例黑羽娛樂', 'Sample Raven', 5, 'MY', '黑名单'],
  ['shili-yeying', '示例夜鹰国际', '示例夜鷹國際', 'Sample Nighthawk', 6, 'PH', '黑名单'],
  ['shili-jinsha', '示例金沙电子', '示例金沙電子', 'Sample Gold Sand', 3, 'TH、VN', '黑名单'],
  ['shili-hongyun', '示例鸿运棋牌', '示例鴻運棋牌', 'Sample Fortune', 7, 'MY', '黑名单'],
] as const;

const REASONS: Record<string, string> = {
  'shili-heiyu': '示例数据：多份已核验出款凭证显示提款申请超过 30 天未处理，经两次通知未答辩',
  'shili-yeying': '示例数据：仲裁结案认定无故冻结账户并拒付，运营商未履行裁决',
  'shili-jinsha': '示例数据：官网与牌照信息不符，所列牌照编号在监管名录中查无此号',
  'shili-hongyun': '示例数据：关联多起拒付案件，收款地址与已列黑名单品牌共用',
};

const operators = OPS.map(([legalName, jurisdiction, foundedYear, relatedParty]) => ({ legalName, jurisdiction, foundedYear, relatedParty }));
const brands = BRANDS.map(([slug, zhHans, zhHant, en, op, markets, status]) => ({
  slug,
  zhHans,
  zhHant,
  en,
  operator: OPS[op][0],
  markets,
  status,
  ...(status === '黑名单' ? { reason: REASONS[slug]!, evidence: `https://evidence.example.invalid/${slug}/1\nhttps://evidence.example.invalid/${slug}/2` } : {}),
}));

const identifiers: Record<string, string>[] = [];
BRANDS.forEach(([slug], i) => {
  identifiers.push({ brand: slug, kind: '官方主域', value: `${slug}.invalid`, ownership: '官方' });
  if (i % 2 === 0) identifiers.push({ brand: slug, kind: '镜像域名', value: `m.${slug}.invalid`, ownership: '官方' });
  if (i % 3 === 0) identifiers.push({ brand: slug, kind: 'TG', value: `@${slug.replaceAll('-', '_')}_cs`, ownership: '官方' });
  if (i % 4 === 0) identifiers.push({ brand: slug, kind: '收款地址', value: trc20(slug), ownership: '官方', chain: 'TRC20' });
  if (i % 5 === 1) identifiers.push({ brand: slug, kind: '其他域名', value: `${slug}-vip.invalid`, ownership: '仿冒', note: '示例：仿冒官网' });
  if (i === 6) identifiers.push({ brand: slug, kind: 'App', value: 'com.shili.nanyang', ownership: '官方' });
});

const licenses: Record<string, string>[] = [];
BRANDS.forEach(([slug, , , , , , status], i) => {
  if (i % 2 !== 0) return;
  const valid = status === '观察' && i % 4 === 0;
  licenses.push({
    brand: slug,
    regulator: i % 3 === 0 ? 'PAGCOR' : 'Curacao GCB',
    licenseNo: `SAMPLE-${String(2020 + (i % 5))}-${String(100 + i)}`,
    result: valid ? '有效' : '未核验',
    ...(valid ? { verifiedAt: '2026-10-01', verifiedAgainst: `https://registry.example.invalid/licence/${slug}` } : {}),
  });
});

const PAY = ['USDT-TRC20', 'USDT-ERC20', 'DuitNow', "Touch 'n Go", 'GrabPay', 'PromptPay'];
const GAMES = ['Evolution', 'PG Soft', 'Pragmatic Play', 'SA Gaming', 'Jili'];
const attributes = BRANDS.map(([slug], i) => ({
  brand: slug,
  payment: [PAY[i % 6], PAY[(i + 2) % 6]].join('、'),
  gameProvider: [GAMES[i % 5], GAMES[(i + 1) % 5]].join('、'),
  language: i % 2 ? '简体中文、English' : '简体中文',
  withdrawalLimit: `单笔 ${(5 + (i % 4) * 5) * 1000} USDT`,
  support: i % 3 ? '在线客服' : '在线客服、Telegram',
}));

// D-029：模拟优惠（只给观察库品牌；黑名单品牌不能有优惠）。四类各有，含贡献率 < 100 与多玩法
const offers: Record<string, string>[] = [
  { brand: 'shili-xinghe', title: '示例首存 100% 奖励，最高 300 USDT', kind: '首存匹配', matchPercent: '100', maxBonus: '300', minDeposit: '30', rolloverMultiple: '15', rolloverBase: '存款+奖励', maxWithdrawal: '3000', validDays: '30', eligibleGames: '老虎机、捕鱼', restrictedGames: '真人百家乐、体育', validUntil: '2026-12-31', exclusive: '是', termsText: '示例数据：奖励须在 30 天内完成 15 倍（存款+奖励）流水，仅老虎机与捕鱼计入。' },
  { brand: 'shili-xinghe', title: '示例周返水 0.6%（真人）', kind: '周返水', rebatePercent: '0.6', rolloverMultiple: '0', rolloverBase: '无', validDays: '7', eligibleGames: '真人百家乐' },
  { brand: 'shili-lanwan', title: '示例再存 50% 奖励，最高 200 USDT', kind: '再存匹配', matchPercent: '50', maxBonus: '200', minDeposit: '50', rolloverMultiple: '10', rolloverBase: '奖励', contributionPercent: '50', validDays: '14', eligibleGames: '真人百家乐、老虎机' },
  { brand: 'shili-jinguan', title: '示例体育首单免死 100 USDT', kind: '免死金', maxBonus: '100', minDeposit: '20', rolloverMultiple: '5', rolloverBase: '奖励', maxWithdrawal: '500', validDays: '7', eligibleGames: '体育' },
  { brand: 'shili-jinguan-live', title: '示例真人周返水 1%', kind: '周返水', rebatePercent: '1', rolloverMultiple: '1', rolloverBase: '奖励', validDays: '7', eligibleGames: '真人百家乐' },
  { brand: 'shili-nanyang', title: '示例首存 200% 奖励，最高 100 USDT', kind: '首存匹配', matchPercent: '200', maxBonus: '100', minDeposit: '20', rolloverMultiple: '30', rolloverBase: '存款+奖励', validDays: '30', eligibleGames: '老虎机' },
  { brand: 'shili-yunding', title: '示例体育再存 30%，最高 150 USDT', kind: '再存匹配', matchPercent: '30', maxBonus: '150', minDeposit: '50', rolloverMultiple: '8', rolloverBase: '存款+奖励', contributionPercent: '50', validDays: '14', eligibleGames: '体育' },
  { brand: 'shili-dongan', title: '示例捕鱼首存 100%，最高 80 USDT', kind: '首存匹配', matchPercent: '100', maxBonus: '80', minDeposit: '10', rolloverMultiple: '5', rolloverBase: '奖励', validDays: '14', eligibleGames: '捕鱼' },
];

await buildWorkbook().xlsx.writeFile(`${OUT}/brand-import-template.xlsx`);
await buildWorkbook({ operators, brands, identifiers, licenses, attributes, offers }).xlsx.writeFile(`${OUT}/brand-import-mock.xlsx`);
console.log(`✅ 已生成 docs/ops/brand-import-template.xlsx 与 brand-import-mock.xlsx（${brands.length} 家模拟品牌 · ${identifiers.length} 条标识 · ${licenses.length} 张牌照 · ${offers.length} 条优惠）`);
