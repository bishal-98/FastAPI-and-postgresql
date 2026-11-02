/* Student Registry — vanilla JS frontend for the FastAPI student API.
 *
 * Endpoints used:
 *   GET    /student                 → all students (stats + course list)
 *   GET    /paginate?page=&limit=   → default table view
 *   GET    /filter?course=          → when a course is selected
 *   GET    /sort?sort_by=&order=    → when a sort field is selected
 *   GET    /students/{id}           → "Find" box / opening a row
 *   POST   /create                  → new student
 *   PUT    /update/{id}             → edit (sends only changed fields)
 *   DELETE /delete/{id}             → delete
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ───────────── Storage (safe wrappers) ───────────── */
const store = {
  get(k, fallback) { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/* ───────────── State ───────────── */
const state = {
  base: store.get("registry.api", "http://127.0.0.1:8000"),
  all: {},              // { id: {name, age, ...} } from GET /student
  course: "",
  sortBy: "",
  order: "asc",
  page: 1,
  limit: Number(store.get("registry.limit", 10)),
  total: 0,
  connected: false,
  drawer: { mode: null, id: null, student: null },
};

/* ───────────── Helpers ───────────── */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function gradeOf(marks) {
  if (marks >= 90) return "A+";
  if (marks >= 80) return "A";
  if (marks >= 70) return "B";
  if (marks >= 60) return "C";
  return "F";
}
const GRADE_VAR = { "A+": "--g-aplus", A: "--g-a", B: "--g-b", C: "--g-c", F: "--g-f" };
const gradeChip = (g) => `<span class="grade" style="--gc: var(${GRADE_VAR[g]})">${g}</span>`;

const COURSE_HUES = ["#2d5a4c", "#3a7bbf", "#b8862b", "#8a5fb0", "#c0563f", "#4f8a8b", "#7a8b3a", "#b0587f"];
function courseColor(name) {
  // Each course gets its own color based on its alphabetical position
  const courses = [...new Set(Object.values(state.all).map((s) => s.course.toLowerCase()))].sort();
  let i = courses.indexOf(String(name).toLowerCase());
  if (i < 0) for (const ch of String(name)) i = (Math.abs(i) * 31 + ch.charCodeAt(0)) >>> 0;
  return COURSE_HUES[i % COURSE_HUES.length];
}

const toList = (dict) => Object.entries(dict).map(([id, s]) => ({ ...s, id }));
const apiUrl = (path) => state.base.replace(/\/+$/, "") + path;

/* ───────────── API layer ───────────── */
class ApiError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : "Validation failed");
    this.status = status;
    this.detail = detail;
  }
}

async function api(method, path, body) {
  const started = performance.now();
  showRequest(method, path, "…");
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    showRequest(method, path, "network error", true);
    setConnected(false);
    throw new ApiError(0, "Can't reach the API. Is uvicorn running, and is CORS enabled?");
  }
  const ms = Math.round(performance.now() - started);
  showRequest(method, path, `${res.status} · ${ms} ms`, !res.ok);
  setConnected(true);

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data?.detail ?? res.statusText);
  return data;
}

function showRequest(method, path, code, isErr = false) {
  $("#reqline").innerHTML = `
    <span class="method ${method.toLowerCase()}">${method}</span>
    <span>${esc(path)}</span>
    <span class="code ${isErr ? "err" : ""}">${esc(code)}</span>`;
}

function setConnected(ok) {
  state.connected = ok;
  $("#connDot").className = "dot " + (ok ? "ok" : "bad");
  $("#connStatus").textContent = ok ? "Connected" : "Offline";
}

/* Turn FastAPI 422 detail into { field: message } */
function fieldErrors(detail) {
  const out = {};
  if (!Array.isArray(detail)) return out;
  for (const e of detail) {
    const field = Array.isArray(e.loc) ? e.loc[e.loc.length - 1] : "form";
    out[field] = String(e.msg || "Invalid value").replace(/^Value error,\s*/i, "");
  }
  return out;
}

