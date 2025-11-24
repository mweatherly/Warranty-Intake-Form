/**
 * Boatmate Warranty Intake — Cloudflare Worker (Module syntax)
 * ============================================================
 * WHAT THIS SERVICE DOES
 * - Backend endpoint for the Warranty Intake form.
 * - Accepts POSTs as either JSON (fetch) or regular HTML form posts.
 * - Validates VIN (17 chars, excludes I/O/Q) and a basic email pattern.
 * - Issues a sequential **Claim #** via a Durable Object (SQLite-backed on Free plan).
 * - Upserts a HubSpot Contact (by email) and creates a Ticket in the Warranty pipeline.
 * - Optionally sends a confirmation email via **Brevo** (HTTP v3 API).
 * - Responds with JSON: { ok, claimNumber, contactId, ticketId, emailStatus, message }.
 *
 * HOW CORS IS HANDLED
 * - OPTIONS requests are answered by handlePreflight(), which **echoes**
 *   the browser’s requested method/headers to satisfy preflight checks.
 * - Non-OPTIONS responses use corsHeaders(), which sets ACAO to the
 *   exact allow-listed origin (or nothing in production-hardened mode).
 *
 * DURABLE OBJECT (CLAIM COUNTER)
 * - A single object instance stores one integer (`n`), incremented atomically.
 * - We call POST /next to fetch `{ n }`, which becomes the **Claim #**.
 *
 * REQUIRED VARIABLES/SECRETS (Workers → Settings → Variables & Secrets)
 *   TEXT:
 *     EMAIL_ENABLED        : "true" to send email; any other value skips send.
 *     EMAIL_API_ENDPOINT   : "https://api.brevo.com/v3/smtp/email" (default if unset)
 *     FROM_EMAIL           : Verified Brevo sender (e.g., no-reply@mweatherly.com)
 *     FROM_NAME            : Optional, friendly name (e.g., "Boatmate Support")
 *     REPLY_TO             : Optional, reply-to address
 *     HS_TICKET_PIPELINE   : (optional override) Warranty pipeline ID (string)
 *     HS_TICKET_STAGE      : (optional override) Warranty stage ID (string)
 *   SECRETS:
 *     EMAIL_API_KEY        : Brevo **Transactional v3** API key
 *     HUBSPOT_TOKEN        : HubSpot Private App token (tickets+contacts write)
 *
 * NOTES
 * - Never embed secrets in code or expose them client-side.
 * - Use the Worker dashboard logs (console.log / console.error) while testing.
 */

// ---------------------- CORS allow-list ----------------------
// Exact origins allowed to call this endpoint (scheme + host [+ port]).
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5500",            // VS Code Live Server (dev)
  "https://boatmateparts.com",
  "https://www.boatmateparts.com",
  "http://boatmateparts.com",         // include only if you truly serve http://
  "http://www.boatmateparts.com"      // include only if you truly serve http://
]);

// If an Origin is not allow-listed, we normally omit ACAO (best for prod).
// During early dev you can set this to true to return "*" instead.
const DEV_FALLBACK_STAR = false;

// -------------------------------------------------------------
// Durable Object: strictly-incrementing Claim # counter.
// - Storage is strongly consistent; increments are atomic.
// - Uses SQLite-backed DO on Free plan (registered with `new_sqlite_classes`).
export class ClaimCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // Only one endpoint: POST /next → returns { n } where n is the next claim number.
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/next") {
      return new Response("Not found", { status: 404 });
    }

    // Read current, increment, persist, return.
    let n = (await this.state.storage.get("n")) || 100000; // seed/start value
    n += 1;
    await this.state.storage.put("n", n);

    return new Response(JSON.stringify({ n }), {
      headers: { "content-type": "application/json" }
    });
  }
}

