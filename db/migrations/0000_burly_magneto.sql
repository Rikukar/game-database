CREATE TYPE "public"."company_role" AS ENUM('developer', 'publisher', 'porting', 'supporting');--> statement-breakpoint
CREATE TYPE "public"."game_category" AS ENUM('main_game', 'dlc', 'expansion', 'standalone_expansion', 'bundle', 'remake', 'remaster', 'port', 'episode', 'season', 'mod');--> statement-breakpoint
CREATE TYPE "public"."library_status" AS ENUM('wishlist', 'backlog', 'playing', 'completed', 'dropped');--> statement-breakpoint
CREATE TABLE "companies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "companies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"igdb_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"country" char(2),
	"founded_at" date,
	"description" text,
	CONSTRAINT "companies_igdb_id_unique" UNIQUE("igdb_id"),
	CONSTRAINT "companies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "franchises" (
	"id" smallint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "franchises_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 32767 START WITH 1 CACHE 1),
	"igdb_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "franchises_igdb_id_unique" UNIQUE("igdb_id"),
	CONSTRAINT "franchises_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "game_companies" (
	"game_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"role" "company_role" NOT NULL,
	CONSTRAINT "game_companies_game_id_company_id_role_pk" PRIMARY KEY("game_id","company_id","role")
);
--> statement-breakpoint
CREATE TABLE "game_genres" (
	"game_id" integer NOT NULL,
	"genre_id" smallint NOT NULL,
	CONSTRAINT "game_genres_game_id_genre_id_pk" PRIMARY KEY("game_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "game_keywords" (
	"game_id" integer NOT NULL,
	"keyword_id" integer NOT NULL,
	CONSTRAINT "game_keywords_game_id_keyword_id_pk" PRIMARY KEY("game_id","keyword_id")
);
--> statement-breakpoint
CREATE TABLE "game_platforms" (
	"game_id" integer NOT NULL,
	"platform_id" smallint NOT NULL,
	CONSTRAINT "game_platforms_game_id_platform_id_pk" PRIMARY KEY("game_id","platform_id")
);
--> statement-breakpoint
CREATE TABLE "game_similarity" (
	"game_id" integer NOT NULL,
	"similar_game_id" integer NOT NULL,
	"score" real NOT NULL,
	CONSTRAINT "game_similarity_game_id_similar_game_id_pk" PRIMARY KEY("game_id","similar_game_id"),
	CONSTRAINT "similarity_not_self" CHECK ("game_similarity"."game_id" <> "game_similarity"."similar_game_id")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "games_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"igdb_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" "game_category" DEFAULT 'main_game' NOT NULL,
	"parent_game_id" integer,
	"franchise_id" smallint,
	"summary" text,
	"storyline" text,
	"cover_url" text,
	"first_release_date" date,
	"igdb_rating" real,
	"igdb_rating_count" integer DEFAULT 0 NOT NULL,
	"critic_rating" real,
	"search_extra" text DEFAULT '' NOT NULL,
	"genre_ids" smallint[] DEFAULT '{}' NOT NULL,
	"platform_ids" smallint[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple',  coalesce(name, '')),         'A') ||
          setweight(to_tsvector('simple',  coalesce(search_extra, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(summary, '')),      'C')) STORED,
	CONSTRAINT "games_igdb_id_unique" UNIQUE("igdb_id"),
	CONSTRAINT "games_slug_unique" UNIQUE("slug"),
	CONSTRAINT "games_rating_range" CHECK ("games"."igdb_rating" IS NULL OR "games"."igdb_rating" BETWEEN 0 AND 100),
	CONSTRAINT "games_not_own_parent" CHECK ("games"."parent_game_id" IS DISTINCT FROM "games"."id")
);
--> statement-breakpoint
CREATE TABLE "genres" (
	"id" smallint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "genres_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 32767 START WITH 1 CACHE 1),
	"igdb_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "genres_igdb_id_unique" UNIQUE("igdb_id"),
	CONSTRAINT "genres_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "keywords_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"igdb_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "keywords_igdb_id_unique" UNIQUE("igdb_id"),
	CONSTRAINT "keywords_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "library_entries" (
	"user_id" integer NOT NULL,
	"game_id" integer NOT NULL,
	"status" "library_status" DEFAULT 'backlog' NOT NULL,
	"rating" smallint,
	"hours_played" numeric(6, 1),
	"notes" text,
	"started_at" date,
	"finished_at" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_entries_user_id_game_id_pk" PRIMARY KEY("user_id","game_id"),
	CONSTRAINT "library_rating_range" CHECK ("library_entries"."rating" BETWEEN 1 AND 10),
	CONSTRAINT "library_hours_positive" CHECK ("library_entries"."hours_played" >= 0),
	CONSTRAINT "library_finished_after_started" CHECK ("library_entries"."finished_at" IS NULL OR "library_entries"."started_at" IS NULL OR "library_entries"."finished_at" >= "library_entries"."started_at")
);
--> statement-breakpoint
CREATE TABLE "platforms" (
	"id" smallint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platforms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 32767 START WITH 1 CACHE 1),
	"igdb_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text,
	"family" text,
	"generation" smallint,
	CONSTRAINT "platforms_igdb_id_unique" UNIQUE("igdb_id"),
	CONSTRAINT "platforms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "release_dates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "release_dates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"game_id" integer NOT NULL,
	"platform_id" smallint NOT NULL,
	"region" text DEFAULT 'worldwide' NOT NULL,
	"released_on" date,
	"date_precision" text DEFAULT 'day' NOT NULL,
	CONSTRAINT "release_dates_game_platform_region_key" UNIQUE("game_id","platform_id","region"),
	CONSTRAINT "release_dates_precision_valid" CHECK ("release_dates"."date_precision" IN ('day', 'month', 'quarter', 'year', 'tbd'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"external_id" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "game_companies" ADD CONSTRAINT "game_companies_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_companies" ADD CONSTRAINT "game_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_genres" ADD CONSTRAINT "game_genres_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_genres" ADD CONSTRAINT "game_genres_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_keywords" ADD CONSTRAINT "game_keywords_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_keywords" ADD CONSTRAINT "game_keywords_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_platforms" ADD CONSTRAINT "game_platforms_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_platforms" ADD CONSTRAINT "game_platforms_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_similarity" ADD CONSTRAINT "game_similarity_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_similarity" ADD CONSTRAINT "game_similarity_similar_game_id_games_id_fk" FOREIGN KEY ("similar_game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_parent_game_id_games_id_fk" FOREIGN KEY ("parent_game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_franchise_id_franchises_id_fk" FOREIGN KEY ("franchise_id") REFERENCES "public"."franchises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_dates" ADD CONSTRAINT "release_dates_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_dates" ADD CONSTRAINT "release_dates_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_name_trgm_idx" ON "companies" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "game_companies_reverse_idx" ON "game_companies" USING btree ("company_id","role","game_id");--> statement-breakpoint
CREATE INDEX "game_genres_reverse_idx" ON "game_genres" USING btree ("genre_id","game_id");--> statement-breakpoint
CREATE INDEX "game_keywords_reverse_idx" ON "game_keywords" USING btree ("keyword_id","game_id");--> statement-breakpoint
CREATE INDEX "game_platforms_reverse_idx" ON "game_platforms" USING btree ("platform_id","game_id");--> statement-breakpoint
CREATE INDEX "game_similarity_top_idx" ON "game_similarity" USING btree ("game_id","score" DESC);--> statement-breakpoint
CREATE INDEX "games_search_idx" ON "games" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "games_name_trgm_idx" ON "games" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "games_genres_idx" ON "games" USING gin ("genre_ids");--> statement-breakpoint
CREATE INDEX "games_platforms_idx" ON "games" USING gin ("platform_ids");--> statement-breakpoint
CREATE INDEX "games_release_idx" ON "games" USING btree ("first_release_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "games_top_rated_idx" ON "games" USING btree ("igdb_rating" DESC) WHERE "games"."igdb_rating_count" >= 50;--> statement-breakpoint
CREATE INDEX "games_parent_idx" ON "games" USING btree ("parent_game_id") WHERE "games"."parent_game_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "games_franchise_idx" ON "games" USING btree ("franchise_id") WHERE "games"."franchise_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "library_user_status_idx" ON "library_entries" USING btree ("user_id","status","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "library_game_idx" ON "library_entries" USING btree ("game_id","status");--> statement-breakpoint
CREATE INDEX "library_ratings_idx" ON "library_entries" USING btree ("game_id","rating") WHERE "library_entries"."rating" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "release_dates_game_idx" ON "release_dates" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "release_dates_platform_idx" ON "release_dates" USING btree ("platform_id","released_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "release_dates_upcoming_idx" ON "release_dates" USING btree ("released_on") WHERE "release_dates"."released_on" IS NOT NULL;