export const MARKER = "data-oc-ui-patch";

export const STYLE =
  '[data-slot="user-message-copy-wrapper"],' +
  '[data-slot="text-part-copy-wrapper"]' +
  "{opacity:1 !important;pointer-events:auto !important}";

export const IOS_BLUR_MARKER = "data-ios-blur-fix";

export const IOS_BLUR_STYLE =
  ".ios-blur-fix{position:fixed;top:0;left:0;right:0;height:11px;z-index:2147483647;" +
  "pointer-events:none;background-color:#ffffff;-webkit-background-clip:text;background-clip:text;" +
  "color-scheme:light dark}" +
  "@media (prefers-color-scheme:dark){.ios-blur-fix{background-color:#000000}}";

export const IOS_BLUR_DIV = '<div class="ios-blur-fix" aria-hidden="true"></div>';

function injectStyle(html, marker, style) {
  if (html.includes(marker)) return html;
  const tag = `<style ${marker}>${style}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html;
}

function patchIosBlurFix(html) {
  if (html.includes(IOS_BLUR_MARKER)) return html;
  let out = injectStyle(html, IOS_BLUR_MARKER, IOS_BLUR_STYLE);
  const m = out.match(/<body[^>]*>/i);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    out = out.slice(0, at) + IOS_BLUR_DIV + out.slice(at);
  } else if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${IOS_BLUR_DIV}</body>`);
  } else {
    out += IOS_BLUR_DIV;
  }
  return out;
}

function patchStatusBarStyle(html) {
  if (!html.includes("apple-mobile-web-app-status-bar-style")) return html;
  return html.replace(/content="black-translucent"/i, 'content="default"');
}

function patchHtml(html) {
  return patchIosBlurFix(injectStyle(patchStatusBarStyle(html), MARKER, STYLE));
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