/* ───────────── Toasts ───────────── */
function toast(msg, { error = false, code = "" } = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (error ? " err" : "");
  el.innerHTML = `<div>${esc(msg)}${code ? `<div class="t-code">${esc(code)}</div>` : ""}</div>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .2s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

function toastError(err) {
  const msg = Array.isArray(err.detail)
    ? Object.values(fieldErrors(err.detail)).join(" · ")
    : err.message;
  toast(msg, { error: true, code: err.status ? `HTTP ${err.status}` : "" });
}

/* ───────────── Data loading ───────────── */
async function loadAll() {
  try {
    state.all = (await api("GET", "/student")) || {};
  } catch (err) {
    state.all = {};
    renderStats();
    renderEmpty(err);
    return false;
  }
  renderStats();
  renderCourseOptions();
  return true;
}

async function loadTable() {
  renderSkeleton();
  try {
    let rows, total, serverPaged = false;

    if (state.course) {
      // GET /filter returns a dict, sort locally if a sort field is also chosen
      const dict = await api("GET", `/filter?course=${encodeURIComponent(state.course)}`);
      rows = toList(dict);
      if (state.sortBy) rows = localSort(rows, state.sortBy, state.order);
    } else if (state.sortBy) {
      rows = await api("GET", `/sort?sort_by=${state.sortBy}&order=${state.order}`);
    } else {
      const data = await api("GET", `/paginate?page=${state.page}&limit=${state.limit}`);
      rows = data.students;
      total = data.total_students;
      serverPaged = true;
    }

    if (!serverPaged) {
      total = rows.length;
      const start = (state.page - 1) * state.limit;
      rows = rows.slice(start, start + state.limit);
    }

    state.total = total;
    // Ran past the last page (e.g. after a delete) → step back
    if (rows.length === 0 && state.page > 1) {
      state.page = Math.max(1, Math.ceil(total / state.limit));
      return loadTable();
    }
    renderRows(rows);
    renderPager();
  } catch (err) {
    renderEmpty(err);
  }
}

function localSort(rows, key, order) {
  const dir = order === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
  });
}

async function refresh() {
  if (await loadAll()) await loadTable();
}

/* ───────────── Rendering ───────────── */
function renderStats() {
  const list = toList(state.all);
  const n = list.length;
  $("#statTotal").textContent = n ? n : "—";

  const courses = new Set(list.map((s) => s.course));
  $("#statCourses").textContent = n ? `across ${courses.size} course${courses.size === 1 ? "" : "s"}` : " ";

  if (!n) {
    $("#statAvg").textContent = "—";
    $("#statAge").innerHTML = "&nbsp;";
    $("#statTop").textContent = "—";
    $("#statTopSub").innerHTML = "&nbsp;";
    $("#spread").innerHTML = "";
    $("#spreadLegend").innerHTML = "";
    return;
  }

  const avg = list.reduce((a, s) => a + s.marks, 0) / n;
  const avgAge = list.reduce((a, s) => a + s.age, 0) / n;
  $("#statAvg").textContent = avg.toFixed(1);
  $("#statAge").textContent = `average age ${avgAge.toFixed(1)}`;

  const top = list.reduce((a, b) => (b.marks > a.marks ? b : a));
  $("#statTop").textContent = top.marks;
  $("#statTopSub").textContent = `${top.name} · ${top.course}`;

  const counts = { "A+": 0, A: 0, B: 0, C: 0, F: 0 };
  list.forEach((s) => counts[gradeOf(s.marks)]++);
  $("#spread").innerHTML = Object.entries(counts)
    .filter(([, c]) => c)
    .map(([g, c]) => `<span title="${g}: ${c}" style="width:${(c / n) * 100}%;background:var(${GRADE_VAR[g]})"></span>`)
    .join("");
  $("#spreadLegend").innerHTML = Object.entries(counts)
    .map(([g, c]) => `<span><i style="background:var(${GRADE_VAR[g]})"></i>${g} ${c}</span>`)
    .join("");
}

function renderCourseOptions() {
  const sel = $("#courseFilter");
  const courses = [...new Set(toList(state.all).map((s) => s.course))].sort((a, b) => a.localeCompare(b));
  if (state.course && !courses.some((c) => c.toLowerCase() === state.course.toLowerCase())) state.course = "";
  sel.innerHTML = `<option value="">All courses</option>` +
    courses.map((c) => `<option ${c === state.course ? "selected" : ""}>${esc(c)}</option>`).join("");
}

const ICON_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const ICON_DEL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`;

function renderRows(rows) {
  const tbody = $("#rows");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty">
      <h3>No students here</h3>
      <p>${state.course ? `Nobody is enrolled in ${esc(state.course)} yet.` : "The registry is empty. Add your first student to get started."}</p>
    </div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((s) => {
    const g = gradeOf(s.marks);
    return `<tr data-id="${esc(s.id)}" tabindex="0">
      <td class="id mono">${esc(s.id)}</td>
      <td class="name">${esc(s.name)}</td>
      <td><span class="course-tag" style="--cc:${courseColor(s.course)}">${esc(s.course)}</span></td>
      <td class="num">${esc(s.age)}</td>
      <td class="num"><div class="marks">
        <div class="bar"><span style="width:${Math.max(0, Math.min(100, s.marks))}%;background:var(${GRADE_VAR[g]})"></span></div>
        <b>${esc(s.marks)}</b></div></td>
      <td>${gradeChip(g)}</td>
      <td class="email">${esc(s.email)}</td>
      <td><div class="row-actions">
        <button data-act="edit" aria-label="Edit ${esc(s.name)}" title="Edit">${ICON_EDIT}</button>
        <button data-act="delete" class="del" aria-label="Delete ${esc(s.name)}" title="Delete">${ICON_DEL}</button>
      </div></td>
    </tr>`;
  }).join("");
}

function renderSkeleton() {
  const widths = [40, 120, 90, 24, 80, 30, 150, 0];
  $("#rows").innerHTML = Array.from({ length: Math.min(state.limit, 6) }, () =>
    `<tr class="skeleton">${widths.map((w) => `<td>${w ? `<span style="width:${w}px"></span>` : ""}</td>`).join("")}</tr>`
  ).join("");
}

function renderEmpty(err) {
  const offline = err.status === 0;
  $("#rows").innerHTML = `<tr><td colspan="8"><div class="empty">
    <h3>${offline ? "Can't reach the API" : "Something went wrong"}</h3>
    <p>${offline
      ? `Start the server with <code>uvicorn main:app --reload</code>, check the URL above, and make sure CORS is enabled in <code>main.py</code>.`
      : esc(err.message)}</p>
  </div></td></tr>`;
  $("#pageInfo").textContent = "";
  $("#prevPage").disabled = $("#nextPage").disabled = true;
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(state.total / state.limit));
  const from = state.total ? (state.page - 1) * state.limit + 1 : 0;
  const to = Math.min(state.total, state.page * state.limit);
  $("#pageInfo").textContent = state.total
    ? `${from}–${to} of ${state.total} · page ${state.page} of ${pages}`
    : "0 results";
  $("#prevPage").disabled = state.page <= 1;
  $("#nextPage").disabled = state.page >= pages;
}

