import { dispatch } from "@/server/router";
import { userRoutes } from "@/server/user-routes";
import { adminRoutes } from "@/server/admin-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const routes = [...userRoutes, ...adminRoutes];

export async function GET(req: Request) {
  return dispatch(req, routes);
}
export async function POST(req: Request) {
  return dispatch(req, routes);
}
export async function PUT(req: Request) {
  return dispatch(req, routes);
}
export async function DELETE(req: Request) {
  return dispatch(req, routes);
}
