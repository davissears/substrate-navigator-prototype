import { loadExchangeSnapshot, MCP_ENDPOINT } from "./exchange-api.js";

const DEFAULT_RESOURCE_PREFIX = "public/";

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "around",
  "because",
  "before",
  "between",
  "could",
  "from",
  "have",
  "here",
  "into",
  "like",
  "more",
  "public",
  "salon",
  "that",
  "their",
  "there",
  "these",
  "this",
  "transcript",
  "using",
  "what",
  "when",
  "with",
  "would",
  "your"
]);

let exchangeSnapshot = {
  surface: "exchange",
  principal: "connecting",
  capturedAt: null,
  resourcePrefix: DEFAULT_RESOURCE_PREFIX,
  status: "loading",
  rawStatus: null,
  rawList: null,
  allowedModes: [],
  resources: [],
  recentActivity: [],
  rawRecentActivity: null
};
let resources = [];
let resourceByPath = new Map();
let renderedPath = null;

const state = {
  filter: "all",
  query: "",
  selectedPath: null,
  resourcePrefix: DEFAULT_RESOURCE_PREFIX,
  loadStatus: "loading",
  loadError: null
};

const els = {
  principal: document.querySelector("#principal"),
  connectionStatus: document.querySelector("#connectionStatus"),
  capturedAt: document.querySelector("#capturedAt"),
  scopeForm: document.querySelector("#scopeForm"),
  resourceScope: document.querySelector("#resourceScope"),
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  filters: [...document.querySelectorAll(".filter")],
  corpusStats: document.querySelector("#corpusStats"),
  resourceList: document.querySelector("#resourceList"),
  resourceKind: document.querySelector("#resourceKind"),
  resourceTitle: document.querySelector("#resourceTitle"),
  resourcePath: document.querySelector("#resourcePath"),
  resourceRef: document.querySelector("#resourceRef"),
  wordCount: document.querySelector("#wordCount"),
  content: document.querySelector("#content"),
  copyPath: document.querySelector("#copyPath"),
  outlineList: document.querySelector("#outlineList"),
  linkedResources: document.querySelector("#linkedResources"),
  relatedResources: document.querySelector("#relatedResources"),
  modeList: document.querySelector("#modeList"),
  inspectDetails: document.querySelector("#inspectDetails"),
  rawJson: document.querySelector("#rawJson"),
  recentActivity: document.querySelector("#recentActivity")
};

function selectedResource() {
  return resourceByPath.get(state.selectedPath);
}

