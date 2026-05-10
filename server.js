const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;
const HERMES_API_URL = process.env.HERMES_API_URL;
const HERMES_API_KEY = process.env.HERMES_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    })
  : null;

async function initializeDatabase() {
  if (!pool) {
    console.log("Postgres not configured; skipping database initialization.");
    return;
  }

  const schemaPath = path.join(__dirname, "db", "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");

  await pool.query(schemaSql);
  console.log("Postgres schema initialized.");
}

async function saveRecommendationRun(mode, filters, localMemory, hermesResponse) {
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `INSERT INTO recommendation_runs (mode, filters, local_memory, hermes_response)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
     RETURNING id, created_at`,
    [
      mode,
      JSON.stringify(filters || {}),
      JSON.stringify(localMemory || {}),
      JSON.stringify(hermesResponse || {})
    ]
  );

  return result.rows[0];
}

async function saveWatchEvent(action, title, service, filters, recommendation, note) {
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `INSERT INTO watch_events (action, title, service, filters, recommendation, note)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     RETURNING id, created_at`,
    [
      action,
      title,
      service || null,
      JSON.stringify(filters || {}),
      JSON.stringify(recommendation || {}),
      note || null
    ]
  );

  return result.rows[0];
}


function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));
}


app.use(express.json({ limit: "1mb" }));

// Serve existing static HTML files.
app.use(express.static(__dirname));


// Basic health check.
app.get("/api/health", async (req, res) => {
  let databaseConnected = false;

  if (pool) {
    try {
      await pool.query("SELECT 1");
      databaseConnected = true;
    } catch (error) {
      databaseConnected = false;
    }
  }

  res.json({
    ok: true,
    app: "premium-streaming-dashboard",
    hermesConfigured: Boolean(HERMES_API_URL && HERMES_API_KEY),
    databaseConfigured: Boolean(DATABASE_URL),
    databaseConnected
  });
});


