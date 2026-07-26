export type CompanionMode = "friend" | "balanced" | "autonomous";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface WorldSnapshot {
  botPosition: Vec3;
  worldSpawn?: Vec3;
  botYaw?: number;
  botPitch?: number;
  ownerPosition?: Vec3;
  health: number;
  food: number;
  timeOfDay: number;
  weather: "clear" | "rain" | "thunder";
  inventorySummary: Array<{ name: string; count: number }>;
  nearbyBlocks?: Array<{ name: string; position: Vec3 }>;
  nearbyEntities?: Array<{ id: number; kind: string; position: Vec3 }>;
  nearbyHostiles: Array<{ kind: string; position: Vec3 }>;
}

export type GameAction =
  | { kind: "say"; message: string }
  | { kind: "move_to"; position: Vec3 }
  | { kind: "follow_owner"; distance: number }
  | { kind: "look_at"; position: Vec3 }
  | { kind: "jump" }
  | { kind: "dig_block"; position: Vec3; blockName: string }
  | { kind: "place_block"; position: Vec3; blockName: string }
  | { kind: "craft_item"; itemName: string; count: number }
  | { kind: "smelt_item"; itemName: string; count: number }
  | { kind: "collect_dropped"; entityId: number }
  | {
      kind: "equip_item";
      itemName: string;
      destination: "hand" | "head" | "torso" | "legs" | "feet";
    }
  | { kind: "attack_hostile"; entityId: number }
  | { kind: "wait"; milliseconds: number };

export type ConfirmableOperation =
  { kind: "game_action"; action: GameAction } | { kind: "memory_clear" };

export type SafetyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "confirm"; reason: string; confirmationId: number; expiresAt: string };
