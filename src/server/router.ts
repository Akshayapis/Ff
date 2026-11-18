/**
 * Tiny router used by the /api catch-all handler.
 * All responses use the format { success, message, data }.
 */
import { ApiError, authAdmin, authUser, clientIp, getSettings, init, limit, type Row } from "./core";

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  body: Row;
  ip: string;
  user: Row;
  admin: Row;
}
export class Ok {
  constructor(public data: unknown = null, public message = "OK") {}
}
export const ok = (data: unknown = null, message = "OK") => new Ok(data, message);

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  auth?: "user" | "admin";
  /** skip maintenance-mode check */
  open?: boolean;
  handler: (c: Ctx) => Promise<unknown>;
}

function compile(path: string) {
  const names: string[] = [];
  const re = new RegExp("^" + path.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), "([^/]+)")) + "/?$");
  return { re, names };
}

let compiled: { route: Route; re: RegExp; names: string[] }[] | null = null;

function json(success: boolean, message: string, data: unknown, status = 200) {
  return Response.json({ success, message, data }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function dispatch(req: Request, routes: Route[]): Promise<Response> {
  try {
    await init();
    if (!compiled) compiled = routes.map((route) => ({ route, ...compile(route.path) }));
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    const ip = clientIp(req);
    let matchedPath = false;
    for (const { route, re, names } of compiled) {
      const m = re.exec(path);
      if (!m) continue;
      matchedPath = true;
      if (route.method !== req.method) continue;
      limit(`g:${ip}`, 400, 60_000);
      const params: Record<string, string> = {};
      names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      let body: Row = {};
      if (req.method !== "GET") {
        try {
          const b = await req.json();
          if (b && typeof b === "object") body = b;
        } catch {
          body = {};
        }
      }
      const ctx = { req, url, params, body, ip } as Ctx;
      if (!route.open && route.auth !== "admin" && !path.startsWith("/admin")) {
        const s = await getSettings();
        if (s.maintenance === "1") throw new ApiError(503, "Host Zone is under maintenance. Please check back soon.", "MAINTENANCE");
      }
      if (route.auth === "user") ctx.user = await authUser(req);
      if (route.auth === "admin") ctx.admin = await authAdmin(req);
      const out = await route.handler(ctx);
      if (out instanceof Response) return out;
      if (out instanceof Ok) return json(true, out.message, out.data);
      return json(true, "OK", out ?? null);
    }
    return json(false, matchedPath ? "Method not allowed" : "Not found", null, matchedPath ? 405 : 404);
  } catch (e) {
    if (e instanceof ApiError) return json(false, e.message, e.code ? { code: e.code } : null, e.status);
    const code = (e as { code?: string }).code;
    if (code === "23505") return json(false, "This entry already exists", null, 409);
    if (code === "23514") return json(false, "Insufficient balance", null, 400);
    console.error("API error:", e);
    return json(false, "Something went wrong. Please try again.", null, 500);
  }
}
