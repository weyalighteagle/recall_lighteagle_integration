export type IsolationMode = 'full_access' | 'attribution_controlled' | 'contribution_consent';

export interface SharingFilterConfig {
    mode: IsolationMode;
    requestingUserEmail: string;
}

export interface KBSearchResult {
    id: string;
    content: string;
    document_id: string;
    document_title: string;
    category_name: string | null;
    source_type: string;
    similarity: number;
    document_date: string | null;
    contributor_email: string | null;
    meeting_date: string | null;
}

export interface FilteredKBSearchResult extends KBSearchResult {
    brokerableConnection: boolean;
}

// Heuristic: last " — " segment is a name if it contains 2+ capitalised words and no digits.
function stripNameFromTitle(title: string): string {
    const segments = title.split(" — ");
    if (segments.length < 2) return title;

    const last = segments[segments.length - 1];
    const words = last.trim().split(/\s+/);
    const looksLikeName =
        words.length >= 2 &&
        words.every((w) => /^[A-ZÇĞİÖŞÜÂ]/.test(w)) &&
        !/\d/.test(last);

    if (!looksLikeName) return title;

    return [...segments.slice(0, -1), "bir takım üyesi"].join(" — ");
}

export function filterSharedResults(
    results: KBSearchResult[],
    config: SharingFilterConfig,
): FilteredKBSearchResult[] {
    if (config.mode === 'contribution_consent') {
        throw new Error('contribution_consent not implemented — Mod 3');
    }

    return results.map((result) => {
        if (config.mode === 'full_access') {
            return { ...result, brokerableConnection: false };
        }

        // attribution_controlled
        const isOwn =
            result.contributor_email === null ||
            result.contributor_email === config.requestingUserEmail;

        if (isOwn) {
            return { ...result, brokerableConnection: false };
        }

        return {
            ...result,
            brokerableConnection: true,
            contributor_email: null,
            document_title: stripNameFromTitle(result.document_title),
            content: result.contributor_email
                ? result.content.replaceAll(result.contributor_email, '[team member]')
                : result.content,
        };
    });
}
