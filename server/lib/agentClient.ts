/**
 * Gemini Managed Agents client.
 * The server only sends user prompts — no inline system instructions.
 */

/* ────────────────────────────────────────────────────────── */
/*  Types                                                      */
/* ────────────────────────────────────────────────────────── */

export interface InteractionOptions {
  prompt: string;
  agentName?: string;
  environmentId?: string;
  previousInteractionId?: string;
  stream?: boolean;
  inlineSources?: Array<{
    type: string;
    content: string;
    target: string;
  }>;
  signal?: AbortSignal;
}

export interface AgentEvent {
  type:
    | "info"
    | "thinking"
    | "text"
    | "tool_call"
    | "tool_result"
    | "complete"
    | "error"
    | "done";
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  interaction?: Record<string, unknown>;
  message?: string;
}

/* ────────────────────────────────────────────────────────── */
/*  Create an interaction                                       */
/* ────────────────────────────────────────────────────────── */
export const API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export async function createInteraction(
  opts: InteractionOptions
): Promise<Response> {
  const agentName = opts.agentName ?? "antigravity-preview-09-2026";

  const payload: Record<string, unknown> = {
    agent: agentName,
    input: [
      {
        type: "text",
        text: opts.prompt,
      },
    ],
    stream: true,
  };

  // Environment config
  if (opts.environmentId) {
    payload.environment = { env_id: opts.environmentId };
  } else {
    const envConfig: Record<string, unknown> = {
      type: "remote",
      sources: opts.inlineSources ?? [],
      network: {
        allowlist: [
          {
            domain: "generativelanguage.googleapis.com",
            transform: { "x-goog-api-key": process.env.GEMINI_API_KEY },
          },
          { domain: "*" },
        ],
      },
    };
    payload.environment = envConfig;
  }

  if (opts.previousInteractionId) {
    payload.previous_interaction_id = opts.previousInteractionId;
  }

  const response = await fetch(`${API_BASE_URL}/interactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY || "",
      "x-server-timeout": "600",
      "Api-Revision": "2026-05-20",
      "x-goog-api-client": "applet-ai-radio/1.0.0",
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  return response;
}

/* ────────────────────────────────────────────────────────── */
/*  Parse SSE stream                                            */
/* ────────────────────────────────────────────────────────── */

/**
 * Async generator that yields parsed AgentEvent objects from
 * the Gemini Managed Agents SSE stream.
 */
export async function* streamInteraction(
  response: Response
): AsyncGenerator<AgentEvent> {
  console.log(`[streamInteraction] Initializing stream reader on body present: ${!!response.body}`);
  const reader = response.body?.getReader();
  if (!reader) {
    console.error(`[streamInteraction] Error: response.body.getReader() is undefined!`);
    yield { type: "error", message: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;

  try {
    while (true) {
      console.log(`[streamInteraction] Pre-read: Awaiting chunk #${chunkCount + 1}...`);
      const { done, value } = await reader.read();
      console.log(`[streamInteraction] Post-read: chunk #${chunkCount + 1} done=${done}, value_length=${value ? value.length : 0}`);
      if (done) {
        console.log(`[streamInteraction] Stream reader reported done.`);
        break;
      }

      chunkCount++;
      const decoded = decoder.decode(value, { stream: true });
      console.log(`[streamInteraction] Raw decoded chunk text length: ${decoded.length}, contents (first 200 chars): "${decoded.substring(0, 200)}"`);
      buffer += decoded;

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      console.log(`[streamInteraction] Processing ${lines.length} lines from buffer. Leftover buffer size: ${buffer.length}`);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.log(`[streamInteraction] Parsing line: "${trimmed}"`);

        if (!trimmed.startsWith("data: ")) {
          console.log(`[streamInteraction] Skipping non-SSE line: "${trimmed}"`);
          continue;
        }

        const dataStr = trimmed.slice(6); // Strip "data: " prefix
        console.log(`[streamInteraction] SSE Payload data content: "${dataStr}"`);
        if (dataStr === "[DONE]") {
          console.log(`[streamInteraction] Received [DONE] token.`);
          yield { type: "done" };
          return;
        }

        try {
          const data = JSON.parse(dataStr);
          const event = parseAgentEvent(data);
          if (event) {
            console.log(`[streamInteraction] Successfully parsed event: type="${event.type}"`);
            yield event;
          } else {
            console.log(`[streamInteraction] parseAgentEvent returned null for data:`, JSON.stringify(data).substring(0, 100));
          }
        } catch (jsonErr: any) {
          console.error(`[streamInteraction] JSON Parse Error on payload "${dataStr}":`, jsonErr.message);
          // Malformed JSON line — skip
          continue;
        }
      }
    }
  } catch (err: any) {
    console.error(`[streamInteraction] Exception caught in read loop:`, err);
    yield { type: "error", message: `Stream read exception: ${err.message}` };
  } finally {
    reader.releaseLock();
    console.log(`[streamInteraction] Stream reader released lock.`);
  }
}

