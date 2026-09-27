/* eslint-disable no-console */
"use strict"

let state = null
let graphPositions = {}
let selectedNode = null
let graphTimer = null

const $ = (selector) => document.querySelector(selector)

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || response.statusText)
  return data
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value
    else if (key === "text") node.textContent = value
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child)
  return node
}

function sortedRepos() {
  return Object.entries(state.registry.repos).sort((a, b) => a[1].name.localeCompare(b[1].name))
}

function repoDisplay(key) {
  const repo = state.registry.repos[key]
  return repo ? repo.name : key
}

// --- banner ----------------------------------------------------------------

function renderBanner() {
  const banner = $("#banner")
  banner.replaceChildren()
  const { self, host } = state
  if (!self.key) {
    banner.append(el("div", { class: "info", text: "当前目录未识别到 git remote（非 git 仓库或没有 origin），references 注入不生效，但 WebUI 可正常使用。" }))
  } else if (self.registered) {
    banner.append(el("div", { class: "ok", text: `当前仓库：${repoDisplay(self.key)}（${self.key}）` }))
  } else {
    banner.append(
      el(
        "div",
        { class: "warn" },
        el("span", { text: `当前仓库 ${self.key} 还未注册。` }),
        el("button", { text: "注册当前仓库", onclick: () => api("/api/repos", { method: "POST", body: { key: self.key } }).then(refresh).catch(alert) }),
      ),
    )
  }
  if (self.missing.length > 0) {
    banner.append(
      el("div", { class: "warn", text: `以下关联仓库在本机没有可用 checkout，references 已跳过：${self.missing.join("、")}。可在“仓库”页为其添加本机路径。` }),
    )
  }
  void host
}

// --- repos -----------------------------------------------------------------

function renderRepos() {
  const list = $("#repo-list")
  list.replaceChildren()
  const entries = sortedRepos()
  if (entries.length === 0) {
    list.append(el("div", { class: "empty", text: "还没有仓库。用上面的表单添加，或直接注册当前仓库。" }))
    return
  }
  for (const [key, repo] of entries) list.append(repoCard(key, repo))
}

function repoCard(key, repo) {
  const checkouts = el(
    "div",
    { class: "checkouts" },
    ...Object.entries(repo.checkouts).flatMap(([host, paths]) =>
      paths.map((path) =>
        el(
          "div",
          { class: "checkout" },
          el("span", { class: host === state.host ? "present" : "absent", text: host === state.host ? "● 本机" : "○" }),
          el("span", { text: `${host}: ${path}` }),
          host === state.host
            ? el("button", {
                class: "danger",
                text: "移除",
                onclick: () => api(`/api/checkouts?key=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`, { method: "DELETE" }).then(refresh).catch(alert),
              })
            : null,
        ),
      ),
    ),
  )
  const addForm = el(
    "form",
    { onsubmit: (event) => {
        event.preventDefault()
        const path = event.target.elements.path.value
        api("/api/checkouts", { method: "POST", body: { key, path } }).then(refresh).catch(alert)
      } },
    el("input", { name: "path", placeholder: "添加本机 checkout 路径，如 ~/work/billing" }),
    el("button", { class: "ghost", type: "submit", text: "添加路径" }),
  )
  return el(
    "div",
    { class: "card entry" },
    el(
      "div",
      { class: "head" },
      el("span", { class: "name", text: repo.name }),
      el("span", { class: "key", text: key }),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "ghost", text: "查询关联", onclick: () => { $("#query-form").elements.key.value = key; switchTab("query"); runQuery(key) } }),
        el("button", { class: "ghost", text: "改名", onclick: async () => {
          const name = prompt("显示名", repo.name)
          if (name && name !== repo.name) api(`/api/repos?key=${encodeURIComponent(key)}`, { method: "PATCH", body: { name } }).then(refresh).catch(alert)
        } }),
        el("button", { class: "ghost", text: "描述", onclick: async () => {
          const description = prompt("描述（给 agent 看的用途说明）", repo.description || "")
          if (description !== null) api(`/api/repos?key=${encodeURIComponent(key)}`, { method: "PATCH", body: { description } }).then(refresh).catch(alert)
        } }),
        el("button", { class: "danger", text: "删除", onclick: () => {
          if (confirm(`删除 ${repo.name}（${key}）？其分组与成对关联会一并清理。`)) {
            api(`/api/repos?key=${encodeURIComponent(key)}`, { method: "DELETE" }).then(refresh).catch(alert)
          }
        } }),
      ),
    ),
    repo.description ? el("div", { class: "desc", text: repo.description }) : null,
    checkouts,
    addForm,
  )
}

