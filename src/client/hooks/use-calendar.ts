import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { CalendarSchema } from "../../schemas/CalendarArtifactSchema";

export function useCalendar(props: { email: string | null }) {
    const { email } = z.object({ email: z.string().nullable() }).parse(props);

    const { data: results, isPending } = useQuery({
        queryKey: ["calendars"], // email'i key'den çıkar — her zaman tümünü getir
        queryFn: async () => {
            try {
                const url = new URL("/api/calendar", window.location.origin);
                // email parametresini GÖNDERME — tüm calendarsları getir

                const res = await fetch(url.toString());
                if (!res.ok) throw new Error(await res.text());

                const data = z
                    .object({ calendars: CalendarSchema.array() })
                    .parse(await res.json());

                // localStorage'ı güncelle (geriye dönük uyumluluk için ilkini sakla)
                if (data.calendars.length > 0) {
                    const firstEmail = data.calendars[0].platform_email;
                    if (firstEmail) {
                        localStorage.setItem("weya_platform_email", firstEmail);
                    }
                } else {
                    localStorage.removeItem("weya_platform_email");
                }

                return data;
            } catch (error) {
                console.error("Error fetching calendars:", error);
                toast.error("Failed to fetch calendars. See console for details.");
            }
        },
        enabled: true,
    });

    return { calendars: results?.calendars ?? [], isPending };
}