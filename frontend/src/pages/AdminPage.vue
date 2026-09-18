<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import { useCatalogStore } from "@/stores/catalog";
import type { DispatchOverview } from "@/api/types";

const catalog = useCatalogStore();
const tab = ref("dashboard");

const dashboard = ref<Record<string, any> | null>(null);
const users = ref<Array<Record<string, any>>>([]);
const userQuery = ref({ q: "", role: "", status: "" });
const appeals = ref<Array<Record<string, any>>>([]);
const audits = ref<Array<Record<string, any>>>([]);
const categories = ref<Array<Record<string, any>>>([]);
const loading = ref(false);

async function loadDashboard() {
  dashboard.value = await api.get<Record<string, any>>("/admin/dashboard");
}

async function loadUsers() {
  const result = await api.get<{ items: Array<Record<string, any>> }>("/admin/users", {
    q: userQuery.value.q || undefined,
    role: userQuery.value.role || undefined,
    status: userQuery.value.status || undefined,
    pageSize: 50,
  });
  users.value = result.items;
}

async function loadAppeals() {
  const result = await api.get<{ items: Array<Record<string, any>> }>("/moderation/appeals");
  appeals.value = result.items;
}

async function loadAudits() {
  const result = await api.get<{ items: Array<Record<string, any>> }>("/admin/audit-logs", { pageSize: 50 });
  audits.value = result.items;
}

async function loadCategories() {
  const result = await api.get<{ items: Array<Record<string, any>> }>("/admin/categories");
  categories.value = result.items;
}