// --- groups ----------------------------------------------------------------

function renderGroups() {
  const list = $("#group-list")
  list.replaceChildren()
  if (state.registry.groups.length === 0) {
    list.append(el("div", { class: "empty", text: "还没有分组。创建后把相关仓库加进来，组内自动两两互连。" }))
    return
  }
  for (const group of state.registry.groups) list.append(groupCard(group))
}

function groupCard(group) {
  const chips = el(
    "div",
    { class: "chips" },
    group.members.length === 0 ? el("span", { class: "hint", text: "还没有成员" }) : null,
    ...group.members.map((member) =>
      el(
        "span",
        { class: "chip" },
        el("span", { text: repoDisplay(member) }),
        el("button", {
          class: "x",
          text: "×",
          onclick: () =>
            api(`/api/groups?id=${encodeURIComponent(group.id)}`, { method: "PATCH", body: { members: group.members.filter((m) => m !== member) } })
              .then(refresh)
              .catch(alert),
        }),
      ),
    ),
  )
  const addMember = el(
    "form",
    { onsubmit: (event) => {
        event.preventDefault()
        const member = event.target.elements.member.value
        if (!member) return
        api(`/api/groups?id=${encodeURIComponent(group.id)}`, { method: "PATCH", body: { members: [...group.members, member] } }).then(refresh).catch(alert)
      } },
    el("select", { name: "member" }, ...repoOptions(group.members)),
    el("button", { class: "ghost", type: "submit", text: "加入" }),
  )
  return el(
    "div",
    { class: "card entry" },
    el(
      "div",
      { class: "head" },
      el("span", { class: "name", text: group.name }),
      el("span", { class: "key", text: group.id }),
      el("div", { class: "actions" }, el("button", {
        class: "danger",
        text: "删除分组",
        onclick: () => confirm(`删除分组 ${group.name}？`) && api(`/api/groups?id=${encodeURIComponent(group.id)}`, { method: "DELETE" }).then(refresh).catch(alert),
      })),
    ),
    chips,
    addMember,
  )
}

function repoOptions(exclude = []) {
  return sortedRepos()
    .filter(([key]) => !exclude.includes(key))
    .map(([key, repo]) => el("option", { value: key, text: `${repo.name}（${key}）` }))
}

function fillRepoSelects() {
  const validKeys = new Set(sortedRepos().map(([key]) => key))
  for (const select of document.querySelectorAll("#edge-add select")) {
    const current = select.value
    select.replaceChildren(el("option", { value: "", text: "选择仓库" }), ...repoOptions())
    select.value = validKeys.has(current) ? current : ""
  }
  const querySelect = $("#query-form select[name=key]")
  const queryCurrent = querySelect.value
  querySelect.replaceChildren(el("option", { value: "", text: "选择仓库" }), ...repoOptions())
  querySelect.value = validKeys.has(queryCurrent) ? queryCurrent : ""
}

// --- edges -----------------------------------------------------------------

function renderEdges() {
  const list = $("#edge-list")
  list.replaceChildren()
  const edges = state.registry.edges
  if (edges.length === 0) {
    list.append(el("div", { class: "empty", text: "还没有成对关联。" }))
    return
  }
  edges.forEach((edge, index) => {
    list.append(
      el(
        "div",
        { class: "card entry" },
        el(
          "div",
          { class: "head" },
          el("span", { class: "name", text: `${repoDisplay(edge.a)} ↔ ${repoDisplay(edge.b)}` }),
          edge.note ? el("span", { class: "desc", text: edge.note }) : null,
          el("span", { class: "key", text: `${edge.a} ↔ ${edge.b}` }),
          el("div", { class: "actions" }, el("button", {
            class: "danger",
            text: "删除",
            onclick: () => api(`/api/edges?index=${index}`, { method: "DELETE" }).then(refresh).catch(alert),
          })),
        ),
      ),
    )
  })
}

// --- query -----------------------------------------------------------------

async function runQuery(key) {
  const result = $("#query-result")
  result.replaceChildren(el("div", { class: "empty", text: "查询中…" }))
  try {
    const data = await api(`/api/related?key=${encodeURIComponent(key)}`)
    result.replaceChildren()
    if (data.neighbors.length === 0) {
      result.append(el("div", { class: "empty", text: `${repoDisplay(key)} 暂无关联仓库。` }))
      return
    }
    result.append(el("div", { class: "hint", text: `${repoDisplay(key)} 的有效关联（${data.neighbors.length}）：` }))
    for (const neighbor of data.neighbors) {
      result.append(
        el(
          "div",
          { class: "card result-item" },
          el("span", { class: "name", text: `${neighbor.name}（${neighbor.key}）` }),
          neighbor.description ? el("span", { class: "desc", text: neighbor.description }) : null,
          el("span", { class: "via", text: `关联来源：${neighbor.via.join("、")}` }),
          neighbor.path
            ? el("span", { class: "path-ok", text: `本机路径：${neighbor.path}` })
            : el("span", { class: "path-missing", text: "本机没有可用 checkout，references 未注入" }),
        ),
      )
    }
  } catch (error) {
    result.replaceChildren(el("div", { class: "empty", text: `查询失败：${error.message}` }))
  }
}

