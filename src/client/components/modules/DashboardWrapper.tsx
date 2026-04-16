import {
  Bell,
  BookOpen,
  Bot,
  Calendar,
  ChevronRight,
  FileText,
  Menu,
  Search,
  Settings,
  X,
  Zap,
} from "lucide-react";
import { UserButton, useUser } from "@clerk/react";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "../../utils/cn";

type NavItem = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href: string;
};

const WORKSPACE_ITEMS: NavItem[] = [
  { icon: Calendar, label: "Calendars", href: "/dashboard/calendar" },
  { icon: Zap, label: "Instant meeting", href: "/dashboard/instant-meeting" },
  { icon: FileText, label: "Notes", href: "/dashboard/notes" },
  { icon: BookOpen, label: "Knowledge base", href: "/dashboard/knowledge-base" },
];

const CONFIGURE_ITEMS: NavItem[] = [
  { icon: Bot, label: "Voice agent", href: "/dashboard/voice-agent-settings" },
  { icon: Settings, label: "Settings", href: "/dashboard/settings" },
];

const BREADCRUMB_MAP: Record<string, string> = {
  "/dashboard/calendar": "Calendars",
  "/dashboard/instant-meeting": "Instant meeting",
  "/dashboard/notes": "Notes",
  "/dashboard/knowledge-base": "Knowledge base",
  "/dashboard/voice-agent-settings": "Voice agent",
  "/dashboard/settings": "Settings",
};

function getBreadcrumbLabel(pathname: string): string {
  if (pathname.startsWith("/dashboard/notes/")) return "Note detail";
  return BREADCRUMB_MAP[pathname] ?? "Dashboard";
}

function DashboardWrapper({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const { user } = useUser();

  const breadcrumb = getBreadcrumbLabel(location.pathname);
  const userEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const initials = userEmail
    ? userEmail
      .split("@")[0]
      .split(/[._-]/)
      .map((s) => s[0]?.toUpperCase())
      .slice(0, 2)
      .join("")
    : "W";

  return (
    <div className="min-h-screen bg-muted/30">
      {/* ── Top bar ──────────────────────────────────────────── */}
      <nav className="fixed top-0 left-0 right-0 h-14 bg-background border-b border-border z-50 px-4">
        <div className="flex items-center justify-between h-full">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-muted rounded-md md:hidden transition-colors"
              aria-label="Toggle sidebar"
            >
              {sidebarOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>

            {/* Breadcrumb */}
            <div className="hidden md:flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Workspace</span>
              <ChevronRight className="size-3.5 text-muted-foreground/60" />
              <span className="font-medium text-foreground">{breadcrumb}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative hidden md:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search meetings, notes…"
                disabled
                className="pl-9 pr-3 py-1.5 h-8 text-sm bg-muted/50 border border-border rounded-md w-60 focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/70"
              />
            </div>
            <button
              className="p-2 hover:bg-muted rounded-md relative transition-colors"
              aria-label="Notifications"
            >
              <Bell className="size-4 text-muted-foreground" />
              <span className="absolute top-1.5 right-1.5 size-1.5 bg-brand-600 rounded-full" />
            </button>
            <div className="ml-1">
              <UserButton />
            </div>
          </div>
        </div>
      </nav>

      {/* ── Sidebar ──────────────────────────────────────────── */}
      <aside
        className={cn(
          "fixed top-14 left-0 bottom-0 w-60 bg-sidebar border-r border-sidebar-border z-40 transition-transform md:translate-x-0 flex flex-col",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-sidebar-border">
          <div className="size-8 rounded-lg bg-brand-600 flex items-center justify-center shrink-0">
            <span className="text-white text-sm font-semibold tracking-tight">W</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">Weya</p>
            <p className="text-[11px] text-muted-foreground leading-tight">Command Center</p>
          </div>
        </div>

        {/* Nav */}
        <div className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
          <NavSection title="Workspace" items={WORKSPACE_ITEMS} location={location} onNavigate={() => setSidebarOpen(false)} />
          <NavSection title="Configure" items={CONFIGURE_ITEMS} location={location} onNavigate={() => setSidebarOpen(false)} />
        </div>

        {/* User block */}
        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2.5 p-2 rounded-md bg-background border border-border">
            <div className="size-8 rounded-full bg-brand-50 text-brand-700 flex items-center justify-center text-xs font-semibold shrink-0">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium truncate">{user?.fullName ?? "Signed in"}</p>
              <p className="text-[11px] text-muted-foreground truncate">{userEmail}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Main content ─────────────────────────────────────── */}
      <main className="pt-14 md:pl-60">
        <div className="p-6 md:p-8 max-w-[1400px] mx-auto">{children}</div>
      </main>
    </div>
  );
}

function NavSection({
  title,
  items,
  location,
  onNavigate,
}: {
  title: string;
  items: NavItem[];
  location: { pathname: string };
  onNavigate: () => void;
}) {
  return (
    <div>
      <p className="px-2 mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="space-y-0.5">
        {items.map((item) => {
          const isActive =
            location.pathname === item.href ||
            (item.href === "/dashboard/notes" && location.pathname.startsWith("/dashboard/notes"));
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              to={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors",
                isActive
                  ? "bg-background border border-border text-foreground font-medium shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground border border-transparent",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default DashboardWrapper;