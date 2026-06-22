import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { parseApiError } from "../lib/parseApiError";

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
        mutationFn: async () => {
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
            });
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(parseApiError(errText));
            }
            return { isScheduled: true };
        },
        onSuccess: () => {
            toast.success(`${label} scheduled`);
            void queryClient.invalidateQueries({ queryKey: ["calendar_events"] });
        },
        onError: (error) => {
            console.error(`Error scheduling ${label}:`, error);
            toast.error(error.message);
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
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(parseApiError(errText));
            }
            return { isUnscheduled: true };
        },
        onSuccess: () => {
            toast.success(`${label} cancelled`);
            void queryClient.invalidateQueries({ queryKey: ["calendar_events"] });
        },
        onError: (error) => {
            console.error(`Error cancelling ${label}:`, error);
            toast.error(error.message);
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
