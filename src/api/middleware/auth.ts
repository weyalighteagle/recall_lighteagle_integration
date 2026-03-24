import { createClerkClient } from "@clerk/backend";
import type { IncomingMessage, ServerResponse } from "http";
import { env } from "../config/env";

const clerkClient = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
});

export async function requireAuth(
    req: IncomingMessage,
    res: ServerResponse,
): Promise<boolean> {
    try {
        const authHeader = req.headers["authorization"];
        const token = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;

        if (!token) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return false;
        }

        const requestUrl = new URL(
            req.url ?? "/",
            `https://${req.headers.host ?? "localhost"}`,
        );
        const webRequest = new Request(requestUrl.toString(), {
            method: req.method,
            headers: { authorization: `Bearer ${token}` },
        });

        const requestState = await clerkClient.authenticateRequest(webRequest);

        if (!requestState.isAuthenticated) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return false;
        }

        const auth = requestState.toAuth();
        const userId = auth?.userId;
        if (!userId) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return false;
        }

        const user = await clerkClient.users.getUser(userId);

        (req as any).userEmail = user.emailAddresses[0]?.emailAddress;
        (req as any).userId = userId;

        return true;
    } catch (error) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return false;
    }
}
