export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  text: string;
  status: "completed" | "failed" | "interrupted";
}

export interface CodexPort {
  start(): Promise<void>;
  listModels(): Promise<string[]>;
  validateModelSelection(selection: { modelId: string; reasoningEffort: string }): Promise<boolean>;
  startThread(input: {
    cwd: string;
    model: string;
    reasoningEffort: string;
    toolAccess?: "none" | "minecraft";
  }): Promise<string>;
  sendTurn(
    threadId: string,
    text: string,
    onStarted?: (turnId: string) => void,
  ): Promise<CodexTurnResult>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  closeThread(threadId: string): Promise<void>;
  stop(): Promise<void>;
}
