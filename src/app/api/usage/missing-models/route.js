import { NextResponse } from "next/server";
import {
  getUnresolvedModels,
  setUnresolvedModelResolved,
  deleteUnresolvedModel,
  clearUnresolvedModels,
} from "@/lib/db/repos/unresolvedModelsRepo.js";

/**
 * GET /api/usage/missing-models
 * Query parameters: page, pageSize (1-100), reason, includeResolved
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const pageRaw = parseInt(searchParams.get("page"), 10);
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"), 10);
    const pageSize = Number.isNaN(pageSizeRaw) ? 50 : pageSizeRaw;
    const reason = searchParams.get("reason");
    const includeResolved = searchParams.get("includeResolved") === "true";

    if (page < 1) {
      return NextResponse.json({ error: "Page must be >= 1" }, { status: 400 });
    }

    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }

    const filter = { page, pageSize, includeResolved };
    if (reason) filter.reason = reason;

    const result = await getUnresolvedModels(filter);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] Failed to get missing models:", error);
    return NextResponse.json(
      { error: "Failed to fetch missing models" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/usage/missing-models
 * Body: { id: string, resolved: boolean }
 */
export async function PATCH(request) {
  try {
    const body = await request.json();
    const { id, resolved } = body || {};

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing or invalid id" }, { status: 400 });
    }

    const isResolved = resolved !== undefined ? Boolean(resolved) : true;
    await setUnresolvedModelResolved(id, isResolved);

    return NextResponse.json({ success: true, id, resolved: isResolved });
  } catch (error) {
    console.error("[API] Failed to update missing model:", error);
    return NextResponse.json(
      { error: "Failed to update missing model" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/usage/missing-models?id=... (single) or no id (clear all)
 */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (id) {
      await deleteUnresolvedModel(id);
      return NextResponse.json({ success: true, deleted: id });
    }

    await clearUnresolvedModels();
    return NextResponse.json({ success: true, cleared: true });
  } catch (error) {
    console.error("[API] Failed to delete missing models:", error);
    return NextResponse.json(
      { error: "Failed to delete missing models" },
      { status: 500 }
    );
  }
}
