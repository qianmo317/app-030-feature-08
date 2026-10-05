/**
 * 批次维护：新增 / 改名 / 合并 / 删除（规格书 §5「多批次」配套）。
 *
 * 不变量：
 * - 批次调整只改 person.batch 归属与 project.batches 清单，不删人、不改号型；
 *   因此调整前后总人数、有效人数、总套数天然守恒。
 * - 删除只允许「一个人都没有」的批次（含无效 / 重复行也算有人）。
 * - 合并时把源批次下所有人挪到目标批次，再把源批次从清单移除。
 * - 导入 / 旧数据里可能出现不在 project.batches 清单中的批次（「清单外批次」），
 *   同样统计、可改名 / 合并，但有人时不允许直接删除。
 */
import type { Person, Project } from './types'

/** 未填批次时各页面统一展示的兜底名（与 merge.buildSummary 保持一致） */
export const UNBATCHED = '未分批'

export function displayBatchName(raw: string): string {
  return raw.trim() === '' ? UNBATCHED : raw
}

export function normalizeBatchName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('批次名称不能为空')
  return trimmed
}

export type BatchStats = {
  name: string
  /** 是否登记在项目批次清单中（false = 数据里有、清单里没有的历史批次） */
  listed: boolean
  /** 人数：全部录入行（含无效 / 重复行） */
  peopleCount: number
  /** 有效人数（active） */
  validCount: number
  /** 常规档套数：有效、非特殊、已归出号型 */
  regularQty: number
  /** 特殊单列套数：有效且带特殊体型标记 */
  specialQty: number
  /** 套数小计 = 常规档 + 特殊单列 */
  suits: number
}

function personSuits(person: Person): { regular: number; special: number } {
  if (person.status !== 'active') return { regular: 0, special: 0 }
  if (person.specialFlag) return { regular: 0, special: 1 }
  if (person.result) return { regular: 1, special: 0 }
  return { regular: 0, special: 0 }
}

/** 全部批次（清单批次在前，按清单顺序；清单外批次按名称排序补在后面）的人数 / 套数统计 */
export function batchStats(project: Project): BatchStats[] {
  const map = new Map<string, BatchStats>()
  const ensure = (name: string, listed: boolean): BatchStats => {
    let stats = map.get(name)
    if (!stats) {
      stats = { name, listed, peopleCount: 0, validCount: 0, regularQty: 0, specialQty: 0, suits: 0 }
      map.set(name, stats)
    }
    return stats
  }

  for (const name of project.batches) ensure(name, true)
  for (const person of project.persons) {
    const name = displayBatchName(person.batch)
    const stats = ensure(name, project.batches.includes(name))
    stats.listed = stats.listed || project.batches.includes(name)
    stats.peopleCount += 1
    if (person.status === 'active') stats.validCount += 1
    const { regular, special } = personSuits(person)
    stats.regularQty += regular
    stats.specialQty += special
    stats.suits += regular + special
  }

  const orderIndex = new Map(project.batches.map((name, index) => [name, index]))
  return [...map.values()].sort((a, b) => {
    const ia = orderIndex.has(a.name) ? orderIndex.get(a.name)! : Number.MAX_SAFE_INTEGER
    const ib = orderIndex.has(b.name) ? orderIndex.get(b.name)! : Number.MAX_SAFE_INTEGER
    if (ia !== ib) return ia - ib
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

export function effectiveBatchNames(project: Project): string[] {
  return batchStats(project).map((stats) => stats.name)
}

/** 新增批次：名称不能为空、不能与既有批次重名（清单批次与清单外批次都算） */
export function addBatch(project: Project, name: string): string {
  const normalized = normalizeBatchName(name)
  const existing = new Set(effectiveBatchNames(project))
  if (existing.has(normalized)) throw new Error(`批次「${normalized}」已经存在，请换一个名称`)
  project.batches.push(normalized)
  return normalized
}

/**
 * 改名：替换清单中的批次名，并把该批次下所有人挪到新名字。
 * 目标名被其他批次占用时拒绝。
 */
export function renameBatch(project: Project, oldName: string, newName: string): void {
  const target = normalizeBatchName(newName)
  if (oldName === target) return
  const stats = batchStats(project)
  if (!stats.some((item) => item.name === oldName)) throw new Error(`批次「${oldName}」不存在`)
  if (stats.some((item) => item.name === target)) {
    throw new Error(`已经有名为「${target}」的批次，不能改成重名；如要并到一起请使用「合并」`)
  }
  const listIndex = project.batches.indexOf(oldName)
  if (listIndex >= 0) project.batches[listIndex] = target
  else project.batches.push(target) // 清单外批次（如导入带来的）改名后登记进清单
  for (const person of project.persons) {
    if (displayBatchName(person.batch) === oldName) person.batch = target
  }
}

/**
 * 合并：把 source 批次下所有人挪到 target，再从清单删除 source。
 * 两边都有人也允许，但调用方必须先把双方人数 / 套数摆给用户确认。
 */
export function mergeBatches(project: Project, sourceName: string, targetName: string): number {
  if (sourceName === targetName) throw new Error('请选择两个不同的批次进行合并')
  const names = new Set(effectiveBatchNames(project))
  if (!names.has(sourceName)) throw new Error(`批次「${sourceName}」不存在`)
  if (!names.has(targetName)) throw new Error(`批次「${targetName}」不存在`)
  let moved = 0
  for (const person of project.persons) {
    if (displayBatchName(person.batch) === sourceName) {
      person.batch = targetName
      moved += 1
    }
  }
  project.batches = project.batches.filter((name) => name !== sourceName)
  if (!project.batches.includes(targetName)) project.batches.push(targetName)
  return moved
}

/** 删除：只允许一个人都没有的批次（无效 / 重复行也占人，一并拦截） */
export function deleteBatch(project: Project, name: string): void {
  const stats = batchStats(project).find((item) => item.name === name)
  if (!stats) throw new Error(`批次「${name}」不存在`)
  if (stats.peopleCount > 0) {
    throw new Error(`批次「${name}」下还有 ${stats.peopleCount} 人，不能删除；如要并到其他批次请使用「合并」`)
  }
  project.batches = project.batches.filter((item) => item !== name)
}
