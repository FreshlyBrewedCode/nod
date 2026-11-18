/**
 * The web app's one way to `nod serve`. `ConnectionProvider` (once, at the
 * root) owns the pairing and the socket; `useConnection()` anywhere below
 * reads the pushed state and gets typed actions:
 *
 *   const { status, welcome, snapshot, signer, actions } = useConnection();
 *   await actions.unlock(passphrase, { minutes: 15 });
 *   await actions.sign([{ pr: 482, head_sha: pr.headSha }]);
 *
 * Actions resolve with the request's result and reject with `RequestFailed`
 * (its `code` is the protocol's error code, or `offline` / `timeout`). The
 * state they change also arrives as a push, so a component may ignore what
 * they resolve with.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { RequestBody, RequestResult, RequestType, SignEntry } from "../../shared/protocol";
import {
  INITIAL_STATE,
  NodClient,
  PAIRING_KEY,
  RequestFailed,
  forgetPairing,
  loadPairing,
  readHostLink,
  socketUrl,
  takePairing,
  type ConnectionState,
  type Pairing,
} from "@/lib/connection";

export interface Actions {
  request<K extends RequestType>(t: K, body: RequestBody<K>): Promise<RequestResult<K>>;
  unlock(
    passphrase: string,
    options?: { minutes?: number; once?: boolean },
  ): Promise<RequestResult<"unlock">>;
  lock(): Promise<RequestResult<"lock">>;
  /** Nod a batch at the heads the user looked at; `note` is the comment's human line. */
  sign(
    entries: ReadonlyArray<SignEntry>,
    options?: { note?: string },
  ): Promise<RequestResult<"sign">>;
  ackFyi(pr: number): Promise<RequestResult<"ack-fyi">>;
  refresh(): Promise<RequestResult<"refresh">>;
  /** Forget this browser's pairing (it needs the host link again). */
  unpair(): void;
}

export interface Connection extends ConnectionState {
  readonly pairing: Pairing | null;
  readonly actions: Actions;
}

const UNPAIRED: ConnectionState = { ...INITIAL_STATE, status: "unpaired" };

/** Owns the socket. Use once, at the root; `useConnection` reads it. */
export function useNodConnection(): Connection {
  const [pairing, setPairing] = useState<Pairing | null>(() =>
    takePairing(window.location, window.history, window.localStorage),
  );
  // The state of the client of one pairing; a new pairing starts from scratch.
  const [pushed, setPushed] = useState<{ for: Pairing; state: ConnectionState } | null>(null);
  const state = !pairing ? UNPAIRED : pushed?.for === pairing ? pushed.state : INITIAL_STATE;
  const client = useRef<NodClient | null>(null);

  // A host link opened in this tab (hashchange), or another tab paired (storage).
  useEffect(() => {
    const repair = () => {
      const before = window.location.hash;
      const next = readHostLink(before).pairing
        ? takePairing(window.location, window.history, window.localStorage)
        : loadPairing(window.localStorage);
      // The host link left the address bar (and maybe led on to a remembered
      // deep link): `replaceState` fires no event, so the route hears of it here.
      if (window.location.hash !== before) window.dispatchEvent(new HashChangeEvent("hashchange"));
      setPairing((current) =>
        current?.host === next?.host && current?.token === next?.token ? current : next,
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === PAIRING_KEY || event.key === null) repair();
    };
    window.addEventListener("hashchange", repair);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("hashchange", repair);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!pairing) return;
    const c = new NodClient(socketUrl(pairing));
    client.current = c;
    const off = c.subscribe(() => setPushed({ for: pairing, state: c.state }));
    return () => {
      off();
      c.close();
      if (client.current === c) client.current = null;
    };
  }, [pairing]);

  const actions = useMemo<Actions>(() => {
    const request = <K extends RequestType>(t: K, body: RequestBody<K>) =>
      client.current
        ? client.current.request(t, body)
        : Promise.reject(new RequestFailed("offline", "Not paired with nod serve."));
    return {
      request,
      unlock: (passphrase, options = {}) => request("unlock", { passphrase, ...options }),
      lock: () => request("lock", {}),
      sign: (entries, options = {}) => request("sign", { entries, verdict: "approve", ...options }),
      ackFyi: (pr) => request("ack-fyi", { pr }),
      refresh: () => request("refresh", {}),
      unpair: () => {
        forgetPairing(window.localStorage);
        setPairing(null);
      },
    };
  }, []);

  return { ...state, pairing, actions };
}

const ConnectionContext = createContext<Connection | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const connection = useNodConnection();
  return createElement(ConnectionContext.Provider, { value: connection }, children);
}

export function useConnection(): Connection {
  const connection = useContext(ConnectionContext);
  if (!connection) throw new Error("useConnection needs a ConnectionProvider above it");
  return connection;
}
