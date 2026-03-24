import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { CalendarSchema } from "../../schemas/CalendarArtifactSchema";

export function useCalendar(props?: { email?: string | null }) {
    const email = props?.email ?? null;
    const { getToken } = useAuth();

    const { data: results, isPending } = useQuery({
        queryKey: ["calendars", email ?? "all"],
        queryFn: async () => {
            try {
                const url = new URL("/api/calendar", window.location.origin);
                // Sadece email verilmişse filtrele, yoksa hepsini getir
                if (email) url.searchParams.set("platform_email", email);

                const token = await getToken();
                const res = await fetch(url.toString(), {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!res.ok) throw new Error(await res.text());

                const data = z
                    .object({ calendars: CalendarSchema.array() })
                    .parse(await res.json());

                // localStorage ve URL manipülasyonu KALDIRILDI
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