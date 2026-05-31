export const MCP_ENDPOINT = "https://substrate-exchange.5.78.90.96.sslip.io/mcp";
export const DEFAULT_RESOURCE_PREFIX = "public/";
const LIST_PAGE_LIMIT = 100;
const ACTIVITY_LIMIT = 25;

let nextRequestId = 1;

export async function loadExchangeSnapshot({ resourcePrefix = DEFAULT_RESOURCE_PREFIX } = {}) {
  const [statusResult, listResult, recentResult] = await Promise.all([
    callExchangeTool("exchange_status"),
    listExchangeResources(resourcePrefix),
    callExchangeTool("exchange_recent_activity", { limit: ACTIVITY_LIMIT })
  ]);

  const resources = await Promise.all(
    listResult.items.map((item) => loadResourceDetails(item))
  );

  return {
    surface: statusResult.surface ?? "exchange",
    principal: statusResult.principal ?? "unknown principal",
    capturedAt: new Date().toISOString(),
    allowedModes: statusResult.allowed_modes ?? statusResult.allowedModes ?? [],
    resourcePrefix,
    status: statusResult,
    rawStatus: statusResult,
    rawList: listResult.rawList,
    resources: sortResources(resources),
    recentActivity: normalizeRecentActivity(recentResult.items ?? []),
    rawRecentActivity: recentResult
  };
}

async function listExchangeResources(resourcePrefix) {
  const items = [];
  const pages = [];
  let cursor;

  do {
    const page = await callExchangeTool("exchange_list", {
      prefix: resourcePrefix,
      limit: LIST_PAGE_LIMIT,
      ...(cursor ? { cursor } : {})
    });

    pages.push(page);
    items.push(...(page.items ?? []));
    cursor = page.next_cursor ?? page.nextCursor ?? null;
  } while (cursor);

  return {
    items,
    rawList: rawListForPages(pages, items)
  };
}

async function loadResourceDetails(item) {
  const listedPath = item.path;
  const [readResult, inspectResult] = await Promise.all([
    callExchangeTool("exchange_read", { resource: listedPath }),
    inspectResource(listedPath)
  ]);
  const path = readResult.resource ?? listedPath;
  const inspect = inspectResult.rawInspect;

  return {
    path,
    kind: kindForPath(path),
    ref: readResult.ref ?? item.ref ?? "",
    content: readResult.content ?? "",
    inspect,
    claims: claimsForInspect(inspect),
    rawRead: readResult,
    rawInspect: inspectResult.rawInspect,
    inspectError: inspectResult.inspectError
  };
}

async function inspectResource(path) {
  try {
    return {
      rawInspect: await callExchangeTool("exchange_inspect", { resource: path }),
      inspectError: null
    };
  } catch (error) {
    return {
      rawInspect: null,
      inspectError: error instanceof Error ? error.message : String(error)
    };
  }
}

function rawListForPages(pages, items) {
  const lastPage = pages.at(-1) ?? {};
  const rawList = {
    ...lastPage,
    items
  };

  if (pages.length > 1) {
    rawList.pages = pages;
  }

  return rawList;
}

async function callExchangeTool(name, args = {}) {
  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRequestId++,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    })
  });

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`MCP ${name} failed with HTTP ${response.status}: ${bodyText}`);
  }

  const envelope = parseRpcEnvelope(bodyText);
  if (envelope.error) {
    const message = envelope.error.message ?? JSON.stringify(envelope.error);
    throw new Error(`MCP ${name} failed: ${message}`);
  }

  const textItem = envelope.result?.content?.find((item) => item.type === "text");
  if (envelope.result?.isError) {
    const message = textItem?.text?.trim() || JSON.stringify(envelope.result);
    throw new Error(`MCP ${name} failed: ${message}`);
  }

  if (!textItem?.text) {
    throw new Error(`MCP ${name} returned no JSON text content.`);
  }

  try {
    return JSON.parse(textItem.text);
  } catch (error) {
    throw new Error(`MCP ${name} returned non-JSON text content: ${shortTextSnippet(textItem.text)}`);
  }
}

function shortTextSnippet(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function parseRpcEnvelope(bodyText) {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    throw new Error("MCP response was empty.");
  }

  try {
    return JSON.parse(trimmed);
  } catch (jsonError) {
    if (!/^data:/m.test(trimmed)) {
      throw jsonError;
    }
  }

  const events = trimmed
    .split(/\r?\n\r?\n/)
    .map((eventBlock) =>
      eventBlock
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
    )
    .filter((payload) => payload && payload !== "[DONE]");

  if (!events.length) {
    throw new Error("MCP response stream did not include a data payload.");
  }

  for (const event of [...events].reverse()) {
    try {
      return JSON.parse(event);
    } catch {
      // Keep scanning older SSE payloads; some streams include non-JSON terminal events.
    }
  }

  throw new Error("MCP response stream did not include a JSON data payload.");
}

function kindForPath(path) {
  if (path.includes("/transcripts/")) {
    return "transcript";
  }

  if (path.includes("/salon/") || path.startsWith("public/salon/")) {
    return "salon";
  }

  return "guide";
}

function sortResources(resources) {
  const exactPriority = new Map([
    ["public/start", 0],
    ["public/about", 1],
    ["public/how-to-participate", 2],
    ["public/salon/index", 3]
  ]);
  const scopedPriority = new Map([
    ["start", 0],
    ["about", 1],
    ["how-to-participate", 2],
    ["salon/index", 3]
  ]);

  return [...resources].sort((a, b) => {
    const aPriority = priorityForPath(a.path, exactPriority, scopedPriority);
    const bPriority = priorityForPath(b.path, exactPriority, scopedPriority);
    return aPriority - bPriority || a.path.localeCompare(b.path);
  });
}

function priorityForPath(path, exactPriority, scopedPriority) {
  if (exactPriority.has(path)) {
    return exactPriority.get(path);
  }

  const scopedPath = path.split("/").slice(1).join("/");
  return scopedPriority.get(scopedPath) ?? scopedPriority.get(path) ?? 100;
}

function claimsForInspect(inspect) {
  if (!inspect || typeof inspect !== "object") {
    return [];
  }

  const claims = inspect.claims ?? inspect.summary?.claims ?? inspect.details?.claims;
  return Array.isArray(claims) ? claims : [];
}

function normalizeRecentActivity(items) {
  return items.map((item) => {
    const operation = firstDefined(item.operation, item.op, item.tool, item.name);
    const action = firstDefined(item.action, item.event, item.type, item.activity);

    return {
      time: firstDefined(item.time, item.timestamp, item.created_at, item.createdAt, ""),
      mode: firstDefined(item.move_mode, item.moveMode, item.mode, item.action, item.operation, "activity"),
      principal: firstDefined(item.principal, item.actor, item.user, ""),
      resource: firstDefined(item.resource, item.path, ""),
      producedRef: firstDefined(
        item.produced_ref,
        item.producedRef,
        item.activity_ref,
        item.activityRef,
        item.ref,
        ""
      ),
      ...(operation !== undefined ? { operation } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(item.note !== undefined ? { note: item.note } : {}),
      ...(item.title !== undefined ? { title: item.title } : {}),
      ...(item.details !== undefined ? { details: item.details } : {}),
      raw: item
    };
  });
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}
