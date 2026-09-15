// Team 11 Transport & Parking — Assignment 3: data + query design.
// Cloudflare Workers + Hono + D1. Implements the PRD /v1 contract (API-1..7)
// and full CRUD on every stored entity. Journeys are computed, never stored.

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

type Bindings = { DB: D1Database; OPERATOR_TOKEN?: string; DISPATCHER_TOKEN?: string };
type Role = "operator" | "dispatcher";
type Env = { Bindings: Bindings; Variables: { role?: Role } };
type C = Context<Env>;

const ID = /^[A-Za-z0-9_-]{1,40}$/;                 // PRD 4.3 id rule
const PERMITS = ["student", "staff", "visitor", "disabled"] as const;
const now = () => new Date().toISOString();

const app = new Hono<Env>();
app.use("/*", cors());

// ---------------------------------------------------------------- helpers
const fail = (c: C, status: 400 | 401 | 403 | 404 | 409 | 422, error: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, ...extra }, status);

function requireRole(c: C, ...allowed: Role[]): Response | null {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return fail(c, 401, "Bearer token required");
  const role: Role | null =
    token === c.env.OPERATOR_TOKEN ? "operator" : token === c.env.DISPATCHER_TOKEN ? "dispatcher" : null;
  if (!role) return fail(c, 401, "Invalid token");
  if (!allowed.includes(role)) return fail(c, 403, `Requires role: ${allowed.join(" or ")}`, { your_role: role });
  c.set("role", role);
  return null;
}

const validId = (c: C, raw: string | undefined) => (raw && ID.test(raw) ? raw : null);
const readJson = <T>(c: C) => c.req.json<T>().catch(() => null);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** SQLite raises our trigger / FK errors as generic D1 errors — map them to the PRD error model. */
function dbError(c: C, err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  if (/free exceeds zone capacity/.test(msg)) return fail(c, 422, "free must be <= capacity");
  if (/FOREIGN KEY constraint failed/.test(msg)) return fail(c, 409, "Operation violates a reference (foreign key)");
  if (/UNIQUE constraint failed|PRIMARY KEY/.test(msg)) return fail(c, 409, "Already exists");
  if (/CHECK constraint failed/.test(msg)) return fail(c, 422, "Value rejected by a database CHECK constraint", { detail: msg });
  throw err;
}

app.get("/", (c) =>
  c.json({
    name: "Team 11 Transport & Parking API",
    database: "Cloudflare D1 (SQLite)",
    public: ["GET /v1/routes", "GET /v1/routes/:id", "GET /v1/routes/:id/stops", "GET /v1/stops", "GET /v1/stops/:id",
      "GET /v1/vehicles?routeId=", "GET /v1/vehicles/:id", "GET /v1/parking?permitType=", "GET /v1/parking/:id",
      "GET /v1/journeys?origin=&dest=&permitType=", "GET /v1/alerts"],
    operator: ["POST/PUT/DELETE /v1/parking[/:id]", "PATCH /v1/parking/:id (availability, optimistic version)", "POST /v1/alerts"],
    dispatcher: ["POST/PUT/DELETE /v1/routes[/:id]", "POST/PUT/DELETE /v1/stops[/:id]", "POST/PATCH/DELETE /v1/vehicles[/:id]", "POST /v1/alerts"],
  })
);

// ================================================================ ROUTES (API-1, API-2)
type RouteRow = { id: string; name: string; active: number; created_at: string; updated_at: string; stop_count?: number };

app.get("/v1/routes", async (c) => {
  const onlyActive = c.req.query("active") !== "all";
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count
       FROM routes r ${onlyActive ? "WHERE r.active = 1" : ""} ORDER BY r.id`
  ).all<RouteRow>();
  return c.json({ count: results.length, data: results });
});

async function routeWithStops(c: C, id: string) {
  const route = await c.env.DB.prepare("SELECT * FROM routes WHERE id = ?").bind(id).first<RouteRow>();
  if (!route) return null;
  const { results: stops } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.lat, s.lng, rs.seq FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
      WHERE rs.route_id = ? ORDER BY rs.seq`
  ).bind(id).all();
  return { ...route, stops };
}

app.get("/v1/routes/:id", async (c) => {
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const route = await routeWithStops(c, id);
  return route ? c.json(route) : fail(c, 404, "Route not found");
});

app.get("/v1/routes/:id/stops", async (c) => {
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const route = await routeWithStops(c, id);
  return route ? c.json({ route_id: id, count: route.stops.length, data: route.stops }) : fail(c, 404, "Route not found");
});

