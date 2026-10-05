/* 批次维护端到端不变量验证（node 直跑，esbuild 临时打包）：
 * 1. 新增  2. 改名  3. 两边都有人时合并  4. 非空批次拒绝删除 / 空批次可删
 * 5. 全程总人数 / 总套数守恒  6. 汇总分批小计与导出明细批次名同步  7. 孤儿批次补登 / 未分批归拢 */
import {
  addBatch,
  deleteBatch,
  effectiveBatchKeys,
  mergeBatches,
  renameBatch,
  statsForBatch,
  UNBATCHED
} from '../src/logic/batches'
import { runMerge, buildSummary } from '../src/logic/merge'
import { detailRows } from '../src/logic/exporter'
import { BUILTIN_RULES } from '../src/logic/sizeRules'
import type { Person, Project, SizeRule } from '../src/logic/types'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

const rule: SizeRule = BUILTIN_RULES[0]

function makePerson(partial: Partial<Person> & { name: string }): Person {
  return {
    id: `p_${Math.random().toString(36).slice(2)}`,
    name: partial.name,
    gender: partial.gender ?? 'male',
    orgUnit: partial.orgUnit ?? '一班',
    batch: partial.batch ?? '',
    heightCm: partial.heightCm ?? 170,
    weightKg: partial.weightKg ?? 60,
    chestCm: partial.chestCm ?? 88,
    waistCm: partial.waistCm ?? 74,
    specialFlag: partial.specialFlag ?? null,
    note: '',
    status: partial.status ?? 'active',
    statusReason: '',
    anomaly: [],
    needsConfirm: false,
    possibleDuplicateOf: null,
    sourceRow: null,
    source: 'manual',
    result: null,
    createdAt: 0
  }
}

function makeProject(): Project {
  return {
    id: 'prj_test',
    name: '测试项目',
    kind: 'school',
    ruleVersion: rule.version,
    // 建项目时写重了：春装 出现两次（模拟登记名单里的重复），另有一个空批次「秋装」
    batches: ['春装', '秋装'],
    persons: [],
    imports: [],
    createdAt: 0,
    updatedAt: 0
  }
}

const project = makeProject()
// 春装 6 人（含 1 无效），秋装 0 人，冬装（孤儿，导入带来的）2 人，未分批 2 人（含 1 特殊）
const people = [
  makePerson({ name: 'A1', batch: '春装' }),
  makePerson({ name: 'A2', batch: '春装' }),
  makePerson({ name: 'A3', batch: '春装' }),
  makePerson({ name: 'A4', batch: '春装' }),
  makePerson({ name: 'A5', batch: '春装' }),
  makePerson({ name: 'A6', batch: '春装', status: 'invalid', heightCm: 0, chestCm: 0, waistCm: 0 }),
  makePerson({ name: 'B1', batch: '冬装' }),
  makePerson({ name: 'B2', batch: '冬装' }),
  makePerson({ name: 'C1', batch: '', specialFlag: rule.specialFlags[0]?.code ?? null }),
  makePerson({ name: 'C2', batch: '' })
]
project.persons = people
runMerge(project, rule)

let summary = buildSummary(project, rule)
const baselineTotal = summary.totals.totalRows
const baselineValid = summary.totals.validRows
const baselineSuits = summary.totals.accountedQty
console.log(`基线：总录入 ${baselineTotal}，有效 ${baselineValid}，总套数 ${baselineSuits}`)
assert(baselineTotal === 10, '基线总录入 10')
assert(baselineValid === 9, '基线有效 9（含 1 无效）')
assert(baselineSuits === 9, '基线总套数 9（1 常规×8 + 特殊×1）')

/* ---------------- 1. 新增批次 ---------------- */
console.log('\n[1] 新增批次')
assert(!addBatch(project, '春装').ok, '重名批次被拒绝')
assert(!addBatch(project, '   ').ok, '空白批次名被拒绝')
assert(!addBatch(project, UNBATCHED).ok, '保留名「未分批」被拒绝')
assert(addBatch(project, ' 冬装 ').ok, '「冬装」新增（同时把孤儿批次补登）')
assert(effectiveBatchKeys(project).join('|') === '春装|秋装|冬装', `有效批次顺序正确：${effectiveBatchKeys(project).join(' / ')}`)

/* ---------------- 2. 改名 ---------------- */
console.log('\n[2] 改名：春装 → 春季')
assert(!renameBatch(project, '不存在', 'X').ok, '不存在的批次改名被拒绝')
assert(!renameBatch(project, '春季', '春装').ok, '改成已存在的名字被拒绝（应走合并）')
assert(renameBatch(project, '春装', '春季').ok, '春装改名为春季成功')
assert(project.batches.includes('春季') && !project.batches.includes('春装'), '登记名单已更新')
assert(project.persons.filter((p) => p.batch === '春季').length === 6, '原春装 6 人（含无效）已全部挪到春季')
assert(!project.persons.some((p) => p.batch === '春装'), '没有人留在旧批次名')

