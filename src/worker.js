const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const badRequest = (message) => json({ error: message }, 400);

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeYearOfBirth(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (!/^\d{4}$/.test(raw)) {
    throw new Error("Year of birth must be a 4-digit year.");
  }

  const year = Number(raw);
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < 1900 || year > currentYear) {
    throw new Error(`Year of birth must be between 1900 and ${currentYear}.`);
  }

  return year;
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  if (!header) return {};

  const cookies = {};
  for (const part of header.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (!rawName) continue;
    const rawValue = rawValueParts.join("=") || "";
    try {
      cookies[rawName] = decodeURIComponent(rawValue);
    } catch {
      cookies[rawName] = rawValue;
    }
  }
  return cookies;
}

function encodeBase64Url(input) {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(normalized + padding);
}

async function signString(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return encodeBase64Url(binary);
}

function makeCookie(name, value, { maxAge, secure = false, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (typeof maxAge === "number") parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

function redirectWithCookies(location, cookies = []) {
  const headers = new Headers({ location });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function hasGoogleAuthConfig(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.AUTH_SECRET);
}

function authConfigErrorResponse(isApi) {
  if (isApi) return json({ error: "Google auth is not configured on the server." }, 500);
  return new Response("Google auth is not configured on the server.", { status: 500 });
}

function isEmailAllowed(email, env) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return false;

  const allowedEmails = String(env.ALLOWED_EMAILS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const allowedDomains = String(env.ALLOWED_DOMAINS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.length > 0 && allowedEmails.includes(normalizedEmail)) return true;
  if (allowedDomains.length > 0) {
    const domain = normalizedEmail.split("@")[1] || "";
    if (allowedDomains.includes(domain)) return true;
  }
  if (allowedEmails.length === 0 && allowedDomains.length === 0) return true;
  return false;
}

async function createSessionToken(env, payload) {
  const payloadB64 = encodeBase64Url(JSON.stringify(payload));
  const signature = await signString(env.AUTH_SECRET, payloadB64);
  return `${payloadB64}.${signature}`;
}

async function verifySessionToken(env, token) {
  if (!token || !token.includes(".")) return null;
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;

  try {
    const expected = await signString(env.AUTH_SECRET, payloadB64);
    if (expected !== signature) return null;

    const payload = JSON.parse(decodeBase64Url(payloadB64));
    if (!payload?.exp || Date.now() >= Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function ensureRuntimeSchema(env) {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS sailors (id TEXT PRIMARY KEY, name TEXT NOT NULL, year_of_birth INTEGER, sail_number TEXT DEFAULT '', club TEXT DEFAULT '')"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS races (id TEXT PRIMARY KEY, name TEXT NOT NULL, race_date TEXT NOT NULL, regatta_id TEXT)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS results (race_id TEXT NOT NULL, sailor_id TEXT NOT NULL, status TEXT NOT NULL, position INTEGER, PRIMARY KEY (race_id, sailor_id))"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO app_meta (key, value) VALUES ('updated_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS regattas (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, start_date TEXT NOT NULL, end_date TEXT NOT NULL, discards_enabled INTEGER NOT NULL DEFAULT 1)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_results_race_id ON results (race_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_results_sailor_id ON results (sailor_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_races_regatta_id ON races (regatta_id)")
  ]);

  const sailorColumns = await env.DB.prepare("PRAGMA table_info(sailors)").all();
  const hasYearOfBirth = (sailorColumns.results || []).some(
    (column) => column?.name === "year_of_birth"
  );
  if (!hasYearOfBirth) {
    await env.DB.prepare("ALTER TABLE sailors ADD COLUMN year_of_birth INTEGER").run();
  }

  const regattaColumns = await env.DB.prepare("PRAGMA table_info(regattas)").all();
  const hasDiscardsEnabled = (regattaColumns.results || []).some(
    (column) => column?.name === "discards_enabled"
  );
  if (!hasDiscardsEnabled) {
    await env.DB
      .prepare("ALTER TABLE regattas ADD COLUMN discards_enabled INTEGER NOT NULL DEFAULT 1")
      .run();
  }

  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS regatta_participants (regatta_id TEXT NOT NULL, sailor_id TEXT NOT NULL, PRIMARY KEY (regatta_id, sailor_id))"
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_regatta_participants_regatta ON regatta_participants (regatta_id)"
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_regatta_participants_sailor ON regatta_participants (sailor_id)"
    )
  ]);
}

async function touchUpdatedAt(env) {
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      "INSERT INTO app_meta (key, value) VALUES ('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .bind(now)
    .run();
  return now;
}

async function upsertRegattaSailNumbers(env, regattaId, sailNumbers, validSailorIds) {
  if (!Array.isArray(sailNumbers) || sailNumbers.length === 0) return;

  const validSet = new Set(validSailorIds);
  const statements = [];

  for (const item of sailNumbers) {
    const sailorId = item?.sailorId;
    if (!validSet.has(sailorId)) continue;
    const sailNumber = String(item?.sailNumber || "").trim();

    statements.push(
      env.DB
        .prepare(
          "INSERT INTO sailor_regatta_numbers (sailor_id, regatta_id, sail_number) VALUES (?, ?, ?) ON CONFLICT(sailor_id, regatta_id) DO UPDATE SET sail_number = excluded.sail_number"
        )
        .bind(sailorId, regattaId, sailNumber)
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

async function loadRegattaParticipantIds(env, regattaId) {
  if (!regattaId) return [];
  const rows = await env.DB
    .prepare("SELECT sailor_id AS sailorId FROM regatta_participants WHERE regatta_id = ?")
    .bind(regattaId)
    .all();
  return (rows.results || []).map((row) => row.sailorId);
}

async function setRegattaParticipants(env, regattaId, participantIds, validSailorIds) {
  const validSet = new Set(validSailorIds);
  const uniqueParticipants = Array.from(
    new Set((participantIds || []).filter((id) => validSet.has(id)))
  );

  const statements = [env.DB.prepare("DELETE FROM regatta_participants WHERE regatta_id = ?").bind(regattaId)];
  for (const sailorId of uniqueParticipants) {
    statements.push(
      env.DB
        .prepare("INSERT INTO regatta_participants (regatta_id, sailor_id) VALUES (?, ?)")
        .bind(regattaId, sailorId)
    );
  }

  await env.DB.batch(statements);
  return uniqueParticipants;
}

async function refreshRegattaRange(env, regattaId) {
  const aggregate = await env.DB
    .prepare(
      "SELECT COUNT(*) AS raceCount, MIN(race_date) AS startDate, MAX(race_date) AS endDate FROM races WHERE regatta_id = ?"
    )
    .bind(regattaId)
    .first();

  if (!aggregate || Number(aggregate.raceCount || 0) === 0) {
    await env.DB
      .prepare("DELETE FROM sailor_regatta_numbers WHERE regatta_id = ?")
      .bind(regattaId)
      .run();
    await env.DB
      .prepare("DELETE FROM regatta_participants WHERE regatta_id = ?")
      .bind(regattaId)
      .run();
    await env.DB.prepare("DELETE FROM regattas WHERE id = ?").bind(regattaId).run();
    return;
  }

  await env.DB
    .prepare("UPDATE regattas SET start_date = ?, end_date = ? WHERE id = ?")
    .bind(aggregate.startDate, aggregate.endDate, regattaId)
    .run();
}

async function getOrCreateRegatta(env, regattaName, raceDate, discardsEnabledArg = undefined) {
  const normalizedDiscardsEnabled =
    discardsEnabledArg === undefined ? undefined : discardsEnabledArg ? 1 : 0;

  const existing = await env.DB
    .prepare("SELECT id FROM regattas WHERE name = ?")
    .bind(regattaName)
    .first();

  if (existing?.id) {
    if (normalizedDiscardsEnabled === undefined) {
      await env.DB
        .prepare(
          "UPDATE regattas SET start_date = CASE WHEN start_date <= ? THEN start_date ELSE ? END, end_date = CASE WHEN end_date >= ? THEN end_date ELSE ? END WHERE id = ?"
        )
        .bind(raceDate, raceDate, raceDate, raceDate, existing.id)
        .run();
    } else {
      await env.DB
        .prepare(
          "UPDATE regattas SET start_date = CASE WHEN start_date <= ? THEN start_date ELSE ? END, end_date = CASE WHEN end_date >= ? THEN end_date ELSE ? END, discards_enabled = ? WHERE id = ?"
        )
        .bind(raceDate, raceDate, raceDate, raceDate, normalizedDiscardsEnabled, existing.id)
        .run();
    }
    return existing.id;
  }

  const regattaId = createId("regatta");
  const discardsEnabled = normalizedDiscardsEnabled === undefined ? 1 : normalizedDiscardsEnabled;
  await env.DB
    .prepare(
      "INSERT INTO regattas (id, name, start_date, end_date, discards_enabled) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(regattaId, regattaName, raceDate, raceDate, discardsEnabled)
    .run();

  return regattaId;
}

async function loadState(env) {
  const [sailorsRows, regattasRows, racesRows, resultsRows, sailNumbersRows, participantsRows, updatedAtRow] =
    await Promise.all([
    env.DB.prepare(
      "SELECT id, name, year_of_birth AS yearOfBirth, sail_number AS sailNumber, club FROM sailors ORDER BY name ASC"
    ).all(),
    env.DB.prepare(
      "SELECT id, name, start_date AS startDate, end_date AS endDate, discards_enabled AS discardsEnabled FROM regattas ORDER BY start_date DESC, name ASC"
    ).all(),
    env.DB.prepare(
      "SELECT races.rowid AS createdOrder, races.id, races.name, races.race_date AS date, races.regatta_id AS regattaId, regattas.name AS regattaName FROM races LEFT JOIN regattas ON regattas.id = races.regatta_id ORDER BY races.rowid ASC"
    ).all(),
    env.DB.prepare(
      "SELECT race_id AS raceId, sailor_id AS sailorId, status, position FROM results"
    ).all(),
    env.DB.prepare(
      "SELECT sailor_id AS sailorId, regatta_id AS regattaId, sail_number AS sailNumber FROM sailor_regatta_numbers"
    ).all(),
    env.DB.prepare(
      "SELECT regatta_id AS regattaId, sailor_id AS sailorId FROM regatta_participants"
    ).all(),
    env.DB.prepare("SELECT value FROM app_meta WHERE key = 'updated_at'").first()
  ]);

  const sailors = sailorsRows.results || [];
  const regattas = (regattasRows.results || []).map((regatta) => ({
    ...regatta,
    discardsEnabled: Number(regatta.discardsEnabled) !== 0
  }));
  const regattaCounters = new Map();
  const races = (racesRows.results || []).map((race) => {
    const counter = (regattaCounters.get(race.regattaId) || 0) + 1;
    regattaCounters.set(race.regattaId, counter);

    return {
      ...race,
      name: `R${counter}`,
      results: []
    };
  });

  const racesById = new Map(races.map((race) => [race.id, race]));
  for (const result of resultsRows.results || []) {
    const race = racesById.get(result.raceId);
    if (!race) continue;
    race.results.push({
      sailorId: result.sailorId,
      status: result.status,
      position: result.position
    });
  }

  const sailorRegattaNumbers = {};
  for (const row of sailNumbersRows.results || []) {
    if (!sailorRegattaNumbers[row.regattaId]) sailorRegattaNumbers[row.regattaId] = {};
    sailorRegattaNumbers[row.regattaId][row.sailorId] = row.sailNumber || "";
  }

  const regattaParticipants = {};
  for (const row of participantsRows.results || []) {
    if (!regattaParticipants[row.regattaId]) regattaParticipants[row.regattaId] = [];
    regattaParticipants[row.regattaId].push(row.sailorId);
  }

  return {
    sailors,
    regattas,
    races,
    sailorRegattaNumbers,
    regattaParticipants,
    updatedAt: updatedAtRow?.value || null
  };
}

function normalizeResults(results, sailorIds) {
  const bySailor = new Map();
  for (const sailorId of sailorIds) {
    bySailor.set(sailorId, { sailorId, status: "DNC" });
  }

  for (const result of results) {
    if (!result || !sailorIds.includes(result.sailorId)) continue;

    const position = Number(result.position);
    const hasPosition = Number.isInteger(position) && position > 0;
    let status = (result.status || "OK").toUpperCase();
    if (hasPosition && status === "DNC") {
      status = "OK";
    }
    const entry = {
      sailorId: result.sailorId,
      status
    };

    if (status === "OK" && !hasPosition) {
      continue;
    }
    if (hasPosition) {
      entry.position = position;
    }

    bySailor.set(result.sailorId, entry);
  }

  return Array.from(bySailor.values());
}

function pointsForResult(result, sailorCount) {
  if (!result) return sailorCount;

  const status = (result.status || "OK").toUpperCase();
  if (status === "OK") return result.position;
  if (Number.isFinite(Number(result.position))) return Number(result.position);
  if (status === "DNC") return sailorCount;
  if (["DNS", "DNF", "RET", "OCS", "RAF"].includes(status)) return sailorCount + 1;
  if (["DSQ", "BFD", "UFD", "DNE"].includes(status)) return sailorCount + 2;

  return sailorCount;
}

function yearFromDateString(value, fallbackYear) {
  const raw = String(value || "");
  const match = raw.match(/^(\d{4})/);
  if (!match) return fallbackYear;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : fallbackYear;
}

function effectiveYearOfBirth(sailor, referenceYear) {
  const raw = sailor?.yearOfBirth;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return referenceYear;
}

function isUnder16ForYear(sailor, referenceYear) {
  const yob = effectiveYearOfBirth(sailor, referenceYear);
  return referenceYear - yob < 16;
}

function calculateLeaderboardForRaces(
  sailors,
  races,
  discardCount,
  scoringSailorCount = sailors.length,
  discardEligibleRaceIds = null
) {
  const sailorCount = scoringSailorCount;

  function computeTotalsForSailor(sailor, raceSubset, subsetDiscardCount) {
    const racePointsRaw = raceSubset.map((race) => {
      const result = race.results.find((r) => r.sailorId === sailor.id);
      const points = pointsForResult(result, sailorCount);

      return {
        raceId: race.id,
        raceName: race.name,
        status: result?.status || "DNC",
        position: result?.position || null,
        points
      };
    });

    const isDiscardEligible = (racePoint) =>
      !discardEligibleRaceIds || discardEligibleRaceIds.has(racePoint.raceId);

    const discardedIndexes = new Set(
      racePointsRaw
        .map((racePoint, index) => ({ index, raceId: racePoint.raceId, points: racePoint.points }))
        .filter((entry) => isDiscardEligible(entry))
        .sort((a, b) => b.points - a.points || a.index - b.index)
        .slice(0, subsetDiscardCount)
        .map((entry) => entry.index)
    );

    const racePoints = racePointsRaw.map((racePoint, index) => ({
      ...racePoint,
      discarded: discardedIndexes.has(index)
    }));

    const discard = racePoints.reduce(
      (sum, racePoint) => sum + (racePoint.discarded ? racePoint.points : 0),
      0
    );
    const netTotal = racePoints.reduce((sum, racePoint) => sum + racePoint.points, 0);

    return {
      racePoints,
      netTotal,
      discard,
      net: netTotal - discard
    };
  }

  function sortEntries(entries) {
    function compareByBestRaceProgressive(a, b) {
      const aPoints = a.racePoints
        .map((racePoint) => Number(racePoint.points))
        .filter((value) => Number.isFinite(value))
        .sort((x, y) => x - y);
      const bPoints = b.racePoints
        .map((racePoint) => Number(racePoint.points))
        .filter((value) => Number.isFinite(value))
        .sort((x, y) => x - y);

      const maxLength = Math.max(aPoints.length, bPoints.length);
      let runningA = 0;
      let runningB = 0;

      for (let i = 0; i < maxLength; i += 1) {
        const nextA = Number.isFinite(aPoints[i]) ? aPoints[i] : Number.POSITIVE_INFINITY;
        const nextB = Number.isFinite(bPoints[i]) ? bPoints[i] : Number.POSITIVE_INFINITY;
        runningA += nextA;
        runningB += nextB;
        if (runningA !== runningB) return runningA - runningB;
      }

      return 0;
    }

    function compareForRankTie(a, b) {
      if (a.net !== b.net) return a.net - b.net;
      return compareByBestRaceProgressive(a, b);
    }

    function buildRanks(sortedEntries) {
      const ranks = [];
      for (let i = 0; i < sortedEntries.length; i += 1) {
        if (i === 0) {
          ranks.push(1);
          continue;
        }

        const sameAsPrevious = compareForRankTie(sortedEntries[i], sortedEntries[i - 1]) === 0;
        ranks.push(sameAsPrevious ? ranks[i - 1] : i + 1);
      }
      return ranks;
    }

    entries.sort((a, b) => {
      const tieComparison = compareForRankTie(a, b);
      if (tieComparison !== 0) return tieComparison;
      return a.sailor.name.localeCompare(b.sailor.name);
    });
    return {
      entries,
      ranks: buildRanks(entries)
    };
  }

  const currentEntries = sailors.map((sailor) => {
    const current = computeTotalsForSailor(sailor, races, discardCount);

    return {
      sailor,
      racePoints: current.racePoints,
      netTotal: current.netTotal,
      discard: current.discard,
      net: current.net
    };
  });

  const sortedCurrent = sortEntries(currentEntries);
  const rankedCurrentEntries = sortedCurrent.entries;
  const currentRanks = sortedCurrent.ranks;

  const previousRaces = races.slice(0, -1);
  const previousDiscardCount = Math.floor(previousRaces.length / 6);
  const previousEntries = sailors.map((sailor) => ({
    sailor,
    ...computeTotalsForSailor(sailor, previousRaces, previousDiscardCount)
  }));
  const sortedPrevious = sortEntries(previousEntries);
  const rankedPreviousEntries = sortedPrevious.entries;
  const previousRanks = sortedPrevious.ranks;

  const previousRankBySailor = new Map();
  rankedPreviousEntries.forEach((entry, index) => {
    previousRankBySailor.set(entry.sailor.id, previousRanks[index]);
  });

  const leaderboard = rankedCurrentEntries.map((entry, index) => {
    const currentRank = currentRanks[index];
    const previousRank = previousRankBySailor.get(entry.sailor.id) || currentRank;
    const trendDeltaAbs = Math.abs(currentRank - previousRank);

    let trend = "equal";
    let trendSymbol = "=";
    if (currentRank < previousRank) {
      trend = "up";
      trendSymbol = "↑";
    } else if (currentRank > previousRank) {
      trend = "down";
      trendSymbol = "↓";
    }

    return {
      ...entry,
      rank: currentRank,
      previousRank,
      trend,
      trendSymbol,
      trendDeltaAbs
    };
  });

  return {
    races,
    discardCount,
    leaderboard
  };
}

function calculateLeaderboards(state) {
  const sailors = [...state.sailors];
  const regattas = [...state.regattas];
  const allRaces = [...state.races];
  const currentYear = new Date().getUTCFullYear();
  const regattaParticipants = state.regattaParticipants || {};
  const sailorsById = new Map(sailors.map((sailor) => [sailor.id, sailor]));
  const regattasById = new Map(regattas.map((regatta) => [regatta.id, regatta]));
  const calculateDiscardCount = (raceCount) => Math.floor(raceCount / 6);

  const regattasWithRaces = regattas
    .filter((regatta) => allRaces.some((race) => race.regattaId === regatta.id))
    .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  const currentRegattaInfo = regattasWithRaces[0] || null;

  const currentRegattaRaces = currentRegattaInfo
    ? allRaces.filter((race) => race.regattaId === currentRegattaInfo.id)
    : [];
  const currentRegattaYear = currentRegattaInfo
    ? yearFromDateString(currentRegattaInfo.startDate, currentYear)
    : currentYear;
  const currentRegattaSailors = currentRegattaInfo
    ? (regattaParticipants[currentRegattaInfo.id] || [])
        .map((id) => sailorsById.get(id))
        .filter(Boolean)
        .filter((sailor) => isUnder16ForYear(sailor, currentRegattaYear))
    : [];
  const currentRegattaDiscardsEnabled = currentRegattaInfo
    ? currentRegattaInfo.discardsEnabled !== false
    : true;
  const currentRegattaDiscardEligibleRaceIds = currentRegattaDiscardsEnabled
    ? new Set(currentRegattaRaces.map((race) => race.id))
    : new Set();
  const currentRegattaDiscardCount = currentRegattaDiscardsEnabled
    ? calculateDiscardCount(currentRegattaDiscardEligibleRaceIds.size)
    : 0;

  const rankingRaces = allRaces.slice(-18).map((race, index) => ({
    ...race,
    name: `R${index + 1}`
  }));
  const rankingDiscardEligibleRaceIds = new Set(rankingRaces.map((race) => race.id));
  const rankingReferenceYear = rankingRaces.length
    ? yearFromDateString(rankingRaces[rankingRaces.length - 1].date, currentYear)
    : currentYear;
  const rankingEligibleSailors = sailors.filter((sailor) =>
    isUnder16ForYear(sailor, rankingReferenceYear) &&
    rankingRaces.some((race) => {
      const result = race.results.find((r) => r.sailorId === sailor.id);
      return (result?.status || "DNC").toUpperCase() !== "DNC";
    })
  );
  const rankingDiscardCount = calculateDiscardCount(rankingRaces.length);

  return {
    sailors,
    regattas,
    races: allRaces,
    sailorRegattaNumbers: state.sailorRegattaNumbers || {},
    regattaParticipants,
    currentRegattaInfo: currentRegattaInfo
      ? {
          id: currentRegattaInfo.id,
          name: currentRegattaInfo.name,
          startDate: currentRegattaInfo.startDate,
          endDate: currentRegattaInfo.endDate,
          discardsEnabled: currentRegattaInfo.discardsEnabled !== false
        }
      : null,
    currentRegatta: calculateLeaderboardForRaces(
      currentRegattaSailors,
      currentRegattaRaces,
      currentRegattaDiscardCount,
      currentRegattaSailors.length,
      currentRegattaDiscardEligibleRaceIds
    ),
    rankingList: calculateLeaderboardForRaces(
      rankingEligibleSailors,
      rankingRaces,
      rankingDiscardCount,
      sailors.length,
      rankingDiscardEligibleRaceIds
    )
  };
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    const secureCookie = url.protocol === "https:";
    const isPublicResultsPage = url.pathname === "/results.html";
    const isPublicStateApi = request.method === "GET" && url.pathname === "/api/public-state";

    if (isPublicResultsPage) {
      return env.ASSETS.fetch(request);
    }

    if (isPublicStateApi) {
      await ensureRuntimeSchema(env);
      const state = await loadState(env);
      return json({ ...calculateLeaderboards(state), updatedAt: state.updatedAt });
    }

    if (url.pathname === "/auth/google/start") {
      if (!hasGoogleAuthConfig(env)) return authConfigErrorResponse(isApi);

      const state = crypto.randomUUID();
      const next = url.searchParams.get("next") || "/";
      const redirectUri = env.GOOGLE_REDIRECT_URI || `${url.origin}/auth/google/callback`;

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("access_type", "online");
      authUrl.searchParams.set("prompt", "select_account");

      return redirectWithCookies(authUrl.toString(), [
        makeCookie("oauth_state", state, { maxAge: 600, secure: secureCookie }),
        makeCookie("oauth_next", next, { maxAge: 600, secure: secureCookie })
      ]);
    }

    if (url.pathname === "/auth/google/callback") {
      if (!hasGoogleAuthConfig(env)) return authConfigErrorResponse(isApi);

      const cookies = parseCookies(request);
      const state = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      if (!state || !code || cookies.oauth_state !== state) {
        return new Response("Invalid OAuth state.", { status: 400 });
      }

      const redirectUri = env.GOOGLE_REDIRECT_URI || `${url.origin}/auth/google/callback`;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code"
        })
      });

      if (!tokenRes.ok) {
        return new Response("Google token exchange failed.", { status: 401 });
      }
      const tokenData = await tokenRes.json();
      const accessToken = tokenData?.access_token;
      if (!accessToken) {
        return new Response("Google access token missing.", { status: 401 });
      }

      const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` }
      });
      if (!userRes.ok) {
        return new Response("Google user profile fetch failed.", { status: 401 });
      }
      const profile = await userRes.json();
      const email = String(profile?.email || "").trim().toLowerCase();
      const verified = Boolean(profile?.email_verified);
      if (!email || !verified || !isEmailAllowed(email, env)) {
        return new Response("Access denied for this Google account.", { status: 403 });
      }

      const sessionTtlHours = Number(env.SESSION_TTL_HOURS || 12);
      const sessionMaxAge = Math.max(1, Math.floor(sessionTtlHours * 3600));
      const sessionPayload = {
        email,
        name: profile?.name || email,
        exp: Date.now() + sessionMaxAge * 1000
      };
      const sessionToken = await createSessionToken(env, sessionPayload);
      const next = cookies.oauth_next || "/";

      return redirectWithCookies(next, [
        makeCookie("session", sessionToken, { maxAge: sessionMaxAge, secure: secureCookie }),
        makeCookie("oauth_state", "", { maxAge: 0, secure: secureCookie }),
        makeCookie("oauth_next", "", { maxAge: 0, secure: secureCookie })
      ]);
    }

    if (url.pathname === "/auth/logout") {
      return redirectWithCookies("/", [makeCookie("session", "", { maxAge: 0, secure: secureCookie })]);
    }

    if (!hasGoogleAuthConfig(env)) {
      if (!isApi) {
        return Response.redirect(`${url.origin}/results.html`, 302);
      }
      return authConfigErrorResponse(isApi);
    }

    const sessionToken = parseCookies(request).session || "";
    const session = await verifySessionToken(env, sessionToken);
    if (!session) {
      if (isApi) {
        return json({ error: "Unauthorized" }, 401);
      }
      return Response.redirect(
        `${url.origin}/auth/google/start?next=${encodeURIComponent(url.pathname + url.search)}`,
        302
      );
    }

    if (!isApi) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const headers = new Headers(assetResponse.headers);
        headers.set("cache-control", "no-store");
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers
        });
      }
      return assetResponse;
    }

    await ensureRuntimeSchema(env);

    if (request.method === "GET" && url.pathname === "/api/state") {
      const state = await loadState(env);
      return json({ ...calculateLeaderboards(state), updatedAt: state.updatedAt });
    }

    if (request.method === "POST" && url.pathname === "/api/sailors") {
      const body = await parseJson(request);
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return badRequest("Sailor name is required.");

      let yearOfBirth = null;
      try {
        yearOfBirth = normalizeYearOfBirth(body?.yearOfBirth);
      } catch (error) {
        return badRequest(error.message);
      }

      const sailor = {
        id: createId("sailor"),
        name,
        yearOfBirth,
        sailNumber: "",
        club: (body.club || "").trim()
      };

      await env.DB
        .prepare("INSERT INTO sailors (id, name, year_of_birth, sail_number, club) VALUES (?, ?, ?, ?, ?)")
        .bind(sailor.id, sailor.name, sailor.yearOfBirth, sailor.sailNumber, sailor.club)
        .run();

      const updatedAt = await touchUpdatedAt(env);
      return json({ sailor, updatedAt }, 201);
    }

    if (request.method === "POST" && url.pathname === "/api/sailors/merge") {
      const body = await parseJson(request);
      const sourceSailorId = typeof body?.sourceSailorId === "string" ? body.sourceSailorId.trim() : "";
      const targetSailorId = typeof body?.targetSailorId === "string" ? body.targetSailorId.trim() : "";

      if (!sourceSailorId || !targetSailorId) {
        return badRequest("Both sourceSailorId and targetSailorId are required.");
      }
      if (sourceSailorId === targetSailorId) {
        return badRequest("Source and target sailors must be different.");
      }

      const [sourceSailor, targetSailor] = await Promise.all([
        env.DB.prepare("SELECT id, name FROM sailors WHERE id = ?").bind(sourceSailorId).first(),
        env.DB.prepare("SELECT id, name FROM sailors WHERE id = ?").bind(targetSailorId).first()
      ]);

      if (!sourceSailor) return badRequest("Source sailor not found.");
      if (!targetSailor) return badRequest("Target sailor not found.");

      const overlap = await env.DB
        .prepare(
          "SELECT r1.race_id AS raceId FROM results r1 INNER JOIN results r2 ON r1.race_id = r2.race_id WHERE r1.sailor_id = ? AND r2.sailor_id = ? LIMIT 1"
        )
        .bind(sourceSailorId, targetSailorId)
        .first();
      if (overlap?.raceId) {
        return badRequest(
          "Cannot merge sailors: they have overlapping scores in at least one race."
        );
      }

      const conflictingSailNumber = await env.DB
        .prepare(
          "SELECT s.regatta_id AS regattaId, s.sail_number AS sourceSailNumber, t.sail_number AS targetSailNumber FROM sailor_regatta_numbers s INNER JOIN sailor_regatta_numbers t ON t.regatta_id = s.regatta_id WHERE s.sailor_id = ? AND t.sailor_id = ? AND TRIM(COALESCE(s.sail_number, '')) <> '' AND TRIM(COALESCE(t.sail_number, '')) <> '' AND TRIM(s.sail_number) <> TRIM(t.sail_number) LIMIT 1"
        )
        .bind(sourceSailorId, targetSailorId)
        .first();
      if (conflictingSailNumber?.regattaId) {
        return badRequest(
          "Cannot merge sailors: both sailors have different sail numbers in the same regatta."
        );
      }

      await env.DB.batch([
        env.DB
          .prepare("UPDATE results SET sailor_id = ? WHERE sailor_id = ?")
          .bind(targetSailorId, sourceSailorId),
        env.DB
          .prepare(
            "INSERT OR IGNORE INTO regatta_participants (regatta_id, sailor_id) SELECT regatta_id, ? FROM regatta_participants WHERE sailor_id = ?"
          )
          .bind(targetSailorId, sourceSailorId),
        env.DB
          .prepare("DELETE FROM regatta_participants WHERE sailor_id = ?")
          .bind(sourceSailorId),
        env.DB
          .prepare(
            "INSERT INTO sailor_regatta_numbers (sailor_id, regatta_id, sail_number) SELECT ?, regatta_id, sail_number FROM sailor_regatta_numbers WHERE sailor_id = ? ON CONFLICT(sailor_id, regatta_id) DO UPDATE SET sail_number = CASE WHEN TRIM(COALESCE(sailor_regatta_numbers.sail_number, '')) = '' THEN excluded.sail_number ELSE sailor_regatta_numbers.sail_number END"
          )
          .bind(targetSailorId, sourceSailorId),
        env.DB
          .prepare("DELETE FROM sailor_regatta_numbers WHERE sailor_id = ?")
          .bind(sourceSailorId),
        env.DB.prepare("DELETE FROM sailors WHERE id = ?").bind(sourceSailorId)
      ]);

      const updatedAt = await touchUpdatedAt(env);
      return json(
        {
          ok: true,
          mergedFrom: { id: sourceSailor.id, name: sourceSailor.name },
          mergedInto: { id: targetSailor.id, name: targetSailor.name },
          updatedAt
        },
        200
      );
    }

    if (request.method === "PUT" && url.pathname.startsWith("/api/sailors/")) {
      const id = url.pathname.split("/").pop();
      const existing = await env.DB
        .prepare("SELECT id, name, year_of_birth AS yearOfBirth, club FROM sailors WHERE id = ?")
        .bind(id)
        .first();

      if (!existing) return badRequest("Sailor not found.");

      const body = await parseJson(request);
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return badRequest("Sailor name is required.");
      const hasYearOfBirth = Object.prototype.hasOwnProperty.call(body || {}, "yearOfBirth");

      let yearOfBirth = existing.yearOfBirth ?? null;
      if (hasYearOfBirth) {
        try {
          yearOfBirth = normalizeYearOfBirth(body?.yearOfBirth);
        } catch (error) {
          return badRequest(error.message);
        }
      }

      await env.DB
        .prepare("UPDATE sailors SET name = ?, year_of_birth = ? WHERE id = ?")
        .bind(name, yearOfBirth, id)
        .run();

      const updatedAt = await touchUpdatedAt(env);
      return json(
        {
          sailor: {
            id,
            name,
            yearOfBirth,
            sailNumber: "",
            club: existing.club || ""
          },
          updatedAt
        },
        200
      );
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/sailors/")) {
      const id = url.pathname.split("/").pop();
      const existing = await env.DB
        .prepare("SELECT id FROM sailors WHERE id = ?")
        .bind(id)
        .first();

      if (!existing) return badRequest("Sailor not found.");

      const resultCountRow = await env.DB
        .prepare("SELECT COUNT(*) AS count FROM results WHERE sailor_id = ?")
        .bind(id)
        .first();
      const resultCount = Number(resultCountRow?.count || 0);
      if (resultCount > 0) {
        return badRequest(
          "Cannot delete sailor: this sailor already has regatta scores. Remove scores first."
        );
      }

      await env.DB.batch([
        env.DB.prepare("DELETE FROM regatta_participants WHERE sailor_id = ?").bind(id),
        env.DB.prepare("DELETE FROM sailor_regatta_numbers WHERE sailor_id = ?").bind(id),
        env.DB.prepare("DELETE FROM sailors WHERE id = ?").bind(id)
      ]);

      const updatedAt = await touchUpdatedAt(env);
      return json({ ok: true, updatedAt });
    }

    if (
      request.method === "PUT" &&
      url.pathname.startsWith("/api/regattas/") &&
      url.pathname.endsWith("/participants")
    ) {
      const parts = url.pathname.split("/");
      const regattaId = parts[3];
      if (!regattaId) return badRequest("Regatta id is required.");

      const regatta = await env.DB
        .prepare("SELECT id FROM regattas WHERE id = ?")
        .bind(regattaId)
        .first();
      if (!regatta) return badRequest("Regatta not found.");

      const body = await parseJson(request);
      const participantIds = Array.isArray(body?.participantIds) ? body.participantIds : [];

      const sailorsRows = await env.DB.prepare("SELECT id FROM sailors").all();
      const sailorIds = (sailorsRows.results || []).map((row) => row.id);
      const savedParticipantIds = await setRegattaParticipants(
        env,
        regattaId,
        participantIds,
        sailorIds
      );

      const updatedAt = await touchUpdatedAt(env);
      return json({ regattaId, participantIds: savedParticipantIds, updatedAt }, 200);
    }

    if (
      request.method === "PUT" &&
      url.pathname.startsWith("/api/regattas/") &&
      !url.pathname.endsWith("/participants")
    ) {
      const parts = url.pathname.split("/");
      const regattaId = parts[3];
      if (!regattaId) return badRequest("Regatta id is required.");

      const regatta = await env.DB
        .prepare("SELECT id FROM regattas WHERE id = ?")
        .bind(regattaId)
        .first();
      if (!regatta) return badRequest("Regatta not found.");

      const body = await parseJson(request);
      if (!body || !Object.prototype.hasOwnProperty.call(body, "discardsEnabled")) {
        return badRequest("discardsEnabled is required.");
      }
      const discardsEnabled = body.discardsEnabled !== false ? 1 : 0;

      await env.DB
        .prepare("UPDATE regattas SET discards_enabled = ? WHERE id = ?")
        .bind(discardsEnabled, regattaId)
        .run();

      const updatedAt = await touchUpdatedAt(env);
      return json({ regattaId, discardsEnabled: discardsEnabled === 1, updatedAt }, 200);
    }

    if (request.method === "POST" && url.pathname === "/api/races") {
      const body = await parseJson(request);
      const regattaName = typeof body?.regattaName === "string" ? body.regattaName.trim() : "";
      const raceDate = body?.date || new Date().toISOString().slice(0, 10);
      const sailNumbers = Array.isArray(body?.sailNumbers) ? body.sailNumbers : [];
      const requestedParticipants = Array.isArray(body?.participantIds) ? body.participantIds : [];
      const discardsEnabled = body?.discardsEnabled !== false;

      if (!regattaName) return badRequest("Regatta name is required.");

      const sailorsRows = await env.DB.prepare("SELECT id FROM sailors").all();
      const sailorIds = (sailorsRows.results || []).map((row) => row.id);
      if (sailorIds.length === 0) {
        return badRequest("Add sailors before submitting race results.");
      }

      const regattaId = await getOrCreateRegatta(env, regattaName, raceDate, discardsEnabled);
      let participantIds = requestedParticipants.filter((id) => sailorIds.includes(id));
      if (participantIds.length === 0) {
        participantIds = await loadRegattaParticipantIds(env, regattaId);
      }
      if (participantIds.length === 0) {
        participantIds = [...sailorIds];
      }

      let normalized;
      try {
        normalized = normalizeResults(Array.isArray(body.results) ? body.results : [], participantIds);
      } catch (error) {
        return badRequest(error.message);
      }
      const raceCountRow = await env.DB
        .prepare("SELECT COUNT(*) AS count FROM races WHERE regatta_id = ?")
        .bind(regattaId)
        .first();
      const raceName = `R${Number(raceCountRow?.count || 0) + 1}`;
      const race = {
        id: createId("race"),
        name: raceName,
        date: raceDate,
        regattaId,
        regattaName,
        results: normalized
      };

      const statements = [
        env.DB
          .prepare("INSERT INTO races (id, name, race_date, regatta_id) VALUES (?, ?, ?, ?)")
          .bind(race.id, raceName, race.date, regattaId)
      ];

      for (const result of normalized) {
        statements.push(
          env.DB
            .prepare(
              "INSERT INTO results (race_id, sailor_id, status, position) VALUES (?, ?, ?, ?)"
            )
            .bind(race.id, result.sailorId, result.status, result.position ?? null)
        );
      }

      await env.DB.batch(statements);
      await setRegattaParticipants(env, regattaId, participantIds, sailorIds);
      await upsertRegattaSailNumbers(env, regattaId, sailNumbers, sailorIds);
      await refreshRegattaRange(env, regattaId);

      const updatedAt = await touchUpdatedAt(env);
      return json({ race, updatedAt }, 201);
    }

    if (request.method === "PUT" && url.pathname.startsWith("/api/races/")) {
      const id = url.pathname.split("/").pop();
      const existingRace = await env.DB
        .prepare("SELECT id, name, regatta_id AS regattaId FROM races WHERE id = ?")
        .bind(id)
        .first();
      if (!existingRace) return badRequest("Race not found.");

      const body = await parseJson(request);
      const regattaName = typeof body?.regattaName === "string" ? body.regattaName.trim() : "";
      const raceDate = body?.date || new Date().toISOString().slice(0, 10);
      const sailNumbers = Array.isArray(body?.sailNumbers) ? body.sailNumbers : [];
      const requestedParticipants = Array.isArray(body?.participantIds) ? body.participantIds : [];
      const discardsEnabled = body?.discardsEnabled !== false;

      if (!regattaName) return badRequest("Regatta name is required.");

      const sailorsRows = await env.DB.prepare("SELECT id FROM sailors").all();
      const sailorIds = (sailorsRows.results || []).map((row) => row.id);
      if (sailorIds.length === 0) {
        return badRequest("Add sailors before submitting race results.");
      }

      const newRegattaId = await getOrCreateRegatta(env, regattaName, raceDate, discardsEnabled);
      let participantIds = requestedParticipants.filter((id) => sailorIds.includes(id));
      if (participantIds.length === 0) {
        participantIds = await loadRegattaParticipantIds(env, newRegattaId);
      }
      if (participantIds.length === 0) {
        participantIds = [...sailorIds];
      }

      let normalized;
      try {
        normalized = normalizeResults(Array.isArray(body.results) ? body.results : [], participantIds);
      } catch (error) {
        return badRequest(error.message);
      }

      let raceName = existingRace.name;
      if (existingRace.regattaId !== newRegattaId) {
        const raceCountRow = await env.DB
          .prepare("SELECT COUNT(*) AS count FROM races WHERE regatta_id = ?")
          .bind(newRegattaId)
          .first();
        raceName = `R${Number(raceCountRow?.count || 0) + 1}`;
      }

      const statements = [
        env.DB
          .prepare("UPDATE races SET name = ?, race_date = ?, regatta_id = ? WHERE id = ?")
          .bind(raceName, raceDate, newRegattaId, id),
        env.DB.prepare("DELETE FROM results WHERE race_id = ?").bind(id)
      ];

      for (const result of normalized) {
        statements.push(
          env.DB
            .prepare(
              "INSERT INTO results (race_id, sailor_id, status, position) VALUES (?, ?, ?, ?)"
            )
            .bind(id, result.sailorId, result.status, result.position ?? null)
        );
      }

      await env.DB.batch(statements);
      await setRegattaParticipants(env, newRegattaId, participantIds, sailorIds);
      await upsertRegattaSailNumbers(env, newRegattaId, sailNumbers, sailorIds);

      await refreshRegattaRange(env, existingRace.regattaId);
      if (existingRace.regattaId !== newRegattaId) {
        await refreshRegattaRange(env, newRegattaId);
      }

      const updatedAt = await touchUpdatedAt(env);
      return json(
        {
          race: {
            id,
            name: raceName,
            date: raceDate,
            regattaId: newRegattaId,
            regattaName,
            results: normalized
          },
          updatedAt
        },
        200
      );
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/races/")) {
      const id = url.pathname.split("/").pop();
      const existing = await env.DB
        .prepare("SELECT id, regatta_id AS regattaId FROM races WHERE id = ?")
        .bind(id)
        .first();

      if (!existing) return badRequest("Race not found.");

      await env.DB.batch([
        env.DB.prepare("DELETE FROM results WHERE race_id = ?").bind(id),
        env.DB.prepare("DELETE FROM races WHERE id = ?").bind(id)
      ]);
      await refreshRegattaRange(env, existing.regattaId);

      const updatedAt = await touchUpdatedAt(env);
      return json({ ok: true, updatedAt });
    }

    if (request.method === "POST" && url.pathname === "/api/reset") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM regatta_participants"),
        env.DB.prepare("DELETE FROM sailor_regatta_numbers"),
        env.DB.prepare("DELETE FROM results"),
        env.DB.prepare("DELETE FROM races"),
        env.DB.prepare("DELETE FROM regattas"),
        env.DB.prepare("DELETE FROM sailors")
      ]);

      const updatedAt = await touchUpdatedAt(env);
      return json({ ok: true, updatedAt });
    }

    return json({ error: "Not found" }, 404);
  }
};