type RouteBody = { id?: unknown; name?: unknown; active?: unknown; stops?: unknown };
function parseRouteBody(c: C, body: RouteBody | null, idFromPath?: string) {
  if (!body) return { err: fail(c, 400, "JSON body required") };
  const id = idFromPath ?? (typeof body.id === "string" ? body.id : "");
  if (!ID.test(id)) return { err: fail(c, 400, "id must match ^[A-Za-z0-9_-]{1,40}$") };
  if (typeof body.name !== "string" || !body.name.trim()) return { err: fail(c, 400, "name is required") };
  const active = body.active === undefined ? 1 : body.active ? 1 : 0;
  const stops = Array.isArray(body.stops) ? body.stops : [];
  if (!stops.every((s) => typeof s === "string" && ID.test(s))) return { err: fail(c, 400, "stops must be an array of stop ids") };
  if (new Set(stops).size !== stops.length) return { err: fail(c, 422, "stops must not repeat") };
  return { id, name: body.name.trim(), active, stops: stops as string[] };
}

/** Route + its ordered stops written atomically with D1 batch (a transaction). */
async function writeRoute(c: C, r: { id: string; name: string; active: number; stops: string[] }, create: boolean) {
  const stmts = [
    create
      ? c.env.DB.prepare("INSERT INTO routes (id, name, active) VALUES (?, ?, ?)").bind(r.id, r.name, r.active)
      : c.env.DB.prepare("UPDATE routes SET name = ?, active = ?, updated_at = ? WHERE id = ?").bind(r.name, r.active, now(), r.id),
    c.env.DB.prepare("DELETE FROM route_stops WHERE route_id = ?").bind(r.id),
    ...r.stops.map((s, i) => c.env.DB.prepare("INSERT INTO route_stops (route_id, stop_id, seq) VALUES (?, ?, ?)").bind(r.id, s, i + 1)),
  ];
  await c.env.DB.batch(stmts);
}

app.post("/v1/routes", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const p = parseRouteBody(c, await readJson<RouteBody>(c));
  if ("err" in p) return p.err;
  try { await writeRoute(c, p, true); } catch (e) { return dbError(c, e); }
  return c.json(await routeWithStops(c, p.id), 201);
});

app.put("/v1/routes/:id", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  if (!(await c.env.DB.prepare("SELECT 1 FROM routes WHERE id = ?").bind(id).first())) return fail(c, 404, "Route not found");
  const p = parseRouteBody(c, await readJson<RouteBody>(c), id);
  if ("err" in p) return p.err;
  try { await writeRoute(c, p, false); } catch (e) { return dbError(c, e); }
  return c.json(await routeWithStops(c, id));
});

app.delete("/v1/routes/:id", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const r = await c.env.DB.prepare("DELETE FROM routes WHERE id = ? RETURNING id").bind(id).first();
  return r ? c.json({ deleted: id, note: "route_stops cascaded; vehicles on this route now have route_id = NULL" }) : fail(c, 404, "Route not found");
});

