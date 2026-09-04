import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface SearchArgs {
	q?: string;
	tags?: string;
	limit?: number;
	offset?: number;
}

/**
 * A single bookmark result, shaped for the model. `tag_names` and `date_added`
 * are included so the analysis workflow can reason about tags and recency.
 */
interface LinkdingBookmark {
	id: number;
	url: string;
	title: string;
	description: string;
	tag_names: string[];
	date_added: string;
}

interface LinkdingRawResponse {
	count?: number;
	results?: unknown[];
}

type MCPResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return 100;
	if (!Number.isFinite(limit)) return 100;
	return Math.min(1000, Math.max(1, Math.floor(limit)));
}

/**
 * Translate the `tags` tool argument ("foo,bar") into linkding search syntax
 * (#foo AND #bar) and combine with the free-text query.
 */
function buildLinkdingQuery(args: SearchArgs): string {
	const parts: string[] = [];
	if (args.q && args.q.trim().length > 0) {
		parts.push(args.q.trim());
	}
	const tags = (args.tags ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	if (tags.length > 0) {
		// linkding tag syntax: #tag; bare words are ANDed together
		parts.push(tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" "));
	}
	return parts.join(" ");
}

/**
 * Call linkding through the Workers VPC binding. This is a GET subrequest and
 * the only way this Worker touches linkding.
 */
async function fetchLinkding(env: Env, path: string): Promise<Response> {
	const base = new URL(env.LINKDING_BASE_URL);
	const target = new URL(path, base.origin);
	const headers = new Headers({ Accept: "application/json" });
	if (env.LINKDING_API_TOKEN) {
		headers.set("Authorization", `Token ${env.LINKDING_API_TOKEN}`);
	}
	// VPC Network binding: the URL decides the destination (host/port from
	// LINKDING_BASE_URL). https is avoided unless the operator set it, since
	// linkding typically serves plain http on the private network.
	return env.MESH.fetch(target.toString(), { method: "GET", headers });
}

/**
 * Core search implementation. No cache: linkding answers from SQLite over the
 * VPC, fast enough that a read-through cache is not worth its complexity.
 */
export async function linkdingSearch(
	env: Env,
	args: SearchArgs,
): Promise<MCPResult> {
	const limit = clampLimit(args.limit);
	const offset = Math.max(0, Math.floor(args.offset ?? 0));
	const q = buildLinkdingQuery(args);

	const params = new URLSearchParams();
	if (q) params.set("q", q);
	params.set("limit", String(limit));
	if (offset > 0) params.set("offset", String(offset));

	// Any upstream/config/network failure becomes a model-readable tool error,
	// never an unhandled transport 500 (which opaquely kills the tool call).
	try {
		const apiUrl = `/api/bookmarks/?${params.toString()}`;
		const upstream = await fetchLinkding(env, apiUrl);

		if (!upstream.ok) {
			const body = await upstream.text();
			return {
				content: [
					{
						type: "text",
						text: `linkding API error: HTTP ${upstream.status} ${upstream.statusText}\n${body.slice(0, 2000)}`,
					},
				],
				isError: true,
			};
		}

		const raw = (await upstream.json()) as LinkdingRawResponse;
		return toResult(raw, limit);
	} catch (e) {
		return {
			content: [
				{
					type: "text",
					text: `linkding request failed: ${e instanceof Error ? e.message : String(e)}`,
				},
			],
			isError: true,
		};
	}
}

function toResult(raw: LinkdingRawResponse, limit: number): MCPResult {
	const results = Array.isArray(raw.results) ? (raw.results as LinkdingBookmark[]) : [];
	const bookmarks = results.slice(0, limit).map((b) => ({
		url: b.url ?? "",
		title: b.title ?? "",
		description: b.description ?? "",
		tags: Array.isArray(b.tag_names) ? b.tag_names : [],
		date_added: b.date_added ?? "",
	}));

	const total = typeof raw.count === "number" ? raw.count : bookmarks.length;
	const text = JSON.stringify({ count: total, results: bookmarks }, null, 2);

	return { content: [{ type: "text", text }] };
}

/**
 * Build a fresh McpServer bound to this request's env.
 * A new instance per request is required: agents' stateless handler refuses
 * to reuse a server that is already connected to a transport.
 */
export function createLinkdingServer(env: Env): McpServer {
	const server = new McpServer({
		name: "linkding-mcp",
		version: "0.2.0",
	});
	server.tool(
		"search",
		"Search linkding bookmarks. Returns URL, title, description, tags and date_added for each match. " +
			"Read-only; no bookmarks are created or modified.",
		{
			q: z
				.string()
				.optional()
				.describe(
					"Search query using linkding syntax. Words are ANDed. Wrap phrases in quotes. " +
						"Filter by tag with #tagname, e.g. 'rust #reading'. Empty string returns all bookmarks.",
				),
			tags: z
				.string()
				.optional()
				.describe(
					"Comma-separated tag names to filter by (AND). Equivalent to appending #tag1 #tag2 to q.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(1000)
				.optional()
				.describe("Maximum number of results. Default 100."),
			offset: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Pagination offset. Default 0."),
		},
		async (args) => linkdingSearch(env, args),
	);
	return server;
}
