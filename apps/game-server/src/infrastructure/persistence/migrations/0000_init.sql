CREATE TYPE "ai_fallback_reason" AS ENUM('TIMEOUT', 'HTTP_ERROR', 'INVALID_JSON', 'ILLEGAL_ACTION', 'PROVIDER_ERROR');--> statement-breakpoint
CREATE TYPE "ai_request_status" AS ENUM('SUCCESS', 'FALLBACK');--> statement-breakpoint
CREATE TYPE "hand_end_reason" AS ENUM('ALL_FOLDED', 'SHOWDOWN', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "room_player_left_reason" AS ENUM('USER_LEFT', 'DISCONNECT_TIMEOUT', 'ROOM_CLOSED');--> statement-breakpoint
CREATE TYPE "player_kind" AS ENUM('HUMAN', 'BOT');--> statement-breakpoint
CREATE TYPE "poker_status" AS ENUM('ACTIVE', 'ELIMINATED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "room_mode" AS ENUM('MULTIPLAYER', 'SINGLE_PLAYER');--> statement-breakpoint
CREATE TYPE "room_player_status" AS ENUM('ACTIVE', 'LEFT');--> statement-breakpoint
CREATE TYPE "room_status" AS ENUM('CREATED', 'LOBBY', 'IN_GAME', 'FINISHED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "tournament_status" AS ENUM('IN_GAME', 'FINISHED', 'ABANDONED_NO_HUMAN');--> statement-breakpoint
CREATE TABLE "ai_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tournament_id" uuid NOT NULL,
	"tournament_player_id" uuid NOT NULL,
	"hand_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer NOT NULL,
	"status" "ai_request_status" NOT NULL,
	"fallback_reason" "ai_fallback_reason",
	"provider_status_code" integer,
	"cost" numeric(18, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_requests_fallback_reason_check" CHECK (("status" = 'FALLBACK') = ("fallback_reason" IS NOT NULL)),
	CONSTRAINT "ai_requests_latency_ms_check" CHECK ("latency_ms" >= 0),
	CONSTRAINT "ai_requests_input_tokens_check" CHECK ("input_tokens" IS NULL OR "input_tokens" >= 0),
	CONSTRAINT "ai_requests_output_tokens_check" CHECK ("output_tokens" IS NULL OR "output_tokens" >= 0),
	CONSTRAINT "ai_requests_cost_check" CHECK ("cost" IS NULL OR "cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "game_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"hand_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"engine_version" text NOT NULL,
	"state_checksum" "bytea" NOT NULL,
	"commit_checksum" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_snapshots_sequence_check" CHECK ("sequence" > 0),
	CONSTRAINT "game_snapshots_schema_version_check" CHECK ("schema_version" > 0),
	CONSTRAINT "game_snapshots_state_checksum_check" CHECK (octet_length("state_checksum") = 32),
	CONSTRAINT "game_snapshots_commit_checksum_check" CHECK (octet_length("commit_checksum") = 32)
);
--> statement-breakpoint
CREATE TABLE "hand_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hand_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tournament_id" uuid NOT NULL,
	"hand_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"hand_sequence" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hand_events_sequence_check" CHECK ("sequence" > 0),
	CONSTRAINT "hand_events_hand_sequence_check" CHECK ("hand_sequence" > 0),
	CONSTRAINT "hand_events_schema_version_check" CHECK ("schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "hands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"hand_number" integer NOT NULL,
	"dealer_seat" smallint NOT NULL,
	"sb_seat" smallint NOT NULL,
	"bb_seat" smallint NOT NULL,
	"blind_level_index" integer NOT NULL,
	"small_blind" bigint NOT NULL,
	"big_blind" bigint NOT NULL,
	"community_cards" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"end_reason" "hand_end_reason" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hands_hand_number_check" CHECK ("hand_number" > 0),
	CONSTRAINT "hands_dealer_seat_check" CHECK ("dealer_seat" BETWEEN 0 AND 9),
	CONSTRAINT "hands_sb_seat_check" CHECK ("sb_seat" BETWEEN 0 AND 9),
	CONSTRAINT "hands_bb_seat_check" CHECK ("bb_seat" BETWEEN 0 AND 9),
	CONSTRAINT "hands_blind_level_index_check" CHECK ("blind_level_index" >= 0),
	CONSTRAINT "hands_blinds_check" CHECK ("small_blind" > 0 AND "big_blind" > "small_blind"),
	CONSTRAINT "hands_community_cards_check" CHECK (jsonb_typeof("community_cards") = 'array' AND jsonb_array_length("community_cards") BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" "room_mode" NOT NULL,
	"invite_code" text,
	"status" "room_status" NOT NULL,
	"config_json" jsonb NOT NULL,
	"host_player_id" uuid,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"retention_expires_at" timestamp with time zone,
	CONSTRAINT "rooms_invite_code_check" CHECK (("mode" = 'MULTIPLAYER' AND "invite_code" ~ '^[A-HJKMNPQRSTUVWXYZ2-9]{6}$') OR ("mode" = 'SINGLE_PLAYER' AND "invite_code" IS NULL)),
	CONSTRAINT "rooms_closed_at_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL)),
	CONSTRAINT "rooms_closed_reason_check" CHECK ("status" <> 'CLOSED' OR "closed_reason" IS NOT NULL),
	CONSTRAINT "rooms_retention_check" CHECK ((("status" = 'CLOSED') = ("retention_expires_at" IS NOT NULL)) AND ("retention_expires_at" IS NULL OR "closed_at" IS NULL OR "retention_expires_at" >= "closed_at"))
);
--> statement-breakpoint
CREATE TABLE "room_players" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"display_name_key" text NOT NULL,
	"kind" "player_kind" NOT NULL,
	"token_digest" "bytea",
	"token_key_id" text,
	"status" "room_player_status" NOT NULL,
	"left_reason" "room_player_left_reason",
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "room_players_token_check" CHECK (("kind" = 'HUMAN' AND "token_digest" IS NOT NULL AND "token_key_id" IS NOT NULL) OR ("kind" = 'BOT' AND "token_digest" IS NULL AND "token_key_id" IS NULL)),
	CONSTRAINT "room_players_token_digest_length_check" CHECK ("token_digest" IS NULL OR octet_length("token_digest") = 32),
	CONSTRAINT "room_players_left_at_check" CHECK (("status" = 'LEFT') = ("left_at" IS NOT NULL)),
	CONSTRAINT "room_players_left_reason_check" CHECK (("status" = 'LEFT') = ("left_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"tournament_no" integer NOT NULL,
	"status" "tournament_status" NOT NULL,
	"config_json" jsonb NOT NULL,
	"champion_tournament_player_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"retention_expires_at" timestamp with time zone,
	"last_committed_sequence" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tournaments_finished_at_check" CHECK (("status" = 'IN_GAME') = ("finished_at" IS NULL)),
	CONSTRAINT "tournaments_retention_check" CHECK ((("status" = 'IN_GAME') = ("retention_expires_at" IS NULL)) AND ("retention_expires_at" IS NULL OR "finished_at" IS NULL OR "retention_expires_at" >= "finished_at")),
	CONSTRAINT "tournaments_last_committed_sequence_check" CHECK ("last_committed_sequence" >= 0),
	CONSTRAINT "tournaments_champion_check" CHECK ("champion_tournament_player_id" IS NULL OR "status" = 'FINISHED')
);
--> statement-breakpoint
CREATE TABLE "tournament_players" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tournament_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"seat_index" smallint NOT NULL,
	"kind" "player_kind" NOT NULL,
	"starting_stack" bigint NOT NULL,
	"final_stack" bigint,
	"forfeited_chips" bigint DEFAULT 0 NOT NULL,
	"poker_status" "poker_status" NOT NULL,
	"rank" integer,
	"eliminated_hand_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournament_players_seat_index_check" CHECK ("seat_index" BETWEEN 0 AND 9),
	CONSTRAINT "tournament_players_starting_stack_check" CHECK ("starting_stack" > 0),
	CONSTRAINT "tournament_players_final_stack_check" CHECK ("final_stack" IS NULL OR "final_stack" >= 0),
	CONSTRAINT "tournament_players_forfeited_chips_check" CHECK ("forfeited_chips" >= 0),
	CONSTRAINT "tournament_players_rank_check" CHECK ("rank" IS NULL OR "rank" > 0)
);
--> statement-breakpoint
CREATE INDEX "ai_requests_tournament_created_at_idx" ON "ai_requests" USING btree ("tournament_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "game_snapshots_tournament_hand_unique" ON "game_snapshots" USING btree ("tournament_id","hand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_snapshots_tournament_sequence_unique" ON "game_snapshots" USING btree ("tournament_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "hand_events_tournament_sequence_unique" ON "hand_events" USING btree ("tournament_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "hand_events_hand_hand_sequence_unique" ON "hand_events" USING btree ("hand_id","hand_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "hands_tournament_hand_number_unique" ON "hands" USING btree ("tournament_id","hand_number");--> statement-breakpoint
CREATE UNIQUE INDEX "hands_id_tournament_id_unique" ON "hands" USING btree ("id","tournament_id");--> statement-breakpoint
CREATE INDEX "hands_tournament_hand_number_desc_idx" ON "hands" USING btree ("tournament_id","hand_number" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_invite_code_active_unique" ON "rooms" USING btree ("invite_code") WHERE status <> 'CLOSED' AND mode = 'MULTIPLAYER';--> statement-breakpoint
CREATE INDEX "rooms_retention_expires_at_idx" ON "rooms" USING btree ("retention_expires_at") WHERE retention_expires_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "room_players_room_id_id_unique" ON "room_players" USING btree ("room_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_players_display_name_key_unique" ON "room_players" USING btree ("room_id","display_name_key");--> statement-breakpoint
CREATE INDEX "room_players_room_status_joined_idx" ON "room_players" USING btree ("room_id","status","joined_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournaments_room_tournament_no_unique" ON "tournaments" USING btree ("room_id","tournament_no");--> statement-breakpoint
CREATE UNIQUE INDEX "tournaments_id_room_id_unique" ON "tournaments" USING btree ("id","room_id");--> statement-breakpoint
CREATE INDEX "tournaments_retention_expires_at_idx" ON "tournaments" USING btree ("retention_expires_at") WHERE retention_expires_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_players_tournament_player_unique" ON "tournament_players" USING btree ("tournament_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_players_tournament_seat_unique" ON "tournament_players" USING btree ("tournament_id","seat_index");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_players_tournament_rank_unique" ON "tournament_players" USING btree ("tournament_id","rank") WHERE rank IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_players_tournament_id_unique" ON "tournament_players" USING btree ("tournament_id","id");--> statement-breakpoint
CREATE INDEX "tournament_players_tournament_idx" ON "tournament_players" USING btree ("tournament_id");
--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_tournament_player_fk" FOREIGN KEY ("tournament_id","tournament_player_id") REFERENCES "tournament_players"("tournament_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_hand_fk" FOREIGN KEY ("hand_id","tournament_id") REFERENCES "hands"("id","tournament_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_snapshots" ADD CONSTRAINT "game_snapshots_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_snapshots" ADD CONSTRAINT "game_snapshots_hand_fk" FOREIGN KEY ("hand_id","tournament_id") REFERENCES "hands"("id","tournament_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_events" ADD CONSTRAINT "hand_events_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_events" ADD CONSTRAINT "hand_events_hand_fk" FOREIGN KEY ("hand_id","tournament_id") REFERENCES "hands"("id","tournament_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hands" ADD CONSTRAINT "hands_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_tournament_fk" FOREIGN KEY ("tournament_id","room_id") REFERENCES "tournaments"("id","room_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_player_fk" FOREIGN KEY ("room_id","player_id") REFERENCES "room_players"("room_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_eliminated_hand_fk" FOREIGN KEY ("eliminated_hand_id","tournament_id") REFERENCES "hands"("id","tournament_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
