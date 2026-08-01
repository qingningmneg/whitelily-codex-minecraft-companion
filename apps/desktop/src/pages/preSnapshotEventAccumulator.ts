import type { RuntimeEvent } from "../../../../src/runtime/runtimeEvents";

interface PreSnapshotEventAccumulator {
  add(event: RuntimeEvent): void;
  clear(): void;
  drain(): RuntimeEvent[];
}

export function createPreSnapshotEventAccumulator(): PreSnapshotEventAccumulator {
  const events = new Map<RuntimeEvent["kind"], RuntimeEvent>();
  let released = false;

  return {
    add: (event) => {
      if (released) return;
      events.set(event.kind, event);
    },
    clear: () => {
      released = true;
      events.clear();
    },
    drain: () => {
      if (released) return [];
      const retained = [...events.values()].sort((left, right) => left.revision - right.revision);
      released = true;
      events.clear();
      return retained;
    },
  };
}
