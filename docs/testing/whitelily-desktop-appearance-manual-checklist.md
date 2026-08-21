# WhiteLily Desktop Appearance Manual Checklist

Date: 2026-08-21
Build/commit: to be recorded after Task 5 commit
Tester: controller-required
Overall status: NOT RUN — interactive desktop and Minecraft acceptance remains

## Desktop appearance library

- [ ] At 736 px window width, ten appearance cards remain one non-wrapping row.
- [ ] At 360 px window width, ten appearance cards remain one non-wrapping row.
- [ ] The first built-in original portrait is fully visible with `object-fit: contain`.
- [ ] The tenth card is reachable with the appearance track scrollbar.
- [ ] The root page has no horizontal scrolling at either width.
- [ ] A damaged built-in portrait shows a safe preview/placeholder without a blank window.
- [ ] AI chat still replies after the damaged-portrait case.

Evidence to attach: 736 px screenshot, 360 px screenshot, damaged-portrait screenshot, AI reply screenshot.

## Real Minecraft world

- [ ] Switch from the built-in WhiteLily skin to one imported 64×64 RGBA user skin.
- [ ] Confirm the new skin only after its first successful vanilla player frame.
- [ ] Restart desktop and Minecraft; confirm the last committed skin is restored.
- [ ] Change worlds during prepare/commit; confirm the candidate is cancelled and the old skin remains.
- [ ] Confirm front and back views for both the built-in and imported skin.
- [ ] Confirm main-hand and off-hand items render normally.
- [ ] Confirm walking, running, jumping, swimming, attacking, mining, fishing, eating and sleeping.
- [ ] Confirm queued actions continue across an appearance failure.
- [ ] Confirm “先停下来吧” stops at the next valid state update.
- [ ] Confirm “先来帮我一下” interrupts the work action at the next valid state update.
- [ ] Confirm Minecraft connection and AI conversation remain usable after a failed first frame.

Evidence to attach: world/session ID, before/after front/back screenshots, restart result, world-change cancellation log, action/AI transcript.

## Required visual confirmation

- [ ] Present one comparison containing: user original artwork / complete in-app 2D portrait / Minecraft native skin front and back.
- [ ] Record the user's explicit visual approval.

No visual acceptance may be marked complete without the explicit user confirmation above.