/* ───────────── Drawer ───────────── */
function openDrawer() {
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("open");
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("open");
  state.drawer = { mode: null, id: null, student: null };
}

async function showStudent(id) {
  try {
    const s = await api("GET", `/students/${encodeURIComponent(id)}`);
    renderView(id, s);
    openDrawer();
  } catch (err) {
    toastError(err);
  }
}

function renderView(id, s) {
  state.drawer = { mode: "view", id, student: s };
  const g = gradeOf(s.marks);
  $("#drawerEyebrow").innerHTML = `<span class="mono">${esc(id)}</span>`;
  $("#drawerTitle").textContent = s.name;
  $("#drawerBody").innerHTML = `
    <div class="profile-score">
      <div class="ring" style="--p:${s.marks};--gc:var(${GRADE_VAR[g]})"><div>${esc(s.marks)}</div></div>
      <div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:6px">Marks out of 100</div>
        ${gradeChip(g)}
      </div>
    </div>
    <dl class="facts">
      <dt>Course</dt><dd><span class="course-tag" style="--cc:${courseColor(s.course)}">${esc(s.course)}</span></dd>
      <dt>Age</dt><dd>${esc(s.age)}</dd>
      <dt>Email</dt><dd><a href="mailto:${esc(s.email)}" style="color:inherit">${esc(s.email)}</a></dd>
    </dl>`;
  $("#drawerFoot").innerHTML = `
    <button class="btn ghost-danger left" data-act="delete">Delete</button>
    <button class="btn primary" data-act="edit">Edit</button>`;
}