// Temporary diagnostic endpoint: probes Hermes routes server-side.
// Does not expose HERMES_API_KEY to the browser.
app.get("/api/hermes/probe", async (req, res) => {
  try {
    if (!HERMES_API_URL || !HERMES_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Hermes is not configured on this server."
      });
    }

    const base = HERMES_API_URL.replace(/\/$/, "");

    const probes = [
      { method: "GET", path: "/api/auth/status" },
      { method: "GET", path: "/api/sessions" },
      { method: "POST", path: "/api/session/new", body: {} },
      { method: "POST", path: "/api/session/create", body: {} },
      { method: "POST", path: "/api/sessions", body: {} },
      { method: "POST", path: "/api/chat", body: { session_id: "probe_missing_session", message: "ping" } },
      { method: "POST", path: "/api/chat/start", body: { session_id: "probe_missing_session", message: "ping" } }
    ];

    const results = [];

    for (const probe of probes) {
      try {
        const response = await fetch(`${base}${probe.path}`, {
          method: probe.method,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${HERMES_API_KEY}`
          },
          body: probe.method === "POST" ? JSON.stringify(probe.body || {}) : undefined
        });

        const text = await response.text();

        results.push({
          method: probe.method,
          path: probe.path,
          status: response.status,
          ok: response.ok,
          bodyPreview: text.slice(0, 500)
        });
      } catch (error) {
        results.push({
          method: probe.method,
          path: probe.path,
          error: String(error)
        });
      }
    }

    res.json({ ok: true, results });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Unexpected Hermes probe failure.",
      details: String(error)
    });
  }
});


// Secure Hermes recommendation proxy.
// Browser calls this endpoint. This server calls Hermes.
// The Hermes key is never sent to the browser.
app.post("/api/premium/recommend", async (req, res) => {
  try {
    if (!HERMES_API_URL || !HERMES_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Hermes is not configured on this server."
      });
    }

    const {
      filters = {},
      localMemory = {},
      availableTitles = []
    } = req.body || {};

    const prompt = `
You are Sean Pate's premium streaming discovery assistant.

Goal:
Use Sean's selected filter values to find strong premium streaming recommendations in real time.

Important constraints:
- Do not claim you have direct access to Sean's Netflix, Hulu, Prime Video, Max, Disney+, Apple TV+, Paramount+, Peacock, YouTube TV, or other paid accounts.
- Use public web/search capability when available to identify likely matching titles.
- Prefer titles that appear to be available on the selected streaming service.
- For every recommendation, include service_url when you can find a direct official streaming-service title page.
- If you cannot find a direct official title page, include the best official service search URL for that title.
- If exact availability cannot be verified, say so clearly in availability_note.
- Use the provided curated title list only as optional context, not as the only source.
- Use Hermes long-term memory if available.
- If you infer a durable user preference, include it in memory_to_save.
- Return JSON only. No markdown. No surrounding explanation.

Current filters selected by Sean:
${JSON.stringify(filters, null, 2)}

Local browser memory:
${JSON.stringify(localMemory, null, 2)}

Optional existing curated premium titles:
${JSON.stringify(availableTitles, null, 2)}

Find recommendations that match:
- selected streaming service when provided
- selected mood
- selected time window
- selected energy level
- selected format
- selected intensity

Return this JSON shape exactly:
{
  "best_pick": {
    "title": "",
    "service": "",
    "type": "",
    "runtime_estimate": "",
    "why": "",
    "availability_note": "",
    "confidence": "",
    "service_url": ""
  },
  "backup_picks": [
    {
      "title": "",
      "service": "",
      "type": "",
      "runtime_estimate": "",
      "why": "",
      "availability_note": "",
      "confidence": "",
      "service_url": ""
    }
  ],
  "quick_pick": {
    "title": "",
    "service": "",
    "type": "",
    "runtime_estimate": "",
    "why": "",
    "availability_note": "",
    "confidence": "",
    "service_url": ""
  },
  "comfort_pick": {
    "title": "",
    "service": "",
    "type": "",
    "runtime_estimate": "",
    "why": "",
    "availability_note": "",
    "confidence": "",
    "service_url": ""
  },
  "wild_card": {
    "title": "",
    "service": "",
    "type": "",
    "runtime_estimate": "",
    "why": "",
    "availability_note": "",
    "confidence": "",
    "service_url": ""
  },
  "search_summary": "",
  "memory_used": [],
  "memory_to_save": [],
  "avoid": ""
}
`;

    const base = HERMES_API_URL.replace(/\/$/, "");

    const chatResp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HERMES_API_KEY}`
      },
      body: JSON.stringify({
        model: "hermes-agent",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 900
      })
    }, 120000);

    if (!chatResp.ok) {
      const text = await chatResp.text();
      return res.status(502).json({
        ok: false,
        error: "Hermes /v1/chat/completions request failed.",
        details: text
      });
    }

    const chatData = await chatResp.json();

    const raw =
      chatData?.choices?.[0]?.message?.content ||
      chatData?.choices?.[0]?.text ||
      chatData?.response ||
      chatData?.message ||
      "";

    let parsed = null;

    try {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      }
    } catch (err) {
      parsed = null;
    }

    let savedRun = null;
    try {
      savedRun = await saveRecommendationRun("deep", filters, localMemory, {
        recommendation: parsed,
        raw_response: raw,
        hermes_response_shape: {
          id: chatData?.id || null,
          model: chatData?.model || null,
          choices_count: Array.isArray(chatData?.choices) ? chatData.choices.length : null
        }
      });
    } catch (dbError) {
      console.error("Failed to save deep recommendation run:", dbError);
    }

    return res.json({
      ok: true,
      recommendation: parsed,
      raw_response: raw,
      saved_run: savedRun,
      hermes_response_shape: {
        id: chatData?.id || null,
        model: chatData?.model || null,
        choices_count: Array.isArray(chatData?.choices) ? chatData.choices.length : null
      }
    });
  } catch (err) {
    console.error("Hermes proxy error:", err);

    if (err && err.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        error: "Hermes took longer than 120 seconds to respond. Try again with fewer filters or use a simpler request."
      });
    }

    return res.status(500).json({
      ok: false,
      error: "Unexpected server error while contacting Hermes."
    });
  }
});


