/**
 * One typed request/response channel between the main thread and a module
 * worker — the boundary all four of Chromashift's workers speak.
 *
 * A protocol is a map of method name → `(request) => response`, declared once
 * next to the worker and imported as a type by its host:
 *
 *   export type MotionProtocol = { 'motion-field': (req: MotionFieldRequest) => MotionFieldResponse };
 *
 *   // worker
 *   exposeWorkerRpc<MotionProtocol>(self, { 'motion-field': (req, ctx) => … });
 *   // host
 *   const rpc = createWorkerRpc<MotionProtocol>(() => new Worker(…), { label: 'motion' });
 *   const res = await rpc.call('motion-field', req, { transfer: [req.pixels] });
 *
 * What the channel guarantees, so no host has to hand-roll it again:
 *
 * - **Every call settles.** Replies are correlated by id. A worker-level
 *   `error` (a script that failed to load, an OOM, an exception outside any
 *   handler) rejects every call in flight and drops the worker; the next call
 *   spawns a fresh one. A `messageerror` (a reply that could not be
 *   deserialized — its id is unknowable) rejects every call in flight but keeps
 *   the worker. An optional per-call timeout rejects that call alone.
 * - **The worker is lazy.** Nothing is constructed until the first `call()`, so
 *   a host can be created eagerly without fetching the worker's chunk.
 * - **Progress is typed.** A handler may report progress any number of times
 *   before it returns; the host receives it on that call's `onProgress`.
 * - **Transfers are explicit** on both sides: `transfer` on the call, and
 *   `ctx.transfer(…)` in the handler for the reply.
 */

/** Any worker API: method name → `(request) => response`. */
export type RpcProtocol<P> = { [M in keyof P]: (req: never) => unknown };

export type RpcRequest<P, M extends keyof P> =
  P[M] extends (req: infer Req) => unknown ? Req : never;

export type RpcResponse<P, M extends keyof P> =
  P[M] extends (req: never) => infer Res ? Awaited<Res> : never;

/** What crosses the boundary. Hosts and workers never build these by hand. */
export type RpcCallMessage = { rpc: 'call'; id: number; method: string; req: unknown };
export type RpcReplyMessage =
  | { rpc: 'ok'; id: number; res: unknown }
  | { rpc: 'error'; id: number; message: string }
  | { rpc: 'progress'; id: number; progress: unknown };

export interface RpcCallOptions<Progress> {
  /** Moved, not copied, to the worker. The caller must not touch them afterwards. */
  transfer?: Transferable[];
  onProgress?: (progress: Progress) => void;
  /** Rejects this call if no reply arrives in time; overrides the channel default. */
  timeoutMs?: number;
}

export interface WorkerRpc<P extends RpcProtocol<P>, Progress = never> {
  call<M extends keyof P & string>(
    method: M,
    req: RpcRequest<P, M>,
    options?: RpcCallOptions<Progress>,
  ): Promise<RpcResponse<P, M>>;
  /** Calls still waiting on a reply. */
  readonly pending: number;
  /** Rejects every call in flight and terminates the worker. A later call spawns a new one. */
  terminate(reason?: string): void;
}

