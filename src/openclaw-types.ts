import type { IncomingMessage, ServerResponse } from "node:http";

export type OpenClawConfig = Record<string, unknown>;

export type PluginLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type HttpRoute = {
  path: string;
  auth: "plugin" | "gateway";
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>;
};

export type AgentToolResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

export type AnyAgentTool = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ): Promise<AgentToolResult> | AgentToolResult;
  ownerOnly?: boolean;
};

export type OpenClawPluginToolFactory = (ctx: { sandboxed?: boolean }) => AnyAgentTool | null;
export type OpenClawPluginToolOptions = {
  optional?: boolean;
  name?: string;
};

export type OpenClawPluginApi = {
  pluginConfig: unknown;
  config: OpenClawConfig;
  logger: PluginLogger;
  runtime: {
    state: {
      resolveStateDir(): string;
    };
    stt: {
      transcribeAudioFile(params: {
        filePath: string;
        mime?: string;
        cfg: OpenClawConfig;
        agentDir: string;
      }): Promise<{ text?: string; transcript?: string } | string>;
    };
    system: {
      requestHeartbeatNow(): Promise<void>;
    };
  };
  registerTool(tool: AnyAgentTool | OpenClawPluginToolFactory, options?: OpenClawPluginToolOptions): void;
  registerHttpRoute(route: HttpRoute): void;
  registerCli(
    register: (params: {
      program: {
        command(name: string): {
          description(text: string): {
            command(name: string): {
              description(text: string): {
                action(handler: () => Promise<void> | void): void;
              };
            };
          };
        };
      };
    }) => void,
    options?: { commands?: string[] },
  ): void;
  registerService(service: {
    id: string;
    start(): Promise<void>;
    stop(): Promise<void>;
  }): void;
};
