-- Migration 0002 — course seed data (PRD 3.1: routes, stops, zones are "course team seed data").
-- Coordinates are approximate points around the Mae Fah Luang University campus.

INSERT INTO stops (id, name, lat, lng) VALUES
  ('S-GATE', 'Main Gate',            20.0424, 99.8951),
  ('S-LIB',  'Learning Resource Ctr', 20.0455, 99.8930),
  ('S-E1',   'E1 Building',          20.0470, 99.8912),
  ('S-C5',   'C5 Lecture Hall',      20.0489, 99.8898),
  ('S-DORM', 'Lamduan Dormitories',  20.0512, 99.8869);

INSERT INTO routes (id, name, active) VALUES
  ('R1', 'Campus Loop',   1),
  ('R2', 'Dorm Express',  1),
  ('R9', 'Night Shuttle', 0);

INSERT INTO route_stops (route_id, stop_id, seq) VALUES
  ('R1', 'S-GATE', 1), ('R1', 'S-LIB', 2), ('R1', 'S-E1', 3), ('R1', 'S-C5', 4), ('R1', 'S-DORM', 5),
  ('R2', 'S-DORM', 1), ('R2', 'S-E1', 2),  ('R2', 'S-GATE', 3),
  ('R9', 'S-GATE', 1), ('R9', 'S-DORM', 2);

INSERT INTO vehicles (id, route_id, last_stop_id, eta_next_stop_sec, delay_sec) VALUES
  ('V-01', 'R1', 'S-LIB',  180, 0),
  ('V-02', 'R1', 'S-C5',   240, 60),
  ('V-03', 'R2', 'S-DORM', 90,  0),
  ('V-04', NULL, NULL,     NULL, 0);   -- out of service, not assigned

INSERT INTO parking_zones (id, name, capacity, lat, lng) VALUES
  ('Z-GATE', 'Main Gate Car Park',  120, 20.0420, 99.8958),
  ('Z-LIB',  'Library Car Park',     80, 20.0452, 99.8938),
  ('Z-E1',   'E1 Staff Parking',     40, 20.0468, 99.8905),
  ('Z-DORM', 'Dormitory Car Park',  200, 20.0515, 99.8875);

INSERT INTO zone_permit_types (zone_id, permit_type) VALUES
  ('Z-GATE', 'student'), ('Z-GATE', 'visitor'),
  ('Z-LIB',  'student'), ('Z-LIB',  'staff'),
  ('Z-E1',   'staff'),   ('Z-E1',   'disabled'),
  ('Z-DORM', 'student');

INSERT INTO availability (zone_id, free) VALUES
  ('Z-GATE', 45),
  ('Z-LIB',  0),      -- full: exercises the "no free zone" branch of the planner
  ('Z-E1',   12),
  ('Z-DORM', 133);
