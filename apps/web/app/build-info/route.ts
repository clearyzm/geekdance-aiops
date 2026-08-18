import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      service: "web",
      release: process.env.APP_RELEASE ?? "local",
    },
    {
      headers: {
        "cache-control": "private, no-store, max-age=0, must-revalidate",
      },
    },
  );
}