/* ---------------- 3. 删除规则 ---------------- */
console.log('\n[3] 删除：非空拒绝、空批次可删')
assert(!deleteBatch(project, '春季').ok, '有人的「春季」拒绝删除')
assert(!deleteBatch(project, UNBATCHED).ok, '未分批保留桶拒绝删除')
assert(deleteBatch(project, '秋装').ok, '空批次「秋装」删除成功')
assert(!project.batches.includes('秋装'), '秋装已从登记名单移除')
assert(statsForBatch(project.persons, '春季').invalid === 1, '春季下无效行仍计 1')

/* ---------------- 4. 合并（两边都有人） ---------------- */
console.log('\n[4] 合并：冬装 → 春季（两边都有人，先摆人数/套数）')
const src = statsForBatch(project.persons, '冬装')
const dst = statsForBatch(project.persons, '春季')
assert(src.active === 2 && src.suits === 2, `合并前冬装：2 人 / 2 套（实得 ${src.active}/${src.suits}）`)
assert(dst.active === 5 && dst.suits === 5, `合并前春季：5 人 / 5 套（实得 ${dst.active}/${dst.suits}，无效行不计套）`)
assert(!mergeBatches(project, '春季', '春季').ok, '相同批次合并被拒绝')
assert(mergeBatches(project, '冬装', '春季').ok, '冬装合并进春季成功')
assert(!project.batches.includes('冬装'), '冬装已从登记名单移除')
assert(!project.persons.some((p) => p.batch === '冬装'), '没有人留在冬装')
const merged = statsForBatch(project.persons, '春季')
assert(merged.total === 8, `合并后春季共 8 条录入（实得 ${merged.total}）`)
assert(merged.active === 7 && merged.suits === 7, `合并后春季 7 人 / 7 套（实得 ${merged.active}/${merged.suits}）`)
assert(merged.invalid === 1, '合并后春季仍带 1 条无效行')

/* ---------------- 5. 未分批归拢 ---------------- */
console.log('\n[5] 未分批 → 春季（来源是保留桶）')
const unbatchedBefore = statsForBatch(project.persons, UNBATCHED)
assert(unbatchedBefore.total === 2, `未分批桶现有 2 人（实得 ${unbatchedBefore.total}）`)
assert(!mergeBatches(project, '春季', UNBATCHED).ok, '目标不允许是未分批')
assert(mergeBatches(project, UNBATCHED, '春季').ok, '未分批并入春季成功')
assert(statsForBatch(project.persons, UNBATCHED).total === 0, '未分批桶已清空')
assert(statsForBatch(project.persons, '春季').total === 10, '春季最终 10 条录入（全部）')

/* ---------------- 6. 全程守恒 ---------------- */
console.log('\n[6] 守恒校验')
runMerge(project, rule)
summary = buildSummary(project, rule)
assert(summary.totals.totalRows === baselineTotal, `总录入不变：${summary.totals.totalRows} == ${baselineTotal}`)
assert(summary.totals.validRows === baselineValid, `有效人数不变：${summary.totals.validRows} == ${baselineValid}`)
assert(summary.totals.accountedQty === baselineSuits, `总套数不变：${summary.totals.accountedQty} == ${baselineSuits}`)

/* ---------------- 7. 分批小计 & 导出同步 ---------------- */
console.log('\n[7] 汇总分批小计与导出批次名同步')
assert(summary.byBatch.length === 1, `分批小计只剩 1 个批次桶：${summary.byBatch.map((g) => g.batch).join('、')}`)
assert(summary.byBatch[0]?.batch === '春季', '唯一批次桶名为「春季」（用的是改动后的名字）')
assert(summary.byBatch[0]?.validCount === 9, '分批小计有效人数 9（春季 7 + 未分批 2）')
const detail = detailRows({ project, rule })
const header = detail[0]
const batchCol = header.indexOf('批次')
const dataBatches = new Set(detail.slice(1).map((row) => String(row[batchCol])))
assert(dataBatches.size === 1 && dataBatches.has('春季'), `导出明细批次列全部显示「春季」（实得：${[...dataBatches].join('、')}）`)
assert(!dataBatches.has('春装') && !dataBatches.has('冬装'), '导出里不再出现旧批次名')

/* ---------------- 8. 空批次删除后又能重新加 ---------------- */
console.log('\n[8) 反复维护')
assert(addBatch(project, '夏装').ok, '再加一个夏装')
assert(deleteBatch(project, '夏装').ok, '空夏装立即删除')
assert(effectiveBatchKeys(project).join('|') === '春季', `最终有效批次只剩春季：${effectiveBatchKeys(project).join('、')}`)

if (failures > 0) {
  console.error(`\n${failures} 条断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过 ✅')
