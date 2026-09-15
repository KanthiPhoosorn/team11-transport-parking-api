-- Migration 0001 — Team 11 Transport & Parking, core schema (Cloudflare D1 / SQLite)
--
-- Derived from PRD Phase 3 (entities & ownership) and 3.2 (invariants).
-- Design notes:
--   * IDs are short slugs matching the PRD contract regex ^[A-Za-z0-9_-]{1,40}$,
--     so they can appear in URLs (/v1/parking/Z-LIB) and in other teams' events.
--   * The PRD's array fields (Route.stopIds[], Stop.routeIds[], ParkingZone.permitTypes[])
--     become join tables — third normal form, and queryable with plain SQL.
--   * Availability is its own table because it has a different OWNER (the parking
--     operator) and a different write rate from ParkingZone (course seed data).
--   * Journey has NO table on purpose: it is computed per request (PRD "privacy by
--     design"). Permit lives with the Identity team; we only store a permit_type string.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- shuttle side
CREATE TABLE routes (
  id         TEXT PRIMARY KEY CHECK (id GLOB '[A-Za-z0-9_-]*' AND length(id) BETWEEN 1 AND 40),
  name       TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE stops (
  id   TEXT PRIMARY KEY CHECK (id GLOB '[A-Za-z0-9_-]*' AND length(id) BETWEEN 1 AND 40),
  name TEXT NOT NULL,
  lat  REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng  REAL NOT NULL CHECK (lng BETWEEN -180 AND 180)
);

-- Route.stopIds[] / Stop.routeIds[]  ->  ordered many-to-many
CREATE TABLE route_stops (
  route_id TEXT    NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  stop_id  TEXT    NOT NULL REFERENCES stops(id)  ON DELETE RESTRICT,
  seq      INTEGER NOT NULL CHECK (seq >= 1),
  PRIMARY KEY (route_id, stop_id),
  UNIQUE (route_id, seq)
);

-- VehicleStatus: one row per shuttle, written by the dispatcher / GPS feed
CREATE TABLE vehicles (
  id               TEXT PRIMARY KEY CHECK (id GLOB '[A-Za-z0-9_-]*' AND length(id) BETWEEN 1 AND 40),
  route_id         TEXT    REFERENCES routes(id) ON DELETE SET NULL,
  last_stop_id     TEXT    REFERENCES stops(id)  ON DELETE SET NULL,
  eta_next_stop_sec INTEGER CHECK (eta_next_stop_sec IS NULL OR eta_next_stop_sec >= 0),
  delay_sec        INTEGER NOT NULL DEFAULT 0 CHECK (delay_sec >= 0),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_vehicles_route ON vehicles(route_id);

-- ---------------------------------------------------------------- parking side
CREATE TABLE parking_zones (
  id         TEXT PRIMARY KEY CHECK (id GLOB '[A-Za-z0-9_-]*' AND length(id) BETWEEN 1 AND 40),
  name       TEXT    NOT NULL,
  capacity   INTEGER NOT NULL CHECK (capacity > 0),
  lat        REAL    NOT NULL,
  lng        REAL    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ParkingZone.permitTypes[]  ->  join table. permit_type is a reference to the
-- Identity team's Permit; we never store permit holders.
CREATE TABLE zone_permit_types (
  zone_id     TEXT NOT NULL REFERENCES parking_zones(id) ON DELETE CASCADE,
  permit_type TEXT NOT NULL CHECK (permit_type IN ('student', 'staff', 'visitor', 'disabled')),
  PRIMARY KEY (zone_id, permit_type)
);

-- Availability: owned by the parking OPERATOR only. `version` is the optimistic
-- concurrency token that closes the PRD 3.2 race (two operators PATCH at once).
CREATE TABLE availability (
  zone_id    TEXT    PRIMARY KEY REFERENCES parking_zones(id) ON DELETE CASCADE,
  free       INTEGER NOT NULL CHECK (free >= 0),
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Invariant 0 <= free <= capacity. A CHECK cannot look at another table, so the
-- upper bound is a trigger — the database refuses the write, not just the API.
CREATE TRIGGER trg_availability_free_le_capacity_ins
BEFORE INSERT ON availability
BEGIN
  SELECT RAISE(ABORT, 'free exceeds zone capacity')
  WHERE NEW.free > (SELECT capacity FROM parking_zones WHERE id = NEW.zone_id);
END;

CREATE TRIGGER trg_availability_free_le_capacity_upd
BEFORE UPDATE OF free ON availability
BEGIN
  SELECT RAISE(ABORT, 'free exceeds zone capacity')
  WHERE NEW.free > (SELECT capacity FROM parking_zones WHERE id = NEW.zone_id);
END;

-- ---------------------------------------------------------------- events
-- Alerts raised by operators/dispatchers (API-6) and the edge-triggered events
-- from PRD 4.4 (parking.full, route.delayed). Other teams read these; the
-- webhook delivery itself is Assignment 5's concern.
CREATE TABLE alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('service.alert', 'route.delayed', 'parking.full')),
  route_id    TEXT    REFERENCES routes(id)        ON DELETE SET NULL,
  zone_id     TEXT    REFERENCES parking_zones(id) ON DELETE SET NULL,
  message     TEXT    NOT NULL,
  raised_by   TEXT    NOT NULL,   -- 'operator' | 'dispatcher' | 'system'
  occurred_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_alerts_occurred ON alerts(occurred_at DESC);