// -------------------------------------------------------------
export default {
  /**
   * fetch(request, env)
   * Entry point for requests. `env` exposes Worker variables/secrets/bindings.
   */
  async fetch(request, env) {
    // 1) CORS preflight — echo requested method/headers so preflight passes.
    if (request.method === "OPTIONS") {
      return handlePreflight(request);
    }

    // 2) Only POST is allowed (still returns CORS headers).
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders(request)
      });
    }

    // 3) Parse body (JSON or form-data). Accept either fetch()-JSON or <form> POST.
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    let vin = "", email = "", category = "Warranty";

    try {
      if (ct.includes("application/json")) {
        const b = await request.json().catch(() => ({}));
        vin = String(b.vin || "").trim().toUpperCase();
        email = String(b.email || "").trim();
        if (b.category) category = String(b.category).trim();
      } else {
        const f = await request.formData();
        vin = String(f.get("vin") || "").trim().toUpperCase();
        email = String(f.get("email") || "").trim();
        const cat = f.get("category");
        if (cat) category = String(cat).trim();
      }
    } catch {
      // Friendly 400 on malformed bodies.
      return json(request, { ok: false, errors: ["Invalid request body"] }, 400);
    }

    // 4) Server-side validation is the authority. Fail fast with a clear 400.
    const errors = [];
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) errors.push("VIN must be 17 chars (no I, O, Q).");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email is invalid.");
    if (errors.length) return json(request, { ok: false, errors }, 400);

    // Build normalized submission for HubSpot + logs
    const submission = {
      ref: crypto.randomUUID(),           // independent trace id (not shown to user)
      vin: vin.toUpperCase(),
      email: email.toLowerCase(),
      category
      // room for optional metadata later (IP, UA, UTM, etc.)
    };

    // 5) Claim number: ask the Durable Object for the next sequential integer.
    const doId = env.CLAIM_COUNTER.idFromName("global"); // single, global counter
    const doStub = env.CLAIM_COUNTER.get(doId);
    const { n: claimNumber } = await doStub
      .fetch("https://counter/next", { method: "POST" })
      .then(r => r.json());

    // 6) HubSpot Contact upsert (idempotent by email). Non-fatal if it fails for POC.
    let contactId = null;
    try {
      contactId = await hsUpsertContact(env, submission.email, {
        email: submission.email
        // Optional: firstname, lastname, lifecycle_stage, etc.
      });
      console.log("HS contactId", contactId);
    } catch (e) {
      console.error("HS contact upsert failed", e);
      // POC continues even if contact upsert fails.
    }

    // 7) Create Ticket in Warranty pipeline. Include Claim # in subject/body and add helpful props.
    let ticketId = null;
    try {
      const pipeline = env.HS_TICKET_PIPELINE || "760934225";
      const stage    = env.HS_TICKET_STAGE    || "1108043102";

      // Note: property keys must exist on the Ticket object in HubSpot.
      const ticketProps = {
        hs_pipeline: pipeline,
        hs_pipeline_stage: stage,
        subject: `Warranty Claim #${claimNumber} - ${submission.vin}`,
        content:
          `Warranty intake POC\n` +
          `Claim #: ${claimNumber}\n` +
          `VIN: ${submission.vin}\n` +
          `Email: ${submission.email}`
      };
      ticketProps["hs_ticket_category"] = submission.category;
      ticketProps["trailer_vin"] = submission.vin;

      ticketId = await hsCreateTicket(env, ticketProps);
      console.log("HS ticketId", ticketId);
    } catch (e) {
      console.error("HS ticket create failed", e);
      // POC continues even if ticket creation fails.
    }

    // Keep `ref` for logs/tracing (not surfaced to the user).
    const ref = submission.ref;

    // 8) Confirmation email (Brevo). Controlled by EMAIL_ENABLED + required vars.
    const emailConfigured =
      env.EMAIL_ENABLED === "true" &&
      !!(env.EMAIL_API_ENDPOINT && env.EMAIL_API_KEY && env.FROM_EMAIL);

    let emailStatus = "skipped"; // "sent" | "failed" | "skipped"

    if (emailConfigured) {
      const subject = `Warranty request received - Claim #${claimNumber}`;
      const html = `
        <p>Thanks! We received your warranty request.</p>
        <p><strong>Claim #:</strong> ${claimNumber}</p>
        <p><strong>VIN:</strong> ${escapeHtml(vin)}<br/>
           <strong>Email:</strong> ${escapeHtml(email)}<br/>
           <strong>Category:</strong> ${escapeHtml(category)}</p>
        <p>We’ll follow up shortly.</p>
      `;
      const text = `Thanks!
Claim #: ${claimNumber}
VIN: ${vin}
Email: ${email}
Category: ${category}`;

      try {
        await sendEmail(env, { to: email, from: env.FROM_EMAIL, subject, html, text });
        emailStatus = "sent";
      } catch (err) {
        console.error("Email send failed", err);
        emailStatus = "failed";
      }
    }

    // 9) Consistent JSON response for the frontend (handy for manual testing).
    const message =
      emailStatus === "sent"    ? "Submitted. Confirmation email sent." :
      emailStatus === "failed"  ? "Submitted. Email delivery is currently unavailable; we’ll follow up." :
                                  "Submitted. (Email not configured in this environment.)";

    return json(request, { ok: true, claimNumber, ref, contactId, ticketId, emailStatus, message });
  }
};

// ------------------------ Helpers ------------------------

/**
 * handlePreflight(request)
 * Responds to CORS preflight by **echoing** the requested method/headers so
 * the browser sees exactly what it asked for. Avoids “missing header” errors.
 */
function handlePreflight(request) {
  const reqMethod  = request.headers.get("Access-Control-Request-Method")  || "POST";
  const reqHeaders = request.headers.get("Access-Control-Request-Headers") || "content-type";
  const origin     = request.headers.get("Origin") || "";

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowOrigin(origin),
      "Access-Control-Allow-Methods": reqMethod,
      "Access-Control-Allow-Headers": reqHeaders,
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    }
  });
}