export interface WorkerRpcOptions {
  /** Prefixes every error this channel raises, e.g. `motion worker: timed out`. */
  label: string;
  /** Default per-call timeout in ms. Omitted: calls wait as long as the worker lives. */
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (res: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: never) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createWorkerRpc<P extends RpcProtocol<P>, Progress = never>(
  factory: () => Worker,
  options: WorkerRpcOptions,
): WorkerRpc<P, Progress> {
  const { label } = options;
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  function settle(id: number): PendingCall | undefined {
    const call = pending.get(id);
    if (!call) return undefined;
    pending.delete(id);
    if (call.timer !== undefined) clearTimeout(call.timer);
    return call;
  }

  function rejectAll(error: Error): void {
    for (const id of [...pending.keys()]) settle(id)?.reject(error);
  }

  function drop(target: Worker): void {
    target.terminate();
    if (worker === target) worker = null;
  }

  function spawn(): Worker {
    const created = factory();
    created.addEventListener('message', (e: MessageEvent<RpcReplyMessage>) => {
      const msg = e.data;
      if (msg.rpc === 'progress') {
        (pending.get(msg.id)?.onProgress as ((p: unknown) => void) | undefined)?.(msg.progress);
      } else if (msg.rpc === 'ok') {
        settle(msg.id)?.resolve(msg.res);
      } else if (msg.rpc === 'error') {
        settle(msg.id)?.reject(new Error(msg.message));
      }
    });
    created.addEventListener('error', (e: ErrorEvent) => {
      // Not attributable to one call, and the worker may be half-dead (a
      // failed import, an OOM): fail everything and start over next time.
      rejectAll(new Error(`${label} worker: ${e.message || 'worker error'}`));
      drop(created);
    });
    created.addEventListener('messageerror', () => {
      rejectAll(new Error(`${label} worker: a reply could not be deserialized`));
    });
    return created;
  }

  return {
    call(method, req, callOptions = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const entry: PendingCall = {
          resolve: resolve as (res: unknown) => void,
          reject,
          onProgress: callOptions.onProgress as PendingCall['onProgress'],
        };
        pending.set(id, entry);
        const timeoutMs = callOptions.timeoutMs ?? options.timeoutMs;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            settle(id)?.reject(new Error(`${label} worker: "${method}" timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        }
        try {
          worker ??= spawn();
          const message: RpcCallMessage = { rpc: 'call', id, method, req };
          worker.postMessage(message, callOptions.transfer ?? []);
        } catch (error) {
          settle(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    get pending() {
      return pending.size;
    },
    terminate(reason = 'terminated') {
      rejectAll(new Error(`${label} worker: ${reason}`));
      if (worker) drop(worker);
    },
  };
}

/** The slice of `DedicatedWorkerGlobalScope` a worker hands `exposeWorkerRpc`. */
export interface RpcWorkerScope {
  addEventListener(type: 'message', listener: (e: MessageEvent<RpcCallMessage>) => void): void;
  postMessage(message: RpcReplyMessage, transfer: Transferable[]): void;
}

export interface RpcHandlerContext<Progress> {
  progress(value: Progress): void;
  /** Moves these with the reply instead of copying them. */
  transfer(...objects: Transferable[]): void;
}

export type RpcHandlers<P extends RpcProtocol<P>, Progress = never> = {
  [M in keyof P]: (
    req: RpcRequest<P, M>,
    ctx: RpcHandlerContext<Progress>,
  ) => RpcResponse<P, M> | Promise<RpcResponse<P, M>>;
};

/**
 * Worker side: answers every call with exactly one `ok` or `error` reply. A
 * handler that throws (or rejects) becomes an `error` reply for that call
 * alone, never a worker-level error that would fail its siblings.
 */
export function exposeWorkerRpc<P extends RpcProtocol<P>, Progress = never>(
  scope: RpcWorkerScope,
  handlers: RpcHandlers<P, Progress>,
): void {
  scope.addEventListener('message', (e) => {
    const { id, method, req } = e.data;
    const transfer: Transferable[] = [];
    const ctx: RpcHandlerContext<Progress> = {
      progress: (progress) => scope.postMessage({ rpc: 'progress', id, progress }, []),
      transfer: (...objects) => { transfer.push(...objects); },
    };
    const reply = async (): Promise<void> => {
      try {
        if (!Object.prototype.hasOwnProperty.call(handlers, method)) {
          throw new Error(`unknown method "${method}"`);
        }
        const handler = handlers[method as keyof P] as (req: unknown, ctx: RpcHandlerContext<Progress>) => unknown;
        const res = await handler(req, ctx);
        scope.postMessage({ rpc: 'ok', id, res }, transfer);
      } catch (error) {
        scope.postMessage({ rpc: 'error', id, message: error instanceof Error ? error.message : String(error) }, []);
      }
    };
    void reply();
  });
}
