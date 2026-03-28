import { env } from "../config/env";
import { supabase } from "../config/supabase";

const SYSTEM_PROMPT = `You are a transcript cleaner for a multilingual software team.
The team primarily speaks Turkish and English but meetings can be in any language.
Fix ASR errors only. Do not summarize, rephrase, translate, or reorder anything.
Known team names: Heval, Gulfem, Yigit, Mehmet Cem, Onur, Yusuf, Eren.
Known products: WEYA, Clerk, Vercel, GitHub, TypeScript, Supabase, Railway, Recall, ChatGPT.
Rules:
- Remove lines that are clearly ASR hallucinations: non-Latin script fragments (Arabic, Hebrew, Cyrillic, etc.) that are short and nonsensical, AND short fragments in languages that have no relation to this team (e.g. Portuguese, Spanish, Hindi) when the surrounding conversation is entirely in Turkish or English. Do NOT remove a line if it contains meaningful content or if the whole meeting is in that language.
- Fix obvious ASR misrecognitions for example: "Whorequest" -> "webhook", "Spabase" -> "Supabase", "Cetci Piti" -> "ChatGPT", "Versel" -> "Vercel", "JVT" -> "JWT", "Superbase" -> "Supabase", "Plurk" -> "Plurk", "Haywire light" -> "Light Eagle", "Hayır light" -> "Light Eagle"
- Preserve every speaker label exactly as given including brackets
- Keep all languages as-is only when the language switch is intentional — if a single short utterance is in an unrelated language (Portuguese, Spanish, etc.) while the rest of the meeting is in Turkish/English, treat it as a hallucination and remove it
- Return ONLY the corrected transcript lines in exactly the same [Speaker]: text format, one per line, nothing else
- If a line has no errors, return it unchanged`;

const CHUNK_SIZE = 50; // utterances per Claude call — safe for any meeting length

type Utterance = { id: string; speaker: string; text: string };

async function cleanChunk(chunk: Utterance[]): Promise<Utterance[]> {
  const transcriptString = chunk
    .map((u) => `[${u.speaker}]: ${u.text}`)
    .join("\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcriptString }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[cleanTranscript] Anthropic API error ${response.status}: ${errText}`);
    return chunk; // return original chunk unchanged on error — never lose data
  }

  const data = await response.json();
  const cleaned = (data.content?.[0]?.text as string) ?? "";

  const cleanedLines = cleaned
    .split("\n")
    .map((l: string) => l.trim())
    .filter(Boolean);

  // Match cleaned lines back to original utterances by position
  // If Claude returns fewer lines (removed hallucinations), mark removed as empty string
  return chunk.map((original, i) => {
    const cleanedLine = cleanedLines[i];
    if (!cleanedLine) {
      // Line was removed as hallucination — blank out the text
      return { ...original, text: "" };
    }
    const cleanedText = cleanedLine.replace(/^\[[^\]]+\]:\s*/, "").trim();
    return { ...original, text: cleanedText };
  });
}

export async function cleanTranscript(botId: string): Promise<void> {
  console.log(`[cleanTranscript] START bot_id=${botId}`);

  const { data: utterances, error } = await supabase
    .from("utterances")
    .select("id, speaker, words")
    .eq("bot_id", botId)
    .order("created_at");

  if (error || !utterances || utterances.length === 0) {
    console.warn(`[cleanTranscript] no utterances found for bot ${botId}`);
    return;
  }

  // Build flat array of utterances with joined text
  const lines: Utterance[] = utterances.map((u) => ({
    id: u.id as string,
    speaker: u.speaker as string,
    text: (u.words as any[]).map((w) => w.text).join(" ").trim(),
  }));

  console.log(
    `[cleanTranscript] ${lines.length} utterances — processing in chunks of ${CHUNK_SIZE}`,
  );

  // Process in chunks — handles meetings of any length safely
  const allCleaned: Utterance[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunk = lines.slice(i, i + CHUNK_SIZE);
    const chunkIndex = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(lines.length / CHUNK_SIZE);
    console.log(`[cleanTranscript] chunk ${chunkIndex}/${totalChunks}`);
    const cleanedChunk = await cleanChunk(chunk);
    allCleaned.push(...cleanedChunk);
  }

  // Update Supabase — only rows where text actually changed or was removed
  let updatedCount = 0;
  let removedCount = 0;

  for (const cleaned of allCleaned) {
    const original = lines.find((l) => l.id === cleaned.id);
    if (!original || cleaned.text === original.text) continue;

    if (cleaned.text === "") {
      // Hallucinated line — delete the utterance entirely
      const { error: deleteError } = await supabase
        .from("utterances")
        .delete()
        .eq("id", cleaned.id);
      if (deleteError) {
        console.error(`[cleanTranscript] delete failed for ${cleaned.id}:`, deleteError);
      } else {
        removedCount++;
      }
    } else {
      // Corrected text — update words array
      const cleanedWords = cleaned.text.split(" ").map((word) => ({ text: word }));
      const { error: updateError } = await supabase
        .from("utterances")
        .update({ words: cleanedWords })
        .eq("id", cleaned.id);
      if (updateError) {
        console.error(`[cleanTranscript] update failed for ${cleaned.id}:`, updateError);
      } else {
        updatedCount++;
      }
    }
  }

  console.log(
    `[cleanTranscript] END bot_id=${botId} — ${updatedCount} corrected, ${removedCount} hallucinations removed`,
  );
}
