-- 加权派单：审核员画像 + 临时加派批次 + 任务派单来源
--
-- 手工编写，沿用 20260102000000 迁移的约定：
-- 不要直接套用 prisma migrate diff 生成的 SQL，它会误删 spots 表上的手工索引。

-- ============ 审核员派单画像 ============
CREATE TABLE "moderator_profiles" (
    "user_id" BIGINT NOT NULL,
    "weight_factor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "max_active" SMALLINT NOT NULL DEFAULT 10,
    "preferred_categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "dispatch_paused_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderator_profiles_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "moderator_profiles"
    ADD CONSTRAINT "moderator_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============ 临时加派批次 ============
CREATE TABLE "dispatch_surges" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "created_by" BIGINT NOT NULL,
    "boost_factor" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "category_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "reason" VARCHAR(200),
    "role_promoted" BOOLEAN NOT NULL DEFAULT FALSE,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "ended_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_surges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_surge_user_active" ON "dispatch_surges"("user_id", "ended_at");
CREATE INDEX "idx_surge_expires" ON "dispatch_surges"("expires_at");

ALTER TABLE "dispatch_surges"
    ADD CONSTRAINT "dispatch_surges_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dispatch_surges"
    ADD CONSTRAINT "dispatch_surges_ended_by_fkey"
    FOREIGN KEY ("ended_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============ 审核任务的派单来源 ============
ALTER TABLE "review_tasks" ADD COLUMN "dispatch_meta" JSONB;
