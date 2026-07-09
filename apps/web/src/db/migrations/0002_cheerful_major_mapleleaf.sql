CREATE TYPE "public"."page_redirect_kind" AS ENUM('permanent');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'move';--> statement-breakpoint
CREATE TABLE "pageRedirect" (
	"sourceCollectionSlug" text NOT NULL,
	"sourceFileSlug" text NOT NULL,
	"targetPageId" text NOT NULL,
	"kind" "page_redirect_kind" DEFAULT 'permanent' NOT NULL,
	"createdBy" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "page_redirect_source_pk" PRIMARY KEY("sourceCollectionSlug","sourceFileSlug")
);
--> statement-breakpoint
ALTER TABLE "auditEvent" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "pageRedirect" ADD CONSTRAINT "pageRedirect_sourceCollectionSlug_collection_slug_fk" FOREIGN KEY ("sourceCollectionSlug") REFERENCES "public"."collection"("slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pageRedirect" ADD CONSTRAINT "pageRedirect_targetPageId_page_id_fk" FOREIGN KEY ("targetPageId") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pageRedirect" ADD CONSTRAINT "pageRedirect_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_redirect_target_page_id_idx" ON "pageRedirect" USING btree ("targetPageId");