function renderForm(mode, id = "", s = {}) {
  state.drawer = { mode, id, student: s };
  const isEdit = mode === "edit";
  $("#drawerEyebrow").innerHTML = isEdit ? `Editing <span class="mono">${esc(id)}</span>` : "New record";
  $("#drawerTitle").textContent = isEdit ? s.name : "Add a student";

  const v = (k) => esc(s[k] ?? "");
  $("#drawerBody").innerHTML = `
    <form id="studentForm" novalidate>
      ${isEdit ? `<p class="form-note">Only the fields you change are sent to <span class="mono">PUT /update/${esc(id)}</span>.</p>` : ""}
      <div class="field" data-field="id">
        <label for="f-id">Student ID <small>e.g. S011</small></label>
        <input id="f-id" name="id" value="${esc(id)}" ${isEdit ? "disabled" : ""} autocomplete="off" spellcheck="false" class="mono" />
        <div class="err"></div>
      </div>
      <div class="field" data-field="name">
        <label for="f-name">Full name <small>letters &amp; spaces</small></label>
        <input id="f-name" name="name" value="${v("name")}" autocomplete="off" />
        <div class="err"></div>
      </div>
      <div class="field" data-field="email">
        <label for="f-email">Email</label>
        <input id="f-email" name="email" type="email" value="${v("email")}" autocomplete="off" />
        <div class="err"></div>
      </div>
      <div class="field" data-field="course">
        <label for="f-course">Course</label>
        <input id="f-course" name="course" value="${v("course")}" list="courseList" autocomplete="off" />
        <datalist id="courseList">${[...new Set(toList(state.all).map((x) => x.course))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        <div class="err"></div>
      </div>
      <div class="field-row">
        <div class="field" data-field="age">
          <label for="f-age">Age</label>
          <input id="f-age" name="age" type="number" inputmode="numeric" min="1" max="${isEdit ? 99 : 100}" value="${v("age")}" />
          <div class="err"></div>
        </div>
        <div class="field" data-field="marks">
          <label for="f-marks">Marks <small>0–100</small></label>
          <input id="f-marks" name="marks" type="number" inputmode="numeric" min="0" max="100" value="${v("marks")}" />
          <div class="err"></div>
        </div>
      </div>
      <div class="grade-preview" id="gradePreview"></div>
      <button type="submit" hidden></button>
    </form>`;
  $("#drawerFoot").innerHTML = `
    <button class="btn" data-act="${isEdit ? "cancel-edit" : "close"}">Cancel</button>
    <button class="btn primary" data-act="save">${isEdit ? "Save changes" : "Create student"}</button>`;

  const form = $("#studentForm");
  form.addEventListener("submit", (e) => { e.preventDefault(); submitForm(); });
  form.addEventListener("input", (e) => {
    clearFieldError(e.target.name);
    if (e.target.name === "marks") updateGradePreview();
  });
  updateGradePreview();
  setTimeout(() => (isEdit ? $("#f-name") : $("#f-id")).focus(), 260);
}

