import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import LookupPage from "@/pages/lookup-page";
import SearchPage from "@/pages/search-page";
import SessionPage from "@/pages/session-page";
import MorePage from "@/pages/more-page";
import PriceComparePage from "@/pages/price-compare-page";
import { ScanLine, Search, ListChecks, MoreHorizontal } from "lucide-react";

const TABS = [
  { path: "/",        label: "Lookup",  Icon: ScanLine    },
  { path: "/search",  label: "Search",  Icon: Search      },
  { path: "/session", label: "Session", Icon: ListChecks  },
  { path: "/more",    label: "More",    Icon: MoreHorizontal },
];

function useSessionItemCount() {
  const { data: sessionData } = useQuery<any>({
    queryKey: ["/api/sessions/active"],
    refetchInterval: 5000,
  });
  const sessionId = sessionData?.session?.id;
  const { data: itemsData } = useQuery<any>({
    queryKey: ["/api/scanned-items", sessionId],
    enabled: !!sessionId,
    refetchInterval: 5000,
  });
  return (itemsData?.items?.length ?? 0) as number;
}

function BottomNav() {
  const [location, setLocation] = useLocation();
  const sessionCount = useSessionItemCount();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-zinc-900 border-t border-zinc-800 flex"
         style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {TABS.map(({ path, label, Icon }) => {
        const active = path === "/" ? location === "/" : location.startsWith(path);
        const isSession = path === "/session";
        return (
          <button
            key={path}
            data-testid={`tab-${label.toLowerCase()}`}
            onClick={() => setLocation(path)}
            className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] font-medium transition-colors
              ${active ? "text-blue-400" : "text-zinc-500"}`}
          >
            <div className="relative">
              <Icon className={`h-5 w-5 ${active ? "stroke-[2.5]" : "stroke-2"}`} />
              {isSession && sessionCount > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 bg-blue-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5 leading-none">
                  {sessionCount > 99 ? "99+" : sessionCount}
                </span>
              )}
            </div>
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function Router() {
  return (
    <>
      <div className="pb-16">
        <Switch>
          <Route path="/" component={LookupPage} />
          <Route path="/search" component={SearchPage} />
          <Route path="/session" component={SessionPage} />
          <Route path="/more" component={MorePage} />
          <Route path="/more/price-compare" component={PriceComparePage} />
          <Route component={NotFound} />
        </Switch>
      </div>
      <BottomNav />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