async function banUser(row: Record<string, any>) {
  try {
    const { value } = await ElMessageBox.prompt("请填写封禁理由（会展示给用户）", "封禁账号", {
      inputValidator: (text) => (text && text.trim().length >= 2 ? true : "请填写至少 2 个字的理由"),
    });
    await api.post(`/admin/users/${row.uuid}/ban`, { reason: value.trim() });
    ElMessage.success("已封禁并踢下线");
    await loadUsers();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function unbanUser(row: Record<string, any>) {
  await api.post(`/admin/users/${row.uuid}/unban`, { reason: "管理员解封" });
  ElMessage.success("已解封");
  await loadUsers();
}

async function muteUser(row: Record<string, any>) {
  try {
    const { value } = await ElMessageBox.prompt("禁言时长（小时）与理由，用空格分隔，例如：24 言语攻击", "禁言", {
      inputValidator: (text) => {
        const hours = Number((text ?? "").trim().split(/\s+/)[0]);
        return Number.isFinite(hours) && hours >= 1 ? true : "请按「小时 理由」格式填写";
      },
    });

    const [hoursRaw, ...rest] = value.trim().split(/\s+/);
    await api.post(`/admin/users/${row.uuid}/mute`, {
      hours: Number(hoursRaw),
      reason: rest.join(" ") || "违反社区规范",
    });
    ElMessage.success("已禁言");
    await loadUsers();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function changeRole(row: Record<string, any>, role: string) {
  try {
    await api.patch(`/admin/users/${row.uuid}/role`, { role });
    ElMessage.success("角色已更新");
    await loadUsers();
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function decideAppeal(row: Record<string, any>, decision: "approve" | "uphold") {
  try {
    const { value } = await ElMessageBox.prompt("终审理由（会通知作者）", "申诉终审", {
      inputValidator: (text) => (text && text.trim().length >= 5 ? true : "请填写至少 5 个字的理由"),
    });
    await api.post(`/moderation/appeals/${row.id}/decide`, { decision, reason: value.trim() });
    ElMessage.success("终审完成");
    await loadAppeals();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function updateSchema(row: Record<string, any>) {
  try {
    const { value } = await ElMessageBox.prompt("粘贴新的属性 Schema（JSON）", `编辑「${row.name}」的属性`, {
      inputType: "textarea",
      inputValue: JSON.stringify(row.schema, null, 2),
      inputValidator: (text) => {
        try {
          JSON.parse(text ?? "");
          return true;
        } catch {
          return "JSON 格式不正确";
        }
      },
    });

    const result = await api.put<{ version: number; changed: boolean }>(`/admin/categories/${row.id}/schema`, {
      schema: JSON.parse(value),
    });

    ElMessage.success(result.changed ? `已发布 Schema 版本 v${result.version}` : "内容没有变化");
    await loadCategories();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function toggleCategory(row: Record<string, any>) {
  await api.patch(`/admin/categories/${row.id}`, { isActive: !row.isActive });
  ElMessage.success(row.isActive ? "已停用该分类" : "已启用该分类");
  await loadCategories();
}

async function loadTab(name: string) {
  loading.value = true;
  try {
    if (name === "dashboard") await loadDashboard();
    if (name === "users") await loadUsers();
    if (name === "categories") await loadCategories();
    if (name === "appeals") await loadAppeals();
    if (name === "audit") await loadAudits();
    if (name === "dispatch") await loadDispatch();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------- 加权派单调度

const dispatch = ref<DispatchOverview | null>(null);
const surgeDialogVisible = ref(false);
const surgeSaving = ref(false);
const surgeCandidates = ref<Array<Record<string, any>>>([]);
const surgeForm = ref<{
  userUuids: string[];
  hours: number;
  boostFactor: number;
  categoryCodes: string[];
  reason: string;
}>({
  userUuids: [],
  hours: 8,
  boostFactor: 2,
  categoryCodes: [],
  reason: "",
});

async function loadDispatch() {
  await catalog.load().catch(() => undefined);
  dispatch.value = await api.get<DispatchOverview>("/moderation/dispatch/overview");
}

async function openSurgeDialog() {
  surgeForm.value = { userUuids: [], hours: 8, boostFactor: 2, categoryCodes: [], reason: "" };
  const result = await api.get<{ items: Array<Record<string, any>> }>("/admin/users", {
    status: "active",
    pageSize: 100,
  });
  // 只选还没有在生效加派中的人，避免重复加派
  const surged = new Set(dispatch.value?.activeSurges.map((item) => item.user.uuid));
  surgeCandidates.value = result.items.filter(
    (user) => !surged.has(user.uuid) && user.role !== "admin",
  );
  surgeDialogVisible.value = true;
}

async function submitSurge() {
  if (surgeForm.value.userUuids.length === 0) {
    ElMessage.warning("请至少选择一位支援者");
    return;
  }
  surgeSaving.value = true;
  try {
    const result = await api.post<{ surgeCount: number; rolePromoted: number; dispatchedTasks: number }>(
      "/moderation/dispatch/surges",
      {
        userUuids: surgeForm.value.userUuids,
        hours: surgeForm.value.hours,
        boostFactor: surgeForm.value.boostFactor,
        categoryCodes: surgeForm.value.categoryCodes.length > 0 ? surgeForm.value.categoryCodes : undefined,
        reason: surgeForm.value.reason.trim() || undefined,
      },
    );
    ElMessage.success(
      `已加派 ${result.surgeCount} 人（临时提权 ${result.rolePromoted} 人），积压已重新加权派单 ${result.dispatchedTasks} 条`,
    );
    surgeDialogVisible.value = false;
    await loadDispatch();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    surgeSaving.value = false;
  }
}

async function endDispatchSurge(id: string, nickname: string) {
  try {
    const { value } = await ElMessageBox.confirm(
      `结束「${nickname}」的临时加派？`,
      "结束加派",
      {
        distinguishCancelAndClose: true,
        confirmButtonText: "结束并把未完成任务转交他人",
        cancelButtonText: "仅结束，保留其锁内任务",
        type: "warning",
      },
    ).then(
      () => ({ value: true as const }),
      (action: string) =>
        action === "cancel" ? Promise.resolve({ value: false as const }) : Promise.reject(),
    );

    const result = await api.post<{ reassigned: number; roleDemoted: boolean }>(
      `/moderation/dispatch/surges/${id}/end`,
      { reassign: value, reason: "管理员手动结束加派" },
    );
    ElMessage.success(
      `加派已结束${value ? `，转交任务 ${result.reassigned} 条` : ""}${result.roleDemoted ? "，已收回审核权限" : ""}`,
    );
    await loadDispatch();
  } catch (error) {
    if (error !== "close" && error !== "cancel" && error instanceof Error) {
      ElMessage.error(error.message);
    }
  }
}

function formatRate(rate: number | null): string {
  return rate === null ? "样本不足" : `${(rate * 100).toFixed(1)}%`;
}

function surgeCandidateLabel(user: Record<string, any>): string {
  const contact = user.email ?? String(user.uuid).slice(0, 8);
  const suffix = user.role === "moderator" ? " · 已是审核员" : "";
  return `${user.nickname}（${contact}）${suffix}`;
}

onMounted(async () => {
  await catalog.load().catch(() => undefined);
  await loadTab("dashboard");
});
</script>

<template>
  <div class="page page--wide" v-loading="loading">
    <h1 class="page-title">管理后台</h1>

    <el-tabs v-model="tab" @tab-change="(name: string | number) => loadTab(String(name))">
      <el-tab-pane label="数据看板" name="dashboard">
        <template v-if="dashboard">
          <el-row :gutter="12">
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>已发布条目</span><strong>{{ dashboard.spots.published }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>今日新增</span><strong>{{ dashboard.spots.today }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待审核</span><strong>{{ dashboard.moderation.pending }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待处理举报</span><strong>{{ dashboard.reports.open }}</strong></div></el-card>
            </el-col>
          </el-row>

          <el-row :gutter="12" style="margin-top: 12px">
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>疑似过期条目</span><strong>{{ dashboard.spots.stale }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待确认隐私图片</span><strong>{{ dashboard.privacy.pending }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>平均审核时长</span><strong>{{ dashboard.averageReviewHours }}h</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待终审申诉</span><strong>{{ dashboard.appeals }}</strong></div></el-card>
            </el-col>
          </el-row>

          <el-card shadow="never" style="margin-top: 12px">
            <template #header>分类分布</template>
            <el-table :data="dashboard.byCategory" size="small">
              <el-table-column prop="name" label="分类" />
              <el-table-column prop="count" label="已发布数量" />
            </el-table>
          </el-card>

          <el-card shadow="never" style="margin-top: 12px">
            <template #header>最近操作</template>
            <el-table :data="dashboard.recentAudits" size="small">
              <el-table-column prop="action" label="动作" width="200" />
              <el-table-column prop="actor" label="操作人" width="140" />
              <el-table-column prop="reason" label="说明" />
              <el-table-column label="时间" width="180">
                <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString("zh-CN") }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </template>
      </el-tab-pane>

      <el-tab-pane label="用户管理" name="users">
        <div style="display: flex; gap: 10px; margin-bottom: 12px">
          <el-input v-model="userQuery.q" placeholder="搜索昵称 / 邮箱 / 手机号" style="width: 240px" @keyup.enter="loadUsers" />
          <el-select v-model="userQuery.role" placeholder="全部角色" clearable style="width: 140px">
            <el-option label="普通用户" value="user" />
            <el-option label="审核员" value="moderator" />
            <el-option label="管理员" value="admin" />
          </el-select>
          <el-select v-model="userQuery.status" placeholder="全部状态" clearable style="width: 140px">
            <el-option label="正常" value="active" />
            <el-option label="禁言" value="muted" />
            <el-option label="封禁" value="banned" />
          </el-select>
          <el-button @click="loadUsers">查询</el-button>
        </div>

        <el-table :data="users" style="width: 100%">
          <el-table-column prop="nickname" label="昵称" width="140" />
          <el-table-column prop="email" label="邮箱" width="200" />
          <el-table-column prop="role" label="角色" width="110" />
          <el-table-column prop="status" label="状态" width="100" />
          <el-table-column prop="creditScore" label="信用分" width="90" />
          <el-table-column label="内容" width="140">
            <template #default="{ row }">{{ row.counts.spots }} 条 / {{ row.counts.comments }} 评论</template>
          </el-table-column>
          <el-table-column label="操作" min-width="260">
            <template #default="{ row }">
              <el-select
                :model-value="row.role"
                size="small"
                style="width: 110px; margin-right: 6px"
                @change="(value: string) => changeRole(row, value)"
              >
                <el-option label="普通用户" value="user" />
                <el-option label="审核员" value="moderator" />
                <el-option label="管理员" value="admin" />
              </el-select>
              <el-button size="small" @click="muteUser(row)">禁言</el-button>
              <el-button v-if="row.status !== 'banned'" size="small" type="danger" plain @click="banUser(row)">
                封禁
              </el-button>
              <el-button v-else size="small" @click="unbanUser(row)">解封</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="分类与属性" name="categories">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="属性 Schema 是版本化的"
          description="发布新版本后，已存在的条目不受影响，只有新提交会按新版本校验。"
          style="margin-bottom: 12px"
        />

        <el-table :data="categories" style="width: 100%">
          <el-table-column prop="name" label="分类" width="120" />
          <el-table-column prop="code" label="代码" width="160" />
          <el-table-column label="属性数量" width="100">
            <template #default="{ row }">
              {{ Object.keys(row.schema?.properties ?? {}).length }}
            </template>
          </el-table-column>
          <el-table-column prop="schemaVersion" label="Schema 版本" width="120" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
                {{ row.isActive ? "启用" : "停用" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="200">
            <template #default="{ row }">
              <el-button size="small" @click="updateSchema(row)">编辑属性</el-button>
              <el-button size="small" @click="toggleCategory(row)">
                {{ row.isActive ? "停用" : "启用" }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="派单调度" name="dispatch">
        <template v-if="dispatch">
          <el-alert
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom: 12px"
            :title="`系统每 10 分钟自动加权派单：分类偏好 × 近 ${dispatch.windowDays} 天通过率 × 当前在手工单量 × 加派倍数。自己提交的条目不会派给自己。`"
          />

          <el-row :gutter="12" style="margin-bottom: 12px">
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>待派积压</span><strong>{{ dispatch.backlog.pending }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>已超时</span><strong class="danger">{{ dispatch.backlog.overdue }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>在岗审核员</span><strong>{{ dispatch.moderators.filter((m) => !m.paused).length }}</strong></div></el-card>
            </el-col>
            <el-col :xs="12" :md="6">
              <el-card shadow="never"><div class="stat"><span>加派批次进行中</span><strong>{{ dispatch.activeSurges.length }}</strong></div></el-card>
            </el-col>
          </el-row>

          <div style="display: flex; justify-content: space-between; align-items: center; margin: 8px 0">
            <strong>进行中的临时加派</strong>
            <el-button type="primary" @click="openSurgeDialog">＋ 临时加派人手</el-button>
          </div>

          <el-table :data="dispatch.activeSurges" style="width: 100%; margin-bottom: 16px">
            <el-table-column label="支援者" min-width="140">
              <template #default="{ row }">{{ row.user.nickname }}</template>
            </el-table-column>
            <el-table-column label="加派倍数" width="100">
              <template #default="{ row }">×{{ row.boostFactor }}</template>
            </el-table-column>
            <el-table-column label="限定分类" min-width="140">
              <template #default="{ row }">
                {{ row.categoryCodes.length > 0 ? row.categoryCodes.join("、") : "不限" }}
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" min-width="160" />
            <el-table-column label="到期时间" width="180">
              <template #default="{ row }">{{ new Date(row.expiresAt).toLocaleString("zh-CN") }}</template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button size="small" type="warning" plain @click="endDispatchSurge(row.id, row.user.nickname)">
                  结束加派
                </el-button>
              </template>
            </el-table-column>
            <template #empty>暂无进行中的加派</template>
          </el-table>

          <strong>审核员派单画像</strong>
          <el-table :data="dispatch.moderators" style="width: 100%; margin-top: 8px">
            <el-table-column prop="nickname" label="审核员" width="140" />
            <el-table-column label="角色" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.role === 'admin' ? 'danger' : row.surge ? 'warning' : 'info'">
                  {{ row.surge ? "加派支援" : row.role === "admin" ? "管理员" : "审核员" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="在手上限" width="100">
              <template #default="{ row }">{{ row.activeCount }} / {{ row.maxActive }}</template>
            </el-table-column>
            <el-table-column label="近 90 天通过率" width="120">
              <template #default="{ row }">
                {{ formatRate(row.stats.approvalRate) }}
                <span class="muted">（{{ row.stats.windowTotal }} 条）</span>
              </template>
            </el-table-column>
            <el-table-column label="偏好分类" min-width="160">
              <template #default="{ row }">
                {{ row.preferredCategories.length > 0 ? row.preferredCategories.join("、") : "未设置" }}
              </template>
            </el-table-column>
            <el-table-column label="加派" min-width="180">
              <template #default="{ row }">
                <template v-if="row.surge">
                  <el-tag type="warning" size="small">
                    ×{{ row.surge.boostFactor }} · 到期 {{ new Date(row.surge.expiresAt).toLocaleString("zh-CN") }}
                  </el-tag>
                </template>
                <span v-else class="muted">-</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.paused ? 'info' : 'success'" size="small">
                  {{ row.paused ? "已暂停" : "派单中" }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-tab-pane>

      <el-tab-pane label="申诉终审" name="appeals">
        <el-empty v-if="appeals.length === 0" description="没有待终审的申诉" />
        <el-card v-for="item in appeals" :key="item.id" shadow="never" style="margin-bottom: 10px">
          <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap">
            <div>
              <strong>{{ item.spot.title }}</strong>
              <div class="muted">
                作者 {{ item.spot.owner.nickname }} · 信用分 {{ item.spot.owner.creditScore }}
              </div>
              <p style="margin: 8px 0 0; white-space: pre-wrap">申诉理由：{{ item.appealText }}</p>
              <p class="muted" style="margin: 6px 0 0">
                原判定：{{ item.original?.decisionReason }}
              </p>
            </div>
            <div style="display: flex; gap: 8px; align-items: flex-start">
              <el-button size="small" type="success" @click="decideAppeal(item, 'approve')">改判通过</el-button>
              <el-button size="small" @click="decideAppeal(item, 'uphold')">维持原判</el-button>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="审计日志" name="audit">
        <el-table :data="audits" style="width: 100%">
          <el-table-column prop="action" label="动作" width="220" />
          <el-table-column label="操作人" width="140">
            <template #default="{ row }">{{ row.actor?.nickname ?? "系统" }}</template>
          </el-table-column>
          <el-table-column label="对象" width="160">
            <template #default="{ row }">{{ row.targetType }} #{{ row.targetId ?? "-" }}</template>
          </el-table-column>
          <el-table-column prop="reason" label="说明" min-width="200" />
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString("zh-CN") }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="surgeDialogVisible" title="临时加派人手接管积压" width="560px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
        title="加派期间被选中的普通用户会临时获得审核员权限，到期自动收回；加派提交后系统立即按权重重新派一轮积压任务。"
      />
      <el-form label-position="top">
        <el-form-item label="选择支援者（可多选，只显示状态正常且未在加派中的账号）">
          <el-select
            v-model="surgeForm.userUuids"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="按昵称 / 邮箱搜索后选择"
            style="width: 100%"
          >
            <el-option
              v-for="user in surgeCandidates"
              :key="user.uuid"
              :label="surgeCandidateLabel(user)"
              :value="user.uuid"
            />
          </el-select>
        </el-form-item>

        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="加派时长（小时，最长 720）">
              <el-input-number v-model="surgeForm.hours" :min="1" :max="720" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="派单倍数（1 ~ 5，建议 2）">
              <el-input-number v-model="surgeForm.boostFactor" :min="1" :max="5" :step="0.5" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="限定分类（不选表示所有积压都可以接）">
          <el-select
            v-model="surgeForm.categoryCodes"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="全部分类"
            style="width: 100%"
          >
            <el-option
              v-for="category in catalog.categories"
              :key="category.code"
              :label="category.name"
              :value="category.code"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="加派原因（会通知支援者）">
          <el-input v-model="surgeForm.reason" maxlength="200" show-word-limit placeholder="例如：周末提交高峰，长椅类积压超过 SLA" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="surgeDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="surgeSaving" @click="submitSurge">确认加派并立即接管积压</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--color-text-soft);
}

.stat strong {
  font-size: 22px;
  color: var(--color-text);
}
</style>
