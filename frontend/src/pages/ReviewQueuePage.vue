<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import type { MyDispatchProfile, Paged, ReviewQueueItem } from "@/api/types";
import { useCatalogStore } from "@/stores/catalog";

const router = useRouter();
const catalog = useCatalogStore();

const items = ref<ReviewQueueItem[]>([]);
const total = ref(0);
const loading = ref(false);
const onlyOverdue = ref(false);
const selecting = ref<string | null>(null);
const smartClaiming = ref(false);

const profileVisible = ref(false);
const profileSaving = ref(false);
const profile = ref<MyDispatchProfile | null>(null);
const profileForm = ref<{ preferredCategories: string[]; maxActive: number; paused: boolean }>({
  preferredCategories: [],
  maxActive: 10,
  paused: false,
});

async function load() {
  loading.value = true;
  try {
    const [queue, stats] = await Promise.all([
      api.get<Paged<ReviewQueueItem>>("/moderation/queue", {
        pageSize: 50,
        overdueOnly: onlyOverdue.value ? "true" : undefined,
      }),
      api.get<{
        queue: { pending: number; inReview: number; overdue: number };
        today: { decided: number; approved: number; rejected: number };
        appeals: number;
        reports: { open: number };
        privacy: { pending: number };
        averageReviewHours: number;
      }>("/moderation/stats"),
    ]);

    items.value = queue.items;
    total.value = queue.total;
    statsRef.value = stats;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

const statsRef = ref<{
  queue: { pending: number; inReview: number; overdue: number };
  today: { decided: number; approved: number; rejected: number };
  appeals: number;
  reports: { open: number };
  privacy: { pending: number };
  averageReviewHours: number;
} | null>(null);

// 领取锁在服务端保证唯一性，前端只要把并发失败的结果如实告诉审核员
async function openTask(task: ReviewQueueItem) {
  selecting.value = task.id;
  try {
    await api.post(`/moderation/tasks/${task.id}/claim`);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes("领取")) {
      ElMessage.error(message);
      selecting.value = null;
      return;
    }
    // 已被他人领取时给出提示，但仍然允许打开查看
    ElMessage.warning(message);
  }

  selecting.value = null;
  void router.push({ name: "review-detail", params: { id: task.id } });
}

// 加权派单：系统按通过率、分类偏好、当前负载挑一条最合适的，直接进详情
async function smartClaim() {
  smartClaiming.value = true;
  try {
    const result = await api.post<{ taskId: string }>("/moderation/claim-next");
    ElMessage.success("已按你的审核画像加权派单，锁单 30 分钟");
    void router.push({ name: "review-detail", params: { id: result.taskId } });
  } catch (error) {
    ElMessage.warning((error as Error).message);
  } finally {
    smartClaiming.value = false;
  }
}

async function openProfile() {
  await catalog.load().catch(() => undefined);
  profile.value = await api.get<MyDispatchProfile>("/moderation/dispatch/me");
  profileForm.value = {
    preferredCategories: [...profile.value.preferredCategories],
    maxActive: profile.value.maxActive,
    paused: profile.value.paused,
  };
  profileVisible.value = true;
}

async function saveProfile() {
  profileSaving.value = true;
  try {
    profile.value = await api.patch<MyDispatchProfile>("/moderation/dispatch/me", profileForm.value);
    ElMessage.success("派单偏好已更新");
    profileVisible.value = false;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    profileSaving.value = false;
  }
}

function formatRate(rate: number | null): string {
  return rate === null ? "样本不足" : `${(rate * 100).toFixed(1)}%`;
}

onMounted(load);
</script>

<template>
  <div class="page page--wide">
    <h1 class="page-title">
      审核台
      <el-button size="small" @click="load">刷新</el-button>
    </h1>

    <el-row v-if="statsRef" :gutter="12" style="margin-bottom: 16px">
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>待领取</span><strong>{{ statsRef.queue.pending }}</strong></div></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>审核中</span><strong>{{ statsRef.queue.inReview }}</strong></div></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never">
          <div class="stat"><span>已超时</span><strong class="danger">{{ statsRef.queue.overdue }}</strong></div>
        </el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>今日已处理</span><strong>{{ statsRef.today.decided }}</strong></div></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>待处理举报</span><strong>{{ statsRef.reports.open }}</strong></div></el-card>
      </el-col>
      <el-col :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><div class="stat"><span>待确认隐私</span><strong>{{ statsRef.privacy.pending }}</strong></div></el-card>
      </el-col>
    </el-row>

    <div class="toolbar">
      <el-button type="primary" :loading="smartClaiming" @click="smartClaim">⚖ 智能领单（加权派单）</el-button>
      <el-button @click="openProfile">我的派单偏好</el-button>
      <el-checkbox v-model="onlyOverdue" @change="load">只看超时的</el-checkbox>
      <span class="muted">共 {{ total }} 条待处理</span>
      <span v-if="statsRef" class="muted">近 30 天平均处理时长 {{ statsRef.averageReviewHours }} 小时</span>
    </div>

    <el-table v-loading="loading" :data="items" style="width: 100%">
      <el-table-column label="条目" min-width="240">
        <template #default="{ row }">
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="category-chip" :style="{ background: row.spot.category.color }">
              {{ row.spot.category.name }}
            </span>
            <strong>{{ row.spot.title }}</strong>
          </div>
          <div class="muted" style="margin-top: 4px">
            作者 {{ row.spot.author.nickname }} · 信用分 {{ row.spot.author.creditScore }} ·
            已通过 {{ row.spot.author.approvedCount }} 条
          </div>
        </template>
      </el-table-column>

      <el-table-column label="图片" width="80">
        <template #default="{ row }">{{ row.spot.mediaCount }} 张</template>
      </el-table-column>

      <el-table-column label="状态" width="160">
        <template #default="{ row }">
          <el-tag v-if="row.overdue" type="danger" size="small">已超时</el-tag>
          <el-tag v-else-if="row.lockActive" :type="row.autoAssigned ? 'success' : 'warning'" size="small">
            {{ row.autoAssigned ? "已派单" : "已被领取" }}
          </el-tag>
          <el-tag v-else type="info" size="small">待领取</el-tag>
          <div v-if="row.claimedBy" class="muted" style="margin-top: 4px">{{ row.claimedBy }}</div>
        </template>
      </el-table-column>

      <el-table-column label="提交时间" width="170">
        <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString("zh-CN") }}</template>
      </el-table-column>

      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" :loading="selecting === row.id" @click="openTask(row)">
            领取并审核
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && items.length === 0" description="队列已清空，暂时没有待审核的条目" />

    <el-dialog v-model="profileVisible" title="我的派单偏好" width="520px">
      <div v-if="profile" class="profile-body">
        <el-alert type="info" :closable="false" show-icon>
          <template #title>
            系统按「分类偏好 × 近 {{ profile.stats.windowDays }} 天通过率 × 当前在手工单量」加权派单。
            通过率只做温和调节，主要看你擅长的分类和手上是否还有空位。
          </template>
        </el-alert>

        <div class="profile-stats">
          <div class="profile-stat">
            <span>近 {{ profile.stats.windowDays }} 天处理</span>
            <strong>{{ profile.stats.total }}</strong>
          </div>
          <div class="profile-stat">
            <span>通过率</span>
            <strong>{{ formatRate(profile.stats.approvalRate) }}</strong>
          </div>
        </div>

        <div class="field">
          <label>偏好分类（命中时派单权重加倍，不选为不限制）</label>
          <el-select
            v-model="profileForm.preferredCategories"
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
        </div>

        <div class="field">
          <label>同时在手工单上限（达到后系统不再给你派新单）</label>
          <el-input-number v-model="profileForm.maxActive" :min="1" :max="50" />
        </div>

        <div class="field">
          <el-switch v-model="profileForm.paused" active-text="暂停接收自动派单（仍可手动领取）" />
        </div>
      </div>
      <template #footer>
        <el-button @click="profileVisible = false">取消</el-button>
        <el-button type="primary" :loading="profileSaving" @click="saveProfile">保存</el-button>
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

.danger {
  color: var(--color-danger);
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
}

.profile-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.profile-stats {
  display: flex;
  gap: 12px;
}

.profile-stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  font-size: 13px;
  color: var(--color-text-soft);
}

.profile-stat strong {
  font-size: 20px;
  color: var(--color-text);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field label {
  font-size: 13px;
  color: var(--color-text-soft);
}
</style>
