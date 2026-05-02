import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";

export function useToggleRecording(props: {
    calendarId: string;
    calendarEventId: string;
    botType?: "recording" | "voice_agent";
}) {
    const { calendarId: _calendarId, calendarEventId } = z.object({
        calendarId: z.string(),
        calendarEventId: z.string(),
    }).parse(props);

    const botType = props.botType ?? "recording";
    const queryClient = useQueryClient();
    const { getToken } = useAuth();

    const label = botType === "voice_agent" ? "Voice agent" : "Recording";

    const { mutate: scheduleRecording, isPending: isScheduling } = useMutation({
        mutationFn: async (vars?: { tag_ids?: string[] }) => {
            const url = new URL("/api/calendar/events/bot", window.location.origin);
            url.searchParams.set("calendar_event_id", calendarEventId);
            url.searchParams.set("bot_type", botType);

            const token = await getToken();
            const res = await fetch(url.toString(), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: vars?.tag_ids?.length ? JSON.stringify({ tag_ids: vars.tag_ids }) : undefined,
            });
            if (!res.ok) throw new Error(await res.text());
            return { isScheduled: true };
        },
        onSuccess: () => {
            toast.success(`${label} scheduled`);
            void queryClient.invalidateQueries({ queryKey: ["calendar_events"] });
        },
        onError: (error) => {
            console.error(`Error scheduling ${label}:`, error);
            toast.error(`Failed to schedule ${label}. See console for details.`);
        },
    });

    const { mutate: unscheduleRecording, isPending: isUnscheduling } = useMutation({
        mutationFn: async () => {
            const url = new URL("/api/calendar/events/bot", window.location.origin);
            url.searchParams.set("calendar_event_id", calendarEventId);
            url.searchParams.set("bot_type", botType);

            const token = await getToken();
            const res = await fetch(url.toString(), {
                method: "DELETE",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!res.ok) throw new Error(await res.text());
            return { isUnscheduled: true };
        },
        onSuccess: () => {
            toast.success(`${label} cancelled`);
            void queryClient.invalidateQueries({ queryKey: ["calendar_events"] });
        },
        onError: (error) => {
            console.error(`Error cancelling ${label}:`, error);
            toast.error(`Failed to cancel ${label}. See console for details.`);
        },
    });

    return {
        scheduleRecording,
        unscheduleRecording,
        isScheduling,
        isUnscheduling,
        isPending: isScheduling || isUnscheduling,
    };
}
