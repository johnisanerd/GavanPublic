"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// One QueryClient per mounted view. Each list/detail island lives inside its
// own provider so server-rendered pages can stay server components and only the
// live-refreshing parts opt into react-query.
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
