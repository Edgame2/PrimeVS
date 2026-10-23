// Minimal protocol types for Prime-Agent RPC mode.
// Full reference: dist/modes/rpc/rpc-types.d.ts in the prime-agent package.

export interface RpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface ModelInfo {
  provider?: string;
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface RpcSessionState {
  model?: ModelInfo;
  thinkingLevel?: string;
  isStreaming?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  [key: string]: unknown;
}

// Agent events streamed from the connection. The shapes below are permissive on
// purpose: the prime-agent package may extend them between versions.
export interface AgentEvent {
  type: string;
  [key: string]: any;
}

export interface ToolResultLike {
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
