import { useAuth } from "@clerk/react";
import { SignIn } from "@clerk/react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, AlertCircle, Clock, CheckCircle2, UserPlus } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/Card";

interface InviteDetails {
    id: string;
    project_id: string;
    project_name: string;
    invited_by: string;
    invited_email: string | null;
    status: "pending" | "accepted" | "expired";
    expires_at: string;
    created_at: string;
}

function formatRelativeDate(dateStr: string): string {
    const diff = new Date(dateStr).getTime() - Date.now();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    if (days <= 0) return "today";
    if (days === 1) return "tomorrow";
    return `in ${days} days`;
}

export default function InviteAcceptPage() {
    const { token } = useParams<{ token: string }>();
    const { isLoaded, isSignedIn, getToken } = useAuth();
    const navigate = useNavigate();
    const [showSignIn, setShowSignIn] = useState(false);

    const { data: invite, isPending: isInviteLoading, error: inviteError } = useQuery<InviteDetails>({
        queryKey: ["invite", token],
        queryFn: async () => {
            const res = await fetch(`/api/invitations/${token}`);
            if (!res.ok) throw new Error(String(res.status));
            return res.json();
        },
        enabled: !!token,
        retry: false,
    });

    const acceptMutation = useMutation({
        mutationFn: async () => {
            const authToken = await getToken();
            const res = await fetch(`/api/invitations/${token}/accept`, {
                method: "POST",
                headers: { Authorization: `Bearer ${authToken}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<{ project_name: string }>;
        },
        onSuccess: (data) => {
            toast.success(`You joined ${data.project_name}!`);
            navigate("/dashboard/knowledge-base");
        },
        onError: (err: Error) => toast.error(err.message),
    });

    // ── Loading (Clerk not ready or invite fetch in progress) ────────────
    if (!isLoaded || isInviteLoading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 gap-3">
                <Loader2 className="size-8 text-blue-500 animate-spin" />
                <p className="text-sm text-gray-500">Loading invitation…</p>
            </div>
        );
    }

    // ── 404 — token not found ────────────────────────────────────────────
    if (inviteError || !invite) {
        return (
            <CenteredCard>
                <AlertCircle className="size-10 text-red-400 mx-auto mb-2" />
                <CardTitle className="text-center">Invitation Not Found</CardTitle>
                <CardDescription className="text-center mt-1">
                    This invitation link is invalid or has been removed.
                </CardDescription>
                <Button className="mt-6 w-full" onClick={() => navigate("/dashboard/knowledge-base")}>
                    Go to Dashboard
                </Button>
            </CenteredCard>
        );
    }

    // ── Expired ──────────────────────────────────────────────────────────
    const isExpired =
        invite.status === "expired" || new Date(invite.expires_at) < new Date();

    if (isExpired) {
        return (
            <CenteredCard>
                <Clock className="size-10 text-yellow-400 mx-auto mb-2" />
                <CardTitle className="text-center">Invitation Expired</CardTitle>
                <CardDescription className="text-center mt-1">
                    This invitation has expired. Ask the project owner to send a new one.
                </CardDescription>
                <Button className="mt-6 w-full" onClick={() => navigate("/dashboard/knowledge-base")}>
                    Go to Dashboard
                </Button>
            </CenteredCard>
        );
    }

    // ── Already accepted ─────────────────────────────────────────────────
    if (invite.status === "accepted") {
        return (
            <CenteredCard>
                <CheckCircle2 className="size-10 text-green-500 mx-auto mb-2" />
                <CardTitle className="text-center">Already a Member</CardTitle>
                <CardDescription className="text-center mt-1">
                    You're already a member of <span className="font-medium text-gray-700">{invite.project_name}</span>.
                </CardDescription>
                <Button className="mt-6 w-full" onClick={() => navigate("/dashboard/knowledge-base")}>
                    Go to Project
                </Button>
            </CenteredCard>
        );
    }

    // ── Valid invite — logged out ─────────────────────────────────────────
    if (!isSignedIn) {
        return (
            <CenteredCard wide={showSignIn}>
                {showSignIn ? (
                    <SignIn forceRedirectUrl={window.location.pathname} />
                ) : (
                    <>
                        <UserPlus className="size-10 text-blue-500 mx-auto mb-2" />
                        <CardTitle className="text-center">{invite.project_name}</CardTitle>
                        <CardDescription className="text-center mt-1">
                            <span className="font-medium text-gray-600">{invite.invited_by}</span> invited you to join this project.
                        </CardDescription>
                        <p className="text-xs text-center text-gray-400 mt-2">
                            Expires {formatRelativeDate(invite.expires_at)}
                        </p>
                        <Button className="mt-6 w-full" onClick={() => setShowSignIn(true)}>
                            Sign in to accept
                        </Button>
                    </>
                )}
            </CenteredCard>
        );
    }

    // ── Valid invite — logged in ──────────────────────────────────────────
    return (
        <CenteredCard>
            <UserPlus className="size-10 text-blue-500 mx-auto mb-2" />
            <CardTitle className="text-center">{invite.project_name}</CardTitle>
            <CardDescription className="text-center mt-2">
                <span className="font-medium text-gray-600">{invite.invited_by}</span> invited you to join this project.
            </CardDescription>
            <p className="text-xs text-center text-gray-400 mt-1">
                Expires {formatRelativeDate(invite.expires_at)}
            </p>
            <Button
                className="mt-6 w-full flex items-center justify-center gap-2"
                disabled={acceptMutation.isPending}
                onClick={() => acceptMutation.mutate()}
            >
                {acceptMutation.isPending ? (
                    <><Loader2 className="size-4 animate-spin" />Accepting…</>
                ) : "Accept Invitation"}
            </Button>
        </CenteredCard>
    );
}

function CenteredCard({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50 px-4">
            <Card className={`w-full ${wide ? "max-w-md" : "max-w-sm"} shadow-md`}>
                <CardHeader className="pb-2" />
                <CardContent className="flex flex-col pb-6">
                    {children}
                </CardContent>
            </Card>
        </div>
    );
}
