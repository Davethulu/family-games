// Copies upcoming events from a published iCloud calendar into the Family Board's database.
// This repo's job logs are public, so this only ever logs counts: never titles, links or the family code.
var HORIZON_DAYS = 120;
var MAX_EVENTS = 100;
var WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
var DAY_MS = 86400000;

function pad(n) { return (n < 10 ? '0' : '') + n; }
function dateKey(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function timeKey(ms) { var d = new Date(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }

/* ---------- Time zones: "wall" means clock time stored in a UTC number, so day arithmetic ignores daylight saving ---------- */
function wallInZone(instant, zone) {
  var parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(instant)).forEach(function (p) { parts[p.type] = +p.value; });
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
function instantFromWall(wall, zone) {
  var guess = wall - (wallInZone(wall, zone) - wall);
  return wall - (wallInZone(guess, zone) - guess);
}
function validZone(zone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (e) { return false; }
}

/* ---------- Reading the calendar file ---------- */
function unescapeText(s) {
  return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}
function parseProp(line) {
  var quoted = false, cut = -1;
  for (var i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) { cut = i; break; }
  }
  if (cut < 0) return null;
  var head = line.slice(0, cut).split(';'), params = {};
  head.slice(1).forEach(function (p) {
    var eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  });
  return { name: head[0].toUpperCase(), params: params, value: line.slice(cut + 1) };
}
function parseStamp(value, params) {
  var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value.trim());
  if (!m) return null;
  var allDay = !m[4];
  return {
    allDay: allDay,
    wall: Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)),
    zone: m[7] ? 'UTC' : (params.TZID && validZone(params.TZID) ? params.TZID : '')
  };
}
function readEvents(text) {
  var lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/), events = [], current = null, depth = 0;
  lines.forEach(function (line) {
    if (/^BEGIN:VEVENT/i.test(line)) { current = { exdates: [] }; depth = 0; return; }
    if (!current) return;
    if (/^END:VEVENT/i.test(line)) { events.push(current); current = null; return; }
    if (/^BEGIN:/i.test(line)) { depth++; return; }
    if (/^END:/i.test(line)) { depth--; return; }
    if (depth > 0) return; // alarms inside an event
    var p = parseProp(line);
    if (!p) return;
    if (p.name === 'SUMMARY') current.title = unescapeText(p.value);
    else if (p.name === 'UID') current.uid = p.value;
    else if (p.name === 'STATUS') current.status = p.value.toUpperCase();
    else if (p.name === 'RRULE') current.rrule = p.value;
    else if (p.name === 'DURATION') current.duration = p.value;
    else if (p.name === 'DTSTART') current.start = parseStamp(p.value, p.params);
    else if (p.name === 'DTEND') current.end = parseStamp(p.value, p.params);
    else if (p.name === 'RECURRENCE-ID') current.recurrenceId = parseStamp(p.value, p.params);
    else if (p.name === 'EXDATE') p.value.split(',').forEach(function (v) { var s = parseStamp(v, p.params); if (s) current.exdates.push(s); });
  });
  return events;
}
function durationMs(value) {
  var m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value || '');
  if (!m) return 0;
  return (+(m[2] || 0) * 7 + +(m[3] || 0)) * DAY_MS + +(m[4] || 0) * 3600000 + +(m[5] || 0) * 60000 + +(m[6] || 0) * 1000;
}