function titleFor(resource) {
  const heading = contentFor(resource).match(/^#\s+(.+)$/m);
  return heading ? heading[1] : pathFor(resource).split("/").at(-1);
}

function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function contentFor(resource) {
  return String(resource?.content ?? "");
}

function pathFor(resource) {
  return String(resource?.path ?? "");
}

function shortRef(ref) {
  const value = String(ref ?? "");
  if (!value) {
    return "None";
  }

  if (value.length <= 24) {
    return value;
  }

  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

function formatDate(value) {
  if (!value) {
    return "pending";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function scopeLabel(value = state.resourcePrefix) {
  return value === "" ? "root scope" : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function headingsFor(resource) {
  if (!resource) {
    return [];
  }

  const counts = new Map();
  return contentFor(resource)
    .split("\n")
    .map((line) => line.match(/^(#{1,2})\s+(.+)$/))
    .filter(Boolean)
    .map((match) => {
      const text = match[2].trim();
      const base = slugify(text);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);

      return {
        id: count ? `${base}-${count + 1}` : base,
        level: match[1].length,
        text
      };
    });
}

function inlineMarkdown(value) {
  const html = [];
  const codePattern = /`([^`]+)`/g;
  let lastIndex = 0;
  let match = codePattern.exec(value);

  while (match) {
    html.push(escapeHtml(value.slice(lastIndex, match.index)));

    const code = match[1];
    const escapedCode = escapeHtml(code);
    if (resourceByPath.has(code)) {
      html.push(
        `<button class="inline-resource" data-path="${escapedCode}" type="button"><code>${escapedCode}</code></button>`
      );
    } else {
      html.push(`<code>${escapedCode}</code>`);
    }

    lastIndex = match.index + match[0].length;
    match = codePattern.exec(value);
  }

  html.push(escapeHtml(value.slice(lastIndex)));
  return html.join("");
}

function renderMarkdown(resource) {
  const lines = contentFor(resource).split("\n");
  const headings = headingsFor(resource);
  const html = [];
  let headingIndex = 0;
  let listOpen = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
      continue;
    }

    if (line.startsWith("## ") || line.startsWith("# ")) {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }

      const heading = headings[headingIndex];
      const tag = heading?.level === 1 ? "h2" : "h3";
      html.push(
        `<${tag} id="${escapeHtml(heading?.id ?? `section-${headingIndex}`)}">${inlineMarkdown(heading?.text ?? line.replace(/^#+\s+/, ""))}</${tag}>`
      );
      headingIndex += 1;
      continue;
    }

    if (line.startsWith("- ")) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
      continue;
    }

    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  if (listOpen) {
    html.push("</ul>");
  }

  return html.join("");
}

function cleanedText(value) {
  return value.replace(/[`#*_>-]/g, " ").replace(/\s+/g, " ").trim();
}

function highlightedSnippet(fragment, query) {
  const index = fragment.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return escapeHtml(fragment);
  }

  return [
    escapeHtml(fragment.slice(0, index)),
    "<mark>",
    escapeHtml(fragment.slice(index, index + query.length)),
    "</mark>",
    escapeHtml(fragment.slice(index + query.length))
  ].join("");
}

function snippetFor(resource) {
  const query = state.query.trim();
  if (!query) {
    return "";
  }

  const source = `${pathFor(resource)} ${cleanedText(contentFor(resource))}`;
  const matchIndex = source.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex < 0) {
    return "";
  }

  const start = Math.max(0, matchIndex - 54);
  const end = Math.min(source.length, matchIndex + query.length + 86);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < source.length ? " ..." : "";
  return `${prefix}${highlightedSnippet(source.slice(start, end), query)}${suffix}`;
}

function tokensFor(value) {
  return (value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function referencedResources(resource) {
  if (!resource) {
    return [];
  }

  return resources.filter(
    (candidate) => pathFor(candidate) !== pathFor(resource) && contentFor(resource).includes(pathFor(candidate))
  );
}

function backlinkResources(resource) {
  if (!resource) {
    return [];
  }

  return resources.filter(
    (candidate) => pathFor(candidate) !== pathFor(resource) && contentFor(candidate).includes(pathFor(resource))
  );
}

function relatedResourcesFor(resource) {
  if (!resource) {
    return [];
  }

  const sourceTokens = new Set(tokensFor(`${titleFor(resource)} ${contentFor(resource)}`));
  const outgoing = new Set(referencedResources(resource).map((item) => item.path));
  const incoming = new Set(backlinkResources(resource).map((item) => item.path));
  const sourceSegments = new Set(pathFor(resource).split("/").slice(0, -1));

  return resources
    .filter((candidate) => pathFor(candidate) !== pathFor(resource))
    .map((candidate) => {
      let score = candidate.kind === resource.kind ? 2 : 0;

      if (outgoing.has(candidate.path)) {
        score += 12;
      }

      if (incoming.has(candidate.path)) {
        score += 9;
      }

      for (const segment of candidate.path.split("/").slice(0, -1)) {
        if (sourceSegments.has(segment)) {
          score += 1;
        }
      }

      const candidateTokens = new Set(tokensFor(`${titleFor(candidate)} ${contentFor(candidate)}`));
      for (const token of sourceTokens) {
        if (candidateTokens.has(token)) {
          score += 1;
        }
      }

      return { resource: candidate, score };
    })
    .filter((item) => item.score > 3)
    .sort((a, b) => b.score - a.score || titleFor(a.resource).localeCompare(titleFor(b.resource)))
    .slice(0, 5)
    .map((item) => item.resource);
}

function filteredResources() {
  const query = state.query.toLowerCase();
  return resources.filter((resource) => {
    const matchesFilter = state.filter === "all" || resource.kind === state.filter;
    const haystack = `${pathFor(resource)}\n${contentFor(resource)}`.toLowerCase();
    return matchesFilter && haystack.includes(query);
  });
}

function resourceLinkButton(resource, label) {
  const path = pathFor(resource);
  return `
    <button class="link-card" data-path="${escapeHtml(path)}" type="button">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(titleFor(resource))}</strong>
      <small>${escapeHtml(path)}</small>
    </button>
  `;
}

function emptyPanel(message) {
  return `<p class="panel-empty">${escapeHtml(message)}</p>`;
}

function renderCorpusStats() {
  const counts = resources.reduce(
    (acc, resource) => {
      acc[resource.kind] = (acc[resource.kind] ?? 0) + 1;
      acc.all += 1;
      acc.words += wordCount(contentFor(resource));
      acc.sections += headingsFor(resource).length;
      return acc;
    },
    { all: 0, guide: 0, salon: 0, transcript: 0, words: 0, sections: 0 }
  );

  const stats = [
    ["all", "resources", counts.all],
    ["guide", "guides", counts.guide],
    ["salon", "salon docs", counts.salon],
    ["transcript", "transcripts", counts.transcript]
  ];

  els.corpusStats.innerHTML = [
    ...stats.map(([filter, label, value]) => {
      const active = state.filter === filter ? " is-active" : "";
      return `
        <button class="stat-card${active}" data-filter="${filter}" type="button">
          <strong>${value}</strong>
          <span>${label}</span>
        </button>
      `;
    }),
    `<p class="stat-note">${counts.words.toLocaleString()} words across ${counts.sections} sections. Scope: ${escapeHtml(scopeLabel())}. Captured ${escapeHtml(formatDate(exchangeSnapshot.capturedAt))}.</p>`
  ].join("");
}

function renderResourceList() {
  const filtered = filteredResources();

  if (!filtered.some((resource) => pathFor(resource) === state.selectedPath)) {
    state.selectedPath = pathFor(filtered[0]) || null;
  }

  if (!filtered.length) {
    els.resourceList.innerHTML = `
      <p class="empty-state">
        No readable resources match the current search and filter.
      </p>
    `;
    return;
  }

  els.resourceList.innerHTML = filtered
    .map((resource) => {
      const path = pathFor(resource);
      const active = path === state.selectedPath ? " is-active" : "";
      const snippet = snippetFor(resource);
      return `
        <button class="resource-item${active}" data-path="${escapeHtml(path)}" type="button">
          <span class="resource-item__kind">${escapeHtml(resource.kind)}</span>
          <strong>${escapeHtml(titleFor(resource))}</strong>
          <small>${escapeHtml(path)}</small>
          <span class="resource-item__meta">${wordCount(contentFor(resource)).toLocaleString()} words / ${headingsFor(resource).length} sections</span>
          ${snippet ? `<span class="resource-snippet">${snippet}</span>` : ""}
        </button>
      `;
    })
    .join("");
}

function renderSelectedResource() {
  const resource = selectedResource();
  if (!resource) {
    renderedPath = null;
    els.resourceKind.textContent = "No matches";
    els.resourceTitle.textContent = "No resource found";
    els.resourcePath.textContent = "None";
    els.resourceRef.textContent = "None";
    els.wordCount.textContent = "0";
    els.copyPath.disabled = true;
    els.content.innerHTML = "<p>No matching readable resource is available. Adjust the search or filter to continue reading.</p>";
    return;
  }

  const path = pathFor(resource);
  const pathChanged = renderedPath !== path;
  els.copyPath.disabled = false;
  els.resourceKind.textContent = resource.kind;
  els.resourceTitle.textContent = titleFor(resource);
  els.resourcePath.textContent = path;
  els.resourceRef.textContent = shortRef(resource.ref);
  els.wordCount.textContent = wordCount(contentFor(resource)).toLocaleString();
  els.content.innerHTML = renderMarkdown(resource);

  if (pathChanged) {
    els.content.scrollTop = 0;
    renderedPath = path;
  }
}

function renderOutline() {
  const resource = selectedResource();
  const headings = headingsFor(resource);

  if (!headings.length) {
    els.outlineList.innerHTML = emptyPanel("No headings available.");
    return;
  }

  els.outlineList.innerHTML = headings
    .map((heading) => `
      <button class="outline-item depth-${heading.level}" data-heading="${escapeHtml(heading.id)}" type="button">
        <span>H${heading.level}</span>
        <strong>${escapeHtml(heading.text)}</strong>
      </button>
    `)
    .join("");
}

function renderLinkedResources() {
  const resource = selectedResource();
  const outgoing = referencedResources(resource).map((item) => ({ label: "links to", resource: item }));
  const incoming = backlinkResources(resource).map((item) => ({ label: "mentioned by", resource: item }));
  const rows = [...outgoing, ...incoming];

  els.linkedResources.innerHTML = rows.length
    ? rows.map((row) => resourceLinkButton(row.resource, row.label)).join("")
    : emptyPanel("No direct resource references in the loaded resources.");
}

function renderRelatedResources() {
  const related = relatedResourcesFor(selectedResource());
  els.relatedResources.innerHTML = related.length
    ? related.map((resource) => resourceLinkButton(resource, "shared context")).join("")
    : emptyPanel("No related resources scored above the current threshold.");
}

function renderModes() {
  els.modeList.innerHTML = exchangeSnapshot.allowedModes.length
    ? exchangeSnapshot.allowedModes
        .map((mode) => `<span class="mode">${escapeHtml(mode)}</span>`)
        .join("")
    : emptyPanel("No permitted move modes returned by the exchange.");
}

function hasValue(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function displayLabel(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatJson(value) {
  if (value === undefined) {
    return "undefined";
  }

  const seen = new WeakSet();

  try {
    const formatted = JSON.stringify(
      value,
      (_key, item) => {
        if (item && typeof item === "object") {
          if (seen.has(item)) {
            return "[Circular]";
          }
          seen.add(item);
        }
        return item;
      },
      2
    );

    return formatted ?? String(value);
  } catch {
    return String(value);
  }
}

function renderInspectInline(value) {
  if (!hasValue(value)) {
    return `<span class="muted-value">None</span>`;
  }

  if (isRecord(value) || Array.isArray(value)) {
    return `<pre class="inspect-json">${escapeHtml(formatJson(value))}</pre>`;
  }

  return escapeHtml(String(value));
}

function renderInspectValue(value) {
  if (!hasValue(value)) {
    return `<p class="inspect-text muted-value">None returned.</p>`;
  }

  if (Array.isArray(value)) {
    return `
      <ul class="inspect-list">
        ${value.map((item) => `<li>${renderInspectInline(item)}</li>`).join("")}
      </ul>
    `;
  }

  if (isRecord(value)) {
    return `
      <dl class="inspect-kv">
        ${Object.entries(value)
          .map(
            ([key, item]) => `
              <div>
                <dt>${escapeHtml(displayLabel(key))}</dt>
                <dd>${renderInspectInline(item)}</dd>
              </div>
            `
          )
          .join("")}
      </dl>
    `;
  }

  return `<p class="inspect-text">${escapeHtml(String(value))}</p>`;
}

function compactInspectDetails(inspect) {
  if (!isRecord(inspect)) {
    return inspect;
  }

  const directDetails = inspect.details ?? inspect.detail ?? inspect.description ?? inspect.summary;
  if (hasValue(directDetails)) {
    return directDetails;
  }

  const remaining = Object.fromEntries(
    Object.entries(inspect).filter(
      ([key]) => !["claims", "details", "detail", "description", "summary"].includes(key)
    )
  );

  return hasValue(remaining) ? remaining : undefined;
}

function renderInspectSection(label, value) {
  if (!hasValue(value)) {
    return "";
  }

  return `
    <section class="inspect-section">
      <h3>${escapeHtml(label)}</h3>
      ${renderInspectValue(value)}
    </section>
  `;
}

function renderInspectDetails() {
  const resource = selectedResource();
  if (!resource) {
    els.inspectDetails.innerHTML = emptyPanel("No resource selected.");
    return;
  }

  const claims = resource.claims ?? resource.inspect?.claims;
  const details = compactInspectDetails(resource.inspect);
  const sections = [
    resource.inspectError
      ? `
        <section class="inspect-section inspect-error">
          <h3>Inspect Error</h3>
          ${renderInspectValue(resource.inspectError)}
        </section>
      `
      : "",
    renderInspectSection("Claims", claims),
    renderInspectSection("Details", details)
  ].filter(Boolean);

  els.inspectDetails.innerHTML = sections.length
    ? sections.join("")
    : emptyPanel("No inspect details returned for this resource.");
}

function renderRawBlock(label, value) {
  if (value === undefined) {
    return `
      <section class="raw-block">
        <h3>${escapeHtml(label)}</h3>
        <p class="panel-empty">Not returned by the current API response.</p>
      </section>
    `;
  }

  return `
    <section class="raw-block">
      <h3>${escapeHtml(label)}</h3>
      <pre><code>${escapeHtml(formatJson(value))}</code></pre>
    </section>
  `;
}

function renderRawJson() {
  const resource = selectedResource();
  if (!resource) {
    els.rawJson.innerHTML = emptyPanel("No resource selected.");
    return;
  }

  els.rawJson.innerHTML = [
    renderRawBlock("rawRead", resource.rawRead),
    renderRawBlock("rawInspect", resource.rawInspect)
  ].join("");
}

function firstActivityField(item, keys) {
  for (const key of keys) {
    if (hasValue(item?.[key])) {
      return item[key];
    }
  }

  if (isRecord(item?.raw)) {
    for (const key of keys) {
      if (hasValue(item.raw[key])) {
        return item.raw[key];
      }
    }
  }

  return undefined;
}

function compactActivityValue(value) {
  if (isRecord(value) || Array.isArray(value)) {
    return `<code>${escapeHtml(formatJson(value))}</code>`;
  }

  return escapeHtml(String(value));
}

function activityMetaLine(label, value) {
  if (!hasValue(value)) {
    return "";
  }

  return `
    <span>
      <b>${escapeHtml(label)}</b>
      <em>${compactActivityValue(value)}</em>
    </span>
  `;
}

function renderActivity() {
  els.recentActivity.innerHTML = exchangeSnapshot.recentActivity.length
    ? exchangeSnapshot.recentActivity
        .map((item) => {
          const mode = firstActivityField(item, ["mode", "moveMode", "move_mode"]) ?? "activity";
          const action = firstActivityField(item, ["operation", "action", "name", "tool"]);
          const principal = firstActivityField(item, ["principal"]);
          const resource = String(firstActivityField(item, ["resource", "path"]) ?? "");
          const producedRef = firstActivityField(item, [
            "producedRef",
            "produced_ref",
            "activityRef",
            "activity_ref"
          ]);
          const note = firstActivityField(item, ["note"]);
          const title = firstActivityField(item, ["title"]);
          const details = firstActivityField(item, ["details", "detail"]);
          const clickable = resourceByPath.has(resource);
          const tag = clickable ? "button" : "div";
          const attrs = clickable ? `data-path="${escapeHtml(resource)}" type="button"` : "";
          const modeLabel = hasValue(action) && String(action) !== String(mode) ? `${mode} / ${action}` : mode;
          const headline = resource || title || note || producedRef || "Activity";
          const meta = [
            activityMetaLine("Principal", principal),
            hasValue(action) && String(action) !== String(mode) ? activityMetaLine("Action", action) : "",
            activityMetaLine("Produced Ref", producedRef),
            activityMetaLine("Title", title),
            activityMetaLine("Note", note),
            activityMetaLine("Details", details)
          ]
            .filter(Boolean)
            .join("");

          return `
            <${tag} class="activity-item" ${attrs}>
              <span>${escapeHtml(modeLabel)}</span>
              <strong>${escapeHtml(String(headline))}</strong>
              <small>${escapeHtml(formatDate(firstActivityField(item, ["time", "createdAt", "created_at"])))}</small>
              ${meta ? `<span class="activity-meta">${meta}</span>` : ""}
            </${tag}>
          `;
        })
        .join("")
    : emptyPanel("No recent activity returned by the exchange.");
}

function renderFilters() {
  els.filters.forEach((filter) => {
    const active = filter.dataset.filter === state.filter;
    filter.classList.toggle("is-active", active);
    filter.setAttribute("aria-pressed", String(active));
  });
}

function renderConnectionStatus() {
  const labels = {
    loading: "Loading",
    connected: "Connected",
    error: "Error"
  };

  els.connectionStatus.textContent = labels[state.loadStatus] ?? "Unknown";
  els.connectionStatus.dataset.status = state.loadStatus;
  els.refreshButton.disabled = state.loadStatus === "loading";

  if (state.loadStatus === "loading") {
    els.capturedAt.textContent = `Loading ${scopeLabel()}`;
    return;
  }

  if (state.loadStatus === "error") {
    els.capturedAt.textContent = `Last capture ${formatDate(exchangeSnapshot.capturedAt)}`;
    return;
  }

  els.capturedAt.textContent = `Captured ${formatDate(exchangeSnapshot.capturedAt)}`;
}

function render() {
  els.principal.textContent = `${exchangeSnapshot.surface} / ${exchangeSnapshot.principal}`;
  renderConnectionStatus();
  renderFilters();
  renderCorpusStats();
  renderResourceList();
  renderSelectedResource();
  renderOutline();
  renderLinkedResources();
  renderRelatedResources();
  renderModes();
  renderInspectDetails();
  renderRawJson();
  renderActivity();
}

function setSnapshot(snapshot, options = {}) {
  const preferredPath = options.preferredPath;
  exchangeSnapshot = {
    surface: "exchange",
    principal: "unknown principal",
    capturedAt: new Date().toISOString(),
    resourcePrefix: state.resourcePrefix,
    status: "connected",
    rawStatus: null,
    rawList: null,
    allowedModes: [],
    resources: [],
    recentActivity: [],
    rawRecentActivity: null,
    ...snapshot
  };
  resources = Array.isArray(exchangeSnapshot.resources) ? exchangeSnapshot.resources : [];
  exchangeSnapshot.allowedModes = Array.isArray(exchangeSnapshot.allowedModes)
    ? exchangeSnapshot.allowedModes
    : [];
  exchangeSnapshot.recentActivity = Array.isArray(exchangeSnapshot.recentActivity)
    ? exchangeSnapshot.recentActivity
    : [];
  resourceByPath = new Map(
    resources
      .map((resource) => [pathFor(resource), resource])
      .filter(([path]) => Boolean(path))
  );

  if (typeof exchangeSnapshot.resourcePrefix === "string") {
    state.resourcePrefix = exchangeSnapshot.resourcePrefix;
    els.resourceScope.value = state.resourcePrefix;
  }

  state.selectedPath =
    preferredPath && resourceByPath.has(preferredPath)
      ? preferredPath
      : pathFor(resources[0]) || null;
}

function setFilter(filter) {
  state.filter = filter;
  render();
}

function selectResource(path, options = {}) {
  if (!resourceByPath.has(path)) {
    return;
  }

  state.selectedPath = path;
  if (!options.preserveControls) {
    state.filter = "all";
    state.query = "";
    els.searchInput.value = "";
  }
  render();
}

function handlePathNavigation(event) {
  const button = event.target.closest("[data-path]");
  if (!button) {
    return;
  }
  selectResource(button.dataset.path);
}

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

els.filters.forEach((button) => {
  button.addEventListener("click", () => {
    setFilter(button.dataset.filter);
  });
});

els.corpusStats.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) {
    return;
  }
  setFilter(button.dataset.filter);
});

els.resourceList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-path]");
  if (!button) {
    return;
  }
  selectResource(button.dataset.path, { preserveControls: true });
});

els.outlineList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-heading]");
  if (!button) {
    return;
  }

  const target = document.getElementById(button.dataset.heading);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
});

els.content.addEventListener("click", handlePathNavigation);
els.linkedResources.addEventListener("click", handlePathNavigation);
els.relatedResources.addEventListener("click", handlePathNavigation);
els.recentActivity.addEventListener("click", handlePathNavigation);

els.copyPath.addEventListener("click", async () => {
  const resource = selectedResource();
  if (!resource) {
    return;
  }

  try {
    await navigator.clipboard.writeText(pathFor(resource));
    els.copyPath.textContent = "Copied";
  } catch {
    els.copyPath.textContent = "Copy failed";
  }

  setTimeout(() => {
    els.copyPath.textContent = "Copy path";
  }, 1200);
});

function renderLoading() {
  state.loadStatus = "loading";
  state.loadError = null;
  renderConnectionStatus();
  els.principal.textContent = `Loading live MCP data from ${MCP_ENDPOINT}`;
  els.corpusStats.innerHTML = `<p class="stat-note">Connecting to the exchange endpoint.</p>`;
  els.resourceList.innerHTML = `<p class="empty-state">Loading readable resources...</p>`;
  els.resourceKind.textContent = "Live MCP";
  els.resourceTitle.textContent = "Loading exchange";
  els.resourcePath.textContent = "Pending";
  els.resourceRef.textContent = "Pending";
  els.wordCount.textContent = "0";
  els.copyPath.disabled = true;
  els.content.innerHTML = `<p>Fetching resources directly from the Substrate Exchange MCP server.</p>`;
  els.outlineList.innerHTML = emptyPanel("Waiting for resource content.");
  els.linkedResources.innerHTML = emptyPanel("Waiting for resource content.");
  els.relatedResources.innerHTML = emptyPanel("Waiting for resource content.");
  els.modeList.innerHTML = emptyPanel("Waiting for exchange status.");
  els.inspectDetails.innerHTML = emptyPanel("Waiting for inspect details.");
  els.rawJson.innerHTML = emptyPanel("Waiting for raw MCP payloads.");
  els.recentActivity.innerHTML = emptyPanel("Waiting for recent activity.");
}

function renderLoadError(error) {
  state.loadStatus = "error";
  state.loadError = error;
  renderConnectionStatus();
  renderedPath = null;
  els.principal.textContent = "Connection failed";
  els.corpusStats.innerHTML = `<p class="stat-note">The live MCP endpoint could not be loaded.</p>`;
  els.resourceList.innerHTML = `<p class="empty-state">No resources loaded from the exchange.</p>`;
  els.resourceKind.textContent = "Live MCP";
  els.resourceTitle.textContent = "Could not load exchange";
  els.resourcePath.textContent = MCP_ENDPOINT;
  els.resourceRef.textContent = "Unavailable";
  els.wordCount.textContent = "0";
  els.copyPath.disabled = true;
  els.content.innerHTML = `
    <p>The app now reads from the MCP server directly, but this request failed.</p>
    <p><code>${escapeHtml(error.message)}</code></p>
  `;
  els.outlineList.innerHTML = emptyPanel("No resource loaded.");
  els.linkedResources.innerHTML = emptyPanel("No resource loaded.");
  els.relatedResources.innerHTML = emptyPanel("No resource loaded.");
  els.modeList.innerHTML = emptyPanel("No move modes loaded.");
  els.inspectDetails.innerHTML = emptyPanel("No inspect details loaded.");
  els.rawJson.innerHTML = emptyPanel("No raw MCP payloads loaded.");
  els.recentActivity.innerHTML = emptyPanel("No activity loaded.");
}

async function reloadExchange(options = {}) {
  const preferredPath = options.preserveSelection ? state.selectedPath : null;
  renderLoading();

  try {
    const snapshot = await loadExchangeSnapshot({ resourcePrefix: state.resourcePrefix });
    state.loadStatus = "connected";
    state.loadError = null;
    setSnapshot(snapshot, { preferredPath });
    render();
  } catch (error) {
    console.error(error);
    renderLoadError(error);
  }
}

async function init() {
  els.resourceScope.value = state.resourcePrefix;
  await reloadExchange();
}

els.scopeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.resourcePrefix = els.resourceScope.value.trim();
  reloadExchange({ preserveSelection: true });
});

init();