/* ────────────────────────────────────────────────────────── */
/*  Parse a single raw SSE event into a frontend-friendly fmt  */
/* ────────────────────────────────────────────────────────── */

function parseAgentEvent(
  event: Record<string, unknown>
): AgentEvent | null {
  const eventType = event.event_type as string | undefined;

  // 1. Interaction created
  if (eventType === "interaction.created") {
    const interaction = (event.interaction as Record<string, unknown>) ?? {};
    return {
      type: "info",
      message: "Agent session initialized",
      interaction,
    };
  }

  // 2. Interaction status update
  if (eventType === "interaction.status_update") {
    const status = (event.status as string) || "in_progress";
    return {
      type: "info",
      message: `Status: ${status}`,
    };
  }

  // 3. Step start
  if (eventType === "step.start") {
    const step = event.step as Record<string, unknown> | undefined;
    if (!step) return null;

    // Check for tool results if provided directly on step start
    const resultVal =
      step.result !== undefined
        ? step.result
        : step.response !== undefined
        ? step.response
        : step.output;
    if (resultVal !== undefined && resultVal !== null) {
      const resultStr =
        typeof resultVal === "object" ? JSON.stringify(resultVal) : String(resultVal);
      return {
        type: "tool_result",
        name: (step.name as string | undefined) || (step.type as string | undefined),
        result: resultStr,
      };
    }

    // Check for tool calls (code_execution_call, function_call, etc.)
    const isToolCall =
      step.type === "code_execution_call" ||
      step.type === "function_call" ||
      (step.id !== undefined && (step.arguments !== undefined || step.call !== undefined)) ||
      step.name !== undefined ||
      step.arguments !== undefined ||
      step.call !== undefined;

    if (isToolCall) {
      const callName =
        (step.name as string | undefined) ||
        (step.type === "code_execution_call" ? "code_execution_call" : undefined) ||
        ((step.call as any)?.name as string | undefined) ||
        (step.type as string | undefined);

      const argumentsObj =
        (step.arguments as Record<string, unknown> | undefined) ||
        ((step.call as any)?.arguments as Record<string, unknown> | undefined);

      return {
        type: "tool_call",
        name: callName || "code_execution_call",
        arguments: argumentsObj ?? {},
      };
    }

    // Check for thought / reasoning step start
    if (
      step.type === "thought" ||
      step.type === "thinking" ||
      step.type === "thought_summary" ||
      step.type === "thought_delta"
    ) {
      const thoughtText =
        typeof step.thought === "string"
          ? step.thought
          : typeof step.summary === "string"
          ? step.summary
          : typeof step.text === "string"
          ? step.text
          : "";

      if (thoughtText) {
        return {
          type: "thinking",
          text: thoughtText,
        };
      }
      return null;
    }

    // Check for initial text in model_output
    if (step.type === "model_output" && Array.isArray(step.content)) {
      let initialText = "";
      for (const part of step.content) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") {
            initialText += p.text;
          }
        }
      }
      if (initialText) {
        return {
          type: "text",
          text: initialText,
        };
      }
    }

    return null;
  }

  // 4. Step stop
  if (eventType === "step.stop") {
    const step = event.step as Record<string, unknown> | undefined;
    if (step) {
      const resultVal =
        step.result !== undefined
          ? step.result
          : step.response !== undefined
          ? step.response
          : step.output;
      if (resultVal !== undefined && resultVal !== null) {
        const resultStr =
          typeof resultVal === "object" ? JSON.stringify(resultVal) : String(resultVal);
        return {
          type: "tool_result",
          name: (step.name as string | undefined) || (step.type as string | undefined),
          result: resultStr,
        };
      }
    }
    return null;
  }

  // 5. Step delta
  if (eventType === "step.delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!delta) return null;

    // Tool Call results (function results, code execution output etc.)
    const resultVal =
      delta.result !== undefined
        ? delta.result
        : delta.response !== undefined
        ? delta.response
        : delta.output;
    if (resultVal !== undefined && resultVal !== null) {
      let resultStr = "";
      if (typeof resultVal === "object") {
        resultStr = JSON.stringify(resultVal);
      } else {
        resultStr = String(resultVal);
      }
      return {
        type: "tool_result",
        name: (delta.name as string | undefined) || (delta.type as string | undefined),
        result: resultStr,
      };
    }

    // Tool Calls (function calls, code execution triggers etc.)
    const argumentsObj =
      (delta.arguments as Record<string, unknown> | undefined) ||
      ((delta.call as any)?.arguments as Record<string, unknown> | undefined);
    const callName =
      (delta.name as string | undefined) ||
      ((delta.call as any)?.name as string | undefined) ||
      (delta.type === "code_execution_call" ? "code_execution_call" : undefined);

    if (callName || argumentsObj) {
      return {
        type: "tool_call",
        name: callName || "code_execution_call",
        arguments: argumentsObj ?? {},
      };
    }

    // Text & Reasoning / Thinking deltas (content modalities)
    let extractedText = "";
    let isThinking = false;

    // Check if the step delta is annotated as a thought/reasoning step
    if (
      delta.type === "thought_summary" ||
      delta.type === "thinking" ||
      delta.type === "thought" ||
      delta.type === "thought_delta"
    ) {
      isThinking = true;
    }

    if (typeof delta.text === "string") {
      extractedText = delta.text;
    } else if (typeof delta.thought === "string") {
      extractedText = delta.thought;
      isThinking = true;
    } else if (typeof delta.summary === "string" && isThinking) {
      extractedText = delta.summary;
    }

    // Parse the content modalities representation: "content" represents modalities only
    const content = delta.content;
    if (content !== undefined && content !== null) {
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === "object") {
            const partObj = part as Record<string, unknown>;
            if (partObj.type === "thought") {
              isThinking = true;
              if (typeof partObj.text === "string") {
                extractedText += partObj.text;
              } else if (typeof partObj.thought === "string") {
                extractedText += partObj.thought;
              }
            } else if (partObj.type === "text" && typeof partObj.text === "string") {
              extractedText += partObj.text;
            } else if (typeof partObj.thought === "string") {
              extractedText += partObj.thought;
              isThinking = true;
            }
          } else if (typeof part === "string") {
            extractedText += part;
          }
        }
      } else if (typeof content === "object") {
        const cObj = content as Record<string, unknown>;
        if (cObj.type === "thought") {
          isThinking = true;
          if (typeof cObj.text === "string") {
            extractedText = cObj.text;
          } else if (typeof cObj.thought === "string") {
            extractedText = cObj.thought;
          }
        } else if (cObj.type === "text" && typeof cObj.text === "string") {
          extractedText = cObj.text;
        } else if (typeof cObj.thought === "string") {
          extractedText = cObj.thought;
          isThinking = true;
        }
      } else if (typeof content === "string") {
        extractedText = content;
      }
    }

    if (extractedText) {
      return {
        type: isThinking ? "thinking" : "text",
        text: extractedText,
      };
    }
  }

  // 6. Interaction completed
  if (eventType === "interaction.completed") {
    return {
      type: "complete",
      interaction: (event.interaction as Record<string, unknown>) ?? {},
    };
  }

  // 7. Interaction failed or error
  if (eventType === "interaction.failed" || eventType === "error") {
    const errObj = (event.error as Record<string, unknown>) || event;
    const msg =
      (errObj.message as string) || (event.message as string) || "Interaction failed";
    return {
      type: "error",
      message: msg,
    };
  }

  return null;
}
