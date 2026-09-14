ALTER TABLE "rooms" ADD COLUMN "room_revision_ceiling" bigint DEFAULT 4294967295 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_room_revision_ceiling_check" CHECK ("room_revision_ceiling" BETWEEN 4294967295 AND 9007199254740991);
