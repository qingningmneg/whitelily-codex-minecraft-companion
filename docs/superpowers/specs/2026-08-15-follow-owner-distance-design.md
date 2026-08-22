# Follow Owner Distance Design

## Problem

For the owner request “到我身边来”, the execution model copied the task limit
`maxHorizontalTravel: 128` into `minecraft_follow_owner.distance`. The tool contract accepts only an
integer from 2 through 16, so every attempted call was rejected before Minecraft execution.

## Design

- Keep the strict `distance` range of 2 through 16 and all existing safety gates.
- In the task-execution prompt, define `minecraft_follow_owner.distance` as the desired gap from the
  owner, explicitly separate it from `maxHorizontalTravel`, and require the safe default `2` when the
  owner asks WhiteLily to come beside them without specifying a gap.
- Apply the same wording to the dynamic tool description so both model-visible contracts agree.
- Do not clamp, coerce, or silently accept invalid tool arguments.

## Verification

- Add regression assertions for the execution prompt and generated dynamic tool specification.
- Run the focused prompt-builder and dynamic-tool tests, then the affected integration suite,
  TypeScript checks, formatting checks, and desktop bundle preparation.
- Install the rebuilt runtime without closing Minecraft and send “到我身边来” from the owner account.
  Success means the live call uses a legal distance and WhiteLily actually approaches the owner.

