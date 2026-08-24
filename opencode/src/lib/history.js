// 履歴(GET /api/session/{id}/message...)の JSON から reasoning パートを除去。
// assistant メッセージの content[] 内の {type:"reasoning"} アイテムを落とす。
export function stripReasoningFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  const msgs = Array.isArray(data?.data) ? data.data : [data?.data];
  let changed = false;
  for (const m of msgs) {
    if (m?.type === "assistant" && Array.isArray(m.content)) {
      const filtered = m.content.filter((c) => !(c && c.type === "reasoning"));
      if (filtered.length !== m.content.length) {
        m.content = filtered;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(data) : null;
}

const HISTORY_PATH = /^\/api\/session\/[^/]+\/message(\/[^/]+)?$/;

export function applyHistoryFilter(originResponse) {
  if (!originResponse.ok) return originResponse;
  const ct = originResponse.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return originResponse;

  return originResponse.text().then((text) => {
    const filtered = stripReasoningFromJson(text);
    if (filtered === null) return originResponse;
    const headers = new Headers(originResponse.headers);
    headers.delete("content-length");
    return new Response(filtered, { status: originResponse.status, headers });
  });
}

export { HISTORY_PATH };
