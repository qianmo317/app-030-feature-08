/**
 * 批次维护：新增 / 改名 / 合并 / 删除空批次。
 * 批次是项目级配置（project.batches），每个人的归属快照在 person.batch。
 * 改名与合并只挪动 person.batch，不触碰量体数据与归并结果，因此总人数 / 总套数守恒。
 */
import type { Person, Project } from './types'

/** 未分批的统一展示桶名（与 merge.ts 汇总分批小计时保持一致） */
export const UNBATCHED = '未分批'

export function normalizeBatchName(name: string): string {
  return name.trim()
}

export function isUnbatchedKey(batchKey: string): boolean {
  return batchKey === '' || batchKey === UNBATCHED
}

export function batchKeyOf(person: Person): string {
  const key = person.batch.trim()
  return key === '' ? UNBATCHED : key
}

/**
 * 实际存在的批次：项目里登记过的批次，加上历史数据里出现过、
 * 但后来从登记名单里删掉的「孤儿批次」（导入文件带批次名时也可能出现）。
 * 顺序：登记名单优先，孤儿批次按拼音排序追加。
 */
export function effectiveBatchKeys(project: Project): string[] {
  const keys: string[] = []
  for (const batch of project.batches) {
    const key = normalizeBatchName(batch)
    if (key === '' || key === UNBATCHED || keys.includes(key)) continue
    keys.push(key)
  }
  const orphans = new Set<string>()
  for (const person of project.persons) {
    const key = batchKeyOf(person)
    if (isUnbatchedKey(key) || keys.includes(key)) continue
    orphans.add(key)
  }
  for (const orphan of [...orphans].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    keys.push(orphan)
  }
  return keys
}

