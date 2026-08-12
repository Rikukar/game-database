CREATE TABLE "ingest_checkpoints" (
	"stage" text PRIMARY KEY NOT NULL,
	"last_igdb_id" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
--> Hand-edited: drizzle-kit emits a bare SET DATA TYPE here, but PostgreSQL has
--> no automatic cast from char(2) to smallint and rejects it. IGDB returns
--> ISO 3166-1 numeric rather than alpha-2, and nothing has been ingested yet,
--> so there is no data to preserve and no USING clause worth writing.
ALTER TABLE "companies" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "country" smallint;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "alternative_names" text[] DEFAULT '{}' NOT NULL;