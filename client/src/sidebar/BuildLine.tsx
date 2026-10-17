import { useEffect, useState } from 'react';
import type { Store } from '../net';
import { fetchServerVersion, versionLine, versionTitle, type ServerVersion } from '../buildInfo';

/** The server's version and commit, quietly under your card; the page's own build is in the tooltip (and shown when it's stale). */
export function BuildLine({ store }: { store: Store }) {
  const [server, setServer] = useState<ServerVersion | null>(null);
  useEffect(() => { if (store.connected) void fetchServerVersion().then(setServer); }, [store.connected]); // again after a reconnect: the server may have been deployed
  return <div className="sb-build" title={versionTitle(server)}>{versionLine(server)}</div>;
}
