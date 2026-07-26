import type { GameAction } from "../../src/domain/types.js";

// @ts-expect-error Generic Minecraft commands are intentionally absent.
const command: GameAction = { kind: "run_command", command: "/op WhiteLily" };
// @ts-expect-error Arbitrary JavaScript is intentionally absent.
const javascript: GameAction = { kind: "run_javascript", source: "void 0" };
// @ts-expect-error Arbitrary shell commands are intentionally absent.
const shell: GameAction = { kind: "run_shell", command: "whoami" };
// @ts-expect-error Player-targeted attacks are intentionally absent.
const playerAttack: GameAction = { kind: "attack_player", username: "TestOwner" };
// @ts-expect-error Generic held-item activation is intentionally absent.
const genericHeldItemUse: GameAction = { kind: "use_held_item" };

void [command, javascript, shell, playerAttack, genericHeldItemUse];