function updateGradePreview() {
  const raw = $("#f-marks")?.value;
  const m = Number(raw);
  $("#gradePreview").innerHTML = raw !== "" && Number.isFinite(m) && m >= 0 && m <= 100
    ? `Grade will be ${gradeChip(gradeOf(m))}`
    : "";
}

function setFieldError(name, msg) {
  const f = $(`.field[data-field="${name}"]`);
  if (!f) return false;
  f.classList.add("invalid");
  $(".err", f).textContent = msg;
  return true;
}
function clearFieldError(name) {
  const f = $(`.field[data-field="${name}"]`);
  if (!f) return;
  f.classList.remove("invalid");
  $(".err", f).textContent = "";
}

/* Mirrors the Pydantic rules so most mistakes are caught before the request */
function validate(values, isEdit) {
  const e = {};
  if (!isEdit && !values.id.trim()) e.id = "ID is required.";
  const name = values.name.trim();
  if (name.length < 2 || name.length > 50) e.name = "Name must be 2–50 characters.";
  else if (!/^[\p{L} ]+$/u.test(name)) e.name = "Name must contain only letters and spaces.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) e.email = "Enter a valid email address.";
  if (!values.course.trim()) e.course = "Course is required.";
  else if (values.course.length > 50) e.course = "Course must be 50 characters or fewer.";
  const age = Number(values.age), maxAge = isEdit ? 99 : 100;
  if (values.age === "" || !Number.isInteger(age) || age < 1 || age > maxAge) e.age = `Age must be 1–${maxAge}.`;
  const marks = Number(values.marks);
  if (values.marks === "" || !Number.isInteger(marks) || marks < 0 || marks > 100) e.marks = "Marks must be 0–100.";
  return e;
}

async function submitForm() {
  const { mode, id, student } = state.drawer;
  const isEdit = mode === "edit";
  const form = $("#studentForm");
  const values = Object.fromEntries(["id", "name", "email", "course", "age", "marks"].map((k) => [k, form.elements[k].value]));
  if (isEdit) values.id = id;

  $$(".field", form).forEach((f) => clearFieldError(f.dataset.field));
  const errs = validate(values, isEdit);
  if (Object.keys(errs).length) {
    Object.entries(errs).forEach(([k, m]) => setFieldError(k, m));
    form.querySelector(".field.invalid input")?.focus();
    return;
  }

  const payload = {
    id: values.id.trim(),
    name: values.name.trim(),
    email: values.email.trim(),
    course: values.course.trim(),
    age: Number(values.age),
    marks: Number(values.marks),
  };

  const saveBtn = $('[data-act="save"]');
  saveBtn.disabled = true;
  try {
    if (isEdit) {
      const changes = {};
      for (const k of ["name", "email", "course", "age", "marks"]) {
        if (payload[k] !== student[k]) changes[k] = payload[k];
      }
      if (!Object.keys(changes).length) {
        toast("Nothing changed.");
        renderView(id, student);
        return;
      }
      const res = await api("PUT", `/update/${encodeURIComponent(id)}`, changes);
      toast(`Updated ${res.student?.name ?? id}.`);
      await refresh();
      renderView(id, res.student ?? { ...student, ...changes });
    } else {
      const res = await api("POST", "/create", payload);
      toast(`Created ${res.student?.name ?? payload.name} · grade ${res.student?.grade ?? gradeOf(payload.marks)}.`);
      closeDrawer();
      await refresh();
    }
  } catch (err) {
    if (err.status === 422) {
      const fe = fieldErrors(err.detail);
      let shown = false;
      for (const [k, m] of Object.entries(fe)) shown = setFieldError(k, m) || shown;
      if (!shown) toastError(err);
    } else if (err.status === 400 && !isEdit) {
      setFieldError("id", err.message);
    } else {
      toastError(err);
    }
  } finally {
    if (document.body.contains(saveBtn)) saveBtn.disabled = false;
  }
}

