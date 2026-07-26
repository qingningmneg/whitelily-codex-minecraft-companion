const automaticModels = ["gpt-5.6-terra", "gpt-5.6-luna"] as const;

export function selectModel(available: readonly string[], preferred: string): string {
  if (
    automaticModels.includes(preferred as (typeof automaticModels)[number]) &&
    available.includes(preferred)
  ) {
    return preferred;
  }

  for (const model of automaticModels) {
    if (available.includes(model)) return model;
  }

  throw new Error("no compatible fast Codex model");
}
