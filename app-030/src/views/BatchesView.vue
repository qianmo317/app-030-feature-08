<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, persistProject, store } from '../logic/store'
import { buildSummary } from '../logic/merge'
import {
  UNBATCHED,
  addBatch,
  batchKeyOf,
  deleteBatch,
  effectiveBatchKeys,
  isDeclaredBatch,
  mergeBatches,
  orphanBatchKeys,
  renameBatch,
  statsForBatch,
  type BatchStats
} from '../logic/batches'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

const summary = computed(() => (project.value ? buildSummary(project.value, rule.value) : null))

const message = ref('')
const errorText = ref('')

type BatchRow = {
  key: string
  stats: BatchStats
  declared: boolean
  orphan: boolean
  unbatched: boolean
}

const rows = computed<BatchRow[]>(() => {
  const current = project.value
  if (!current) return []
  const list: BatchRow[] = []
  for (const key of effectiveBatchKeys(current)) {
    list.push({
      key,
      stats: statsForBatch(current.persons, key),
      declared: isDeclaredBatch(current, key),
      orphan: orphanBatchKeys(current).includes(key),
      unbatched: false
    })
  }
  list.push({
    key: UNBATCHED,
    stats: statsForBatch(current.persons, UNBATCHED),
    declared: false,
    orphan: false,
    unbatched: true
  })
  return list.filter((row) => row.stats.total > 0 || row.declared)
})

/* ------------------------------- 新增批次 ------------------------------- */

const newName = ref('')

async function submitAdd(): Promise<void> {
  const current = project.value
  if (!current) return
  const result = addBatch(current, newName.value)
  if (!result.ok) {
    errorText.value = result.message
    return
  }
  newName.value = ''
  errorText.value = ''
  message.value = result.message
  persistProject(current, true)
  await flushProject(current)
}

/* ------------------------------- 改名 ------------------------------- */

const renaming = ref<{ key: string; value: string } | null>(null)

function startRename(row: BatchRow): void {
  renaming.value = { key: row.key, value: row.key }
  errorText.value = ''
}

function cancelRename(): void {
  renaming.value = null
}

async function submitRename(): Promise<void> {
  const current = project.value
  if (!current || !renaming.value) return
  const fromKey = renaming.value.key
  const result = renameBatch(current, fromKey, renaming.value.value)
  if (!result.ok) {
    errorText.value = result.message
    return
  }
  errorText.value = ''
  message.value = result.message
  cancelRename()
  if (mergeForm.source === fromKey) mergeForm.source = ''
  if (mergeForm.target === fromKey) mergeForm.target = ''
  persistProject(current, true)
  await flushProject(current)
}

/* ------------------------------- 删除 ------------------------------- */

async function remove(row: BatchRow): Promise<void> {
  const current = project.value
  if (!current) return
  if (
    !window.confirm(
      `确认删除空批次「${row.key}」？\n该批次下没有任何录入（含无效 / 重复行），删除不影响人数与套数。`
    )
  ) {
    return
  }
  const result = deleteBatch(current, row.key)
  if (!result.ok) {
    errorText.value = result.message
    return
  }
  errorText.value = ''
  message.value = result.message
  persistProject(current, true)
  await flushProject(current)
}

/* ------------------------------- 合并 ------------------------------- */

const mergeForm = reactive({ source: '', target: '' })
const bothHavePeopleAck = ref(false)

/** 被合并方允许选「未分批」（把没填批次的人归拢到有名批次）；目标只能是有名批次 */
const mergeOptions = computed(() =>
  rows.value.filter((row) => !row.unbatched || row.stats.total > 0)
)
const mergeTargetOptions = computed(() => rows.value.filter((row) => !row.unbatched))
const mergeSourceRow = computed(() => rows.value.find((row) => row.key === mergeForm.source) ?? null)
const mergeTargetRow = computed(() => rows.value.find((row) => row.key === mergeForm.target) ?? null)

const canPreviewMerge = computed(
  () => mergeForm.source !== '' && mergeForm.target !== '' && mergeForm.source !== mergeForm.target
)

/** 两边都有人（有效 / 无效 / 重复任一录入）时，必须先核对人数与套数再确认 */
const mergeBothHavePeople = computed(
  () => (mergeSourceRow.value?.stats.total ?? 0) > 0 && (mergeTargetRow.value?.stats.total ?? 0) > 0
)

