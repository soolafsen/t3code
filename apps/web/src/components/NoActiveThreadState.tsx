import { useNavigate } from "@tanstack/react-router";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";

export function NoActiveThreadState() {
  const navigate = useNavigate();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-lg rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl">Pick a thread to continue</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => void navigate({ to: "/settings/general" })}>
                Open settings
              </Button>
              <Button
                variant="outline"
                render={
                  <a
                    href="https://github.com/soolafsen/t3code/blob/dev/docs/t3homer-mvp.md"
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                Read the Homer guide
              </Button>
            </div>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
