import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONTENT_REMARKS,
  getContentPreferences,
  saveContentPreferences,
} from "../src/content-preferences.js";

describe("content preferences", () => {
  it("reads the member-specific preference before legacy settings", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ default_remarks: "已保存的成员默认指令", updated_at: "now" }],
    });

    await expect(getContentPreferences({ query }, "member-1")).resolves.toEqual(
      {
        defaultRemarks: "已保存的成员默认指令",
        customized: true,
        updatedAt: "now",
      },
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps defaults saved by the previous app_settings implementation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ value: { text: "旧版本保存的默认指令" }, updated_at: "old" }],
      });

    await expect(getContentPreferences({ query }, "member-2")).resolves.toEqual(
      {
        defaultRemarks: "旧版本保存的默认指令",
        customized: true,
        updatedAt: "old",
      },
    );
  });

  it("returns the system prompt only when no member preference exists", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(getContentPreferences({ query }, "member-3")).resolves.toEqual(
      {
        defaultRemarks: DEFAULT_CONTENT_REMARKS,
        customized: false,
        updatedAt: null,
      },
    );
  });

  it("upserts and returns the exact persisted value", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ default_remarks: "刷新后仍应显示的指令", updated_at: "new" }],
    });

    await expect(
      saveContentPreferences({ query }, "member-4", "刷新后仍应显示的指令"),
    ).resolves.toEqual({
      defaultRemarks: "刷新后仍应显示的指令",
      updatedAt: "new",
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT"), [
      "member-4",
      "刷新后仍应显示的指令",
    ]);
  });
});
