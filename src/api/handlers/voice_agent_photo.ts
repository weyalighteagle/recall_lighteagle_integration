import { supabase } from "../config/supabase";
import { randomUUID } from "crypto";

/**
 * POST /api/voice-agent-config/photo
 *
 * Accepts a JSON body with:
 *   - image: base64-encoded image data (without the data:image/...;base64, prefix)
 *   - content_type: MIME type, e.g. "image/png", "image/jpeg"
 *
 * Uploads to Supabase Storage bucket "voice-agent-avatars",
 * updates the active voice_agent_config row with the public URL,
 * and returns { photo_url: string }.
 */
export async function voice_agent_photo_upload(body: {
    image: string;
    content_type: string;
}): Promise<{ photo_url: string }> {
    const { image, content_type } = body;

    if (!image || !content_type) {
        throw new Error("image (base64) and content_type are required");
    }

    // Validate content type
    const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (!allowedTypes.includes(content_type)) {
        throw new Error(`Unsupported image type: ${content_type}. Allowed: ${allowedTypes.join(", ")}`);
    }

    // Decode base64 to Buffer
    const buffer = Buffer.from(image, "base64");

    // Limit file size to 2MB
    if (buffer.length > 2 * 1024 * 1024) {
        throw new Error("Image too large. Maximum size is 2MB.");
    }

    // Generate a unique filename
    const ext = content_type.split("/")[1] === "jpeg" ? "jpg" : content_type.split("/")[1];
    const filename = `avatar-${randomUUID()}.${ext}`;

    // Delete any existing avatars (cleanup — keeps bucket tidy)
    const { data: existingFiles } = await supabase.storage
        .from("voice-agent-avatars")
        .list("", { limit: 100 });

    if (existingFiles && existingFiles.length > 0) {
        const filesToRemove = existingFiles.map(f => f.name);
        await supabase.storage
            .from("voice-agent-avatars")
            .remove(filesToRemove);
    }

    // Upload new file
    const { error: uploadError } = await supabase.storage
        .from("voice-agent-avatars")
        .upload(filename, buffer, {
            contentType: content_type,
            upsert: true,
        });

    if (uploadError) {
        console.error("[photo] Upload error:", uploadError);
        throw new Error(`Failed to upload image: ${uploadError.message}`);
    }

    // Get public URL
    const { data: urlData } = supabase.storage
        .from("voice-agent-avatars")
        .getPublicUrl(filename);

    const photo_url = urlData.publicUrl;

    // Update the active voice_agent_config row
    const { data: existing, error: fetchError } = await supabase
        .from("voice_agent_config")
        .select("id")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!existing) throw new Error("No active voice agent config found");

    const { error: updateError } = await supabase
        .from("voice_agent_config")
        .update({ photo_url, updated_at: new Date().toISOString() })
        .eq("id", existing.id);

    if (updateError) throw new Error(updateError.message);

    console.log(`[photo] Uploaded voice agent photo: ${photo_url}`);
    return { photo_url };
}

/**
 * DELETE /api/voice-agent-config/photo
 *
 * Removes the current photo and sets photo_url to null.
 */
export async function voice_agent_photo_delete(): Promise<void> {
    const { data: config } = await supabase
        .from("voice_agent_config")
        .select("id, photo_url")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

    if (!config) throw new Error("No active voice agent config found");

    // Delete from storage if exists
    if (config.photo_url) {
        const urlParts = config.photo_url.split("/voice-agent-avatars/");
        if (urlParts[1]) {
            await supabase.storage
                .from("voice-agent-avatars")
                .remove([urlParts[1]]);
        }
    }

    // Clear the photo_url in config
    const { error } = await supabase
        .from("voice_agent_config")
        .update({ photo_url: null, updated_at: new Date().toISOString() })
        .eq("id", config.id);

    if (error) throw new Error(error.message);
    console.log("[photo] Voice agent photo removed");
}
