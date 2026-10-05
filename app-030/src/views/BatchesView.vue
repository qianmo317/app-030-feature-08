<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  addProjectBatch,
  deleteProjectBatch,
  getProject,
  getRule,
  mergeProjectBatches,
  renameProjectBatch,
  store
} from '../logic/store'
import { batchStats, type BatchStats } from '../logic/batches'
import { buildSummary } from '../logic/merge'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

const stats = computed<BatchStats[]>(() => (project.value ? batchStats(project.value) : []))
const summary = computed(() => (project.value ? buildSummary(project.value, rule.value) : null))

const totals = computed(() => {
  const list = stats.value
  return {
    people: list.reduce((sum, item) => sum + item.peopleCount, 0),
    valid: list.reduce((sum, item) => sum + item.validCount, 0),
    regular: list.reduce((sum, item) => sum + item.regularQty, 0),
    special: list.reduce((sum, item) => sum + item.specialQty, 0),
    suits: list.reduce((sum, item) => sum + item.suits, 0)
  }
})

const message = ref('')
const errorText = ref('')

/* ------------------------------ 新增 ------------------------------ */

const newName = ref('')
const adding = ref(false)

async function add(): Promise<void> {
  const current = project.value
  if (!current || adding.value) return
  const name = newName.value.trim()
  if (name === '') {
    errorText.value = '请填写批次名称，如「冬装」'
    return
  }
  adding.value = true
  errorText.value = ''
  try {
    const added = await addProjectBatch(current, name)
    newName.value = ''
    message.value = `已新增批次「${added}」；可在量体录入页的批次下拉中选择`
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error)
  } finally {
    adding.value = false
  }
}

/* ------------------------------ 改名 ------------------------------ */

const renaming = ref<BatchStats | null>(null)
const renameForm = reactive({ name: '' })

function startRename(item: BatchStats): void {
  renaming.value = item
  renameForm.name = item.name
  errorText.value = ''
}

function cancelRename(): void {
  renaming.value = null
}

