// Web UI への CSS パッチ注入。
// メッセージヘッダー(agent · モデル名 · 時刻)が hover 時しか表示されないのを、
// 常時表示に変える。upstream(opencode の session-ui)では下記 data-slot が
// opacity:0 になり、親 :hover で可視化される(message-part.css L162/L231 相当)。
//
// upstream の data-slot 名変更で効かなくなっても壊れることはない
// (セレクタが一致しないだけ)。marker を見て冪等にしている。

export const MARKER = "data-oc-ui-patch";

export const STYLE =
  '[data-slot="user-message-copy-wrapper"],' +
  '[data-slot="text-part-copy-wrapper"]' +
  "{opacity:1 !important;pointer-events:auto !important}";

function patchHtml(html) {
  if (html.includes(MARKER)) return html;
  const tag = `<style ${MARKER}>${STYLE}</style>`;
  // </head> があれば直前に差し込み、無ければ先頭に足す(SPA の単一 HTML 前提)
  return html.includes("</head>") ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html;
}

// text/html の GET 応答にだけパッチを当てる。それ以外は元の Response をそのまま返す。
export async function applyUiTweaks(response) {
  const type = response.headers.get("content-type") ?? "";
  if (!response.body || !type.includes("text/html")) return response;

  const patched = patchHtml(await response.text());
  const headers = new Headers(response.headers);
  headers.delete("content-length"); // 注入で長さが変わる
  return new Response(patched, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
