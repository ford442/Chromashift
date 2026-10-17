/**
 * Test doubles for `rpc.ts` hosts. Vitest's `node` environment has no
 * `Worker`, so a host under test is handed one of these through its factory.
 *
 * - `LoopbackWorker` runs real `exposeWorkerRpc` handlers over a
 *   `MessageChannel`, so structured cloning and transfers behave as they do
 *   across a real worker boundary.
 * - `ScriptedWorker` answers nothing on its own: the test reads `calls` and
 *   decides when (and whether) each one is answered, or kills the worker.
 */

import { exposeWorkerRpc, type RpcCallMessage, type RpcHandlers, type RpcProtocol, type RpcReplyMessage } from './rpc';

type Listener = (event: never) => void;

class FakeWorkerBase {
  terminated = false;
  protected listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }

  terminate(): void {
    this.terminated = true;
  }

  protected emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) (listener as (e: unknown) => void)(event);
  }

  /** A worker-level `error`: the worker crashed outside any handler. */
  crash(message = 'worker crashed'): void {
    this.emit('error', { message, error: new Error(message) });
  }

  /** A reply the host could not deserialize. */
  messageError(): void {
    this.emit('messageerror', {});
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

export class ScriptedWorker extends FakeWorkerBase {
  calls: Array<{ message: RpcCallMessage; transfer: Transferable[] }> = [];
  throwOnPostMessage: Error | null = null;

  postMessage(message: RpcCallMessage, transfer: Transferable[] = []): void {
    if (this.throwOnPostMessage) throw this.throwOnPostMessage;
    this.calls.push({ message, transfer });
  }

  reply(message: RpcReplyMessage): void {
    this.emit('message', { data: message });
  }

  resolveCall(index: number, res: unknown): void {
    this.reply({ rpc: 'ok', id: this.calls[index].message.id, res });
  }

  rejectCall(index: number, message: string): void {
    this.reply({ rpc: 'error', id: this.calls[index].message.id, message });
  }

  progressCall(index: number, progress: unknown): void {
    this.reply({ rpc: 'progress', id: this.calls[index].message.id, progress });
  }
}

export class LoopbackWorker<P extends RpcProtocol<P>, Progress = never> extends FakeWorkerBase {
  private readonly channel = new MessageChannel();

  constructor(handlers: RpcHandlers<P, Progress>) {
    super();
    const { port1: host, port2: inside } = this.channel;
    host.addEventListener('message', (e) => this.emit('message', { data: e.data }));
    host.start();
    exposeWorkerRpc<P, Progress>({
      addEventListener: (_type, listener) => {
        inside.addEventListener('message', listener as (e: MessageEvent) => void);
        inside.start();
      },
      postMessage: (message, transfer) => inside.postMessage(message, transfer),
    }, handlers);
  }

  postMessage(message: RpcCallMessage, transfer: Transferable[] = []): void {
    this.channel.port1.postMessage(message, transfer);
  }

  override terminate(): void {
    super.terminate();
    this.channel.port1.close();
    this.channel.port2.close();
  }
}
