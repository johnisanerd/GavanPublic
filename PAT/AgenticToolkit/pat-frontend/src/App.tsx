import { useMemo } from 'react';
import { useAuth } from '@clerk/react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AdminShell } from '@/components/shell/admin-shell';
import { SessionLayout } from '@/routes/SessionLayout';
import { LoginPage } from '@/routes/LoginPage';
import { Timeline } from '@/components/Timeline';
import { EventStream } from '@/components/EventStream';
import { DatabaseView } from '@/routes/DatabaseView';
import { PeopleView } from '@/routes/PeopleView';
import { MyHandlesView } from '@/routes/MyHandlesView';
import { EventDetailsProvider } from '@/components/EventDetailsModal';
import { useEventBuffer } from '@/hooks/use-event-buffer';

/**
 * Auth gate. Operators must have a Clerk session to see ANY of the UI; signed
 * out → the login page. The legacy `?token=` path (machine / pat-web iframe
 * embed) bypasses the gate — those callers authenticate to the API with the
 * viewer token, not a Clerk session.
 */
export function App() {
  const hasEmbedToken = useMemo(() => new URLSearchParams(window.location.search).has('token'), []);
  const { isLoaded, isSignedIn } = useAuth();

  if (hasEmbedToken) return <Dashboard />;
  if (!isLoaded) {
    return (
      <div className="bg-background text-muted-foreground flex min-h-screen items-center justify-center font-mono text-xs">
        loading…
      </div>
    );
  }
  if (!isSignedIn) return <LoginPage />;
  return <Dashboard />;
}

/**
 * Router + data root. `useEventBuffer()` runs the realtime SSE/buffer machinery
 * once here; route elements are defined inline so they capture it (no context
 * needed). The preserved Timeline gets the exact same `buffer`/`thread` props it
 * always had. EventDetailsProvider wraps everything (the Timeline depends on it).
 */
function Dashboard() {
  const eb = useEventBuffer();
  return (
    <EventDetailsProvider>
      <Routes>
        <Route element={<AdminShell />}>
          <Route index element={<Navigate to="/session/timeline" replace />} />
          <Route path="session" element={<SessionLayout eb={eb} />}>
            <Route index element={<Navigate to="/session/timeline" replace />} />
            <Route
              path="timeline"
              element={
                // Sized container so the Timeline's ResizeObserver reads a real
                // width (a collapsing flex child reintroduces the 1px-plot bug).
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <Timeline buffer={eb.buffer} thread={eb.displayedThread} />
                </div>
              }
            />
            <Route
              path="logs"
              element={<EventStream front={eb.front} back={eb.back} state={eb.threadScopedState} />}
            />
          </Route>
          <Route path="database" element={<DatabaseView token={eb.token} />} />
          <Route path="people" element={<PeopleView token={eb.token} />} />
          <Route path="my-handles" element={<MyHandlesView />} />
          <Route path="*" element={<Navigate to="/session/timeline" replace />} />
        </Route>
      </Routes>
    </EventDetailsProvider>
  );
}
