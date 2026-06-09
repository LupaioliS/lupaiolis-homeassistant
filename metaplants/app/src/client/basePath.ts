/**
 * Home Assistant ingress serves the app under a path like
 * `/api/hassio_ingress/<token>/` and strips that prefix before forwarding
 * requests to the add-on. Absolute paths (e.g. `/api/...`, `/uploads/...`)
 * therefore break under ingress. These helpers compute the correct base path
 * at runtime so the app works both via ingress and when accessed directly.
 */

function detectBasePath(): string {
	const match = window.location.pathname.match(/^(.*\/api\/hassio_ingress\/[^/]+)/);
	return match ? match[1] : '';
}

export const BASE_PATH = detectBasePath();

/**
 * Prefix a server-relative path (starting with `/`) with the ingress base path.
 * Leaves absolute URLs (http/https/data) untouched.
 */
export function withBase(path: string): string {
	if (!path) return path;
	if (/^([a-z]+:)?\/\//i.test(path) || path.startsWith('data:')) return path;
	if (!path.startsWith('/')) return path;
	return BASE_PATH + path;
}
