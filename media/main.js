// Prime VS chat webview: multiple sessions with tabs, markdown, images, drag&drop.
(function () {
  const vscode = acquireVsCodeApi();

  const tabsEl = document.getElementById("tabs");
  const chatEl = document.getElementById("chat");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const stopBtn = document.getElementById("stopBtn");
  const steerBtn = document.getElementById("steerBtn");
  const followBtn = document.getElementById("followBtn");
  const attachBtn = document.getElementById("attachBtn");

  let pendingImages = [];
  let commands = []; // [{name, description}]
  let filteredCommands = [];
  let selectedCommand = -1;

  // persisted: sessions[id] = { name, streaming, blocks:[{kind,title,bodyHtml}] }
  const persisted = vscode.getState() || {};
  const data = {
    sessions: persisted.sessions || {},
    activeId: persisted.activeId || null,
  };

  function saveState() {
    vscode.setState({ sessions: data.sessions, activeId: data.activeId });
  }

  function session(id) {
    if (!data.sessions[id]) data.sessions[id] = { name: "Session", streaming: false, blocks: [] };
    return data.sessions[id];
  }

  function activeSession() {
    return data.activeId ? session(data.activeId) : null;
  }

  // ------------------------------------------------------------------ utils
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollToBottom() { chatEl.scrollTop = chatEl.scrollHeight; }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  function renderMarkdown(src) {
    const lines = String(src || "").split("\n");
    const out = [];
    let code = null;
    let list = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
    const flushList = () => { if (list) { out.push("</" + list + ">"); list = null; } };

    for (const raw of lines) {
      const line = raw;
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        flushPara(); flushList();
        if (code) { out.push("</code></pre>"); code = null; }
        else { out.push('<pre class="code"><code>'); code = fence[1] || ""; }
        continue;
      }
      if (code !== null) { out.push(escapeHtml(line) + "\n"); continue; }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
      if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) { flushPara(); if (list !== "ul") { flushList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) { flushPara(); if (list !== "ol") { flushList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
      if (/^\s*&gt;/.test(line) || /^\s*>/.test(line)) { flushPara(); flushList(); out.push(`<blockquote>${inline(line.replace(/^\s*&?gt;\s?/, ""))}</blockquote>`); continue; }
      para.push(line);
    }
    if (code !== null) out.push("</code></pre>");
    flushPara(); flushList();
    return out.join("\n");
  }

  function blockHtml(block) {
    return block.bodyHtml || "";
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    const ids = Object.keys(data.sessions);
    ids.forEach((id) => {
      const s = data.sessions[id];
      const tab = el("div", "tab" + (id === data.activeId ? " active" : ""));
      const label = el("span", "tab-label", s.name);
      label.title = s.name + " (double-click to rename)";
      tab.appendChild(label);
      if (s.model) {
        const m = el("span", "tab-model", s.model.split("/").pop() || s.model);
        m.title = "Model: " + s.model;
        tab.appendChild(m);
      }
      if (s.streaming) {
        const dot = el("span", "tab-busy", "●");
        dot.title = "running";
        tab.appendChild(dot);
      }
      const close = el("span", "tab-close", "×");
      close.title = "Close session";
      close.addEventListener("click", (e) => { e.stopPropagation(); post({ type: "closeSession", id }); });
      tab.appendChild(close);
      tab.addEventListener("click", () => { if (id !== data.activeId) post({ type: "switchSession", id }); });
      tab.addEventListener("dblclick", () => post({ type: "renameRequest", id }));
      tabsEl.appendChild(tab);
    });
    const plus = el("div", "tab add", "+");
    plus.title = "New session";
    plus.addEventListener("click", () => post({ type: "newSession" }));
    tabsEl.appendChild(plus);
  }

  function renderChat() {
    chatEl.innerHTML = "";
    const s = activeSession();
    if (!s) return;
    s.blocks.forEach((b) => {
      const wrap = el("div", "block " + b.kind);
      wrap.appendChild(el("div", "block-head", b.title));
      const body = el("div", "block-body");
      body.innerHTML = b.bodyHtml || "";
      wrap.appendChild(body);
      chatEl.appendChild(wrap);
    });
    scrollToBottom();
  }

  function render() {
    renderTabs();
    renderChat();
    updateButtons();
    saveState();
  }

  function updateButtons() {
    const s = activeSession();
    const streaming = !!(s && s.streaming);
    document.body.classList.toggle("streaming", streaming);
    steerBtn.disabled = !streaming;
    followBtn.disabled = !streaming;
    stopBtn.disabled = !streaming;
  }

  function appendBlock(id, block) {
    const s = session(id);
    s.blocks.push(block);
    if (id === data.activeId) renderChat();
    saveState();
  }

  function lastBlock(id, kind) {
    const s = session(id);
    for (let i = s.blocks.length - 1; i >= 0; i--) {
      if (s.blocks[i].kind === kind) return { block: s.blocks[i], index: i };
    }
    return null;
  }

  function post(message) { vscode.postMessage(message); }

  // ------------------------------------------------------------------ input
  function showCommands() {
    const popup = document.getElementById("cmds");
    if (!filteredCommands.length) { popup.classList.add("hidden"); popup.innerHTML = ""; return; }
    popup.innerHTML = "";
    filteredCommands.slice(0, 12).forEach((c, i) => {
      const row = el("div", "cmd-row" + (i === selectedCommand ? " selected" : ""));
      row.appendChild(el("span", "cmd-name", "/" + c.name));
      if (c.description) row.appendChild(el("span", "cmd-desc", c.description.slice(0, 90)));
      row.addEventListener("mousedown", (e) => { e.preventDefault(); chooseCommand(c.name); });
      row.addEventListener("mouseenter", () => { selectedCommand = i; highlightSelected(); });
      popup.appendChild(row);
    });
    popup.classList.remove("hidden");
  }

  function highlightSelected() {
    const rows = document.querySelectorAll("#cmds .cmd-row");
    rows.forEach((r, i) => r.classList.toggle("selected", i === selectedCommand));
  }

  function hideCommands() {
    const popup = document.getElementById("cmds");
    popup.classList.add("hidden");
    popup.innerHTML = "";
    selectedCommand = -1;
  }

  function chooseCommand(name) {
    inputEl.value = "/" + name + " ";
    hideCommands();
    inputEl.focus();
  }

  function updateCommandFilter() {
    const v = inputEl.value;
    const m = v.match(/^\s*\/([\w:.-]*)\s*$/);
    if (!m) { hideCommands(); return; }
    const q = m[1].toLowerCase();
    filteredCommands = commands
      .filter((c) => c.name && c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    selectedCommand = filteredCommands.length ? 0 : -1;
    showCommands();
  }

  function send(text, images) {
    const trimmed = (text || "").trim();
    if (!trimmed && !(images && images.length)) return;
    inputEl.value = "";
    post({ type: "send", text: trimmed, images: images && images.length ? images : undefined });
    pendingImages = [];
    renderChips();
  }

  function renderChips() {
    const chips = document.getElementById("chips");
    chips.innerHTML = "";
    pendingImages.forEach((img, i) => {
      const c = el("span", "chip", (img.name || "image") + " ✕");
      c.addEventListener("click", () => { pendingImages.splice(i, 1); renderChips(); });
      chips.appendChild(c);
    });
  }

  function addImages(files) {
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        pendingImages.push({ data: String(reader.result).split(",")[1] || "", mimeType: f.type || "image/png", name: f.name });
        renderChips();
      };
      reader.readAsDataURL(f);
    }
  }

  function readTextFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const block = "```" + (file.name || "file") + "\n" + text + "\n```";
      inputEl.value += (inputEl.value ? "\n\n" : "") + (text.length > 250000 ? (file.name || "file") : block);
      inputEl.focus();
    };
    reader.onerror = () => { inputEl.value += (inputEl.value ? "\n" : "") + (file.name || "file"); inputEl.focus(); };
    reader.readAsText(file);
  }

  function handleDroppedFiles(files) {
    const images = [];
    const others = [];
    for (const f of files) {
      if (f.type && f.type.startsWith("image/")) images.push(f);
      else others.push(f);
    }
    if (images.length) addImages(images);
    for (const f of others) readTextFile(f);
  }

  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  document.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
  document.addEventListener("dragleave", (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    // 1) VS Code Explorer drop: text/uri-list -> ask the extension to read files
    const uriList = e.dataTransfer && e.dataTransfer.getData("text/uri-list");
    if (uriList) {
      post({ type: "dropUris", uris: uriList.split("\n").map((s) => s.trim()).filter(Boolean) });
      return;
    }
    // 2) OS drop: real File objects
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleDroppedFiles(Array.from(e.dataTransfer.files));
    }
  });

  // ------------------------------------------------------------------ wire
  sendBtn.addEventListener("click", () => send(inputEl.value, pendingImages));
  stopBtn.addEventListener("click", () => post({ type: "stop" }));
  steerBtn.addEventListener("click", () => { const t = inputEl.value; inputEl.value = ""; post({ type: "steer", text: t }); });
  followBtn.addEventListener("click", () => { const t = inputEl.value; inputEl.value = ""; post({ type: "followUp", text: t }); });
  attachBtn.addEventListener("click", () => post({ type: "attach" }));

  inputEl.addEventListener("keydown", (e) => {
    const popup = document.getElementById("cmds");
    const open = !popup.classList.contains("hidden");
    if (open) {
      if (e.key === "ArrowDown") { e.preventDefault(); selectedCommand = Math.min(filteredCommands.length - 1, selectedCommand + 1); highlightSelected(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); selectedCommand = Math.max(0, selectedCommand - 1); highlightSelected(); return; }
      if (e.key === "Tab") { e.preventDefault(); if (filteredCommands[selectedCommand]) chooseCommand(filteredCommands[selectedCommand].name); return; }
      if (e.key === "Escape") { hideCommands(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (open && filteredCommands[selectedCommand]) { chooseCommand(filteredCommands[selectedCommand].name); return; }
      send(inputEl.value, pendingImages);
    }
  });

  inputEl.addEventListener("input", updateCommandFilter);

  document.addEventListener("paste", (e) => {
    if (e.clipboardData && e.clipboardData.files.length) {
      e.preventDefault();
      addImages(Array.from(e.clipboardData.files));
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "meta":
        break;
      case "sessions": {
        const seen = new Set();
        msg.sessions.forEach((s) => {
          seen.add(s.id);
          const cur = data.sessions[s.id] || { name: s.name, streaming: false, model: "", blocks: [] };
          cur.name = s.name;
          cur.streaming = s.streaming;
          if (s.model !== undefined) cur.model = s.model;
          data.sessions[s.id] = cur;
        });
        Object.keys(data.sessions).forEach((id) => { if (!seen.has(id)) delete data.sessions[id]; });
        if (!data.activeId || !data.sessions[data.activeId]) {
          data.activeId = msg.sessions.length ? msg.sessions[0].id : null;
        }
        render();
        break;
      }
      case "sessionEvent": {
        const s = session(msg.sessionId);
        applyEvent(s, msg.event);
        if (msg.sessionId === data.activeId) renderChat();
        renderTabs();
        updateButtons();
        saveState();
        break;
      }
      case "history": {
        const s = session(msg.sessionId);
        s.blocks = (msg.messages || []).map((m) => ({
          kind: m.role === "user" ? "user" : "assistant",
          title: m.role === "user" ? "You" : "Assistant",
          bodyHtml: renderMarkdown(m.text),
        }));
        if (msg.sessionId === data.activeId) renderChat();
        saveState();
        break;
      }
      case "attachResult":
        inputEl.value += (inputEl.value ? "\n\n" : "") + msg.text;
        inputEl.focus();
        break;
      case "commands":
        commands = msg.commands || [];
        break;
      case "dropResult":
        if (msg.text) {
          inputEl.value += (inputEl.value ? "\n\n" : "") + msg.text;
        }
        if (msg.images && msg.images.length) {
          pendingImages.push(...msg.images);
          renderChips();
        }
        inputEl.focus();
        break;
    }
  });

  function applyEvent(s, event) {
    switch (event.type) {
      case "user":
        s.blocks.push({ kind: "user", title: "You", bodyHtml: renderMarkdown(event.text) });
        break;
      case "assistantText": {
        const last = lastBlockById(s, "assistant");
        if (last) last.bodyHtml = renderMarkdown(event.text);
        else s.blocks.push({ kind: "assistant", title: "Assistant", bodyHtml: renderMarkdown(event.text) });
        break;
      }
      case "assistantEnd":
        break;
      case "toolStart":
        s.blocks.push({ kind: "tool", title: "Tool: " + event.name, bodyHtml: '<pre class="code">' + escapeHtml(event.args || "") + "</pre>", toolId: event.id });
        break;
      case "toolUpdate": {
        const b = s.blocks.find((x) => x.toolId === event.id);
        if (b) b.bodyHtml = '<pre class="code">' + escapeHtml(event.text) + "</pre>";
        break;
      }
      case "toolEnd": {
        const b = s.blocks.find((x) => x.toolId === event.id);
        if (b) b.title = "Tool: " + event.name + (event.isError ? " (failed)" : " (done)");
        break;
      }
      case "streaming":
        s.streaming = event.value;
        break;
      case "error":
        s.blocks.push({ kind: "system", title: "Error", bodyHtml: renderMarkdown(event.message) });
        break;
    }
  }

  function lastBlockById(s, kind) {
    for (let i = s.blocks.length - 1; i >= 0; i--) {
      if (s.blocks[i].kind === kind) return s.blocks[i];
    }
    return null;
  }

  render();
  post({ type: "ready" });
})();
