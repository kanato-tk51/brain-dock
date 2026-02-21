"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "next-auth/react";
import { type PropsWithChildren, useMemo } from "react";
import { SessionGuard } from "@/features/auth/SessionGuard";

type ProvidersProps = PropsWithChildren<{
  authRequired: boolean;
}>;

export function Providers({ children, authRequired }: ProvidersProps) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1000,
            gcTime: 1000 * 60 * 10,
          },
        },
      }),
    [],
  );

  return (
    <SessionProvider refetchInterval={5 * 60} refetchOnWindowFocus>
      <SessionGuard enabled={authRequired} />
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SessionProvider>
  );
}