/**
 * corsHeaders(request)
 * Standard CORS headers for non-OPTIONS responses.
 * - ACAO is either the exact Origin (if allow-listed) or "" (production).
 * - In early dev you can set DEV_FALLBACK_STAR=true to return "*".
 */
function corsHeaders(request) {
  const origin     = request.headers.get("Origin") || "";
  const reqHeaders = request.headers.get("Access-Control-Request-Headers") || "content-type";
  return {
    "Access-Control-Allow-Origin": allowOrigin(origin),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": reqHeaders,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

/**
 * allowOrigin(origin)
 * Returns the origin if allow-listed; otherwise returns "*" only when the
 * dev fallback is enabled. In production hardening, keep fallback disabled.
 */
function allowOrigin(origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return DEV_FALLBACK_STAR ? "*" : ""; // empty string = omit ACAO
}

/**
 * json(request, body, status=200)
 * Wraps JSON.stringify(body) with CORS headers from corsHeaders().
 */
function json(request, body, status = 200) {
  const headers = { "content-type": "application/json", ...corsHeaders(request) };
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * sendEmail(env, opts)
 * Provider-specific HTTP POST to Brevo Transactional v3 API.
 * Swap this function only if you change email providers.
 * Throws with response details on non-2xx to simplify debugging.
 */
async function sendEmail(env, { to, from, subject, html, text }) {
  const endpoint = env.EMAIL_API_ENDPOINT || "https://api.brevo.com/v3/smtp/email";
  const apiKey = env.EMAIL_API_KEY;
  const fromEmail = from || env.FROM_EMAIL;
  const fromName = env.FROM_NAME || undefined;
  const replyTo = env.REPLY_TO || undefined;

  if (!apiKey || !fromEmail) {
    throw new Error("Missing EMAIL_API_KEY or FROM_EMAIL for Brevo.");
  }

  const payload = {
    sender: { email: fromEmail, ...(fromName ? { name: fromName } : {}) },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
    ...(replyTo ? { replyTo: { email: replyTo } } : {})
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Brevo send failed ${resp.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * escapeHtml(str)
 * Minimal escaping for values interpolated into HTML email.
 */
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------- HubSpot helpers (Private App token in env.HUBSPOT_TOKEN) ----------
const HS_BASE = "https://api.hubapi.com";

/**
 * hsRequest(path, init)
 * Adds auth header, parses JSON (when present), throws with a readable message
 * on non-2xx. Central place to handle HubSpot HTTP concerns.
 */
async function hsRequest(env, path, init = {}) {
  const url = `${HS_BASE}${path}`;
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${env.HUBSPOT_TOKEN}`);
  headers.set("Content-Type", "application/json");

  const resp = await fetch(url, { ...init, headers });
  const text = await resp.text();

  let json = {};
  if (text) {
    try { json = JSON.parse(text); } catch { json = {}; }
  }

  if (!resp.ok) {
    const code = json?.status || resp.status;
    const msg  = json?.message || json?.error || `HTTP ${resp.status}`;
    throw new Error(`HubSpot ${code}: ${msg}`);
  }
  return json;
}

/**
 * hsFindContactByEmail(env, email)
 * CRM v3 Search API to locate a Contact by email. Returns the contactId or null.
 */
async function hsFindContactByEmail(env, email) {
  const body = {
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: email.toLowerCase() }] }
    ],
    properties: ["email"],
    limit: 1
  };
  const res = await hsRequest(env, "/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify(body)
  });
  const hit = Array.isArray(res?.results) && res.results[0];
  return hit ? hit.id : null;
}

/**
 * hsCreateContact(env, props)
 * Minimal Contact create. Returns contactId or null.
 */
async function hsCreateContact(env, props) {
  const res = await hsRequest(env, "/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({ properties: props })
  });
  return res?.id || null;
}

/**
 * hsUpsertContact(env, email, props)
 * Idempotent: find by email; create if missing. Returns contactId.
 * Throws if HUBSPOT_TOKEN or email is missing.
 */
async function hsUpsertContact(env, email, props = {}) {
  if (!env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN missing");
  if (!email) throw new Error("Email required for contact upsert");

  const existingId = await hsFindContactByEmail(env, email);
  if (existingId) return existingId;

  const createProps = { email: email.toLowerCase(), ...props };
  const newId = await hsCreateContact(env, createProps);
  if (!newId) throw new Error("Failed to create contact");
  return newId;
}

/**
 * hsCreateTicket(env, props)
 * Minimal Ticket create in the specified pipeline/stage. Returns ticketId.
 */
async function hsCreateTicket(env, props) {
  const res = await hsRequest(env, "/crm/v3/objects/tickets", {
    method: "POST",
    body: JSON.stringify({ properties: props })
  });
  return res?.id || null;
}
