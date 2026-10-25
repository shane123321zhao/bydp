/**
 * D-027 品牌导入 Excel：模板生成与解析共用（列定义来自 @bydp/core/admin/brand-import 的 BRAND_IMPORT_SHEETS，两边不会走样）。
 * 每张表：第 1 行表头（中文）· 第 2 行说明（必填列带 *）· 第 3 行示例（灰色斜体，导入时跳过）· 第 4 行起为数据。全部单元格按文本格式，避免 Excel 自动改写日期 / 数字。
 */
import ExcelJS from 'exceljs';
import { BRAND_IMPORT_SHEETS, type ImportInput, type ImportRow } from '@bydp/core/admin/brand-import';

export const FIRST_DATA_ROW = 4;
const GUIDE = '填写说明';

export function buildWorkbook(data?: Partial<Record<keyof ImportInput, Record<string, string>[]>>) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BYDP';
  const guide = wb.addWorksheet(GUIDE);
  guide.columns = [{ width: 16 }, { width: 100 }];
  const lines: [string, string][] = [
    ['用途', 'BYDP 首批品牌资料导入模板（D-027）。按表逐行填写，保存后交给开发会话校验；校验通过才会写入。'],
    ['怎么填', '每张表第 1 行是表头，第 2 行是说明（带 * 的列必填），第 3 行是示例（导入时自动跳过），从第 4 行开始填。不要改表头、不要删表。'],
    ['先后顺序', '运营商 → 品牌 → 标识 → 牌照 → 属性 → 优惠。品牌引用运营商的「主体名称」，其余各表引用品牌的「slug」。'],
    ['重复导入', '同一文件可以改了再导：已存在的运营商 / 品牌 / 标识 / 牌照 / 属性会被更新，不会重复新增；导入不删除系统里已有、表里没写的内容。'],
    ['状态', '新品牌只能是「观察」或「黑名单」；「认证」须走认证流程。已存在品牌的状态不随导入改变，请在后台「品牌状态」操作。'],
    ['公开范围', '品牌名、目标市场、标识、牌照、属性、黑名单理由会在网站上公开；黑名单证据链接与备注只内部留档。'],
    ['优惠', '「真实价值」由系统按公开口径自动计算（参数表 tv-1），不用填；类型暂只支持首存匹配 / 再存匹配 / 免死金 / 周返水。黑名单品牌不能有优惠。'],
    ['暂不包含', '品牌 Logo 首批不收，前端继续显示首字字标。'],
  ];
  for (const [a, b] of lines) {
    const r = guide.addRow([a, b]);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }
  for (const def of BRAND_IMPORT_SHEETS) {
    const ws = wb.addWorksheet(def.name);
    ws.columns = def.columns.map((c) => ({ key: c.key, width: Math.max(14, Math.min(40, c.header.length * 3 + 8)), style: { numFmt: '@' } }));
    const head = ws.addRow(def.columns.map((c) => c.header));
    head.font = { bold: true };
    const note = ws.addRow(def.columns.map((c) => `${c.required ? '* 必填。' : ''}${c.note}`));
    note.alignment = { wrapText: true, vertical: 'top' };
    note.font = { size: 9 };
    note.height = 48;
    const ex = ws.addRow(def.columns.map((c) => c.example));
    ex.font = { italic: true, color: { argb: 'FF888888' } };
    ws.views = [{ state: 'frozen', ySplit: 3 }];
    for (const rec of data?.[def.key] ?? []) ws.addRow(def.columns.map((c) => rec[c.key] ?? ''));
    // 品牌表黑名单两列给出提示（该表 intro 也写在 A1 批注里）
    ws.getCell('A1').note = def.intro;
  }
  return wb;
}

/** 单元格 → 文本：日期取 YYYY-MM-DD；超链接取链接；公式取结果；富文本拼接 */
function cellText(c: ExcelJS.Cell): string {
  const v = c.value as unknown;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { hyperlink?: string; text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (o.hyperlink) return String(o.hyperlink);
    if (o.richText) return o.richText.map((t) => t.text).join('');
    if (o.result != null) return o.result instanceof Date ? o.result.toISOString().slice(0, 10) : String(o.result);
    if (o.text != null) return String(o.text);
    return '';
  }
  return String(v);
}

/** 解析：表名 / 表头按模板匹配；缺表视为空；缺必填表头报错；整行为空跳过 */
export async function readWorkbook(buf: Buffer): Promise<{ input: ImportInput; problems: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const problems: string[] = [];
  const input = Object.fromEntries(BRAND_IMPORT_SHEETS.map((d) => [d.key, [] as ImportRow[]])) as ImportInput;
  for (const def of BRAND_IMPORT_SHEETS) {
    const ws = wb.getWorksheet(def.name);
    if (!ws) continue;
    const headers = new Map<string, number>();
    ws.getRow(1).eachCell((c, col) => headers.set(cellText(c).trim(), col));
    const missing = def.columns.filter((c) => c.required && !headers.has(c.header));
    if (missing.length) {
      problems.push(`「${def.name}」缺少表头：${missing.map((c) => c.header).join('、')}（请勿修改模板表头）`);
      continue;
    }
    for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const v: Record<string, string> = {};
      for (const c of def.columns) {
        const col = headers.get(c.header);
        const t = col ? cellText(row.getCell(col)).trim() : '';
        if (t) v[c.key] = t;
      }
      if (Object.keys(v).length) input[def.key].push({ row: r, v });
    }
  }
  return { input, problems };
}