// --- graph -----------------------------------------------------------------

function groupColor(groupIdString) {
  let hash = 0
  for (const char of groupIdString) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360}, 55%, 58%)`
}

async function drawGraph() {
  const data = await api("/api/graph")
  const svg = $("#graph")
  const width = 900
  const height = 520
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`)

  const nodes = data.nodes.map((node, index) => {
    const saved = graphPositions[node.key]
    const angle = (2 * Math.PI * index) / Math.max(data.nodes.length, 1)
    return {
      ...node,
      x: saved?.x ?? width / 2 + 180 * Math.cos(angle),
      y: saved?.y ?? height / 2 + 180 * Math.sin(angle),
      vx: 0,
      vy: 0,
    }
  })
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const links = data.links
    .map((link) => ({ ...link, a: byKey.get(link.source), b: byKey.get(link.target) }))
    .filter((link) => link.a && link.b)

  // spring-embedder, synchronous — node counts here are small
  for (let step = 0; step < 240; step++) {
    const cooling = 1 - step / 240
    for (const node of nodes) {
      node.vx += (width / 2 - node.x) * 0.003
      node.vy += (height / 2 - node.y) * 0.003
      for (const other of nodes) {
        if (other === node) continue
        const dx = node.x - other.x
        const dy = node.y - other.y
        const distance = Math.max(Math.hypot(dx, dy), 1)
        const force = 26000 / (distance * distance)
        node.vx += (dx / distance) * force
        node.vy += (dy / distance) * force
      }
    }
    for (const link of links) {
      const dx = link.b.x - link.a.x
      const dy = link.b.y - link.a.y
      const distance = Math.max(Math.hypot(dx, dy), 1)
      const force = (distance - 170) * 0.02
      link.a.vx += (dx / distance) * force
      link.a.vy += (dy / distance) * force
      link.b.vx -= (dx / distance) * force
      link.b.vy -= (dy / distance) * force
    }
    for (const node of nodes) {
      node.vx = Math.max(-8, Math.min(8, node.vx * cooling))
      node.vy = Math.max(-8, Math.min(8, node.vy * cooling))
      node.x = Math.max(46, Math.min(width - 46, node.x + node.vx))
      node.y = Math.max(34, Math.min(height - 34, node.y + node.vy))
    }
  }
  graphPositions = Object.fromEntries(nodes.map((node) => [node.key, { x: node.x, y: node.y }]))

  const NS = "http://www.w3.org/2000/svg"
  const svgEl = (tag, attrs = {}, text) => {
    const node = document.createElementNS(NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    if (text !== undefined) node.textContent = text
    return node
  }

  const neighborsOfSelected = new Set()
  if (selectedNode) {
    for (const link of links) {
      if (link.source === selectedNode) neighborsOfSelected.add(link.target)
      if (link.target === selectedNode) neighborsOfSelected.add(link.source)
    }
  }

  svg.replaceChildren()
  for (const link of links) {
    const active = !selectedNode || link.source === selectedNode || link.target === selectedNode
    svg.append(
      svgEl("line", {
        x1: link.a.x,
        y1: link.a.y,
        x2: link.b.x,
        y2: link.b.y,
        stroke: active ? "#3a4356" : "#22273a",
        "stroke-width": active ? 1.6 : 1,
      }),
      active && link.label ? svgEl("text", { x: (link.a.x + link.b.x) / 2, y: (link.a.y + link.b.y) / 2 - 4, fill: "#8a93a3", "font-size": 10, "text-anchor": "middle" }, link.label) : null,
    )
  }
  for (const node of nodes) {
    const color = node.groups.length > 0 ? groupColor(node.groups[0]) : "#6b7385"
    const active = !selectedNode || node.key === selectedNode || neighborsOfSelected.has(node.key)
    const group = svgEl("g", { style: "cursor: pointer" })
    group.append(
      svgEl("circle", {
        cx: node.x,
        cy: node.y,
        r: selectedNode === node.key ? 16 : 12,
        fill: color,
        opacity: active ? 1 : 0.25,
        stroke: selectedNode === node.key ? "#fff" : node.hasLocalCheckout ? "none" : "#e05c5c",
        "stroke-width": selectedNode === node.key ? 2 : node.hasLocalCheckout ? 0 : 2,
      }),
      svgEl("text", { x: node.x, y: node.y - 18, fill: active ? "#d7dce4" : "#555f75", "font-size": 12, "text-anchor": "middle" }, node.name),
    )
    group.addEventListener("click", () => {
      selectedNode = selectedNode === node.key ? null : node.key
      renderGraphInfo(data)
      drawGraph()
    })
    svg.append(group)
  }
  renderGraphInfo(data)
}

