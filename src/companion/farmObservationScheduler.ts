import type { Vec3 } from "../domain/types.js";

export interface FarmObservationSchedule {
  readonly worldGeneration: number;
  readonly position: Vec3;
  readonly earliestAt: number;
  readonly purpose: "wheat_maturity";
}

export interface FarmObservationDue {
  readonly worldGeneration: number;
  readonly position: Vec3;
  readonly purpose: "wheat_maturity";
}

function boundedPosition(position: Vec3): Vec3 {
  if (
    !Number.isSafeInteger(position.x) ||
    !Number.isSafeInteger(position.y) ||
    !Number.isSafeInteger(position.z)
  ) {
    throw new Error("farm observation position is invalid");
  }
  return { x: position.x, y: position.y, z: position.z };
}

/** Schedules observation only; all Minecraft actions remain owned by the action queue. */
export class FarmObservationScheduler {
  readonly #scheduled: FarmObservationSchedule[] = [];

  schedule(input: FarmObservationSchedule): void {
    if (!Number.isSafeInteger(input.worldGeneration) || input.worldGeneration < 0) {
      throw new Error("farm observation world generation is invalid");
    }
    if (!Number.isFinite(input.earliestAt)) throw new Error("farm observation time is invalid");
    this.#scheduled.push({
      worldGeneration: input.worldGeneration,
      position: boundedPosition(input.position),
      earliestAt: input.earliestAt,
      purpose: "wheat_maturity",
    });
  }

  cancelWorld(worldGeneration: number): void {
    for (let index = this.#scheduled.length - 1; index >= 0; index -= 1) {
      if (this.#scheduled[index]?.worldGeneration === worldGeneration)
        this.#scheduled.splice(index, 1);
    }
  }

  due(now: number): readonly FarmObservationDue[] {
    if (!Number.isFinite(now)) throw new Error("farm observation time is invalid");
    const due: FarmObservationDue[] = [];
    for (let index = this.#scheduled.length - 1; index >= 0; index -= 1) {
      const scheduled = this.#scheduled[index];
      if (!scheduled || scheduled.earliestAt > now) continue;
      this.#scheduled.splice(index, 1);
      due.unshift({
        worldGeneration: scheduled.worldGeneration,
        position: { ...scheduled.position },
        purpose: scheduled.purpose,
      });
    }
    return due;
  }
}
