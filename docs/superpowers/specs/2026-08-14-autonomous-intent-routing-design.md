# Autonomous Intent Routing Design

## Goal

WhiteLily should infer whether the owner is chatting or requesting an in-game action without asking the owner to choose between those modes. Clear action requests should execute directly; ordinary conversation should receive a conversational reply; clarification should be reserved for genuinely missing execution-critical information.

## Evidence and root cause

Live Minecraft logs show that `来我身边` and `走到我身边` were repeatedly classified as `clarify`, producing the question “你希望我陪你聊聊天，还是要我在游戏里做一件事？”. The intent schema defines the available decision kinds but does not define when `clarify` is appropriate or establish that an actionable request should prefer a task decision. Parsing, task execution, and transport remained healthy, so the correction belongs at the owner-intent prompt boundary.

## Considered approaches

1. Hard-code specific Chinese commands. This would be fast but brittle, language-specific, and contrary to the existing semantic-routing design.
2. Treat every owner message as a task. This would remove the unwanted question but break normal conversation.
3. Add a general decision policy and a few semantic examples to the intent prompt. This preserves model judgment while clearly separating action, chat, and necessary clarification.

Approach 3 is selected.

## Decision policy

- Prefer a task decision whenever the owner reasonably requests an observable in-world action and the goal can be inferred from the message plus current context.
- Do not seek confirmation for clear action requests and never ask whether the owner wants to chat or take action.
- Use `chat` for conversation, questions, reactions, or social messages that do not request an in-world action.
- Use `clarify` only when a critical target, object, direction, destination, or other execution parameter cannot be inferred safely from the message or context. Ask only for the missing information.
- With an active task, use `continue_task` for the same goal, `replace_task` for a different requested goal, and preserve the existing rules for chat, stop, and clarification.
- Examples are semantic guidance, not keyword matching: “come to me” and “cut down a tree” are tasks, “good morning” is chat, and unresolved “put it there” requires clarification.

## Scope and data flow

`buildOwnerIntentTurn()` remains the sole prompt builder. It will add a reusable decision-policy block before the existing JSON schema and untrusted owner/context data. No task schema, parser, execution budget, Minecraft tool, or transport behavior changes.

## Verification

1. A unit regression test must fail before implementation because the generated prompt lacks the autonomous decision policy.
2. The intent-router unit suite and companion-service integration suite must pass after the change.
3. Root and desktop TypeScript checks must pass.
4. The prepared desktop bundle must contain the updated compiled intent router and a valid runtime manifest.
5. After local installation and restart, a live `来我身边` message must produce a task decision and movement attempt, with no chat/action meta-question.
