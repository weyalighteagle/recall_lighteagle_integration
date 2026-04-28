/**
 * Vercel Edge Middleware — proxies /api/* requests to the correct Railway backend.
 *
 * Production (main)  → RAILWAY_API_URL defaults to production Railway
 * Preview  (develop) → RAILWAY_API_URL points to staging Railway
 *
 * Set RAILWAY_API_URL in Vercel Environment Variables, scoped per environment.
 */

export const config = {
    matcher: "/api/:path*",
};

export default async function middleware(request: Request): Promise<Response> {
    const backendUrl =
        process.env.RAILWAY_API_URL ||
        "https://recalllighteagleintegration-production.up.railway.app";

    const url = new URL(request.url);
    const target = `${backendUrl}${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.delete("host");

    const body =
        request.method !== "GET" && request.method !== "HEAD"
            ? await request.arrayBuffer()
            : undefined;

    const response = await fetch(target, {
        method: request.method,
        headers,
        body: body ?? undefined,
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
    });
}
