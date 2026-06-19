const FRIENDLY_ERRORS: [string, string][] = [
    ["Unauthorized", "Your session has expired. Please sign in again."],
    ["do not have permission", "You don't have permission to do this. Please contact your workspace admin."],
    ["Method not allowed", "Something went wrong. Please try again."],
    ["calendar_id is required", "No calendar selected. Please select a calendar first."],
    ["calendar_event_id is required", "No event selected. Please select an event first."],
    ["title and content are required", "Please fill in both the title and content fields."],
    ["meeting_url is required", "Please enter a meeting URL."],
    ["Endpoint not found", "Something went wrong. Please try again."],
    ["kb_document_id is required", "Please select a knowledge base document."],
];

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

export function parseApiError(raw: string): string {
    let message = raw;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.error === "string") {
            message = parsed.error;
        }
    } catch {
        // not JSON, fall back to the raw string
    }

    const match = FRIENDLY_ERRORS.find(([pattern]) => message.includes(pattern));
    return match ? match[1] : FALLBACK_MESSAGE;
}
