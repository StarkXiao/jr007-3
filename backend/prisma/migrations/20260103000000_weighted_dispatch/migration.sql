-- 加权派单 + 临时加派
--
-- 1. moderator_profiles：审核员画像（历史通过率、各分类偏好、派单容量系数），
--    由已决任务滚动统计 + 管理员手工权重共同决定。
-- 2. temp_assignments：临时加派批次，普通用户临时提权为审核员接管积压，
--    到期或撤销后恢复原角色。

-- 加派批次状态
DO $$ BEGIN
  CREATE TYPE "TempAssignmentStatus" AS ENUM ('active', 'expired', 'revoked');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "moderator_profiles" (
  "user_id" BIGINT NOT NULL,
  "decided_count" INTEGER NOT NULL DEFAULT 0,
  "approved_count" INTEGER NOT NULL DEFAULT 0,
  "category_stats" JSONB NOT NULL DEFAULT '{}',
  "category_weights" JSONB NOT NULL DEFAULT '{}',
  "capacity_factor" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "dispatch_enabled" BOOLEAN NOT NULL DEFAULT true,
  "stats_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "moderator_profiles_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "moderator_profiles_capacity_factor_check" CHECK ("capacity_factor" >= 0 AND "capacity_factor" <= 2)
);

CREATE TABLE "temp_assignments" (
  "id" BIGSERIAL NOT NULL,
  "batch_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" BIGINT NOT NULL,
  "granted_by" BIGINT NOT NULL,
  "original_role" "UserRole" NOT NULL,
  "status" "TempAssignmentStatus" NOT NULL DEFAULT 'active',
  "reason" VARCHAR(200) NOT NULL,
  "task_limit" INTEGER NOT NULL DEFAULT 0,
  "assigned_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "temp_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "temp_assignments_batch_id_key" UNIQUE ("batch_id"),
  CONSTRAINT "temp_assignments_task_limit_check" CHECK ("task_limit" >= 0 AND "task_limit" <= 100)
);

CREATE INDEX "idx_temp_assignment_user" ON "temp_assignments"("user_id", "status");
CREATE INDEX "idx_temp_assignment_status" ON "temp_assignments"("status", "expires_at");

ALTER TABLE "moderator_profiles"
  ADD CONSTRAINT "moderator_profiles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "temp_assignments"
  ADD CONSTRAINT "temp_assignments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "temp_assignments"
  ADD CONSTRAINT "temp_assignments_granted_by_fkey"
  FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON UPDATE CASCADE;
