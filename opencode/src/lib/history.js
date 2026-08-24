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

// headerRewriter: (originResponse) => Headers。ブラウザ向けヘッダの上書き(no-cache 等)。
export async function applyHistoryFilter(originResponse, headerRewriter) {
  if (!originResponse.ok) return originResponse;
  const ct = originResponse.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return originResponse;

  // ボディを text() で消費した後の元 Response は再読不可(ストリーム確定済み)。
  // これをそのまま返すと、クライアント(@opencode-ai/client)が空ボディを
  // 不正な Content-Type として扱い ClientError: UnsupportedContentType になる。
  // よって strip の有無にかかわらず、必ず新しい Response を作り直して返す。
  const text = await originResponse.text();
  const filtered = stripReasoningFromJson(text);
  const headers =
    headerRewriter !== undefined
      ? headerRewriter(originResponse)
      : new Headers(originResponse.headers);
  headers.delete("content-length");
  return new Response(filtered ?? text, { status: originResponse.status, headers });
}

export { HISTORY_PATH };
