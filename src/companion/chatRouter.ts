import { parseLocalCommand, type LocalCommand } from "../commands/commandParser.js";
import type { MinecraftEvent } from "../minecraft/minecraftPort.js";

export type ChatRoute =
  | { kind: "ignore" }
  | { kind: "command"; command: LocalCommand }
  | { kind: "owner_text"; text: string };

export class ChatRouter {
  constructor(private readonly options: { ownerUsername: string; maxMessageLength: number }) {}

  route(event: MinecraftEvent): ChatRoute {
    if (event.kind !== "chat" || event.username !== this.options.ownerUsername) {
      return { kind: "ignore" };
    }

    const command = parseLocalCommand(event.message);
    if (command) return { kind: "command", command };

    return {
      kind: "owner_text",
      text: Array.from(event.message.replace(/[\r\n]/g, " "))
        .slice(0, this.options.maxMessageLength)
        .join(""),
    };
  }
}