/* ---------- Repeating events ---------- */
function parseRule(text) {
  var rule = {};
  text.split(';').forEach(function (part) { var kv = part.split('='); rule[kv[0].toUpperCase()] = kv[1]; });
  return rule;
}
function nums(value) { return value ? value.split(',').map(Number) : null; }
function byDays(value) {
  return value ? value.split(',').map(function (s) {
    var m = /^([+-]?\d+)?([A-Z]{2})$/.exec(s);
    return { nth: m[1] ? +m[1] : 0, day: WEEKDAYS.indexOf(m[2]) };
  }) : null;
}
function monthCandidates(year, month, start, rule) {
  var last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(), days = [], d;
  var byDay = byDays(rule.BYDAY), byMonthDay = nums(rule.BYMONTHDAY);
  if (byMonthDay) byMonthDay.forEach(function (n) { var x = n < 0 ? last + 1 + n : n; if (x >= 1 && x <= last) days.push(x); });
  else if (byDay) {
    byDay.forEach(function (b) {
      var hits = [];
      for (d = 1; d <= last; d++) if (new Date(Date.UTC(year, month, d)).getUTCDay() === b.day) hits.push(d);
      if (!b.nth) days = days.concat(hits);
      else { var x = hits[b.nth > 0 ? b.nth - 1 : hits.length + b.nth]; if (x) days.push(x); }
    });
  } else if (new Date(start).getUTCDate() <= last) days.push(new Date(start).getUTCDate());
  var time = start % DAY_MS;
  return days.map(function (x) { return Date.UTC(year, month, x) + time; });
}
function periodCandidates(rule, start, period) {
  var s = new Date(start), step = +(rule.INTERVAL || 1) * period;
  if (rule.FREQ === 'DAILY') return [start + step * DAY_MS];
  if (rule.FREQ === 'WEEKLY') {
    var weekStart = WEEKDAYS.indexOf(rule.WKST || 'MO');
    var firstDay = start - ((s.getUTCDay() - weekStart + 7) % 7) * DAY_MS + step * 7 * DAY_MS;
    var wanted = byDays(rule.BYDAY);
    if (!wanted) return [start + step * 7 * DAY_MS];
    return wanted.map(function (b) { return firstDay + ((b.day - weekStart + 7) % 7) * DAY_MS; });
  }
  if (rule.FREQ === 'MONTHLY') {
    var total = s.getUTCFullYear() * 12 + s.getUTCMonth() + step;
    return monthCandidates(Math.floor(total / 12), total % 12, start, rule);
  }
  if (rule.FREQ === 'YEARLY') {
    var year = s.getUTCFullYear() + step, out = [];
    (nums(rule.BYMONTH) || [s.getUTCMonth() + 1]).forEach(function (m) { out = out.concat(monthCandidates(year, m - 1, start, rule)); });
    return out;
  }
  return null;
}
function expandRule(start, ruleText, horizon) {
  var rule = parseRule(ruleText), out = [], count = rule.COUNT ? +rule.COUNT : Infinity;
  var until = rule.UNTIL ? parseStamp(rule.UNTIL, {}) : null;
  var limit = until ? Math.min(until.wall, horizon) : horizon;
  var byMonth = nums(rule.BYMONTH), byDay = rule.FREQ === 'DAILY' ? byDays(rule.BYDAY) : null;
  var setPos = nums(rule.BYSETPOS), seen = 0;
  for (var period = 0; period < 20000; period++) {
    var list = periodCandidates(rule, start, period);
    if (!list) return [start]; // a repeat type we don't know: show the first one
    list = list.filter(function (w, i, all) { return all.indexOf(w) === i; }).sort(function (a, b) { return a - b; });
    if (byMonth) list = list.filter(function (w) { return byMonth.indexOf(new Date(w).getUTCMonth() + 1) >= 0; });
    if (byDay) list = list.filter(function (w) { return byDay.some(function (b) { return b.day === new Date(w).getUTCDay(); }); });
    if (setPos) {
      var all = list;
      list = setPos.map(function (n) { return all[n > 0 ? n - 1 : all.length + n]; }).filter(function (w) { return w !== undefined; });
    }
    for (var i = 0; i < list.length; i++) {
      if (list[i] < start) continue;
      if (list[i] > limit || seen >= count) return out;
      out.push(list[i]);
      seen++;
    }
    var earliest = list.length ? list[0] : start + step(rule) * period;
    if (earliest > limit) return out;
  }
  return out;
}
function step(rule) {
  var unit = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 }[rule.FREQ] || 1;
  return +(rule.INTERVAL || 1) * unit * DAY_MS;
}