// ================================================================ STOPS
app.get("/v1/stops", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, (SELECT GROUP_CONCAT(route_id) FROM route_stops rs WHERE rs.stop_id = s.id) AS route_ids FROM stops s ORDER BY s.id`
  ).all();
  return c.json({ count: results.length, data: results });
});

app.get("/v1/stops/:id", async (c) => {
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const s = await c.env.DB.prepare("SELECT * FROM stops WHERE id = ?").bind(id).first();
  return s ? c.json(s) : fail(c, 404, "Stop not found");
});

type StopBody = { id?: unknown; name?: unknown; lat?: unknown; lng?: unknown };
function parseStop(c: C, b: StopBody | null, idFromPath?: string) {
  if (!b) return { err: fail(c, 400, "JSON body required") };
  const id = idFromPath ?? (typeof b.id === "string" ? b.id : "");
  if (!ID.test(id)) return { err: fail(c, 400, "id must match ^[A-Za-z0-9_-]{1,40}$") };
  if (typeof b.name !== "string" || !b.name.trim()) return { err: fail(c, 400, "name is required") };
  if (typeof b.lat !== "number" || typeof b.lng !== "number") return { err: fail(c, 400, "lat and lng are required numbers") };
  return { id, name: b.name.trim(), lat: b.lat, lng: b.lng };
}

app.post("/v1/stops", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const p = parseStop(c, await readJson<StopBody>(c));
  if ("err" in p) return p.err;
  try {
    const row = await c.env.DB.prepare("INSERT INTO stops (id, name, lat, lng) VALUES (?, ?, ?, ?) RETURNING *")
      .bind(p.id, p.name, p.lat, p.lng).first();
    return c.json(row, 201);
  } catch (e) { return dbError(c, e); }
});

app.put("/v1/stops/:id", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const p = parseStop(c, await readJson<StopBody>(c), id);
  if ("err" in p) return p.err;
  try {
    const row = await c.env.DB.prepare("UPDATE stops SET name = ?, lat = ?, lng = ? WHERE id = ? RETURNING *")
      .bind(p.name, p.lat, p.lng, id).first();
    return row ? c.json(row) : fail(c, 404, "Stop not found");
  } catch (e) { return dbError(c, e); }
});

app.delete("/v1/stops/:id", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  try {
    const r = await c.env.DB.prepare("DELETE FROM stops WHERE id = ? RETURNING id").bind(id).first();
    return r ? c.json({ deleted: id }) : fail(c, 404, "Stop not found");
  } catch (e) {
    // ON DELETE RESTRICT on route_stops: a stop that is still on a route cannot vanish.
    if (e instanceof Error && /FOREIGN KEY/.test(e.message)) {
      const { results } = await c.env.DB.prepare("SELECT route_id FROM route_stops WHERE stop_id = ?").bind(id).all<{ route_id: string }>();
      return fail(c, 409, "Stop is still used by routes; remove it from them first", { routes: results.map((r) => r.route_id) });
    }
    return dbError(c, e);
  }
});

// ================================================================ VEHICLES (API-3)
app.get("/v1/vehicles", async (c) => {
  const routeId = c.req.query("routeId");
  if (routeId !== undefined && !ID.test(routeId)) return fail(c, 400, "Invalid routeId");
  const { results } = await (routeId
    ? c.env.DB.prepare("SELECT * FROM vehicles WHERE route_id = ? ORDER BY eta_next_stop_sec").bind(routeId)
    : c.env.DB.prepare("SELECT * FROM vehicles ORDER BY id")).all();
  return c.json({ count: results.length, data: results });
});

app.get("/v1/vehicles/:id", async (c) => {
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const v = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first();
  return v ? c.json(v) : fail(c, 404, "Vehicle not found");
});

type VehicleBody = { id?: unknown; routeId?: unknown; lastStopId?: unknown; etaNextStopSec?: unknown; delaySec?: unknown };
const optId = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" && ID.test(v) ? v : undefined);

app.post("/v1/vehicles", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const b = await readJson<VehicleBody>(c);
  if (!b || typeof b.id !== "string" || !ID.test(b.id)) return fail(c, 400, "id must match ^[A-Za-z0-9_-]{1,40}$");
  const routeId = optId(b.routeId), lastStopId = optId(b.lastStopId);
  if (routeId === undefined || lastStopId === undefined) return fail(c, 400, "routeId / lastStopId must be ids or null");
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO vehicles (id, route_id, last_stop_id, eta_next_stop_sec, delay_sec) VALUES (?, ?, ?, ?, ?) RETURNING *"
    ).bind(b.id, routeId, lastStopId, isInt(b.etaNextStopSec) ? b.etaNextStopSec : null, isInt(b.delaySec) ? b.delaySec : 0).first();
    return c.json(row, 201);
  } catch (e) { return dbError(c, e); }
});

// Status update from the dispatcher / GPS feed. Edge-triggers route.delayed (PRD 4.4).
app.patch("/v1/vehicles/:id", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const cur = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id)
    .first<{ route_id: string | null; last_stop_id: string | null; eta_next_stop_sec: number | null; delay_sec: number }>();
  if (!cur) return fail(c, 404, "Vehicle not found");
  const b = (await readJson<VehicleBody>(c)) ?? {};
  const routeId = b.routeId === undefined ? cur.route_id : optId(b.routeId);
  const lastStopId = b.lastStopId === undefined ? cur.last_stop_id : optId(b.lastStopId);
  if (routeId === undefined || lastStopId === undefined) return fail(c, 400, "routeId / lastStopId must be ids or null");
  const eta = b.etaNextStopSec === undefined ? cur.eta_next_stop_sec : isInt(b.etaNextStopSec) ? b.etaNextStopSec : null;
  const delay = b.delaySec === undefined ? cur.delay_sec : isInt(b.delaySec) ? b.delaySec : cur.delay_sec;
  try {
    const row = await c.env.DB.prepare(
      "UPDATE vehicles SET route_id = ?, last_stop_id = ?, eta_next_stop_sec = ?, delay_sec = ?, updated_at = ? WHERE id = ? RETURNING *"
    ).bind(routeId, lastStopId, eta, delay, now(), id).first();
    const events: string[] = [];
    if (cur.delay_sec < 300 && delay >= 300 && routeId) {
      await c.env.DB.prepare("INSERT INTO alerts (kind, route_id, message, raised_by) VALUES ('route.delayed', ?, ?, 'system')")
        .bind(routeId, `Vehicle ${id} on ${routeId} is ${delay}s late`).run();
      events.push("route.delayed");
    }
    return c.json({ ...row, events });
  } catch (e) { return dbError(c, e); }
});

app.delete("/v1/vehicles/:id", async (c) => {
  const denied = requireRole(c, "dispatcher"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const r = await c.env.DB.prepare("DELETE FROM vehicles WHERE id = ? RETURNING id").bind(id).first();
  return r ? c.json({ deleted: id }) : fail(c, 404, "Vehicle not found");
});

// ================================================================ PARKING (API-4, API-5)
type ZoneRow = { id: string; name: string; capacity: number; lat: number; lng: number; free: number; version: number; updated_at: string; permit_types: string | null };
const ZONE_SELECT = `
  SELECT z.id, z.name, z.capacity, z.lat, z.lng, a.free, a.version, a.updated_at,
         (SELECT GROUP_CONCAT(permit_type) FROM zone_permit_types p WHERE p.zone_id = z.id) AS permit_types
    FROM parking_zones z JOIN availability a ON a.zone_id = z.id`;
const shapeZone = (z: ZoneRow) => ({ ...z, permit_types: z.permit_types ? z.permit_types.split(",") : [] });

app.get("/v1/parking", async (c) => {
  const permit = c.req.query("permitType");
  if (permit !== undefined && !(PERMITS as readonly string[]).includes(permit)) return fail(c, 400, `permitType must be one of ${PERMITS.join(", ")}`);
  const stmt = permit
    ? c.env.DB.prepare(`${ZONE_SELECT} WHERE z.id IN (SELECT zone_id FROM zone_permit_types WHERE permit_type = ?) ORDER BY a.free DESC`).bind(permit)
    : c.env.DB.prepare(`${ZONE_SELECT} ORDER BY z.id`);
  const { results } = await stmt.all<ZoneRow>();
  return c.json({ count: results.length, data: results.map(shapeZone) });
});

app.get("/v1/parking/:id", async (c) => {
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const z = await c.env.DB.prepare(`${ZONE_SELECT} WHERE z.id = ?`).bind(id).first<ZoneRow>();
  return z ? c.json(shapeZone(z)) : fail(c, 404, "Zone not found");
});

type ZoneBody = { id?: unknown; name?: unknown; capacity?: unknown; lat?: unknown; lng?: unknown; permitTypes?: unknown; free?: unknown };
function parseZone(c: C, b: ZoneBody | null, idFromPath?: string) {
  if (!b) return { err: fail(c, 400, "JSON body required") };
  const id = idFromPath ?? (typeof b.id === "string" ? b.id : "");
  if (!ID.test(id)) return { err: fail(c, 400, "id must match ^[A-Za-z0-9_-]{1,40}$") };
  if (typeof b.name !== "string" || !b.name.trim()) return { err: fail(c, 400, "name is required") };
  if (!isInt(b.capacity) || b.capacity <= 0) return { err: fail(c, 400, "capacity must be a positive integer") };
  if (typeof b.lat !== "number" || typeof b.lng !== "number") return { err: fail(c, 400, "lat and lng are required numbers") };
  const permits = Array.isArray(b.permitTypes) ? b.permitTypes : [];
  if (!permits.every((p) => (PERMITS as readonly unknown[]).includes(p))) return { err: fail(c, 400, `permitTypes must be from ${PERMITS.join(", ")}`) };
  return { id, name: b.name.trim(), capacity: b.capacity, lat: b.lat, lng: b.lng, permits: [...new Set(permits as string[])] };
}

app.post("/v1/parking", async (c) => {
  const denied = requireRole(c, "operator"); if (denied) return denied;
  const b = await readJson<ZoneBody>(c);
  const p = parseZone(c, b);
  if ("err" in p) return p.err;
  const free = isInt(b?.free) ? (b!.free as number) : p.capacity;
  if (free < 0 || free > p.capacity) return fail(c, 422, "free must be between 0 and capacity");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO parking_zones (id, name, capacity, lat, lng) VALUES (?, ?, ?, ?, ?)").bind(p.id, p.name, p.capacity, p.lat, p.lng),
      c.env.DB.prepare("INSERT INTO availability (zone_id, free) VALUES (?, ?)").bind(p.id, free),
      ...p.permits.map((t) => c.env.DB.prepare("INSERT INTO zone_permit_types (zone_id, permit_type) VALUES (?, ?)").bind(p.id, t)),
    ]);
  } catch (e) { return dbError(c, e); }
  const z = await c.env.DB.prepare(`${ZONE_SELECT} WHERE z.id = ?`).bind(p.id).first<ZoneRow>();
  return c.json(shapeZone(z!), 201);
});

app.put("/v1/parking/:id", async (c) => {
  const denied = requireRole(c, "operator"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  if (!(await c.env.DB.prepare("SELECT 1 FROM parking_zones WHERE id = ?").bind(id).first())) return fail(c, 404, "Zone not found");
  const p = parseZone(c, await readJson<ZoneBody>(c), id);
  if ("err" in p) return p.err;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE parking_zones SET name = ?, capacity = ?, lat = ?, lng = ? WHERE id = ?").bind(p.name, p.capacity, p.lat, p.lng, id),
      // shrinking capacity below current free would break the invariant — clamp, and bump the version
      c.env.DB.prepare("UPDATE availability SET free = MIN(free, ?), version = version + 1, updated_at = ? WHERE zone_id = ?").bind(p.capacity, now(), id),
      c.env.DB.prepare("DELETE FROM zone_permit_types WHERE zone_id = ?").bind(id),
      ...p.permits.map((t) => c.env.DB.prepare("INSERT INTO zone_permit_types (zone_id, permit_type) VALUES (?, ?)").bind(id, t)),
    ]);
  } catch (e) { return dbError(c, e); }
  const z = await c.env.DB.prepare(`${ZONE_SELECT} WHERE z.id = ?`).bind(id).first<ZoneRow>();
  return c.json(shapeZone(z!));
});

// API-5: the operator's write. Optimistic concurrency closes PRD 3.2's race:
// the UPDATE only applies if the caller's version is still current.
app.patch("/v1/parking/:id", async (c) => {
  const denied = requireRole(c, "operator"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const b = await readJson<{ free?: unknown; version?: unknown }>(c);
  if (!b || !isInt(b.free) || b.free < 0) return fail(c, 400, "free (integer >= 0) is required");
  if (!isInt(b.version)) return fail(c, 400, "version (integer) is required — read it from GET /v1/parking/:id");
  const cur = await c.env.DB.prepare("SELECT free, version FROM availability WHERE zone_id = ?").bind(id).first<{ free: number; version: number }>();
  if (!cur) return fail(c, 404, "Zone not found");
  try {
    const r = await c.env.DB.prepare(
      "UPDATE availability SET free = ?, version = version + 1, updated_at = ? WHERE zone_id = ? AND version = ?"
    ).bind(b.free, now(), id, b.version).run();
    if (r.meta.changes === 0) {
      const latest = await c.env.DB.prepare("SELECT free, version FROM availability WHERE zone_id = ?").bind(id).first<{ free: number; version: number }>();
      return fail(c, 409, "Version conflict: another operator updated this zone first", { your_version: b.version, current: latest });
    }
  } catch (e) { return dbError(c, e); }
  const events: string[] = [];
  if (cur.free > 0 && b.free === 0) {                       // edge-triggered parking.full (PRD 4.4)
    await c.env.DB.prepare("INSERT INTO alerts (kind, zone_id, message, raised_by) VALUES ('parking.full', ?, ?, 'system')")
      .bind(id, `Zone ${id} is full`).run();
    events.push("parking.full");
  }
  const z = await c.env.DB.prepare(`${ZONE_SELECT} WHERE z.id = ?`).bind(id).first<ZoneRow>();
  return c.json({ ...shapeZone(z!), events });
});

app.delete("/v1/parking/:id", async (c) => {
  const denied = requireRole(c, "operator"); if (denied) return denied;
  const id = validId(c, c.req.param("id"));
  if (!id) return fail(c, 400, "Invalid id");
  const r = await c.env.DB.prepare("DELETE FROM parking_zones WHERE id = ? RETURNING id").bind(id).first();
  return r ? c.json({ deleted: id, note: "availability and zone_permit_types cascaded" }) : fail(c, 404, "Zone not found");
});

// ================================================================ ALERTS (API-6)
app.get("/v1/alerts", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT 50").all();
  return c.json({ count: results.length, data: results });
});

app.post("/v1/alerts", async (c) => {
  const denied = requireRole(c, "operator", "dispatcher"); if (denied) return denied;
  const b = await readJson<{ message?: unknown; routeId?: unknown; zoneId?: unknown }>(c);
  if (!b || typeof b.message !== "string" || !b.message.trim()) return fail(c, 400, "message is required");
  const routeId = optId(b.routeId), zoneId = optId(b.zoneId);
  if (routeId === undefined || zoneId === undefined) return fail(c, 400, "routeId / zoneId must be ids or null");
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO alerts (kind, route_id, zone_id, message, raised_by) VALUES ('service.alert', ?, ?, ?, ?) RETURNING *"
    ).bind(routeId, zoneId, b.message.trim(), c.get("role")).first();
    return c.json(row, 201);
  } catch (e) { return dbError(c, e); }
});

// ================================================================ JOURNEYS (API-7) — computed, never stored
app.get("/v1/journeys", async (c) => {
  const origin = c.req.query("origin"), dest = c.req.query("dest"), permit = c.req.query("permitType");
  if (!origin || !dest || !ID.test(origin) || !ID.test(dest)) return fail(c, 400, "origin and dest stop ids are required");
  if (origin === dest) return fail(c, 422, "origin and dest must differ");
  if (permit !== undefined && !(PERMITS as readonly string[]).includes(permit)) return fail(c, 400, `permitType must be one of ${PERMITS.join(", ")}`);

  const destStop = await c.env.DB.prepare("SELECT * FROM stops WHERE id = ?").bind(dest).first<{ id: string; name: string; lat: number; lng: number }>();
  const originStop = await c.env.DB.prepare("SELECT id, name FROM stops WHERE id = ?").bind(origin).first<{ id: string; name: string }>();
  if (!originStop || !destStop) return fail(c, 404, "Unknown origin or dest stop");

  // Active routes that visit origin BEFORE dest, shortest hop first.
  const { results: candidates } = await c.env.DB.prepare(
    `SELECT r.id AS route_id, r.name AS route_name, o.seq AS origin_seq, d.seq AS dest_seq
       FROM routes r
       JOIN route_stops o ON o.route_id = r.id AND o.stop_id = ?
       JOIN route_stops d ON d.route_id = r.id AND d.stop_id = ?
      WHERE r.active = 1 AND o.seq < d.seq
      ORDER BY (d.seq - o.seq), r.id`
  ).bind(origin, dest).all<{ route_id: string; route_name: string; origin_seq: number; dest_seq: number }>();

  let shuttle: Record<string, unknown> | null = null;
  if (candidates.length) {
    const best = candidates[0];
    const next = await c.env.DB.prepare(
      "SELECT id, last_stop_id, eta_next_stop_sec, delay_sec, updated_at FROM vehicles WHERE route_id = ? ORDER BY eta_next_stop_sec LIMIT 1"
    ).bind(best.route_id).first();
    shuttle = { route_id: best.route_id, route_name: best.route_name, stops_to_ride: best.dest_seq - best.origin_seq, next_vehicle: next ?? null };
  }

  // Nearest zone to the destination with a free space (optionally permit-filtered).
  const nearest = await c.env.DB.prepare(
    `${ZONE_SELECT}
      WHERE a.free > 0 ${permit ? "AND z.id IN (SELECT zone_id FROM zone_permit_types WHERE permit_type = ?)" : ""}
      ORDER BY (z.lat - ?) * (z.lat - ?) + (z.lng - ?) * (z.lng - ?) LIMIT 1`
  ).bind(...(permit ? [permit] : []), destStop.lat, destStop.lat, destStop.lng, destStop.lng).first<ZoneRow>();

  return c.json({
    origin: originStop, destination: { id: destStop.id, name: destStop.name },
    shuttle, parking: nearest ? shapeZone(nearest) : null,
    source: "deterministic",              // PRD 4.5: the fallback planner is always available
    stored: false,                        // PRD 3.2: journeys are never persisted
    computed_at: now(),
  });
});

app.notFound((c) => c.json({ error: "Route not found" }, 404));
app.onError((err, c) => { console.error(err); return c.json({ error: "Internal server error" }, 500); });

export default app;
