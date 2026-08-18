export const DEFAULT_CONTENT_REMARKS =
  "请以事实和可验证资料为基础，使用极客跳动专业、克制、清晰的表达；优先解释业务问题、实施路径、边界与风险，避免空泛口号、夸张承诺、虚构案例和明显 AI 腔。标题与正文保持一致，段落简洁，结论给出可执行建议。";

type QueryResult = {
  rowCount: number | null;
  rows: Array<Record<string, any>>;
};
type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
};

export async function getContentPreferences(db: Queryable, userId: string) {
  const result = await db.query(
    `SELECT default_remarks, updated_at
     FROM content_preferences
     WHERE user_id = $1`,
    [userId],
  );
  if (result.rowCount)
    return {
      defaultRemarks: result.rows[0]?.default_remarks as string,
      customized: true,
      updatedAt: result.rows[0]?.updated_at ?? null,
    };

  const legacyKey = `content.default_remarks.${userId}`;
  const legacy = await db.query(
    "SELECT value, updated_at FROM app_settings WHERE key = $1",
    [legacyKey],
  );
  return {
    defaultRemarks:
      typeof legacy.rows[0]?.value?.text === "string"
        ? legacy.rows[0].value.text
        : DEFAULT_CONTENT_REMARKS,
    customized: Boolean(legacy.rowCount),
    updatedAt: legacy.rows[0]?.updated_at ?? null,
  };
}

export async function saveContentPreferences(
  db: Queryable,
  userId: string,
  defaultRemarks: string,
) {
  const result = await db.query(
    `INSERT INTO content_preferences (user_id, default_remarks, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET default_remarks = EXCLUDED.default_remarks, updated_at = NOW()
     RETURNING default_remarks, updated_at`,
    [userId, defaultRemarks],
  );
  const storedRemarks = result.rows[0]?.default_remarks;
  if (typeof storedRemarks !== "string")
    throw new Error("DEFAULT_REMARKS_NOT_PERSISTED");
  return {
    defaultRemarks: storedRemarks,
    updatedAt: result.rows[0]?.updated_at ?? null,
  };
}
