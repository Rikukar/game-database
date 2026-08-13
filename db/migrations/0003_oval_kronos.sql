CREATE TYPE "public"."game_status" AS ENUM('released', 'alpha', 'beta', 'early_access', 'offline', 'cancelled', 'rumored', 'delisted');--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "status" "game_status";--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "total_rating" real;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "total_rating_count" integer DEFAULT 0 NOT NULL;