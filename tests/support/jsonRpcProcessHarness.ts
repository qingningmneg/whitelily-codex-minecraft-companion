import {
  JsonRpcProcess,
  type JsonRpcLineTransport,
  type JsonRpcMessage,
} from "../../src/codex/jsonRpcProcess.js";

export function createJsonRpcProcessHarness(options: { requestTimeoutMs?: number } = {}) {
  const harness = createJsonRpcLineTransportHarness();
  return {
    ...harness,
    process: new JsonRpcProcess(harness.transport, options),
  };
}

export function createJsonRpcLineTransportHarness() {
  let lineListener: ((line: string) => void) | undefined;
  let exitListener: ((error?: Error) => void) | undefined;
  const sent: string[] = [];
  const sentWaiters: Array<(message: JsonRpcMessage) => void> = [];
  let nextSentIndex = 0;
  let closed = false;
  const transport: JsonRpcLineTransport = {
    writeLine: (line) => {
      sent.push(line);
      const waiter = sentWaiters.shift();
      if (waiter) {
        nextSentIndex += 1;
        waiter(JSON.parse(line) as JsonRpcMessage);
      }
    },
    onLine: (listener) => {
      lineListener = listener;
      return () => {
        lineListener = undefined;
      };
    },
    onExit: (listener) => {
      exitListener = listener;
      return () => {
        exitListener = undefined;
      };
    },
    close: () => {
      closed = true;
    },
  };
  return {
    transport,
    receive: (message: JsonRpcMessage) => lineListener?.(JSON.stringify(message)),
    exit: (error?: Error) => exitListener?.(error),
    sent: () => sent.map((line) => JSON.parse(line) as JsonRpcMessage),
    nextSent: () => {
      const line = sent[nextSentIndex];
      if (line !== undefined) {
        nextSentIndex += 1;
        return Promise.resolve(JSON.parse(line) as JsonRpcMessage);
      }
      return new Promise<JsonRpcMessage>((resolve) => {
        sentWaiters.push(resolve);
      });
    },
    closed: () => closed,
  };
}
