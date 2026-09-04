/**
 * RFC 9728 authorization-server discovery challenge for our 401 responses.
 * The metadata URL is served by the Access edge for the request host
 * (observed format:
 * https://<host>/.well-known/cloudflare-access-protected-resource/mcp).
 * Zero imports so the logic stays directly testable outside workerd.
 */
export function accessChallenge(request: Request): string {
	const host = new URL(request.url).host;
	return `Bearer resource_metadata="https://${host}/.well-known/cloudflare-access-protected-resource/mcp"`;
}