// Fallback to index.html for root.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});



// Fast Hermes recommendation proxy.
// Designed for mobile/quick use. Uses shorter prompt and fewer results.
// The Hermes key is never sent to the browser.
app.post("/api/premium/recommend-fast", async (req, res) => {
  try {
    if (!HERMES_API_URL || !HERMES_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Hermes is not configured on this server."
      });
    }

    const {
      filters = {},
      localMemory = {},
      availableTitles = []
    } = req.body || {};

    const prompt = `
You are Sean Pate's fast premium streaming recommendation assistant.

Goal:
Return fast, practical premium streaming suggestions based on Sean's selected filters.

Rules:
- Prioritize speed over verification.
- Return only 3 recommendations: best_pick, backup_pick, quick_pick.
- Do not use web_search, web_extract, browser, microsoft365, todo, or any external tool.
- Do not verify streaming availability.
- Do not browse or search.
- Use general knowledge, Hermes memory if already available, local browser memory, and the optional curated title list.
- If uncertain, provide an official service search URL and a cautious availability note.
- If you know or can quickly infer a direct official service page, include it in service_url.
- If not, use an official service search URL for the title.
- Do not claim direct access to Sean's private streaming accounts.
- Availability wording must be cautious: say "not verified", "service search link provided", or "check account availability".
- Use Hermes long-term memory if available.
- If you infer a durable user preference, include it in memory_to_save.
- Return JSON only. No markdown. No surrounding explanation.

Current filters selected by Sean:
${JSON.stringify(filters, null, 2)}

Local browser memory:
${JSON.stringify(localMemory, null, 2)}

Optional curated premium titles:
${JSON.stringify(availableTitles.slice(0, 20), null, 2)}

Return this JSON shape exactly:
{
  "best_pick": {
    "title": "",
    "service": "",
    "type": "",
    "runtime_estimate": "",
    "why": "",
    "availability_note": "",
    "confidence": "",
    "service_url": ""
  },
  "backup_pick": {
    "title": "",
    "service": "",
    "type": "",
    "runtime_estimate": "",
    "why": "",
    "availability_note": "",
    "confidence": "",
    "service_url": ""
  },
  "quick_pick": {
    "title": "",
    "service": "",
    "type": "",
    "runtime_estimate": "",
    "why": "",
    "availability_note": "",
    "confidence": "",
    "service_url": ""
  },
  "search_summary": "",
  "memory_used": [],
  "memory_to_save": [],
  "avoid": ""
}
`;

    const base = HERMES_API_URL.replace(/\/$/, "");

    const chatResp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HERMES_API_KEY}`
      },
      body: JSON.stringify({
        model: "hermes-agent",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 900
      })
    }, 75000);

    if (!chatResp.ok) {
      const text = await chatResp.text();
      return res.status(502).json({
        ok: false,
        error: "Hermes fast recommendation request failed.",
        details: text
      });
    }

    const chatData = await chatResp.json();

    const raw =
      chatData?.choices?.[0]?.message?.content ||
      chatData?.choices?.[0]?.text ||
      chatData?.response ||
      chatData?.message ||
      "";

    let parsed = null;

    try {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      }
    } catch (err) {
      parsed = null;
    }

    let savedRun = null;
    try {
      savedRun = await saveRecommendationRun("fast", filters, localMemory, {
        recommendation: parsed,
        raw_response: raw,
        hermes_response_shape: {
          id: chatData?.id || null,
          model: chatData?.model || null,
          choices_count: Array.isArray(chatData?.choices) ? chatData.choices.length : null
        }
      });
    } catch (dbError) {
      console.error("Failed to save fast recommendation run:", dbError);
    }

    return res.json({
      ok: true,
      mode: "fast",
      recommendation: parsed,
      raw_response: raw,
      saved_run: savedRun,
      hermes_response_shape: {
        id: chatData?.id || null,
        model: chatData?.model || null,
        choices_count: Array.isArray(chatData?.choices) ? chatData.choices.length : null
      }
    });
  } catch (err) {
    console.error("Hermes fast proxy error:", err);

    if (err && err.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        error: "Hermes Fast took longer than 75 seconds. Try again or simplify the filters."
      });
    }

    return res.status(500).json({
      ok: false,
      error: "Unexpected server error while contacting Hermes Fast."
    });
  }
});



// Read recent recommendation runs from Postgres.
app.get("/api/recommendation-runs", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({
        ok: false,
        error: "Database is not configured."
      });
    }

    const result = await pool.query(
      `SELECT
         id,
         created_at,
         mode,
         filters,
         hermes_response
       FROM recommendation_runs
       ORDER BY created_at DESC
       LIMIT 10`
    );

    res.json({
      ok: true,
      count: result.rows.length,
      runs: result.rows
    });
  } catch (error) {
    console.error("Failed to read recommendation runs:", error);
    res.status(500).json({
      ok: false,
      error: "Failed to read recommendation runs."
    });
  }
});



// Read recent feedback/watch events from Postgres.
app.get("/api/watch-events", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({
        ok: false,
        error: "Database is not configured."
      });
    }

    const result = await pool.query(
      `SELECT
         id,
         created_at,
         action,
         title,
         service,
         filters,
         recommendation,
         note
       FROM watch_events
       ORDER BY created_at DESC
       LIMIT 25`
    );

    res.json({
      ok: true,
      count: result.rows.length,
      events: result.rows
    });
  } catch (error) {
    console.error("Failed to read watch events:", error);
    res.status(500).json({
      ok: false,
      error: "Failed to read watch events."
    });
  }
});



// Dashboard history summary from Postgres.
app.get("/api/dashboard-history", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({
        ok: false,
        error: "Database is not configured."
      });
    }

    const [runs, events, topServices, topMoods, perfectPicks, alreadyWatched, notInterested] = await Promise.all([
      pool.query(
        `SELECT
           id,
           created_at,
           mode,
           filters,
           hermes_response
         FROM recommendation_runs
         ORDER BY created_at DESC
         LIMIT 5`
      ),
      pool.query(
        `SELECT
           id,
           created_at,
           action,
           title,
           service,
           filters,
           note
         FROM watch_events
         ORDER BY created_at DESC
         LIMIT 10`
      ),
      pool.query(
        `SELECT
           COALESCE(service, 'Unknown') AS service,
           COUNT(*)::int AS count
         FROM watch_events
         GROUP BY COALESCE(service, 'Unknown')
         ORDER BY count DESC, service ASC
         LIMIT 8`
      ),
      pool.query(
        `SELECT
           COALESCE(filters->>'mood', 'Unknown') AS mood,
           COUNT(*)::int AS count
         FROM watch_events
         GROUP BY COALESCE(filters->>'mood', 'Unknown')
         ORDER BY count DESC, mood ASC
         LIMIT 8`
      ),
      pool.query(
        `SELECT
           title,
           COALESCE(service, 'Unknown') AS service,
           COUNT(*)::int AS count,
           MAX(created_at) AS last_event_at
         FROM watch_events
         WHERE action = 'Perfect Pick'
         GROUP BY title, COALESCE(service, 'Unknown')
         ORDER BY count DESC, last_event_at DESC
         LIMIT 10`
      ),
      pool.query(
        `SELECT
           title,
           COALESCE(service, 'Unknown') AS service,
           COUNT(*)::int AS count,
           MAX(created_at) AS last_event_at
         FROM watch_events
         WHERE action = 'Already Watched'
         GROUP BY title, COALESCE(service, 'Unknown')
         ORDER BY last_event_at DESC
         LIMIT 10`
      ),
      pool.query(
        `SELECT
           title,
           COALESCE(service, 'Unknown') AS service,
           COUNT(*)::int AS count,
           MAX(created_at) AS last_event_at
         FROM watch_events
         WHERE action = 'Not Interested'
         GROUP BY title, COALESCE(service, 'Unknown')
         ORDER BY last_event_at DESC
         LIMIT 10`
      )
    ]);

    res.json({
      ok: true,
      recent_runs: runs.rows,
      recent_events: events.rows,
      top_services: topServices.rows,
      top_moods: topMoods.rows,
      perfect_picks: perfectPicks.rows,
      already_watched: alreadyWatched.rows,
      not_interested: notInterested.rows
    });
  } catch (error) {
    console.error("Failed to build dashboard history:", error);
    res.status(500).json({
      ok: false,
      error: "Failed to build dashboard history."
    });
  }
});


// Secure Hermes feedback and memory proxy.
// Browser sends feedback here. This server asks Hermes to remember durable preferences.
// The Hermes key is never sent to the browser.
app.post("/api/premium/feedback", async (req, res) => {
  try {
    if (!HERMES_API_URL || !HERMES_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Hermes is not configured on this server."
      });
    }

    const {
      action = "",
      title = "",
      service = "",
      filters = {},
      recommendation = {},
      note = ""
    } = req.body || {};

    if (!action || !title) {
      return res.status(400).json({
        ok: false,
        error: "Missing required feedback fields: action and title."
      });
    }

    let savedWatchEvent = null;
    try {
      savedWatchEvent = await saveWatchEvent(action, title, service, filters, recommendation, note);
    } catch (dbError) {
      console.error("Failed to save watch event:", dbError);
    }

    const prompt = `