/* ---------- Turning events into what the board shows ---------- */
function buildBoardEvents(text, now, homeZone) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That address did not return a calendar');
  function toHome(wall, stamp) {
    if (stamp.allDay || !stamp.zone || stamp.zone === homeZone) return wall;
    return wallInZone(instantFromWall(wall, stamp.zone), homeZone);
  }
  function stampKey(stamp) { return stamp.allDay ? dateKey(stamp.wall) : dateKey(toHome(stamp.wall, stamp)) + 'T' + timeKey(toHome(stamp.wall, stamp)); }

  var todayWall = wallInZone(now, homeZone), today = dateKey(todayWall);
  var horizon = Date.parse(today + 'T00:00:00Z') + HORIZON_DAYS * DAY_MS;
  var all = readEvents(text).filter(function (e) { return e.start; });

  var replaced = {};
  all.forEach(function (e) { if (e.recurrenceId) replaced[e.uid + '|' + stampKey(e.recurrenceId)] = true; });

  var out = [];
  all.forEach(function (e) {
    if (e.status === 'CANCELLED') return;
    var s = e.start;
    var length = e.end ? e.end.wall - s.wall : (e.duration ? durationMs(e.duration) : 0);
    var starts = e.rrule && !e.recurrenceId ? expandRule(s.wall, e.rrule, horizon + DAY_MS) : [s.wall];
    var skip = {};
    e.exdates.forEach(function (x) { skip[stampKey(x)] = true; });
    starts.forEach(function (wall) {
      var key = stampKey({ allDay: s.allDay, wall: wall, zone: s.zone });
      if (skip[key] || (!e.recurrenceId && replaced[e.uid + '|' + key])) return;
      var startHome = toHome(wall, s);
      var date = dateKey(startHome);
      // An all-day event's end date is the day after it finishes.
      var endWall = length > 0 ? toHome(wall + length, s) - (s.allDay ? DAY_MS : 60000) : startHome;
      var end = dateKey(endWall);
      if (end < today || Date.parse(date + 'T00:00:00Z') > horizon) return;
      var title = (e.title || 'Busy').slice(0, 80), item = { title: title, date: date, time: s.allDay ? '' : timeKey(startHome), noSchool: /no\s*school/i.test(title) };
      if (end > date) item.end = end;
      out.push(item);
    });
  });
  out.sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });
  return out.slice(0, MAX_EVENTS);
}

async function main() {
  var feed = (process.env.ICAL_URL || '').trim().replace(/^webcal:/i, 'https:');
  var code = (process.env.BOARD_CODE || '').trim();
  var db = (process.env.BOARD_DB || '').replace(/\/+$/, '');
  var zone = process.env.BOARD_TZ || 'America/Chicago';
  if (!feed || !code) { console.log('Not set up yet: add the ICAL_URL and BOARD_CODE secrets'); return; }
  if (!db) throw new Error('Missing BOARD_DB');

  var res = await fetch(feed, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('Calendar responded with status ' + res.status);
  var list = buildBoardEvents(await res.text(), Date.now(), zone);

  var events = {};
  list.forEach(function (e, i) { events['e' + i] = e; });
  var save = await fetch(db + '/boards/' + encodeURIComponent(code) + '/icloud.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ at: Date.now(), events: events }),
    signal: AbortSignal.timeout(30000)
  });
  if (!save.ok) throw new Error('Database responded with status ' + save.status);
  console.log('Synced ' + list.length + ' events');
}

module.exports = { buildBoardEvents: buildBoardEvents };
if (require.main === module) {
  main().catch(function (err) {
    // A failed run leaves the last good copy on the board, and GitHub emails about the failed job.
    console.error('Sync failed: ' + err.message);
    process.exit(1);
  });
}
