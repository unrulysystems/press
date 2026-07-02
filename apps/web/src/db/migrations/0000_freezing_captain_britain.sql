CREATE TYPE "public"."audit_action" AS ENUM('publish', 'overwrite', 'unpublish', 'visibility-change', 'password-reroll', 'token-revoke');--> statement-breakpoint
CREATE TYPE "public"."page_visibility" AS ENUM('default', 'public', 'password', 'private');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apiToken" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"tokenHash" text NOT NULL,
	"lastUsedAt" timestamp,
	"revokedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"action" "audit_action" NOT NULL,
	"collectionSlug" text NOT NULL,
	"fileSlug" text,
	"contentHash" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection" (
	"slug" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"title" text,
	"defaultVisibility" "page_visibility" DEFAULT 'default' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page" (
	"id" text PRIMARY KEY NOT NULL,
	"collectionSlug" text NOT NULL,
	"fileSlug" text NOT NULL,
	"title" text NOT NULL,
	"visibility" "page_visibility" DEFAULT 'default' NOT NULL,
	"passwordHash" text,
	"allowlist" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"contentHash" text NOT NULL,
	"sizeBytes" integer NOT NULL,
	"publishedBy" text NOT NULL,
	"publishedAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"archivedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	"impersonatedBy" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"banReason" text,
	"banExpires" timestamp,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apiToken" ADD CONSTRAINT "apiToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditEvent" ADD CONSTRAINT "auditEvent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditEvent" ADD CONSTRAINT "auditEvent_collectionSlug_collection_slug_fk" FOREIGN KEY ("collectionSlug") REFERENCES "public"."collection"("slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_collectionSlug_collection_slug_fk" FOREIGN KEY ("collectionSlug") REFERENCES "public"."collection"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_publishedBy_user_id_fk" FOREIGN KEY ("publishedBy") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "api_token_hash_idx" ON "apiToken" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "api_token_user_id_idx" ON "apiToken" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "audit_event_user_id_idx" ON "auditEvent" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "audit_event_collection_slug_idx" ON "auditEvent" USING btree ("collectionSlug");--> statement-breakpoint
CREATE INDEX "audit_event_created_at_idx" ON "auditEvent" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "page_collection_file_idx" ON "page" USING btree ("collectionSlug","fileSlug");--> statement-breakpoint
CREATE INDEX "page_collection_slug_idx" ON "page" USING btree ("collectionSlug");--> statement-breakpoint
CREATE INDEX "page_published_at_idx" ON "page" USING btree ("publishedAt");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");