You are Sean Pate's premium streaming memory assistant.

Goal:
Use the user's feedback to save useful long-term preference memory for future streaming recommendations.

Feedback action:
${action}

Title:
${title}

Service:
${service}

Current filters:
${JSON.stringify(filters, null, 2)}

Recommendation context:
${JSON.stringify(recommendation, null, 2)}

Optional user note:
${note}

Instructions:
- Use Hermes memory capability if available to remember durable preferences.
- Do not save trivial one-time facts.
- Save concise preferences that will improve future recommendations.
- Examples of useful memories:
  - Sean likes smart Prime Video movies around two hours.
  - Sean dislikes heavy shows when energy is low.
  - Sean has already watched a specific title.
  - Sean wants more like a specific title.
- Return JSON only. No markdown.

Return this JSON shape exactly:
{
  "saved": true,
  "memory_saved": "",
  "future_recommendation_effect": ""
}
`;

    const base = HERMES_API_URL.replace(/\/$/, "");

    const chatResp = await fetchWithTimeout(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HERMES_API_KEY}`
      },
      body: JSON.stringify({
        model: "hermes-agent",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1
      })
    }, 60000);

    if (!chatResp.ok) {
      const text = await chatResp.text();
      return res.status(502).json({
        ok: false,
        error: "Hermes feedback memory request failed.",
        details: text
      });
    }

    const chatData = await chatResp.json();

    const raw =
      chatData?.choices?.[0]?.message?.content ||
      chatData?.choices?.[0]?.text ||
      chatData?.response ||
      chatData?.message ||
      "";

    let parsed = null;

    try {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      }
    } catch (err) {
      parsed = null;
    }

    return res.json({
      ok: true,
      feedback: parsed,
      raw_response: raw,
      saved_watch_event: savedWatchEvent
    });
  } catch (err) {
    console.error("Hermes feedback proxy error:", err);

    if (err && err.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        error: "Hermes feedback memory request took too long. Try again."
      });
    }

    return res.status(500).json({
      ok: false,
      error: "Unexpected server error while sending feedback to Hermes."
    });
  }
});


initializeDatabase()
  .catch(error => {
    console.error("Database initialization failed:", error);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Premium Streaming Dashboard running on port ${PORT}`);
    });
  });
