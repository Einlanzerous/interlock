-- Enabled at first boot of the Postgres volume. The canonical schema and its
-- FTS/trigram indexes are created by migrations in ITLK-3; this only guarantees
-- the extensions those migrations depend on are present.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
