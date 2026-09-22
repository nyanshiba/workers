const PROBE_PATH = "/__probe";

function getPositiveFreshness(headers) {
	const cc = headers.get("cache-control") || "";
	for (const token of ["s-maxage", "max-age"]) {
		const m = cc.match(new RegExp(`${token}\\s*=\\s*(\\d+)`, "i"));
		if (m && Number(m[1]) > 0) return { token, seconds: Number(m[1]) };
	}
	return null;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === PROBE_PATH || url.pathname === `${PROBE_PATH}/`) {
			return handleProbe(env, url);
		}
		return handleProxy(request, env);
	},
};

async function handleProxy(request, env) {
	const url = new URL(request.url);
	const token = (env.TKN || "").trim();
	const target = new URL(url.pathname + url.search, env.PRIVATE_BASE);
	target.searchParams.delete("tkn");
	const publicOrigin = `${url.protocol}//${url.host}`;
	const privateOrigin = new URL(env.PRIVATE_BASE).origin;
	const privateHost = new URL(env.PRIVATE_BASE).host;

	const headers = new Headers(request.headers);
	if (token) {
		const pairs = (headers.get("cookie") || "")
			.split(";")
			.map((p) => p.trim())
			.filter((p) => p && !/^vscode-tkn=/.test(p));
		pairs.push(`vscode-tkn=${token}`);
		headers.set("cookie", pairs.join("; "));
	}
	headers.set("X-Forwarded-Host", url.host);
	headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
	if (!headers.has("X-Forwarded-For")) {
		const clientIp =
			request.headers.get("CF-Connecting-IP") ||
			(request.cf ? request.cf.connectingIp : null);
		if (clientIp) headers.set("X-Forwarded-For", clientIp);
	}
	const init = { method: request.method, headers };
	if (request.body) {
		init.body = request.body;
		init.duplex = "half";
	}

	let upstream;
	try {
		upstream = await env.MESH.fetch(new Request(target, init));
	} catch (err) {
		console.error("mesh fetch failed:", err.name, err.message);
		return json(
			{
				error: "upstream unavailable",
				reason: err.message,
				hint: hint(err),
			},
			503,
		);
	}

	if (upstream.webSocket) {
		return upstream;
	}

	const resHeaders = new Headers(upstream.headers);
	if (
		request.method === "GET" &&
		upstream.status === 200 &&
		getPositiveFreshness(upstream.headers)
	) {
		resHeaders.delete("set-cookie");
		const cc = resHeaders.get("cache-control") || "";
		if (!/public/i.test(cc)) resHeaders.set("Cache-Control", `public, ${cc}`);
	} else {
		resHeaders.set("Cache-Control", "no-store");
	}
	for (const name of ["location", "content-security-policy"]) {
		const value = resHeaders.get(name);
		if (value) {
			resHeaders.set(
				name,
				value
					.split(`http://${url.host}`)
					.join(publicOrigin)
					.split(`ws://${url.host}`)
					.join(publicOrigin.replace(/^http/, "ws")),
			);
		}
	}
	const contentType = resHeaders.get("content-type") || "";
	if (contentType.includes("text/html")) {
		let body = upstream.body;
		const encoding = (resHeaders.get("content-encoding") || "").toLowerCase();
		const format = encoding.includes("br")
			? "br"
			: encoding.includes("zstd") || encoding.includes("zst")
				? "zstd"
				: encoding.includes("gzip")
					? "gzip"
					: encoding.includes("deflate")
						? "deflate"
						: null;
		if (body && format) {
			try {
				body = body.pipeThrough(new DecompressionStream(format));
			} catch {
				body = upstream.body;
			}
		}
		let text;
		try {
			text = await new Response(body).text();
		} catch {
			return new Response(upstream.body, {
				status: upstream.status,
				headers: resHeaders,
			});
		}
		text = text.split(`http://${url.host}`).join(publicOrigin);
		text = text
			.split(`ws://${url.host}`)
			.join(publicOrigin.replace(/^http/, "ws"));
		text = text.split(privateHost).join(url.host);
		if (privateOrigin.startsWith("http://")) {
			text = text.split(privateOrigin).join(publicOrigin);
			text = text
				.split(`ws://${privateHost}`)
				.join(publicOrigin.replace(/^http/, "ws"));
		}
		resHeaders.delete("content-encoding");
		resHeaders.delete("content-length");
		return new Response(text, {
			status: upstream.status,
			headers: resHeaders,
		});
	}
	return new Response(upstream.body, {
		status: upstream.status,
		headers: resHeaders,
	});
}

async function handleProbe(env, url) {
	const fallback = new URL(env.PRIVATE_BASE);
	const host = url.searchParams.get("host") || fallback.hostname;
	const port = Number(url.searchParams.get("port") || fallback.port || 8000);
	const mode = url.searchParams.get("mode") || "fetch";

	try {
		if (mode === "connect") {
			const socket = await env.MESH.connect(`${host}:${port}`);
			await socket.opened;
			socket.close();
			return json({ mode, host, port, result: "tcp connected" });
		}
		const res = await env.MESH.fetch(`http://${host}:${port}/`);
		return json({
			mode,
			host,
			port,
			result: "http response",
			status: res.status,
			hasTkn: Boolean((env.TKN || "").trim()),
		});
	} catch (err) {
		console.error(`probe ${mode} ${host}:${port} failed:`, err.message);
		return json({ mode, host, port, error: err.message, hint: hint(err) }, 503);
	}
}

function hint(err) {
	const msg = String(err?.message ?? "");
	if (/http_request_denied/i.test(msg)) {
		return "ポリシーによって転送前に拒否された。Zero Trust の Gateway (Network/DNS/Firewall) ポリシー、tunnel/Mesh 側のアクセス制御を確認。Gateway の Logs > Network に拒否イベントが出る";
	}
	if (/dns_error/i.test(msg)) {
		return "cloudflared が QUIC で接続されているか確認 (TUNNEL_TRANSPORT_PROTOCOL=http2 だと Workers VPC の DNS 解決が失敗)。cloudflared 2025.7.0 以上かも確認";
	}
	if (/timeout/i.test(msg)) {
		return "tunnel からプライベートサービスへの到達性・FW ルールを確認";
	}
	if (/refused/i.test(msg)) {
		return "serve-web のリッスン状態 (--host 0.0.0.0 --port) と FW を確認";
	}
	return "VPC Service の Metrics タブでエラーカテゴリ (Bad Upstream / Client / Internal) を確認";
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