/* ───────────── Delete ───────────── */
function confirmDelete(id, name) {
  const dlg = $("#confirmDialog");
  $("#confirmText").innerHTML = `This permanently removes <strong>${esc(name || id)}</strong> (<span class="mono">${esc(id)}</span>) from <span class="mono">students.json</span>.`;
  dlg.showModal();
  $("#confirmOk").onclick = async () => {
    $("#confirmOk").disabled = true;
    try {
      const res = await api("DELETE", `/delete/${encodeURIComponent(id)}`);
      toast(res?.message ?? `Deleted ${id}.`);
      dlg.close();
      if (state.drawer.id === id) closeDrawer();
      await refresh();
    } catch (err) {
      dlg.close();
      toastError(err);
    } finally {
      $("#confirmOk").disabled = false;
    }
  };
}
$("#confirmCancel").addEventListener("click", () => $("#confirmDialog").close());

/* ───────────── Events ───────────── */
$("#rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const id = tr.dataset.id;
  const act = e.target.closest("button")?.dataset.act;
  const s = { ...state.all[id], id };
  if (act === "edit") { renderForm("edit", id, state.all[id] ?? {}); openDrawer(); }
  else if (act === "delete") confirmDelete(id, s.name);
  else showStudent(id);
});
$("#rows").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("tr[data-id]")) showStudent(e.target.dataset.id);
});

$("#drawerFoot").addEventListener("click", (e) => {
  const act = e.target.closest("button")?.dataset.act;
  const { id, student } = state.drawer;
  if (act === "edit") renderForm("edit", id, student);
  else if (act === "delete") confirmDelete(id, student?.name);
  else if (act === "save") submitForm();
  else if (act === "cancel-edit") renderView(id, student);
  else if (act === "close") closeDrawer();
});

$("#closeDrawer").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#drawer").classList.contains("open") && !$("#confirmDialog").open) closeDrawer();
});

$("#newBtn").addEventListener("click", () => { renderForm("create"); openDrawer(); });

$("#lookupForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#lookupId").value.trim();
  if (id) showStudent(id);
});

$("#courseFilter").addEventListener("change", (e) => { state.course = e.target.value; state.page = 1; loadTable(); });
$("#sortBy").addEventListener("change", (e) => { state.sortBy = e.target.value; state.page = 1; syncOrder(); loadTable(); });
$$(".seg button").forEach((b) => b.addEventListener("click", () => {
  state.order = b.dataset.order;
  syncOrder();
  if (state.sortBy) { state.page = 1; loadTable(); }
}));
function syncOrder() {
  $$(".seg button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.order === state.order));
    b.disabled = !state.sortBy;
  });
}

$("#pageSize").value = String(state.limit);
$("#pageSize").addEventListener("change", (e) => {
  state.limit = Number(e.target.value);
  store.set("registry.limit", state.limit);
  state.page = 1;
  loadTable();
});
$("#prevPage").addEventListener("click", () => { if (state.page > 1) { state.page--; loadTable(); } });
$("#nextPage").addEventListener("click", () => { state.page++; loadTable(); });

const apiInput = $("#apiBase");
apiInput.value = state.base;
function reconnect() {
  state.base = apiInput.value.trim() || "http://127.0.0.1:8000";
  apiInput.value = state.base;
  store.set("registry.api", state.base);
  $("#connStatus").textContent = "Connecting…";
  state.page = 1;
  refresh();
}
apiInput.addEventListener("keydown", (e) => { if (e.key === "Enter") reconnect(); });
$("#reconnect").addEventListener("click", reconnect);

/* Theme */
const savedTheme = store.get("registry.theme", "");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$("#themeToggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("registry.theme", next);
});

/* Boot */
syncOrder();
refresh();