/**
 * linkding MCP server on Cloudflare Workers.
 *
 * Architecture:
 *   OpenCode (MCP client)
 *     │  OAuth 2.1 (PKCE) via Cloudflare Access Managed OAuth
 *     ▼
 *   Cloudflare Access ── Cf-Access-Jwt-Assertion ──► Worker ── POST /mcp ──► env.MESH.fetch() ──► linkding
 *     │
 *     ├─ Gates: country === 'JP' (satident-style redirect to /cdn-cgi/error/500)
 *     ├─ Auth: Access JWT validation against the team JWKS (jose)
 *     └─ MCP: stateless McpServer per request (agents createMcpHandler)
 *
 * Only GET requests are issued to linkding (read-only). The MCP transport uses
 * POST to /mcp per the Streamable HTTP spec; anything else returns 404/405.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMcpHandler } from "agents/mcp";
import { accessChallenge } from "./auth-challenge";
import { createLinkdingServer } from "./mcp";

type RemoteJWKSet = ReturnType<typeof createRemoteJWKSet>;

// In-isolate cache of team JWKS resolvers. jose fetches the key set lazily
// and refreshes it on its own schedule (10 min default).
const jwksCache = new Map<string, RemoteJWKSet>();

/**
 * Normalize TEAM_DOMAIN to the full Access host. Accepts either the bare team
 * name ("myteam") or the full host ("myteam.cloudflareaccess.com").
 */
function accessHost(teamDomain: string): string {
	const bare = teamDomain.trim().replace(/\.cloudflareaccess\.com$/, "");
	return `${bare}.cloudflareaccess.com`;
}

function jwksFor(teamDomain: string): RemoteJWKSet {
	const host = accessHost(teamDomain);
	let jwks = jwksCache.get(host);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`));
		jwksCache.set(host, jwks);
	}
	return jwks;
}

/**
 * 401 responses carry an RFC 9728 challenge so MCP clients can discover OAuth
 * on their own. Without it, a client that reaches the origin unauthenticated
 * dead-ends with an undiscoverable "Unauthorized". The metadata URL is served
 * by the Access edge for this host (observed format:
 * https://<host>/.well-known/cloudflare-access-protected-resource/mcp).
 */
export function unauthorized(request: Request): Response {
	return new Response("Unauthorized", {
		status: 401,
		headers: {
			"WWW-Authenticate": accessChallenge(request),
		},
	});
}
/**
 * Validate the Cf-Access-Jwt-Assertion header that Access attaches after
 * Managed OAuth. Fails closed: any error (missing header, bad signature,
 * wrong issuer/audience, expiry) denies access.
 */
async function hasValidAccessJwt(request: Request, env: Env): Promise<boolean> {
	const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
	// Missing header or missing config denies access (fail closed).
	// env values are typed as string but are undefined at runtime when unset.
	if (!assertion || !env.TEAM_DOMAIN || !env.POLICY_AUD) return false;
	const host = accessHost(env.TEAM_DOMAIN);
	try {
		await jwtVerify(assertion, jwksFor(env.TEAM_DOMAIN), {
			issuer: `https://${host}`,
			audience: env.POLICY_AUD,
		});
		return true;
	} catch {
		return false;
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// 1. Country gate (satident style): non-JP clients see the branded
		// edge 500 page. request.cf is undefined under wrangler dev, which
		// passes through; any known non-JP country is redirected away.
		const country = request.cf?.country;
		if (country && country !== "JP") {
			const u = new URL(request.url);
			return Response.redirect(`${u.origin}/cdn-cgi/error/500`, 302);
		}

		// 2. Managed OAuth: only requests bearing a valid Access JWT proceed.
		if (!(await hasValidAccessJwt(request, env))) {
			return unauthorized(request);
		}

		// 3. MCP spec: only POST to /mcp.
		const url = new URL(request.url);
		if (url.pathname !== "/mcp") {
			return new Response("Not Found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { Allow: "POST" },
			});
		}

		// 4. Stateless MCP: a fresh server per request (a connected server
		// cannot be reused across transports).
		const server = createLinkdingServer(env);
		return createMcpHandler(server)(request, env, ctx);
	},
};