/** 登记名单之外、但仍挂着人的批次 */
export function orphanBatchKeys(project: Project): string[] {
  const declared = new Set(project.batches.map(normalizeBatchName).filter((key) => key !== ''))
  const orphans = new Set<string>()
  for (const person of project.persons) {
    const key = batchKeyOf(person)
    if (isUnbatchedKey(key) || declared.has(key)) continue
    orphans.add(key)
  }
  return [...orphans].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** 是否在登记名单里（未分批与孤儿批次都不可直接删除） */
export function isDeclaredBatch(project: Project, batchKey: string): boolean {
  return project.batches.some((batch) => normalizeBatchName(batch) === batchKey)
}

export type BatchStats = {
  key: string
  /** 有效人数（计入有效人数，即套数口径的人数） */
  active: number
  /** 无效行 */
  invalid: number
  /** 重复排除行 */
  duplicate: number
  /** 全部录入行数 */
  total: number
  /** 常规档套数 */
  regularQty: number
  /** 特殊单列套数 */
  specialQty: number
  /** 总套数（常规 + 特殊） */
  suits: number
  /** 有效但还没归出号型的人数（会导致守恒不通过） */
  unmerged: number
}

export function statsForBatch(persons: Person[], key: string): BatchStats {
  const stats: BatchStats = {
    key,
    active: 0,
    invalid: 0,
    duplicate: 0,
    total: 0,
    regularQty: 0,
    specialQty: 0,
    suits: 0,
    unmerged: 0
  }
  for (const person of persons) {
    if (batchKeyOf(person) !== key) continue
    stats.total += 1
    if (person.status === 'invalid') stats.invalid += 1
    else if (person.status === 'duplicate') stats.duplicate += 1
    if (person.status !== 'active') continue
    stats.active += 1
    if (person.specialFlag) stats.specialQty += 1
    else if (person.result) stats.regularQty += 1
    else stats.unmerged += 1
  }
  stats.suits = stats.regularQty + stats.specialQty
  return stats
}

export type BatchChangeResult = { ok: boolean; error?: string; message: string }

function fail(message: string): BatchChangeResult {
  return { ok: false, error: message, message }
}

/** 新增批次：不允许空名、不允许与已存在批次同名（导入数据里挂着人的同名批次自动并入登记名单） */
export function addBatch(project: Project, rawName: string): BatchChangeResult {
  const name = normalizeBatchName(rawName)
  if (name === '') return fail('批次名称不能为空')
  if (name === UNBATCHED) return fail(`「${UNBATCHED}」是未分批的保留名，请换一个批次名称`)
  if (project.batches.some((batch) => normalizeBatchName(batch) === name)) {
    return fail(`批次「${name}」已经存在，不用重复添加`)
  }
  project.batches.push(name)
  const existing = statsForBatch(project.persons, name)
  const message =
    existing.total > 0
      ? `已新增批次「${name}」，并把此前挂在这个名下的 ${existing.total} 条录入一并纳入登记名单`
      : `已新增批次「${name}」，量体录入的批次下拉里现在可以选了`
  return { ok: true, message }
}

/** 改名：登记批次或挂着人的孤儿批次都能改；改完后该批次下所有人的 person.batch 同步挪过去 */
export function renameBatch(project: Project, fromKey: string, rawToName: string): BatchChangeResult {
  const toName = normalizeBatchName(rawToName)
  if (toName === '') return fail('批次名称不能为空')
  if (toName === UNBATCHED) return fail(`「${UNBATCHED}」是未分批的保留名，请换一个批次名称`)
  if (isUnbatchedKey(fromKey)) return fail('未分批是没有登记名称的录入，不能改名；请改用「合并到批次」把人挪到有名批次')
  if (toName === fromKey) return fail('新名称与原名称相同，没有需要改动的内容')
  const declaredIndex = project.batches.findIndex((batch) => normalizeBatchName(batch) === fromKey)
  if (declaredIndex < 0 && !project.persons.some((person) => batchKeyOf(person) === fromKey)) {
    return fail(`批次「${fromKey}」已经不存在`)
  }
  // 目标名已被登记批次或挂着人的孤儿批次占用 → 应走合并流程（合并要先核对两侧人数 / 套数）
  const targetTaken =
    project.batches.some((batch) => normalizeBatchName(batch) === toName) ||
    project.persons.some((person) => batchKeyOf(person) === toName)
  if (targetTaken) {
    return fail(`批次「${toName}」已经存在；若想把「${fromKey}」并过去，请使用「合并批次」`)
  }
  let moved = 0
  for (const person of project.persons) {
    if (batchKeyOf(person) === fromKey) {
      person.batch = toName
      moved += 1
    }
  }
  if (declaredIndex >= 0) project.batches[declaredIndex] = toName
  else project.batches.push(toName)
  return {
    ok: true,
    message: `已把「${fromKey}」改名为「${toName}」，该批次下 ${moved} 人的批次名已同步更新，人数与套数不变`
  }
}

/**
 * 合并批次：把 from 下所有人挪到 to，from 若是登记批次则从登记名单移除。
 * 来源允许是「未分批」保留桶（把没填批次的人归拢到有名批次）；目标必须是有名批次。
 * 人的量体数据与归并结果一律不动，所以合并后总人数 / 总套数保持不变。
 */
export function mergeBatches(project: Project, rawFrom: string, rawTo: string): BatchChangeResult {
  const fromKey = normalizeBatchName(rawFrom)
  const toKey = normalizeBatchName(rawTo)
  if (fromKey === '' || toKey === '') return fail('请先选择要合并的两个批次')
  if (isUnbatchedKey(toKey)) return fail('不能把批次并入「未分批」，合并目标必须是一个有名称的批次')
  if (fromKey === toKey) return fail('合并的两个批次不能相同')
  const fromExists =
    isUnbatchedKey(fromKey) ||
    project.batches.some((batch) => normalizeBatchName(batch) === fromKey) ||
    project.persons.some((person) => batchKeyOf(person) === fromKey)
  if (!fromExists) return fail(`批次「${fromKey}」已经不存在`)
  const toDeclaredIndex = project.batches.findIndex((batch) => normalizeBatchName(batch) === toKey)
  const toHasPeople = project.persons.some((person) => batchKeyOf(person) === toKey)
  if (toDeclaredIndex < 0 && !toHasPeople) {
    return fail(`目标批次「${toKey}」不存在，请先新增该批次`)
  }
  let moved = 0
  for (const person of project.persons) {
    if (batchKeyOf(person) === fromKey) {
      person.batch = toKey
      moved += 1
    }
  }
  project.batches = project.batches.filter((batch) => normalizeBatchName(batch) !== fromKey)
  if (toDeclaredIndex < 0) project.batches.push(toKey)
  const fromLabel = isUnbatchedKey(fromKey) ? UNBATCHED : fromKey
  return {
    ok: true,
    message: `已把「${fromLabel}」合并进「${toKey}」：${moved} 人的批次归属已挪到「${toKey}」；总人数与总套数不变`
  }
}

/** 删除批次：只允许删除一个人都没有（含无效 / 重复行）的登记批次 */
export function deleteBatch(project: Project, rawBatch: string): BatchChangeResult {
  const key = normalizeBatchName(rawBatch)
  const declaredIndex = project.batches.findIndex((batch) => normalizeBatchName(batch) === key)
  if (declaredIndex < 0) {
    if (isUnbatchedKey(key)) return fail('未分批不是登记批次，不能删除')
    return fail(`批次「${key}」不在登记名单里，没有可删除的登记项；它若已空，无需任何操作`)
  }
  const stats = statsForBatch(project.persons, key)
  if (stats.total > 0) {
    return fail(
      `批次「${key}」下还有 ${stats.total} 条录入（有效 ${stats.active}、无效 ${stats.invalid}、重复 ${stats.duplicate}），不能删除；请先把它合并到其他批次`
    )
  }
  project.batches.splice(declaredIndex, 1)
  return { ok: true, message: `已删除空批次「${key}」（该批次下没有任何人，人数与套数不受影响）` }
}