async function submitRename(): Promise<void> {
  const current = project.value
  const target = renaming.value
  if (!current || !target) return
  try {
    const oldName = target.name
    const newName = renameForm.name.trim()
    await renameProjectBatch(current, oldName, newName)
    message.value = `已把批次「${oldName}」改名为「${newName}」，该批次 ${target.peopleCount} 人已全部随新批次名走`
    renaming.value = null
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}

/* ------------------------------ 合并 ------------------------------ */

const mergeForm = reactive({ source: '', target: '' })
const mergeArmed = ref(false)

const mergePreview = computed(() => {
  if (!mergeForm.source || !mergeForm.target || mergeForm.source === mergeForm.target) return null
  const source = stats.value.find((item) => item.name === mergeForm.source)
  const target = stats.value.find((item) => item.name === mergeForm.target)
  if (!source || !target) return null
  return {
    source,
    target,
    movedPeople: source.peopleCount,
    movedSuits: source.suits,
    mergedPeople: source.peopleCount + target.peopleCount,
    mergedValid: source.validCount + target.validCount,
    mergedSuits: source.suits + target.suits
  }
})

function pickSource(): void {
  mergeArmed.value = false
  errorText.value = ''
}

async function submitMerge(): Promise<void> {
  const current = project.value
  const preview = mergePreview.value
  if (!current || !preview) return
  if (!mergeArmed.value) {
    // 第一次点击：只摆出两边人数 / 套数，等再次确认
    mergeArmed.value = true
    return
  }
  errorText.value = ''
  try {
    await mergeProjectBatches(current, preview.source.name, preview.target.name)
    message.value =
      `已把「${preview.source.name}」并入「${preview.target.name}」：挪动 ${preview.movedPeople} 人、` +
      `${preview.movedSuits} 套；合并后共 ${preview.mergedPeople} 人、${preview.mergedSuits} 套，总人数与总套数不变`
    mergeForm.source = ''
    mergeForm.target = ''
    mergeArmed.value = false
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}

/* ------------------------------ 删除 ------------------------------ */

async function remove(item: BatchStats): Promise<void> {
  const current = project.value
  if (!current) return
  if (item.peopleCount > 0) {
    errorText.value = `批次「${item.name}」下有 ${item.peopleCount} 人，不能删除；如需并到其他批次请使用「合并批次」`
    return
  }
  if (!window.confirm(`确认删除空批次「${item.name}」？该批次下没有任何人，删除不影响量体数据与总数。`)) return
  errorText.value = ''
  try {
    await deleteProjectBatch(current, item.name)
    message.value = `已删除空批次「${item.name}」（未删除任何量体记录）`
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <section v-if="!project" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 批次维护</h1>
        <div class="sub">随时新增、改名、合并、删除批次；改名 / 合并后该批次下的人自动跟着走，录入下拉、归并与汇总的分批小计同步更新</div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <RouterLink class="btn btn-sm" :to="`/measure/${project.id}`">量体录入</RouterLink>
        <RouterLink class="btn btn-sm" :to="`/summary/${project.id}`">汇总与守恒</RouterLink>
      </div>
    </div>

    <p v-if="message" class="notice notice-ok">{{ message }}</p>
    <p v-if="errorText" class="notice notice-error">{{ errorText }}</p>

    <div class="card card-accent-ok">
      <div class="card-head">
        <h3>调整前后守恒</h3>
        <div class="spacer"></div>
        <span class="badge badge-ok">批次只改归属，不删人、不改号型</span>
      </div>
      <div class="card-body tight">
        <div class="stat-row">
          <div class="stat"><div class="stat-label">总人数</div><div class="stat-value">{{ totals.people }}</div></div>
          <div class="stat"><div class="stat-label">有效人数</div><div class="stat-value">{{ totals.valid }}</div></div>
          <div class="stat"><div class="stat-label">常规档套数</div><div class="stat-value">{{ totals.regular }}</div></div>
          <div class="stat"><div class="stat-label">特殊单列套数</div><div class="stat-value">{{ totals.special }}</div></div>
          <div class="stat"><div class="stat-label">总套数</div><div class="stat-value">{{ totals.suits }}</div></div>
          <div class="stat">
            <div class="stat-label">守恒校验</div>
            <div class="stat-value" :class="summary?.conserved ? 'ok' : 'bad'">
              {{ summary?.conserved ? '通过' : '不通过' }}
            </div>
          </div>
        </div>
        <p class="hint" style="margin-top: 8px">
          新增 / 改名 / 合并 / 删除批次都不会改变上面的人数与套数；导出表里的批次名使用调整之后的名称。
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>新增批次</h2>
        <div class="spacer"></div>
        <span class="hint">例如项目建完后追加一批「冬装」</span>
      </div>
      <div class="card-body">
        <form class="toolbar" @submit.prevent="add">
          <input
            v-model="newName"
            class="input"
            type="text"
            style="max-width: 260px"
            placeholder="新批次名称，如：冬装"
            autocomplete="off"
          />
          <button class="btn btn-primary" type="submit" :disabled="adding">新增批次</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>批次清单（{{ stats.length }}）</h2>
        <div class="spacer"></div>
        <span class="hint">删除只允许空批次；两边都有人的合并需先核对人数 / 套数再确认</span>
      </div>
      <div v-if="stats.length === 0" class="empty">
        该项目还没有批次。可在上方新增；未指定批次的录入会归入「未分批」。
      </div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>批次</th>
              <th class="num">人数</th>
              <th class="num">有效人数</th>
              <th class="num">常规档</th>
              <th class="num">特殊单列</th>
              <th class="num">套数小计</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in stats" :key="item.name">
              <td>
                <b>{{ item.name }}</b>
                <span v-if="!item.listed" class="badge badge-warn" style="margin-left: 6px">清单外·历史数据</span>
              </td>
              <td class="num">{{ item.peopleCount }}</td>
              <td class="num">{{ item.validCount }}</td>
              <td class="num">{{ item.regularQty }}</td>
              <td class="num">{{ item.specialQty }}</td>
              <td class="num"><b>{{ item.suits }}</b></td>
              <td>
                <div class="toolbar">
                  <button class="btn btn-sm" type="button" @click="startRename(item)">改名</button>
                  <button class="btn btn-sm btn-danger" type="button" :disabled="item.peopleCount > 0" @click="remove(item)">
                    删除
                  </button>
                </div>
              </td>
            </tr>
            <tr class="row-subtotal">
              <td>合计</td>
              <td class="num">{{ totals.people }}</td>
              <td class="num">{{ totals.valid }}</td>
              <td class="num">{{ totals.regular }}</td>
              <td class="num">{{ totals.special }}</td>
              <td class="num">{{ totals.suits }}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>合并两个批次</h2>
        <div class="spacer"></div>
        <span class="hint">把写重了的批次并成一个：源批次的人全部挪入目标批次，源批次随后移除</span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">源批次（并入后删除） <b class="req">*</b></span>
            <select v-model="mergeForm.source" class="select" @change="pickSource">
              <option value="">请选择源批次…</option>
              <option v-for="item in stats" :key="`s-${item.name}`" :value="item.name">{{ item.name }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">目标批次（保留此名称） <b class="req">*</b></span>
            <select v-model="mergeForm.target" class="select" @change="mergeArmed = false">
              <option value="">请选择目标批次…</option>
              <option
                v-for="item in stats.filter((item) => item.name !== mergeForm.source)"
                :key="`t-${item.name}`"
                :value="item.name"
              >
                {{ item.name }}
              </option>
            </select>
          </label>
        </div>

        <div v-if="mergePreview" class="merge-preview" style="margin-top: 12px">
          <table class="data-table">
            <thead>
              <tr>
                <th>批次</th>
                <th class="num">人数</th>
                <th class="num">有效人数</th>
                <th class="num">常规档</th>
                <th class="num">特殊单列</th>
                <th class="num">套数</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>「{{ mergePreview.source.name }}」（源，将删除）</td>
                <td class="num">{{ mergePreview.source.peopleCount }}</td>
                <td class="num">{{ mergePreview.source.validCount }}</td>
                <td class="num">{{ mergePreview.source.regularQty }}</td>
                <td class="num">{{ mergePreview.source.specialQty }}</td>
                <td class="num">{{ mergePreview.source.suits }}</td>
              </tr>
              <tr>
                <td>「{{ mergePreview.target.name }}」（目标，保留）</td>
                <td class="num">{{ mergePreview.target.peopleCount }}</td>
                <td class="num">{{ mergePreview.target.validCount }}</td>
                <td class="num">{{ mergePreview.target.regularQty }}</td>
                <td class="num">{{ mergePreview.target.specialQty }}</td>
                <td class="num">{{ mergePreview.target.suits }}</td>
              </tr>
              <tr class="row-subtotal">
                <td>合并后（{{ mergePreview.target.name }}）</td>
                <td class="num">{{ mergePreview.mergedPeople }}</td>
                <td class="num">{{ mergePreview.mergedValid }}</td>
                <td class="num">{{ mergePreview.source.regularQty + mergePreview.target.regularQty }}</td>
                <td class="num">{{ mergePreview.source.specialQty + mergePreview.target.specialQty }}</td>
                <td class="num"><b>{{ mergePreview.mergedSuits }}</b></td>
              </tr>
            </tbody>
          </table>
          <p v-if="mergePreview.source.peopleCount > 0 && mergePreview.target.peopleCount > 0" class="notice notice-warn" style="margin-top: 10px">
            两个批次都有人：源批次 {{ mergePreview.source.peopleCount }} 人（{{ mergePreview.source.suits }} 套）将全部挪入
            「{{ mergePreview.target.name }}」，请确认上表人数 / 套数无误后再点「确认合并」。
          </p>
        </div>

        <div class="toolbar" style="margin-top: 12px">
          <button class="btn btn-primary" type="button" :disabled="!mergePreview" @click="submitMerge">
            {{ mergeArmed ? '确认合并（人数 / 套数已核对）' : '预览两边人数与套数' }}
          </button>
          <span v-if="mergeArmed" class="hint">再点一次即执行；总人数 {{ totals.people }}、总套数 {{ totals.suits }} 不会改变</span>
        </div>
      </div>
    </div>

    <div v-if="renaming" class="card card-accent-warn">
      <div class="card-head">
        <h3>批次改名 —— 「{{ renaming.name }}」</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">该批次 {{ renaming.peopleCount }} 人将随新名走</span>
      </div>
      <div class="card-body">
        <label class="field" style="max-width: 320px">
          <span class="field-label">新批次名称 <b class="req">*</b></span>
          <input v-model="renameForm.name" class="input" type="text" placeholder="如：春季" autocomplete="off" />
        </label>
        <div class="toolbar" style="margin-top: 10px">
          <button class="btn btn-primary" type="button" @click="submitRename">确认改名</button>
          <button class="btn" type="button" @click="cancelRename">取消</button>
          <span class="hint">改名后录入页批次下拉、汇总页分批小计、导出表中的批次名同步更新</span>
        </div>
      </div>
    </div>
  </section>
</template>
