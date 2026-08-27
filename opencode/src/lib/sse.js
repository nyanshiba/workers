const decoder = new TextDecoder();
const encoder = new TextEncoder();

// SSE ストリームを行単位で読み、isKept(frame) が true のフレームだけ流す。
// 1 フレーム = 空行 ( \n\n ) で終端するイベントブロック。
export function filterEventStream(isKept) {
  let buf = "";
  let frame = "";
  const finalize = (controller) => {
    if (frame !== "") {
      if (isKept(frame)) controller.enqueue(encoder.encode(frame + "\n\n"));
      frame = "";
    }
  };
  let from = 0;
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n", from)) !== -1) {
        const line = buf.slice(from, i).replace(/\r$/, "");
        from = i + 1;
        line === "" ? finalize(controller) : (frame += line + "\n");
      }
      buf = buf.slice(from); // まとめて1回だけ trim(O(n²) 回避)
      from = 0;
    },
    flush(controller) {
      if (buf.trim() !== "") frame += buf.replace(/\r$/, "") + "\n";
      finalize(controller);
    },
  });
}

// reasoning(推論)と tool 実行中の一過性ストリームは落とす。
// tool.success 等の結果・session.text.delta は履歴に残る表示なので通す。
export function isKept(frame) {
  return !/"type"\s*:\s*"session\.(reasoning|tool\.input\.delta)[^"]*"/.test(frame);
}