function renderGraphInfo(data) {
  const info = $("#graph-info")
  info.replaceChildren()
  info.append(el("div", { class: "hint", text: "点击节点查看详情；空心红圈 = 本机无 checkout。" }))
  if (!selectedNode) {
    info.append(el("div", { text: `共 ${data.nodes.length} 个仓库，${data.links.length} 条关联。` }))
    return
  }
  const node = data.nodes.find((entry) => entry.key === selectedNode)
  if (!node) return
  const links = data.links.filter((link) => link.source === node.key || link.target === node.key)
  info.append(
    el("div", { class: "name", text: node.name }),
    el("div", { class: "mono", text: node.key }),
    node.description ? el("div", { text: node.description }) : null,
    el("div", { class: "via", text: node.groups.length > 0 ? `分组：${node.groups.join("、")}` : "未加入分组" }),
    el("div", { class: "mono", text: node.hasLocalCheckout ? "本机有 checkout" : "本机无 checkout" }),
    el("div", { class: "hint", text: `关联（${links.length}）：` }),
    ...links.map((link) => {
      const other = link.source === node.key ? link.target : link.source
      return el("div", { text: `· ${repoDisplay(other)} — ${link.label}` })
    }),
  )
}

// --- tabs & wiring -----------------------------------------------------------

function switchTab(name) {
  for (const button of document.querySelectorAll("#tabs button")) button.classList.toggle("active", button.dataset.tab === name)
  for (const section of document.querySelectorAll("main .tab")) section.classList.toggle("active", section.id === `tab-${name}`)
  if (name === "graph") {
    drawGraph().catch(alert)
    if ($("#graph-auto").checked && !graphTimer) graphTimer = setInterval(() => drawGraph().catch(console.error), 5000)
  } else if (graphTimer) {
    clearInterval(graphTimer)
    graphTimer = null
  }
}

async function refresh() {
  state = await api("/api/state")
  renderBanner()
  renderRepos()
  renderGroups()
  renderEdges()
  fillRepoSelects()
  if (selectedNode && !state.registry.repos[selectedNode]) selectedNode = null
}

function wire() {
  for (const button of document.querySelectorAll("#tabs button")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab))
  }
  $("#repo-add").addEventListener("submit", (event) => {
    event.preventDefault()
    const form = event.target
    api("/api/repos", { method: "POST", body: { url: form.elements.url.value, name: form.elements.name.value, description: form.elements.description.value } })
      .then(() => {
        form.reset()
        return refresh()
      })
      .catch(alert)
  })
  $("#group-add").addEventListener("submit", (event) => {
    event.preventDefault()
    const name = event.target.elements.name.value
    api("/api/groups", { method: "POST", body: { name } }).then(() => { event.target.reset(); return refresh() }).catch(alert)
  })
  $("#edge-add").addEventListener("submit", (event) => {
    event.preventDefault()
    const form = event.target
    api("/api/edges", { method: "POST", body: { a: form.elements.a.value, b: form.elements.b.value, note: form.elements.note.value } })
      .then(() => {
        form.reset()
        return refresh()
      })
      .catch(alert)
  })
  $("#query-form").addEventListener("submit", (event) => {
    event.preventDefault()
    const key = event.target.elements.key.value
    if (key) runQuery(key)
  })
  $("#graph-refresh").addEventListener("click", () => drawGraph().catch(alert))
  $("#graph-auto").addEventListener("change", (event) => {
    if (event.target.checked && $("#tab-graph").classList.contains("active")) {
      graphTimer = setInterval(() => drawGraph().catch(console.error), 5000)
    } else if (graphTimer) {
      clearInterval(graphTimer)
      graphTimer = null
    }
  })
}

wire()
refresh()
  .then(() => {
    const first = sortedRepos()[0]
    if (first) $("#query-form").elements.key.value = first[0]
  })
  .catch((error) => {
    $("#banner").append(el("div", { class: "warn", text: `加载失败：${error.message}` }))
  })