const mergedStats = computed<BatchStats | null>(() => {
  const current = project.value
  const source = mergeSourceRow.value
  const target = mergeTargetRow.value
  if (!current || !source || !target) return null
  const keys = [source.key, target.key]
  const stats: BatchStats = {
    key: target.key,
    active: 0,
    invalid: 0,
    duplicate: 0,
    total: 0,
    regularQty: 0,
    specialQty: 0,
    suits: 0,
    unmerged: 0
  }
  for (const person of current.persons) {
    const personKey = batchKeyOf(person)
    if (!keys.includes(personKey)) continue
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
})

function resetMergeForm(): void {
  mergeForm.source = ''
  mergeForm.target = ''
  bothHavePeopleAck.value = false
}

async function submitMerge(): Promise<void> {
  const current = project.value
  if (!current || !canPreviewMerge.value) return
  const source = mergeSourceRow.value
  const target = mergeTargetRow.value
  if (!source || !target) return
  if (mergeBothHavePeople.value) {
    if (!bothHavePeopleAck.value) {
      errorText.value = '两边批次都有人：请先核对上方两边的人数与套数，并勾选确认后再合并'
      return
    }
    const confirmed = window.confirm(
      `确认合并：「${source.key}」（${source.stats.active} 人 / ${source.stats.suits} 套，另有无效 ${source.stats.invalid}、重复 ${source.stats.duplicate}）` +
        `\n并入「${target.key}」（${target.stats.active} 人 / ${target.stats.suits} 套，另有无效 ${target.stats.invalid}、重复 ${target.stats.duplicate}）？\n\n` +
        `合并后「${target.key}」共 ${mergedStats.value?.active ?? 0} 人 / ${mergedStats.value?.suits ?? 0} 套，总人数与总套数不变。`
    )
    if (!confirmed) return
  } else {
    let prompt: string
    if (source.stats.total === 0 && target.stats.total === 0) {
      prompt = `两个批次都为空：确认移除空批次「${source.key}」（只整理登记名单，不涉及任何人、人数与套数不变）？`
    } else if (source.stats.total === 0) {
      prompt = `确认移除空批次「${source.key}」？该批次下没有任何人，人数与套数不变。`
    } else {
      prompt = `确认把「${source.key}」的 ${source.stats.total} 条录入并入「${target.key}」？「${target.key}」当前为空，合并后总人数与总套数不变。`
    }
    if (!window.confirm(prompt)) return
  }
  const result = mergeBatches(current, source.key, target.key)
  if (!result.ok) {
    errorText.value = result.message
    return
  }
  errorText.value = ''
  message.value = result.message
  resetMergeForm()
  persistProject(current, true)
  await flushProject(current)
}

function swapMergeSides(): void {
  // 未分批只允许作为被合并方，对调后若落到目标位则只清空目标，避免提交非法合并
  const source = mergeForm.source
  const nextSource = mergeForm.target
  const nextTarget = source
  mergeForm.source = nextSource
  mergeForm.target = nextTarget === UNBATCHED ? '' : nextTarget
  bothHavePeopleAck.value = false
}
</script>

<template>
  <section v-if="!project || !summary" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 批次维护</h1>
        <div class="sub">
          随时新增、改名、合并批次，或删除空批次；改名 / 合并后已录入的人自动跟着挪，归并页与汇总页的分批小计同步更新
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <RouterLink class="btn btn-sm" :to="`/measure/${project.id}`">量体录入</RouterLink>
        <RouterLink class="btn btn-sm" :to="`/summary/${project.id}`">查看汇总</RouterLink>
      </div>
    </div>

    <p v-if="message" class="notice notice-ok">{{ message }}</p>
    <p v-if="errorText" class="notice notice-error">{{ errorText }}</p>

    <div class="card card-accent-ok">
      <div class="card-head">
        <h3>项目总量（批次调整前后保持不变）</h3>
        <div class="spacer"></div>
        <span class="badge badge-ok">守恒等式：{{ summary.totals.regularQty }} 常规 + {{ summary.totals.specialQty }} 特殊 = {{ summary.totals.accountedQty }} 套</span>
      </div>
      <div class="card-body tight">
        <div class="stat-row">
          <div class="stat"><div class="stat-label">总录入人数</div><div class="stat-value">{{ summary.totals.totalRows }}</div></div>
          <div class="stat"><div class="stat-label">有效人数</div><div class="stat-value">{{ summary.totals.validRows }}</div></div>
          <div class="stat"><div class="stat-label">总套数（常规+特殊）</div><div class="stat-value">{{ summary.totals.accountedQty }}</div></div>
          <div class="stat"><div class="stat-label">无效行</div><div class="stat-value">{{ summary.totals.invalidRows }}</div></div>
          <div class="stat"><div class="stat-label">重复行</div><div class="stat-value">{{ summary.totals.duplicateRows }}</div></div>
        </div>
        <p class="hint" style="margin-top: 8px">
          批次调整只改「人挂在哪个批次名下」，不删人、不改量体数据与号型，所以这里的总人数与总套数在任何新增 / 改名 / 合并 / 空批次删除之后都保持不变。
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>新增批次</h3>
        <div class="spacer"></div>
        <span class="hint">例如项目开工后才追加「冬装」批次；新批次会立即出现在量体录入的批次下拉里</span>
      </div>
      <div class="card-body">
        <form class="toolbar" @submit.prevent="submitAdd">
          <input
            v-model="newName"
            class="input"
            style="max-width: 260px"
            type="text"
            placeholder="新批次名称，如：冬装"
            maxlength="20"
          />
          <button class="btn btn-primary" type="submit">新增批次</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>批次名单与各批人数 / 套数</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">登记批次 {{ rows.filter((row) => row.declared).length }} 个</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>批次</th>
              <th class="num">全部录入</th>
              <th class="num">有效人数</th>
              <th class="num">常规档</th>
              <th class="num">特殊单列</th>
              <th class="num">总套数</th>
              <th class="num">无效/重复</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key">
              <td>
                <template v-if="renaming && renaming.key === row.key">
                  <input v-model="renaming.value" class="input" style="width: 150px; min-height: 32px" type="text" maxlength="20" />
                </template>
                <template v-else>
                  <b>{{ row.key }}</b>
                </template>
              </td>
              <td class="num">{{ row.stats.total }}</td>
              <td class="num">{{ row.stats.active }}</td>
              <td class="num">{{ row.stats.regularQty }}</td>
              <td class="num">{{ row.stats.specialQty }}</td>
              <td class="num"><b>{{ row.stats.suits }}</b></td>
              <td class="num">{{ row.stats.invalid }} / {{ row.stats.duplicate }}</td>
              <td>
                <span v-if="row.unbatched" class="badge">未分批（保留桶）</span>
                <span v-else-if="row.orphan" class="badge badge-warn">未登记 · 挂着 {{ row.stats.total }} 条录入</span>
                <span v-else-if="row.stats.total === 0" class="badge">空批次（可删除）</span>
                <span v-else class="badge badge-info">登记批次</span>
              </td>
              <td>
                <div class="toolbar">
                  <template v-if="renaming && renaming.key === row.key">
                    <button class="btn btn-sm btn-primary" type="button" @click="submitRename">保存名称</button>
                    <button class="btn btn-sm" type="button" @click="cancelRename">取消</button>
                  </template>
                  <template v-else>
                    <button v-if="!row.unbatched" class="btn btn-sm" type="button" @click="startRename(row)">改名</button>
                    <button
                      v-if="row.declared && row.stats.total === 0"
                      class="btn btn-sm btn-danger"
                      type="button"
                      @click="remove(row)"
                    >
                      删除空批次
                    </button>
                    <span v-if="row.declared && row.stats.total > 0" class="hint">有人，不能删 · 请用下方合并</span>
                  </template>
                </div>
              </td>
            </tr>
            <tr v-if="rows.length === 0" class="row-subtotal">
              <td colspan="9">还没有任何批次，可在上方新增（如：春装、冬装）</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card-body tight">
        <p class="hint">
          · 删除只允许删「一个人都没有」的空批次（含无效行 / 重复行也视为有人）；批次下还有录入时请先在下方合并到其他批次。<br />
          · 「未分批」是录入时没有批次名称的人所在的保留桶，不能改名或删除；想归拢时，用下方合并把它并入有名批次（来源可选「未分批」）。<br />
          · 标为「未登记」的批次来自导入文件或历史数据（批次里挂着人、但不在项目登记名单），改名即补登；也可以直接合并掉。
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>合并两个批次</h3>
        <div class="spacer"></div>
        <span class="hint">把写重了 / 不再需要的批次并入保留批次；两边都有人时先核对人数与套数再确认</span>
      </div>
      <div class="card-body">
        <div class="toolbar">
          <label class="field" style="max-width: 220px">
            <span class="field-label">被合并的批次（合并后移除）</span>
            <select v-model="mergeForm.source" class="select" @change="bothHavePeopleAck = false">
              <option value="">请选择…</option>
              <option v-for="row in mergeOptions" :key="`src-${row.key}`" :value="row.key">{{ row.key }}</option>
            </select>
          </label>
          <button class="btn btn-sm" type="button" style="margin-top: 16px" @click="swapMergeSides">⇄ 对调</button>
          <label class="field" style="max-width: 220px">
            <span class="field-label">并入到（保留的批次）</span>
            <select v-model="mergeForm.target" class="select" @change="bothHavePeopleAck = false">
              <option value="">请选择…</option>
              <option v-for="row in mergeTargetOptions" :key="`dst-${row.key}`" :value="row.key">{{ row.key }}</option>
            </select>
          </label>
        </div>

        <div v-if="canPreviewMerge && mergeSourceRow && mergeTargetRow && mergedStats" style="margin-top: 12px">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>批次</th>
                  <th class="num">全部录入</th>
                  <th class="num">有效人数</th>
                  <th class="num">常规档</th>
                  <th class="num">特殊单列</th>
                  <th class="num">总套数</th>
                  <th class="num">无效</th>
                  <th class="num">重复</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <b>{{ mergeSourceRow.key }}</b>
                    <span v-if="mergeSourceRow.unbatched">（未分批保留桶，并入后保留为空桶）</span>
                    <span v-else>（将移除）</span>
                  </td>
                  <td class="num">{{ mergeSourceRow.stats.total }}</td>
                  <td class="num">{{ mergeSourceRow.stats.active }}</td>
                  <td class="num">{{ mergeSourceRow.stats.regularQty }}</td>
                  <td class="num">{{ mergeSourceRow.stats.specialQty }}</td>
                  <td class="num"><b>{{ mergeSourceRow.stats.suits }}</b></td>
                  <td class="num">{{ mergeSourceRow.stats.invalid }}</td>
                  <td class="num">{{ mergeSourceRow.stats.duplicate }}</td>
                </tr>
                <tr>
                  <td><b>{{ mergeTargetRow.key }}</b>（保留）</td>
                  <td class="num">{{ mergeTargetRow.stats.total }}</td>
                  <td class="num">{{ mergeTargetRow.stats.active }}</td>
                  <td class="num">{{ mergeTargetRow.stats.regularQty }}</td>
                  <td class="num">{{ mergeTargetRow.stats.specialQty }}</td>
                  <td class="num"><b>{{ mergeTargetRow.stats.suits }}</b></td>
                  <td class="num">{{ mergeTargetRow.stats.invalid }}</td>
                  <td class="num">{{ mergeTargetRow.stats.duplicate }}</td>
                </tr>
                <tr class="row-subtotal">
                  <td>合并后 → {{ mergeTargetRow.key }}</td>
                  <td class="num">{{ mergedStats.total }}</td>
                  <td class="num">{{ mergedStats.active }}</td>
                  <td class="num">{{ mergedStats.regularQty }}</td>
                  <td class="num">{{ mergedStats.specialQty }}</td>
                  <td class="num"><b>{{ mergedStats.suits }}</b></td>
                  <td class="num">{{ mergedStats.invalid }}</td>
                  <td class="num">{{ mergedStats.duplicate }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="hint" style="margin-top: 8px">
            校验：合并后有效人数 {{ mergedStats.active }} = {{ mergeSourceRow.stats.active }} +
            {{ mergeTargetRow.stats.active }}；总套数 {{ mergedStats.suits }} =
            {{ mergeSourceRow.stats.suits }} + {{ mergeTargetRow.stats.suits }}。全项目总量不变。
          </p>
          <label v-if="mergeBothHavePeople" class="field" style="margin-top: 8px">
            <span style="display: flex; gap: 8px; align-items: flex-start; font-size: 13px">
              <input v-model="bothHavePeopleAck" type="checkbox" style="margin-top: 3px" />
              <span>
                两边批次都有人，我已核对「{{ mergeSourceRow.key }}」{{ mergeSourceRow.stats.active }} 人 /
                {{ mergeSourceRow.stats.suits }} 套 与「{{ mergeTargetRow.key }}」{{ mergeTargetRow.stats.active }} 人 /
                {{ mergeTargetRow.stats.suits }} 套，确认合并。
              </span>
            </span>
          </label>
          <div class="toolbar" style="margin-top: 10px">
            <button class="btn btn-primary" type="button" :disabled="mergeBothHavePeople && !bothHavePeopleAck" @click="submitMerge">
              确认合并
            </button>
            <button class="btn" type="button" @click="resetMergeForm">取消</button>
            <span v-if="mergeBothHavePeople && !bothHavePeopleAck" class="hint">勾选核对确认后才能点合并</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>调整后会同步到哪里</h3></div>
      <div class="card-body tight">
        <p>· 量体录入页：批次下拉立即使用新名单，录入的人默认沿用上次批次。</p>
        <p>· 归并页 / 汇总页：分批小计按调整后的批次名与归属重新统计，合计仍与守恒等式一致。</p>
        <p>· 导出下单表与量体明细（Excel / CSV / PDF）：批次列显示调整后的批次名。</p>
      </div>
    </div>
  </section>
</template>
