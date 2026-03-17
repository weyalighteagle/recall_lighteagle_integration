import { supabase } from "../config/supabase";

export async function knowledge_bases_list() {
    const { data, error } = await supabase
        .from("knowledge_bases")
        .select("id, name, slug, description, is_default")
        .eq("is_active", true)
        .order("is_default", { ascending: false })
        .order("name", { ascending: true });

    if (error) {
        console.error("knowledge_bases_list error", error);
        throw new Error(error.message);
    }

    const default_kb = data?.find((kb) => kb.is_default);

    return {
        knowledge_bases: data ?? [],
        default_id: default_kb?.id ?? null,
    };
}

export async function knowledge_base_by_slug(slug: string) {
    const { data, error } = await supabase
        .from("knowledge_bases")
        .select("*")
        .eq("slug", slug)
        .eq("is_active", true)
        .single();

    if (error) {
        console.error("knowledge_base_by_slug error", error);
        return null;
    }

    return data;
}
