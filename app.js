/* ============================================================
   De Agony of De Feet — Track Session Pace Planner
   ============================================================ */

(function () {
  "use strict";

  var STORAGE_KEY = "dadf-planner-v1";

  /* Group-paces tiers: seconds/km offset from whatever pace the coach typed in,
     so the same screenshot works for a spread of runners in the squad. */
  var PACE_TIERS = [-30, -15, 0, 15, 30, 45];

  /* ---------------- time / pace helpers ---------------- */

  function parseTime(str) {
    if (str == null) return null;
    str = String(str).trim();
    if (str === "") return null;
    var parts = str.split(":");
    if (parts.length > 3) return null;
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d+(\.\d+)?$/.test(parts[i])) return null;
    }
    var sec = 0;
    if (parts.length === 1) sec = parseFloat(parts[0]);
    else if (parts.length === 2) sec = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    else sec = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    if (!isFinite(sec) || sec < 0) return null;
    return sec;
  }

  function formatDuration(totalSeconds, forceHours) {
    if (totalSeconds == null || !isFinite(totalSeconds)) return "—";
    totalSeconds = Math.max(0, Math.round(totalSeconds));
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    if (h > 0 || forceHours) {
      return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    }
    return m + ":" + String(s).padStart(2, "0");
  }

  function trimZeros(s) {
    return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  function formatDistance(m) {
    if (m == null || !isFinite(m)) return "—";
    if (m < 1000) return Math.round(m) + " m";
    return trimZeros((m / 1000).toFixed(2)) + " km";
  }

  /* ---------------- VDOT training-pace helpers (Daniels & Gilbert) ---------------- */

  function vo2FromVelocity(v) {
    // v in metres/minute
    return -4.6 + 0.182258 * v + 0.000104 * v * v;
  }

  function velocityFromVO2(vo2) {
    // invert 0.000104 v^2 + 0.182258 v - (4.6 + vo2) = 0
    var a = 0.000104, b = 0.182258, c = -(4.6 + vo2);
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  }

  function percentVO2maxFromDuration(tMin) {
    return 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
  }

  function vdotFromPerformance(distanceM, timeSec) {
    var tMin = timeSec / 60;
    var v = distanceM / tMin;
    return vo2FromVelocity(v) / percentVO2maxFromDuration(tMin);
  }

  function paceFromVdotAndPercent(vdot, pct) {
    var v = velocityFromVO2(vdot * pct);
    return 60000 / v; // sec/km
  }

  /* Midpoints of Daniels' published %VO2max ranges for each training zone. */
  var VDOT_ZONES = [
    { key: "easy", pct: 0.665 },
    { key: "marathon", pct: 0.795 },
    { key: "threshold", pct: 0.855 },
    { key: "interval", pct: 0.975 },
    { key: "repetition", pct: 1.10 },
  ];

  /* ---------------- Garmin Connect step-builder helpers ---------------- */

  var GARMIN_PACE_TOLERANCE = 5; // seconds/km either side of target — a workable range to type into Garmin

  function garminPaceRange(secPerKm) {
    if (secPerKm == null || !isFinite(secPerKm) || secPerKm <= 0) return null;
    var slow = secPerKm + GARMIN_PACE_TOLERANCE;
    var fast = Math.max(10, secPerKm - GARMIN_PACE_TOLERANCE);
    return formatDuration(slow) + "–" + formatDuration(fast) + " /km";
  }

  function garminDetail(durationLabel, durationValue, paceRange) {
    var s = durationLabel + " " + durationValue;
    s += paceRange ? " · Target Pace " + paceRange : " · Open (no target)";
    return s;
  }

  function renderGarminSteps(el, blocks) {
    if (!el) return;
    var html = "";
    blocks.forEach(function (b) {
      if (b.repeat) {
        html += '<li><span class="g-label">Repeat ' + b.repeat + "×</span>" + '<ol class="g-repeat-group">';
        b.steps.forEach(function (s) {
          html += '<li><span class="g-label">' + s.label + '</span><span class="g-val">' + s.detail + "</span></li>";
        });
        html += "</ol></li>";
      } else {
        html += '<li><span class="g-label">' + b.label + '</span><span class="g-val">' + b.detail + "</span></li>";
      }
    });
    el.innerHTML = html;
  }

  var STRIP_SHADE_TIERS = 4;

  /* Renders the hard/recovery effort strip used across the session tools.
     segments: [{cls:'hard'|'float', dur, paceKm?}] in order — widths are
     proportional to duration. When 'hard' segments carry different paceKm
     values (a gear-shift rep, a ladder with per-rung paces), each gets one
     of a few shades graded by how fast it is relative to the others in this
     same strip — the segment closest to the fastest pace present here reads
     as the deepest gold. groups (optional): [{label, dur}] for a label row
     beneath, e.g. one label per rung/phase spanning its segments' width. */
  function renderStrip(stripEl, groupsEl, segments, groups) {
    if (!stripEl) return;
    var hardPaces = segments
      .filter(function (s) { return s.cls === "hard" && s.paceKm != null; })
      .map(function (s) { return s.paceKm; });
    var minPace = hardPaces.length ? Math.min.apply(null, hardPaces) : null;
    var maxPace = hardPaces.length ? Math.max.apply(null, hardPaces) : null;
    var hasSpread = minPace != null && maxPace != null && maxPace > minPace;

    var total = segments.reduce(function (a, s) { return a + s.dur; }, 0);
    stripEl.innerHTML = total > 0
      ? segments.map(function (s) {
          var shadeClass = "";
          if (s.cls === "hard" && hasSpread && s.paceKm != null) {
            var t = (maxPace - s.paceKm) / (maxPace - minPace); // 0 slowest .. 1 fastest
            shadeClass = " shade-" + Math.round(t * (STRIP_SHADE_TIERS - 1));
          }
          return '<div class="strip-seg ' + s.cls + shadeClass + '" style="width:' + (s.dur / total) * 100 + '%"></div>';
        }).join("")
      : "";
    if (!groupsEl) return;
    groupsEl.innerHTML = total > 0 && groups
      ? groups.map(function (g) {
          return '<div class="strip-phase-label" style="width:' + (g.dur / total) * 100 + '%">' + g.label + "</div>";
        }).join("")
      : "";
  }

  function setError(elId, msg) {
    var el = document.getElementById(elId);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.add("show");
    } else {
      el.textContent = "";
      el.classList.remove("show");
    }
  }

  function markValid(inputEl, isValid) {
    if (inputEl) inputEl.classList.toggle("invalid", !isValid);
  }

  /* A pace field wraps a text input holding a pace in seconds-per-kilometre. */
  function createPaceField(inputEl) {
    var secPerKm = parseTime(inputEl.value);
    return {
      sync: function (optional) {
        var raw = inputEl.value.trim();
        if (raw === "") {
          markValid(inputEl, true);
          secPerKm = null;
          return !!optional;
        }
        var t = parseTime(raw);
        if (t == null || t <= 0) {
          markValid(inputEl, false);
          return false;
        }
        markValid(inputEl, true);
        secPerKm = t;
        return true;
      },
      get secPerKm() {
        return secPerKm;
      },
    };
  }

  /* ---------------- state persistence ---------------- */

  var PERSIST_IDS = [
    "iv-distance", "iv-distance-custom", "iv-reps", "iv-sets", "iv-reppace",
    "iv-cycle", "iv-recoveryfixed", "iv-setrest", "iv-recoverypace", "iv-gears-data",
    "mf-hardpace-90", "mf-hardpace-60", "mf-hardpace-30", "mf-hardpace-15", "mf-floatpace", "mf-sets", "mf-setrest",
    "df-harddist", "df-floatdist", "df-harddur", "df-floatdur", "df-reps", "df-hardpace", "df-floatpace",
    "lad-distances", "lad-paces-data", "lad-recmode", "lad-ratio", "lad-fixed", "lad-cycles-data", "lad-repeats",
    "goal-5k", "goal-10k", "goal-half", "goal-full",
    "pc-distance", "pc-distance-custom", "pc-time", "pc-pace",
    "rp-distance", "rp-distance-custom", "rp-time",
    "sp-distance", "sp-distance-custom", "sp-time", "sp-splitdist", "sp-splitdist-custom",
  ];

  function restoreState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var state = JSON.parse(raw);
      PERSIST_IDS.forEach(function (id) {
        if (!(id in state)) return;
        var el = document.getElementById(id);
        if (!el) return;
        if (el.type === "checkbox") el.checked = state[id];
        else el.value = state[id];
      });
    } catch (e) {
      /* ignore corrupt/blocked storage */
    }
  }

  function saveState() {
    try {
      var state = {};
      PERSIST_IDS.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        state[id] = el.type === "checkbox" ? el.checked : el.value;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* ignore corrupt/blocked storage */
    }
  }

  restoreState();

  /* ---------------- mobile-friendly time entry ---------------- */
  /* iOS/Android numeric keypads (inputmode="numeric") have no colon key,
     so auto-insert colons as digits are typed. Delegated on document (capture
     phase, ahead of each field's own recalc listener) so it also covers rows
     added dynamically later, like gear segments and ladder rungs. */

  function isTimeField(el) {
    return el.tagName === "INPUT" && el.type === "text" && el.placeholder && el.placeholder.indexOf(":") !== -1;
  }

  function formatTimeDigits(raw) {
    var digits = raw.replace(/\D/g, "").slice(0, 6);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return digits.slice(0, -2) + ":" + digits.slice(-2);
    return digits.slice(0, -4) + ":" + digits.slice(-4, -2) + ":" + digits.slice(-2);
  }

  document.addEventListener(
    "input",
    function (e) {
      if (!isTimeField(e.target)) return;
      var formatted = formatTimeDigits(e.target.value);
      if (formatted !== e.target.value) e.target.value = formatted;
    },
    true
  );

  /* ---------------- tabs ---------------- */

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (t) {
        t.setAttribute("aria-selected", "false");
      });
      tab.setAttribute("aria-selected", "true");
      document.querySelectorAll(".panel").forEach(function (p) {
        p.hidden = true;
      });
      document.getElementById("panel-" + tab.dataset.tab).hidden = false;
    });
  });

  var categoryTabs = Array.prototype.slice.call(document.querySelectorAll(".category-tab"));
  categoryTabs.forEach(function (catTab) {
    catTab.addEventListener("click", function () {
      categoryTabs.forEach(function (c) {
        c.setAttribute("aria-selected", "false");
      });
      catTab.setAttribute("aria-selected", "true");
      var cat = catTab.dataset.category;
      document.querySelectorAll(".tabs[data-category-group]").forEach(function (nav) {
        nav.hidden = nav.dataset.categoryGroup !== cat;
      });
      var firstTab = document.querySelector('.tabs[data-category-group="' + cat + '"] .tab');
      if (firstTab) firstTab.click();
    });
  });

  /* ============================================================
     INTERVALS & RECOVERY
     ============================================================ */

  (function intervalsTool() {
    var distanceSel = document.getElementById("iv-distance");
    var distanceCustomWrap = document.getElementById("iv-distance-custom-wrap");
    var distanceCustom = document.getElementById("iv-distance-custom");
    var repsInput = document.getElementById("iv-reps");
    var setsInput = document.getElementById("iv-sets");
    var repPaceInput = document.getElementById("iv-reppace");
    var repPaceEquiv = document.getElementById("iv-reppace-equiv");

    var repModeBtns = Array.prototype.slice.call(document.querySelectorAll('#iv-form .mode-switch button[data-repmode]'));
    var singleWrap = document.getElementById("iv-single-wrap");
    var gearWrap = document.getElementById("iv-gear-wrap");
    var gearRowsContainer = document.getElementById("iv-gear-rows");
    var gearAddBtn = document.getElementById("iv-gear-add");
    var gearsDataInput = document.getElementById("iv-gears-data");
    var gearEquiv = document.getElementById("iv-gear-equiv");

    var recModeBtns = Array.prototype.slice.call(document.querySelectorAll('#iv-form .mode-switch button[data-recmode]'));
    var cycleWrap = document.getElementById("iv-cycle-wrap");
    var cycleInput = document.getElementById("iv-cycle");
    var recoveryFixedWrap = document.getElementById("iv-recoveryfixed-wrap");
    var recoveryFixedInput = document.getElementById("iv-recoveryfixed");
    var setRestInput = document.getElementById("iv-setrest");
    var recoveryPaceInput = document.getElementById("iv-recoverypace");

    var outRecovery = document.getElementById("iv-out-recovery");
    var outRecoveryDist = document.getElementById("iv-out-recovery-dist");
    var outTotalReps = document.getElementById("iv-out-totalreps");
    var outTotalDist = document.getElementById("iv-out-totaldist");
    var outTotalTime = document.getElementById("iv-out-totaltime");
    var gearBreakdownWrap = document.getElementById("iv-gear-breakdown-wrap");
    var gearBreakdownBody = document.querySelector("#iv-gear-breakdown-table tbody");
    var outTableBody = document.querySelector("#iv-out-table tbody");
    var groupSummary = document.getElementById("iv-group-summary");
    var groupTheadRow = document.getElementById("iv-group-thead-row");
    var groupTableBody = document.querySelector("#iv-group-table tbody");
    var garminStepsEl = document.getElementById("iv-garmin-steps");
    var stripEl = document.getElementById("iv-strip");

    var recoveryField = createPaceField(recoveryPaceInput);
    var repPaceField = createPaceField(repPaceInput);
    var recMode = "cycle";
    var repMode = "single";
    var gearRows = [];

    function makeGearRow(seedDist, seedPace) {
      var rowEl = document.createElement("div");
      rowEl.className = "gear-row";
      var tagEl = document.createElement("span");
      tagEl.className = "gear-tag";
      var distInput = document.createElement("input");
      distInput.type = "number";
      distInput.className = "gear-dist";
      distInput.min = "1";
      distInput.step = "1";
      distInput.inputMode = "numeric";
      distInput.placeholder = "m";
      distInput.value = seedDist;
      var fieldWrap = document.createElement("div");
      fieldWrap.className = "pace-field";
      var paceInput = document.createElement("input");
      paceInput.type = "text";
      paceInput.inputMode = "numeric";
      paceInput.placeholder = "m:ss";
      paceInput.value = seedPace;
      var unitLabel = document.createElement("span");
      unitLabel.className = "unit-label";
      unitLabel.textContent = "/ KM";
      fieldWrap.appendChild(paceInput);
      fieldWrap.appendChild(unitLabel);
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "gear-row-remove";
      removeBtn.setAttribute("aria-label", "Remove gear");
      removeBtn.textContent = "×";

      rowEl.appendChild(tagEl);
      rowEl.appendChild(distInput);
      rowEl.appendChild(fieldWrap);
      rowEl.appendChild(removeBtn);
      gearRowsContainer.appendChild(rowEl);

      var field = createPaceField(paceInput);
      var row = { rowEl: rowEl, tagEl: tagEl, distInput: distInput, paceInput: paceInput, field: field };

      distInput.addEventListener("input", function () { recalc(); saveState(); });
      paceInput.addEventListener("input", function () { recalc(); saveState(); });
      removeBtn.addEventListener("click", function () {
        if (gearRows.length <= 1) return;
        var idx = gearRows.indexOf(row);
        if (idx === -1) return;
        gearRows.splice(idx, 1);
        row.rowEl.remove();
        updateGearTags();
        recalc();
        saveState();
      });

      return row;
    }

    function updateGearTags() {
      gearRows.forEach(function (r, i) { r.tagEl.textContent = String(i + 1); });
    }

    function addGearRow(seedDist, seedPace) {
      var row = makeGearRow(seedDist || "400", seedPace || "3:45");
      gearRows.push(row);
      updateGearTags();
    }

    function serializeGears() {
      return gearRows.map(function (r) { return r.distInput.value + "|" + r.paceInput.value; }).join(",");
    }

    gearAddBtn.addEventListener("click", function () {
      addGearRow();
      recalc();
      saveState();
    });

    function updateRepModeUI() {
      singleWrap.hidden = repMode !== "single";
      gearWrap.hidden = repMode !== "gear";
      repModeBtns.forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.repmode === repMode ? "true" : "false");
      });
    }

    function updateRecModeUI() {
      cycleWrap.hidden = recMode !== "cycle";
      recoveryFixedWrap.hidden = recMode !== "fixed";
      recModeBtns.forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.recmode === recMode ? "true" : "false");
      });
    }

    function currentDistance() {
      if (distanceSel.value === "custom") {
        var v = parseFloat(distanceCustom.value);
        return v > 0 ? v : null;
      }
      return parseFloat(distanceSel.value);
    }

    function updateDistanceUI() {
      distanceCustomWrap.hidden = distanceSel.value !== "custom";
    }

    function recalc() {
      setError("iv-error", "");

      var distance, repTimeSec, paceKm;
      var gearsValid = true;
      var gearList = [];

      if (repMode === "single") {
        distance = currentDistance();
        markValid(distanceCustom, distanceSel.value !== "custom" || distance != null);
        var repPaceOk = repPaceField.sync(false);
        repTimeSec = repPaceOk && distance > 0 ? repPaceField.secPerKm * (distance / 1000) : null;
        paceKm = repPaceField.secPerKm;
        repPaceEquiv.textContent = repTimeSec != null && distance > 0 ? "= " + formatDuration(repTimeSec) + " for " + formatDistance(distance) : "";
        gearEquiv.textContent = "";
      } else {
        distance = 0;
        repTimeSec = 0;
        gearsDataInput.value = serializeGears();
        gearRows.forEach(function (r) {
          var d = parseFloat(r.distInput.value);
          markValid(r.distInput, d > 0);
          var ok = r.field.sync(false);
          if (!(d > 0) || !ok) {
            gearsValid = false;
          } else {
            distance += d;
            var t = r.field.secPerKm * (d / 1000);
            repTimeSec += t;
            gearList.push({ dist: d, paceKm: r.field.secPerKm, time: t });
          }
        });
        if (gearRows.length === 0) gearsValid = false;
        paceKm = distance > 0 ? repTimeSec / (distance / 1000) : null;
        repPaceEquiv.textContent = "";
        gearEquiv.textContent = gearsValid && distance > 0 ? "= " + formatDuration(repTimeSec) + " total for " + formatDistance(distance) : "";
      }

      var reps = parseInt(repsInput.value, 10);
      markValid(repsInput, reps >= 1);
      var sets = parseInt(setsInput.value, 10);
      markValid(setsInput, sets >= 1);

      var cycleSec = null, recoveryFixedSec = null;
      if (recMode === "cycle") {
        cycleSec = parseTime(cycleInput.value);
        markValid(cycleInput, cycleSec != null && cycleSec > 0);
      } else {
        recoveryFixedSec = parseTime(recoveryFixedInput.value);
        markValid(recoveryFixedInput, recoveryFixedSec != null && recoveryFixedSec >= 0);
      }

      var setRestSec = 0;
      if (sets > 1) {
        setRestSec = parseTime(setRestInput.value);
        markValid(setRestInput, setRestSec != null && setRestSec >= 0);
      } else {
        markValid(setRestInput, true);
      }

      var recoveryOk = recoveryField.sync(true);
      if (!recoveryOk) setError("iv-error", "Recovery jog pace isn't a valid time.");

      var repDataOk = repMode === "single" ? (distance > 0 && repTimeSec != null) : (gearsValid && distance > 0 && gearRows.length > 0);
      var recModeValueOk = recMode === "cycle" ? cycleSec != null : recoveryFixedSec != null;

      if (!repDataOk || !(reps >= 1) || !(sets >= 1) || !recModeValueOk || setRestSec == null) {
        outRecovery.textContent = "—";
        outRecoveryDist.textContent = "";
        outTotalReps.textContent = "—";
        outTotalDist.textContent = "—";
        outTotalTime.textContent = "—";
        gearBreakdownWrap.hidden = true;
        gearBreakdownBody.innerHTML = "";
        outTableBody.innerHTML = "";
        groupTableBody.innerHTML = "";
        groupSummary.textContent = "";
        garminStepsEl.innerHTML = "";
        stripEl.innerHTML = "";
        return;
      }

      if (recMode === "cycle" && cycleSec <= repTimeSec) {
        setError("iv-error", "Cycle time (" + formatDuration(cycleSec) + ") must be longer than the rep time (" + formatDuration(repTimeSec) + ").");
        outRecovery.textContent = "—";
        outRecoveryDist.textContent = "";
        outTotalReps.textContent = "—";
        outTotalDist.textContent = "—";
        outTotalTime.textContent = "—";
        gearBreakdownWrap.hidden = true;
        gearBreakdownBody.innerHTML = "";
        outTableBody.innerHTML = "";
        groupTableBody.innerHTML = "";
        groupSummary.textContent = "";
        garminStepsEl.innerHTML = "";
        stripEl.innerHTML = "";
        return;
      }

      var recoverySec = recMode === "cycle" ? cycleSec - repTimeSec : recoveryFixedSec;
      if (recMode === "fixed") cycleSec = repTimeSec + recoverySec;
      var recoveryJogDist = recoveryField.secPerKm ? (recoverySec / recoveryField.secPerKm) * 1000 : null;

      outRecovery.textContent = formatDuration(recoverySec);
      outRecoveryDist.textContent = recoveryJogDist != null ? "≈ " + formatDistance(recoveryJogDist) + " jog" : "";

      var totalReps = reps * sets;
      var totalRepDist = totalReps * distance;
      var recoveriesPerSet = Math.max(0, reps - 1);
      var totalRecoveriesCount = recoveriesPerSet * sets;
      var totalRecoveryDist = recoveryJogDist != null ? totalRecoveriesCount * recoveryJogDist : 0;

      var setTime = reps * repTimeSec + recoveriesPerSet * recoverySec;
      var totalSessionTime = sets * setTime + Math.max(0, sets - 1) * setRestSec;

      outTotalReps.textContent = String(totalReps);
      outTotalDist.textContent = formatDistance(totalRepDist + totalRecoveryDist);
      outTotalTime.textContent = formatDuration(totalSessionTime, totalSessionTime >= 3600);

      if (repMode === "gear") {
        gearBreakdownWrap.hidden = false;
        var gRows = "";
        gearList.forEach(function (g, i) {
          gRows += "<tr><td>" + (i + 1) + "</td><td>" + formatDistance(g.dist) + "</td><td>" + formatDuration(g.paceKm) + "</td><td>" + formatDuration(g.time) + "</td></tr>";
        });
        gRows += "<tr><td>Total</td><td>" + formatDistance(distance) + "</td><td>" + formatDuration(paceKm) + "</td><td>" + formatDuration(repTimeSec) + "</td></tr>";
        gearBreakdownBody.innerHTML = gRows;
      } else {
        gearBreakdownWrap.hidden = true;
        gearBreakdownBody.innerHTML = "";
      }

      var stripSegments = [];
      for (var gi = 0; gi < reps; gi++) {
        if (repMode === "gear") {
          gearList.forEach(function (g) { stripSegments.push({ cls: "hard", dur: g.time, paceKm: g.paceKm }); });
        } else {
          stripSegments.push({ cls: "hard", dur: repTimeSec, paceKm: paceKm });
        }
        if (gi < reps - 1) stripSegments.push({ cls: "float", dur: recoverySec });
      }
      renderStrip(stripEl, null, stripSegments);

      var rows = "";
      for (var s = 1; s <= sets; s++) {
        rows +=
          "<tr><td>" + s + "</td>" +
          "<td>" + reps + " × " + formatDistance(distance) + "</td>" +
          "<td>" + formatDuration(paceKm) + (repMode === "gear" ? " avg" : "") + "</td>" +
          "<td>" + formatDuration(repTimeSec) + "</td>" +
          "<td>" + formatDuration(cycleSec) + "</td>" +
          "<td>" + formatDuration(recoverySec) + "</td>" +
          "<td>" + formatDuration(setTime) + "</td></tr>";
      }
      var totalRepTimeSum = totalReps * repTimeSec;
      var totalRecoveryTimeSum = totalRecoveriesCount * recoverySec;
      rows +=
        "<tr><td>Total</td>" +
        "<td>" + totalReps + " × " + formatDistance(distance) + "</td>" +
        "<td>—</td>" +
        "<td>" + formatDuration(totalRepTimeSum) + "</td>" +
        "<td>—</td>" +
        "<td>" + formatDuration(totalRecoveryTimeSum) + "</td>" +
        "<td>" + formatDuration(totalSessionTime, totalSessionTime >= 3600) + "</td></tr>";
      outTableBody.innerHTML = rows;

      groupSummary.textContent =
        "— " + reps + " × " + formatDistance(distance) +
        (recMode === "cycle" ? ", " + formatDuration(cycleSec) + " cycle" : ", " + formatDuration(recoverySec) + " rest");

      var groupRows = "";
      if (repMode === "single") {
        groupTheadRow.innerHTML = "<th>Pace /km</th><th>Rep time</th><th>Recovery</th><th>Cycle</th>";
        PACE_TIERS.forEach(function (offset) {
          var tierPaceKm = paceKm + offset;
          if (tierPaceKm <= 0) return;
          var tierRepTime = tierPaceKm * (distance / 1000);
          var tierRecovery, tierCycle, tierValid;
          if (recMode === "cycle") {
            tierRecovery = cycleSec - tierRepTime;
            tierCycle = cycleSec;
            tierValid = tierRecovery >= 0;
          } else {
            tierRecovery = recoverySec;
            tierCycle = tierRepTime + tierRecovery;
            tierValid = true;
          }
          var rowClass = !tierValid ? "tier-invalid" : "";
          groupRows +=
            '<tr class="' + rowClass + '"><td>' + formatDuration(tierPaceKm) + "</td>" +
            "<td>" + formatDuration(tierRepTime) + "</td>" +
            "<td>" + (tierValid ? formatDuration(tierRecovery) : "cycle too short") + "</td>" +
            "<td>" + formatDuration(tierCycle) + "</td></tr>";
        });
      } else {
        var headHtml = "<th>Pace band</th>";
        gearList.forEach(function (g, i) { headHtml += "<th>Gear " + (i + 1) + "</th>"; });
        headHtml += "<th>Recovery</th><th>Cycle</th>";
        groupTheadRow.innerHTML = headHtml;

        PACE_TIERS.forEach(function (offset) {
          var tierOk = gearList.every(function (g) { return g.paceKm + offset > 0; });
          if (!tierOk) return;
          var tierRepTime = 0;
          var cellsHtml = "";
          gearList.forEach(function (g) {
            var tierPaceKm = g.paceKm + offset;
            var tierTime = tierPaceKm * (g.dist / 1000);
            tierRepTime += tierTime;
            cellsHtml += "<td>" + formatDuration(tierTime) + "</td>";
          });
          var tierRecovery, tierCycle, tierValid;
          if (recMode === "cycle") {
            tierRecovery = cycleSec - tierRepTime;
            tierCycle = cycleSec;
            tierValid = tierRecovery >= 0;
          } else {
            tierRecovery = recoverySec;
            tierCycle = tierRepTime + tierRecovery;
            tierValid = true;
          }
          var label = (offset > 0 ? "+" : "") + offset + "s/km";
          var rowClass = !tierValid ? "tier-invalid" : "";
          groupRows +=
            '<tr class="' + rowClass + '"><td>' + label + "</td>" +
            cellsHtml +
            "<td>" + (tierValid ? formatDuration(tierRecovery) : "cycle too short") + "</td>" +
            "<td>" + formatDuration(tierCycle) + "</td></tr>";
        });
      }
      groupTableBody.innerHTML = groupRows;

      var recoveryTarget = recoveryField.secPerKm ? garminPaceRange(recoveryField.secPerKm) : null;
      var recoveryDetail =
        recMode === "cycle"
          ? "Lap Button Press — rest until the caller says go (≈ " + formatDuration(recoverySec) + ")" +
            (recoveryTarget ? " · Target Pace " + recoveryTarget : " · Open (no target)")
          : garminDetail("Time", formatDuration(recoverySec), recoveryTarget);

      var intervalSteps;
      if (repMode === "single") {
        intervalSteps = [{ label: "Interval", detail: garminDetail("Distance", formatDistance(distance), garminPaceRange(paceKm)) }];
      } else {
        intervalSteps = gearList.map(function (g, i) {
          return { label: "Gear " + (i + 1), detail: garminDetail("Distance", formatDistance(g.dist), garminPaceRange(g.paceKm)) };
        });
      }
      intervalSteps.push({ label: "Recovery", detail: recoveryDetail });

      var garminBlocks = [{ repeat: reps, steps: intervalSteps }];
      if (sets > 1) {
        garminBlocks.push({ label: "Rest between sets", detail: garminDetail("Time", formatDuration(setRestSec), null) });
        garminBlocks.push({ label: "Then repeat", detail: "Wrap everything above in one more Repeat, set to " + sets + "× total." });
      }
      renderGarminSteps(garminStepsEl, garminBlocks);
    }

    distanceSel.addEventListener("change", function () {
      updateDistanceUI();
      recalc();
      saveState();
    });
    [repsInput, setsInput, repPaceInput, cycleInput, recoveryFixedInput, setRestInput, distanceCustom].forEach(function (el) {
      el.addEventListener("input", function () {
        recalc();
        saveState();
      });
    });
    repModeBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var newMode = btn.dataset.repmode;
        // Nudge the cycle time to a sane default for the mode being entered,
        // but only if it still looks untouched (equals the other mode's default).
        if (newMode === "gear" && cycleInput.value.trim() === "2:30") {
          cycleInput.value = "4:30";
        } else if (newMode === "single" && cycleInput.value.trim() === "4:30") {
          cycleInput.value = "2:30";
        }
        repMode = newMode;
        updateRepModeUI();
        recalc();
        saveState();
      });
    });
    recModeBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        recMode = btn.dataset.recmode;
        updateRecModeUI();
        recalc();
        saveState();
      });
    });
    recoveryPaceInput.addEventListener("input", function () {
      recalc();
      saveState();
    });

    var savedGears = (gearsDataInput.value || "").split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s !== ""; });
    if (savedGears.length > 0) {
      savedGears.forEach(function (pair) {
        var parts = pair.split("|");
        addGearRow(parts[0], parts[1] || "3:45");
      });
    } else {
      addGearRow("400", "3:55");
      addGearRow("200", "3:40");
      addGearRow("200", "3:20");
    }

    updateDistanceUI();
    updateRepModeUI();
    updateRecModeUI();
    recalc();
  })();

  /* ============================================================
     MONA FARTLEK
     ============================================================ */

  (function monaTool() {
    var PHASES = [
      { key: "90", label: "90s", reps: 2, dur: 90 },
      { key: "60", label: "60s", reps: 4, dur: 60 },
      { key: "30", label: "30s", reps: 4, dur: 30 },
      { key: "15", label: "15s", reps: 4, dur: 15 },
    ];
    var SET_SECONDS = PHASES.reduce(function (a, p) { return a + p.reps * p.dur * 2; }, 0); // 1200

    var floatInput = document.getElementById("mf-floatpace");
    var setsInput = document.getElementById("mf-sets");
    var setRestInput = document.getElementById("mf-setrest");

    var outTotalDist = document.getElementById("mf-out-totaldist");
    var outHardDist = document.getElementById("mf-out-harddist");
    var outFloatDist = document.getElementById("mf-out-floatdist");
    var outTotalTime = document.getElementById("mf-out-totaltime");
    var strip = document.getElementById("mf-strip");
    var stripPhases = document.getElementById("mf-strip-phases");
    var outTableBody = document.querySelector("#mf-out-table tbody");
    var groupSummary = document.getElementById("mf-group-summary");
    var groupTableBody = document.querySelector("#mf-group-table tbody");
    var garminStepsEl = document.getElementById("mf-garmin-steps");

    var hardFields = {};
    PHASES.forEach(function (p) {
      var input = document.getElementById("mf-hardpace-" + p.key);
      var field = createPaceField(input);
      hardFields[p.key] = field;
      input.addEventListener("input", function () { recalc(); saveState(); });
    });
    var floatField = createPaceField(floatInput);

    function buildStrip() {
      var segHtml = "";
      var phaseHtml = "";
      PHASES.forEach(function (p) {
        for (var i = 0; i < p.reps; i++) {
          var pct = (p.dur / SET_SECONDS) * 100;
          segHtml += '<div class="strip-seg hard" style="width:' + pct + '%"></div>';
          segHtml += '<div class="strip-seg float" style="width:' + pct + '%"></div>';
        }
        var phasePct = ((p.reps * p.dur * 2) / SET_SECONDS) * 100;
        phaseHtml += '<div class="strip-phase-label" style="width:' + phasePct + '%">' + p.reps + '×' + p.label + '</div>';
      });
      strip.innerHTML = segHtml;
      stripPhases.innerHTML = phaseHtml;
    }

    function recalc() {
      var hardOk = true;
      PHASES.forEach(function (p) {
        if (!hardFields[p.key].sync(false)) hardOk = false;
      });
      var floatOk = floatField.sync(false);
      if (!hardOk || !floatOk) {
        outTotalDist.textContent = "—";
        outHardDist.textContent = "—";
        outFloatDist.textContent = "—";
        outTotalTime.textContent = "—";
        outTableBody.innerHTML = "";
        groupTableBody.innerHTML = "";
        groupSummary.textContent = "";
        garminStepsEl.innerHTML = "";
        return;
      }

      var floatSpeed = 1000 / floatField.secPerKm;
      var sets = parseInt(setsInput.value, 10) || 1;
      markValid(setsInput, sets >= 1);
      var setRestSec = sets > 1 ? parseTime(setRestInput.value) : 0;
      markValid(setRestInput, sets <= 1 || (setRestSec != null && setRestSec >= 0));
      if (setRestSec == null) setRestSec = 0;

      var cumulative = 0;
      var oneSetHard = 0;
      var oneSetFloat = 0;
      var rows = "";
      PHASES.forEach(function (p) {
        var hardSpeed = 1000 / hardFields[p.key].secPerKm; // m/s
        var hardPerRep = hardSpeed * p.dur;
        var floatPerRep = floatSpeed * p.dur;
        var phaseHard = p.reps * hardPerRep;
        var phaseFloat = p.reps * floatPerRep;
        var phaseTotal = phaseHard + phaseFloat;
        cumulative += phaseTotal;
        oneSetHard += phaseHard;
        oneSetFloat += phaseFloat;
        rows +=
          "<tr><td>" + p.reps + "×" + p.label + " efforts</td>" +
          "<td>" + p.reps + "</td>" +
          "<td>" + formatDistance(hardPerRep) + "</td>" +
          "<td>" + formatDistance(floatPerRep) + "</td>" +
          "<td>" + formatDistance(phaseTotal) + "</td>" +
          "<td>" + formatDistance(cumulative) + "</td></tr>";
      });
      outTableBody.innerHTML = rows;

      var oneSetDist = oneSetHard + oneSetFloat;
      var sets_ = sets;
      var totalDist = oneSetDist * sets_;
      var totalHard = oneSetHard * sets_;
      var totalFloat = oneSetFloat * sets_;
      var totalTime = SET_SECONDS * sets_ + Math.max(0, sets_ - 1) * setRestSec;

      outTotalDist.textContent = formatDistance(totalDist);
      outHardDist.textContent = formatDistance(totalHard);
      outFloatDist.textContent = formatDistance(totalFloat);
      outTotalTime.textContent = formatDuration(totalTime, totalTime >= 3600);

      groupSummary.textContent = "— one set, 20:00" + (sets > 1 ? " × " + sets + " sets" : "");
      var groupRows = "";
      PACE_TIERS.forEach(function (offset) {
        var tierFloatKm = floatField.secPerKm + offset;
        if (tierFloatKm <= 0) return;
        var ok = true;
        var tierHardKm = {};
        PHASES.forEach(function (p) {
          var v = hardFields[p.key].secPerKm + offset;
          if (v <= 0) ok = false;
          tierHardKm[p.key] = v;
        });
        if (!ok) return;
        var tierFloatSpeed = 1000 / tierFloatKm;
        var tierSetDist = 0;
        PHASES.forEach(function (p) {
          var tierHardSpeed = 1000 / tierHardKm[p.key];
          tierSetDist += p.reps * tierHardSpeed * p.dur + p.reps * tierFloatSpeed * p.dur;
        });
        groupRows +=
          "<tr>" +
          "<td>" + formatDuration(tierHardKm["90"]) + "</td>" +
          "<td>" + formatDuration(tierHardKm["60"]) + "</td>" +
          "<td>" + formatDuration(tierHardKm["30"]) + "</td>" +
          "<td>" + formatDuration(tierHardKm["15"]) + "</td>" +
          "<td>" + formatDuration(tierFloatKm) + "</td>" +
          "<td>" + formatDistance(tierSetDist * sets_) + "</td></tr>";
      });
      groupTableBody.innerHTML = groupRows;

      var garminBlocks = PHASES.map(function (p) {
        return {
          repeat: p.reps,
          steps: [
            { label: "Hard " + p.label, detail: garminDetail("Time", formatDuration(p.dur), garminPaceRange(hardFields[p.key].secPerKm)) },
            { label: "Float", detail: garminDetail("Time", formatDuration(p.dur), garminPaceRange(floatField.secPerKm)) },
          ],
        };
      });
      if (sets > 1) {
        garminBlocks.push({ label: "Rest between sets", detail: garminDetail("Time", formatDuration(setRestSec), null) });
        garminBlocks.push({ label: "Then repeat", detail: "Wrap everything above in one more Repeat, set to " + sets + "× total." });
      }
      renderGarminSteps(garminStepsEl, garminBlocks);
    }

    floatInput.addEventListener("input", function () { recalc(); saveState(); });
    setsInput.addEventListener("input", function () { recalc(); saveState(); });
    setRestInput.addEventListener("input", function () { recalc(); saveState(); });

    buildStrip();
    recalc();
  })();

  /* ============================================================
     FARTLEK BUILDER  (Deek's Quarters, 200s, timed fartleks, custom)
     ============================================================ */

  (function distanceFartlekTool() {
    var modeBtns = Array.prototype.slice.call(document.querySelectorAll('#df-form .mode-switch button[data-dfmode]'));
    var presetsDistanceWrap = document.getElementById("df-presets-distance-wrap");
    var presetsTimeWrap = document.getElementById("df-presets-time-wrap");
    var distanceFieldsWrap = document.getElementById("df-distance-fields-wrap");
    var timeFieldsWrap = document.getElementById("df-time-fields-wrap");

    var hardDistInput = document.getElementById("df-harddist");
    var floatDistInput = document.getElementById("df-floatdist");
    var hardDurInput = document.getElementById("df-harddur");
    var floatDurInput = document.getElementById("df-floatdur");
    var repsInput = document.getElementById("df-reps");
    var hardPaceInput = document.getElementById("df-hardpace");
    var floatPaceInput = document.getElementById("df-floatpace");

    var outTotalDist = document.getElementById("df-out-totaldist");
    var outTotalTime = document.getElementById("df-out-totaltime");
    var outReps = document.getElementById("df-out-reps");
    var outTableBody = document.querySelector("#df-out-table tbody");
    var groupSummary = document.getElementById("df-group-summary");
    var groupTableBody = document.querySelector("#df-group-table tbody");
    var groupThMetric = document.getElementById("df-group-th-metric");
    var groupThTotal = document.getElementById("df-group-th-total");
    var garminStepsEl = document.getElementById("df-garmin-steps");
    var stripEl = document.getElementById("df-strip");

    var hardPaceField = createPaceField(hardPaceInput);
    var floatPaceField = createPaceField(floatPaceInput);
    var dfMode = "distance";

    function updateModeUI() {
      presetsDistanceWrap.hidden = dfMode !== "distance";
      presetsTimeWrap.hidden = dfMode !== "time";
      distanceFieldsWrap.hidden = dfMode !== "distance";
      timeFieldsWrap.hidden = dfMode !== "time";
      modeBtns.forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.dfmode === dfMode ? "true" : "false");
      });
    }

    function activePresetBtns() {
      return Array.prototype.slice.call(
        document.querySelectorAll((dfMode === "distance" ? "#df-presets-distance-wrap" : "#df-presets-time-wrap") + " .chip-btn[data-preset]")
      );
    }

    function syncPresetPressed() {
      var current =
        dfMode === "distance"
          ? hardDistInput.value + "," + floatDistInput.value + "," + repsInput.value
          : hardDurInput.value + "," + floatDurInput.value + "," + repsInput.value;
      activePresetBtns().forEach(function (btn) {
        btn.setAttribute("aria-pressed", btn.dataset.preset === current ? "true" : "false");
      });
    }

    function recalc() {
      setError("df-error", "");
      var reps = parseInt(repsInput.value, 10);
      markValid(repsInput, reps >= 1);

      var hardLen, floatLen, lenValid;
      if (dfMode === "distance") {
        hardLen = parseFloat(hardDistInput.value);
        floatLen = parseFloat(floatDistInput.value);
        markValid(hardDistInput, hardLen > 0);
        markValid(floatDistInput, floatLen >= 0 && !isNaN(floatLen));
        lenValid = hardLen > 0 && floatLen >= 0 && !isNaN(floatLen);
      } else {
        hardLen = parseTime(hardDurInput.value);
        floatLen = parseTime(floatDurInput.value);
        markValid(hardDurInput, hardLen != null && hardLen > 0);
        markValid(floatDurInput, floatLen != null && floatLen >= 0);
        lenValid = hardLen != null && hardLen > 0 && floatLen != null && floatLen >= 0;
      }

      var hardOk = hardPaceField.sync(false);
      var floatOk = floatLen > 0 ? floatPaceField.sync(false) : floatPaceField.sync(true);

      if (!lenValid || !(reps >= 1) || !hardOk || !floatOk) {
        if (!hardOk || !floatOk) setError("df-error", "Enter valid paces for the hard and recovery segments.");
        outTotalDist.textContent = "—";
        outTotalTime.textContent = "—";
        outReps.textContent = "—";
        outTableBody.innerHTML = "";
        groupTableBody.innerHTML = "";
        groupSummary.textContent = "";
        garminStepsEl.innerHTML = "";
        stripEl.innerHTML = "";
        return;
      }

      var hardDist, floatDist, hardTimePerRep, floatTimePerRep;
      if (dfMode === "distance") {
        hardDist = hardLen;
        floatDist = floatLen;
        hardTimePerRep = hardPaceField.secPerKm * (hardDist / 1000);
        floatTimePerRep = floatDist > 0 && floatPaceField.secPerKm ? floatPaceField.secPerKm * (floatDist / 1000) : 0;
      } else {
        hardTimePerRep = hardLen;
        floatTimePerRep = floatLen;
        hardDist = (1000 / hardPaceField.secPerKm) * hardTimePerRep;
        floatDist = floatTimePerRep > 0 && floatPaceField.secPerKm ? (1000 / floatPaceField.secPerKm) * floatTimePerRep : 0;
      }

      var totalHardTime = reps * hardTimePerRep;
      var totalFloatTime = reps * floatTimePerRep;
      var totalTime = totalHardTime + totalFloatTime;
      var totalDist = reps * (hardDist + floatDist);
      var repTime = hardTimePerRep + floatTimePerRep;

      outTotalDist.textContent = formatDistance(totalDist);
      outTotalTime.textContent = formatDuration(totalTime, totalTime >= 3600);
      outReps.textContent = String(reps);

      var rows =
        "<tr><td>Hard</td>" +
        "<td>" + formatDistance(hardDist) + "</td>" +
        "<td>" + formatDuration(hardPaceField.secPerKm) + "</td>" +
        "<td>" + formatDuration(hardTimePerRep) + "</td>" +
        "<td>" + reps + "</td>" +
        "<td>" + formatDuration(totalHardTime) + "</td>" +
        "<td>" + formatDistance(reps * hardDist) + "</td></tr>";
      rows +=
        "<tr><td>Recovery</td>" +
        "<td>" + formatDistance(floatDist) + "</td>" +
        "<td>" + (floatDist > 0 ? formatDuration(floatPaceField.secPerKm) : "—") + "</td>" +
        "<td>" + formatDuration(floatTimePerRep) + "</td>" +
        "<td>" + reps + "</td>" +
        "<td>" + formatDuration(totalFloatTime) + "</td>" +
        "<td>" + formatDistance(reps * floatDist) + "</td></tr>";
      rows +=
        "<tr><td>Total</td>" +
        "<td>" + formatDistance(hardDist + floatDist) + " / rep</td>" +
        "<td>—</td>" +
        "<td>" + formatDuration(repTime) + "</td>" +
        "<td>" + reps + "</td>" +
        "<td>" + formatDuration(totalTime, totalTime >= 3600) + "</td>" +
        "<td>" + formatDistance(totalDist) + "</td></tr>";
      outTableBody.innerHTML = rows;

      var stripSegments = [];
      for (var fi = 0; fi < reps; fi++) {
        stripSegments.push({ cls: "hard", dur: hardTimePerRep });
        if (floatTimePerRep > 0) stripSegments.push({ cls: "float", dur: floatTimePerRep });
      }
      renderStrip(stripEl, null, stripSegments);

      var hasFloat = floatLen > 0;
      if (dfMode === "distance") {
        groupThMetric.textContent = "Time / rep";
        groupThTotal.textContent = "Total time";
        groupSummary.textContent = "— " + reps + " × " + formatDistance(hardDist) + (hasFloat ? " hard / " + formatDistance(floatDist) + " float" : " hard");
      } else {
        groupThMetric.textContent = "Distance / rep";
        groupThTotal.textContent = "Total distance";
        groupSummary.textContent = "— " + reps + " × " + formatDuration(hardTimePerRep) + (hasFloat ? " hard / " + formatDuration(floatTimePerRep) + " recovery" : " hard");
      }
      var groupRows = "";
      PACE_TIERS.forEach(function (offset) {
        var tierHardKm = hardPaceField.secPerKm + offset;
        if (tierHardKm <= 0) return;
        var tierFloatKm = hasFloat ? floatPaceField.secPerKm + offset : null;
        if (hasFloat && tierFloatKm <= 0) return;

        var tierMetric, tierTotal;
        if (dfMode === "distance") {
          var tHardTime = tierHardKm * (hardDist / 1000);
          var tFloatTime = hasFloat ? tierFloatKm * (floatDist / 1000) : 0;
          var tRepTime = tHardTime + tFloatTime;
          tierMetric = formatDuration(tRepTime);
          tierTotal = formatDuration(reps * tRepTime, reps * tRepTime >= 3600);
        } else {
          var tHardDist = (1000 / tierHardKm) * hardTimePerRep;
          var tFloatDist = hasFloat ? (1000 / tierFloatKm) * floatTimePerRep : 0;
          var tRepDist = tHardDist + tFloatDist;
          tierMetric = formatDistance(tRepDist);
          tierTotal = formatDistance(reps * tRepDist);
        }
        groupRows +=
          "<tr>" +
          "<td>" + formatDuration(tierHardKm) + "</td>" +
          "<td>" + (hasFloat ? formatDuration(tierFloatKm) : "—") + "</td>" +
          "<td>" + tierMetric + "</td>" +
          "<td>" + tierTotal + "</td></tr>";
      });
      groupTableBody.innerHTML = groupRows;

      var hardDurationLabel = dfMode === "distance" ? "Distance" : "Time";
      var hardDurationValue = dfMode === "distance" ? formatDistance(hardDist) : formatDuration(hardTimePerRep);
      var floatDurationValue = dfMode === "distance" ? formatDistance(floatDist) : formatDuration(floatTimePerRep);
      var garminSteps = [
        { label: "Hard", detail: garminDetail(hardDurationLabel, hardDurationValue, garminPaceRange(hardPaceField.secPerKm)) },
      ];
      if (hasFloat) {
        garminSteps.push({ label: "Recovery", detail: garminDetail(hardDurationLabel, floatDurationValue, garminPaceRange(floatPaceField.secPerKm)) });
      }
      renderGarminSteps(garminStepsEl, [{ repeat: reps, steps: garminSteps }]);
    }

    modeBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        dfMode = btn.dataset.dfmode;
        updateModeUI();
        syncPresetPressed();
        recalc();
        saveState();
      });
    });

    document.querySelectorAll("#df-presets-distance-wrap .chip-btn[data-preset], #df-presets-time-wrap .chip-btn[data-preset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var parts = btn.dataset.preset.split(",");
        if (dfMode === "distance") {
          hardDistInput.value = parts[0];
          floatDistInput.value = parts[1];
        } else {
          hardDurInput.value = parts[0];
          floatDurInput.value = parts[1];
        }
        repsInput.value = parts[2];
        syncPresetPressed();
        recalc();
        saveState();
      });
    });
    [hardDistInput, floatDistInput, hardDurInput, floatDurInput, repsInput].forEach(function (el) {
      el.addEventListener("input", function () {
        syncPresetPressed();
        recalc();
        saveState();
      });
    });
    hardPaceInput.addEventListener("input", function () { recalc(); saveState(); });
    floatPaceInput.addEventListener("input", function () { recalc(); saveState(); });

    updateModeUI();
    syncPresetPressed();
    recalc();
  })();

  /* ============================================================
     LADDER
     ============================================================ */

  (function ladderTool() {
    var presetBtns = Array.prototype.slice.call(document.querySelectorAll("#panel-ladder .chip-btn[data-preset]"));
    var distancesInput = document.getElementById("lad-distances");
    var paceRowsContainer = document.getElementById("lad-pace-rows");
    var pacesDataInput = document.getElementById("lad-paces-data");
    var repeatsInput = document.getElementById("lad-repeats");
    var recModeSel = document.getElementById("lad-recmode");
    var ratioWrap = document.getElementById("lad-ratio-wrap");
    var ratioInput = document.getElementById("lad-ratio");
    var fixedWrap = document.getElementById("lad-fixed-wrap");
    var fixedInput = document.getElementById("lad-fixed");
    var cycleWrap = document.getElementById("lad-cycle-wrap");
    var cycleRowsContainer = document.getElementById("lad-cycle-rows");
    var cyclesDataInput = document.getElementById("lad-cycles-data");

    var outTotalDist = document.getElementById("lad-out-totaldist");
    var outRungs = document.getElementById("lad-out-rungs");
    var outTotalTime = document.getElementById("lad-out-totaltime");
    var outTableBody = document.querySelector("#lad-out-table tbody");
    var groupSummary = document.getElementById("lad-group-summary");
    var groupTheadRow = document.getElementById("lad-group-thead-row");
    var groupTableBody = document.querySelector("#lad-group-table tbody");
    var garminStepsEl = document.getElementById("lad-garmin-steps");
    var stripEl = document.getElementById("lad-strip");
    var stripPhasesEl = document.getElementById("lad-strip-phases");

    var paceRows = [];

    function makePaceRow(seedValue) {
      var rowEl = document.createElement("div");
      rowEl.className = "phase-pace-row";
      var tagEl = document.createElement("span");
      tagEl.className = "phase-pace-tag";
      var fieldWrap = document.createElement("div");
      fieldWrap.className = "pace-field";
      var input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.placeholder = "m:ss";
      input.value = seedValue;
      var unitLabel = document.createElement("span");
      unitLabel.className = "unit-label";
      unitLabel.textContent = "/ KM";
      fieldWrap.appendChild(input);
      fieldWrap.appendChild(unitLabel);
      rowEl.appendChild(tagEl);
      rowEl.appendChild(fieldWrap);
      paceRowsContainer.appendChild(rowEl);
      var field = createPaceField(input);
      input.addEventListener("input", function () { recalc(); saveState(); });
      return { rowEl: rowEl, tagEl: tagEl, input: input, field: field };
    }

    function ensurePaceRowCount(n, seedValues) {
      while (paceRows.length < n) {
        var idx = paceRows.length;
        var seed = seedValues && seedValues[idx] != null && seedValues[idx] !== "" ? seedValues[idx] : "4:15";
        paceRows.push(makePaceRow(seed));
      }
      while (paceRows.length > n) {
        paceRows.pop().rowEl.remove();
      }
    }

    function updatePaceRowTags(raw) {
      raw.forEach(function (dist, i) {
        if (paceRows[i]) paceRows[i].tagEl.textContent = (i + 1) + " · " + formatDistance(dist);
      });
    }

    var cycleRows = [];

    function makeCycleRow(seedValue) {
      var rowEl = document.createElement("div");
      rowEl.className = "phase-pace-row";
      var tagEl = document.createElement("span");
      tagEl.className = "phase-pace-tag";
      var fieldWrap = document.createElement("div");
      fieldWrap.className = "pace-field";
      var input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.placeholder = "m:ss";
      input.value = seedValue;
      fieldWrap.appendChild(input);
      rowEl.appendChild(tagEl);
      rowEl.appendChild(fieldWrap);
      cycleRowsContainer.appendChild(rowEl);
      input.addEventListener("input", function () { recalc(); saveState(); });
      return { rowEl: rowEl, tagEl: tagEl, input: input };
    }

    function ensureCycleRowCount(n, seedValues) {
      while (cycleRows.length < n) {
        var idx = cycleRows.length;
        var seed = seedValues && seedValues[idx] != null && seedValues[idx] !== "" ? seedValues[idx] : "2:30";
        cycleRows.push(makeCycleRow(seed));
      }
      while (cycleRows.length > n) {
        cycleRows.pop().rowEl.remove();
      }
    }

    function updateCycleRowTags(raw) {
      raw.forEach(function (dist, i) {
        if (cycleRows[i]) cycleRows[i].tagEl.textContent = (i + 1) + " · " + formatDistance(dist);
      });
    }

    function syncPresetPressed() {
      var current = distancesInput.value.replace(/\s+/g, "");
      presetBtns.forEach(function (btn) {
        btn.setAttribute("aria-pressed", btn.dataset.preset === current ? "true" : "false");
      });
    }

    function updateRecoveryModeUI() {
      var mode = recModeSel.value;
      ratioWrap.hidden = mode !== "ratio";
      fixedWrap.hidden = mode !== "fixed";
      cycleWrap.hidden = mode !== "cycle";
    }

    function recalc() {
      setError("lad-error", "");
      var raw = distancesInput.value
        .split(",")
        .map(function (s) { return parseFloat(s.trim()); })
        .filter(function (n) { return !isNaN(n) && n > 0; });
      markValid(distancesInput, raw.length > 0);

      ensurePaceRowCount(raw.length);
      updatePaceRowTags(raw);
      pacesDataInput.value = paceRows.map(function (r) { return r.input.value; }).join(",");

      ensureCycleRowCount(raw.length);
      updateCycleRowTags(raw);
      cyclesDataInput.value = cycleRows.map(function (r) { return r.input.value; }).join(",");

      var paceOk = true;
      paceRows.forEach(function (r) {
        if (!r.field.sync(false)) paceOk = false;
      });

      var recMode = recModeSel.value;
      var ratio = null, fixedRec = null, cycleOk = true;
      if (recMode === "ratio") {
        ratio = parseFloat(ratioInput.value);
        markValid(ratioInput, ratio != null && ratio >= 0 && !isNaN(ratio));
      } else if (recMode === "fixed") {
        fixedRec = parseTime(fixedInput.value);
        markValid(fixedInput, fixedRec != null && fixedRec >= 0);
      } else {
        cycleRows.forEach(function (r) {
          var t = parseTime(r.input.value);
          var ok = t != null && t > 0;
          markValid(r.input, ok);
          if (!ok) cycleOk = false;
        });
      }
      var cycleSecs = cycleRows.map(function (r) { return parseTime(r.input.value); });

      var repeats = parseInt(repeatsInput.value, 10);
      markValid(repeatsInput, repeats >= 1);

      if (raw.length === 0) setError("lad-error", "Enter at least one rung distance, e.g. 400,800,1200.");
      else if (!paceOk) setError("lad-error", "Enter a valid pace for every rung.");
      else if (recMode === "ratio" && (ratio == null || isNaN(ratio) || ratio < 0)) setError("lad-error", "Recovery ratio must be zero or greater.");
      else if (recMode === "fixed" && fixedRec == null) setError("lad-error", "Enter a valid fixed recovery time.");
      else if (recMode === "cycle" && !cycleOk) setError("lad-error", "Enter a valid cycle time for every rung.");
      else if (!(repeats >= 1)) setError("lad-error", "Repeat count must be at least 1.");

      var recModeValueOk =
        recMode === "ratio" ? ratio != null && !isNaN(ratio) && ratio >= 0 :
        recMode === "fixed" ? fixedRec != null :
        cycleOk;

      if (raw.length === 0 || !paceOk || !recModeValueOk || !(repeats >= 1)) {
        outTotalDist.textContent = "—";
        outRungs.textContent = "—";
        outTotalTime.textContent = "—";
        outTableBody.innerHTML = "";
        groupTableBody.innerHTML = "";
        groupSummary.textContent = "";
        garminStepsEl.innerHTML = "";
        stripEl.innerHTML = "";
        stripPhasesEl.innerHTML = "";
        return;
      }

      if (recMode === "cycle") {
        var badIdx = -1;
        for (var ci = 0; ci < raw.length; ci++) {
          var badRepTime = paceRows[ci].field.secPerKm * (raw[ci] / 1000);
          if (cycleSecs[ci] <= badRepTime) { badIdx = ci; break; }
        }
        if (badIdx !== -1) {
          var badRepTime2 = paceRows[badIdx].field.secPerKm * (raw[badIdx] / 1000);
          setError(
            "lad-error",
            "Rung " + (badIdx + 1) + "'s cycle time (" + formatDuration(cycleSecs[badIdx]) +
              ") must be longer than its rep time (" + formatDuration(badRepTime2) + ")."
          );
          outTotalDist.textContent = "—";
          outRungs.textContent = "—";
          outTotalTime.textContent = "—";
          outTableBody.innerHTML = "";
          groupTableBody.innerHTML = "";
          groupSummary.textContent = "";
          garminStepsEl.innerHTML = "";
          stripEl.innerHTML = "";
          stripPhasesEl.innerHTML = "";
          return;
        }
      }

      function recoveryForBase(baseIdx, repTime) {
        if (recMode === "fixed") return fixedRec;
        if (recMode === "ratio") return ratio * repTime;
        return cycleSecs[baseIdx] - repTime;
      }

      var seqLen = raw.length * repeats;
      var cumDist = 0, cumTime = 0;
      var rows = "";
      var stripSegments = [];
      var stripGroups = [];
      for (var i = 0; i < seqLen; i++) {
        var baseIdx = i % raw.length;
        var dist = raw[baseIdx];
        var paceKm = paceRows[baseIdx].field.secPerKm;
        var repTime = paceKm * (dist / 1000);
        var recovery = recoveryForBase(baseIdx, repTime);
        var isLast = i === seqLen - 1;
        cumDist += dist;
        cumTime += repTime + (isLast ? 0 : recovery);
        rows +=
          "<tr><td>" + (i + 1) + "</td>" +
          "<td>" + formatDistance(dist) + "</td>" +
          "<td>" + formatDuration(paceKm) + "</td>" +
          "<td>" + formatDuration(repTime) + "</td>" +
          "<td>" + (isLast ? "—" : formatDuration(recovery)) + "</td>" +
          "<td>" + formatDistance(cumDist) + "</td>" +
          "<td>" + formatDuration(cumTime, cumTime >= 3600) + "</td></tr>";
        stripSegments.push({ cls: "hard", dur: repTime, paceKm: paceKm });
        var groupDur = repTime;
        if (!isLast) {
          stripSegments.push({ cls: "float", dur: recovery });
          groupDur += recovery;
        }
        stripGroups.push({ label: formatDistance(dist), dur: groupDur });
      }
      outTableBody.innerHTML = rows;
      renderStrip(stripEl, stripPhasesEl, stripSegments, stripGroups);
      outTotalDist.textContent = formatDistance(cumDist);
      outRungs.textContent = String(seqLen);
      outTotalTime.textContent = formatDuration(cumTime, cumTime >= 3600);

      var recoveryLabel =
        recMode === "fixed" ? formatDuration(fixedRec) + " recovery" :
        recMode === "ratio" ? ratio + "× rep-time recovery" :
        "cycle recovery";
      groupSummary.textContent =
        "— " + raw.map(formatDistance).join(" - ") +
        (repeats > 1 ? " × " + repeats : "") +
        ", " + recoveryLabel;
      var headHtml = "<th>Pace band</th>";
      raw.forEach(function (dist) { headHtml += "<th>" + formatDistance(dist) + "</th>"; });
      headHtml += "<th>Total</th>";
      groupTheadRow.innerHTML = headHtml;

      var groupRows = "";
      PACE_TIERS.forEach(function (offset) {
        var tierPaceKm = raw.map(function (dist, i) { return paceRows[i].field.secPerKm + offset; });
        var tierOk = tierPaceKm.every(function (p) { return p > 0; });
        if (tierOk && recMode === "cycle") {
          tierOk = raw.every(function (dist, i) {
            var tRepTime = tierPaceKm[i] * (dist / 1000);
            return cycleSecs[i] - tRepTime >= 0;
          });
        }
        if (!tierOk) return;
        var tCum = 0;
        var cellsHtml = "";
        for (var ti = 0; ti < seqLen; ti++) {
          var tBaseIdx = ti % raw.length;
          var tDist = raw[tBaseIdx];
          var tRepTime = tierPaceKm[tBaseIdx] * (tDist / 1000);
          var tRecovery = recoveryForBase(tBaseIdx, tRepTime);
          var tIsLast = ti === seqLen - 1;
          tCum += tRepTime + (tIsLast ? 0 : tRecovery);
          if (ti < raw.length) cellsHtml += "<td>" + formatDuration(tRepTime) + "</td>";
        }
        var label = (offset > 0 ? "+" : "") + offset + "s/km";
        groupRows +=
          "<tr><td>" + label + "</td>" +
          cellsHtml +
          "<td>" + formatDuration(tCum, tCum >= 3600) + "</td></tr>";
      });
      groupTableBody.innerHTML = groupRows;

      var lapSteps = [];
      raw.forEach(function (dist, i) {
        var paceKm = paceRows[i].field.secPerKm;
        var repTime = paceKm * (dist / 1000);
        var isLastRungOfLap = i === raw.length - 1;
        lapSteps.push({ label: "Rung " + (i + 1), detail: garminDetail("Distance", formatDistance(dist), garminPaceRange(paceKm)) });
        if (repeats > 1 || !isLastRungOfLap) {
          var recovery = recoveryForBase(i, repTime);
          var recoveryDetail =
            recMode === "cycle"
              ? "Lap Button Press — rest until the caller says go (≈ " + formatDuration(recovery) + ") · Open (no target)"
              : garminDetail("Time", formatDuration(recovery), null);
          lapSteps.push({ label: "Recovery", detail: recoveryDetail });
        }
      });
      var garminBlocks = repeats > 1 ? [{ repeat: repeats, steps: lapSteps }] : lapSteps;
      renderGarminSteps(garminStepsEl, garminBlocks);
    }

    presetBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        distancesInput.value = btn.dataset.preset;
        syncPresetPressed();
        recalc();
        saveState();
      });
    });
    distancesInput.addEventListener("input", function () {
      syncPresetPressed();
      recalc();
      saveState();
    });
    recModeSel.addEventListener("change", function () { updateRecoveryModeUI(); recalc(); saveState(); });
    ratioInput.addEventListener("input", function () { recalc(); saveState(); });
    fixedInput.addEventListener("input", function () { recalc(); saveState(); });
    repeatsInput.addEventListener("input", function () { recalc(); saveState(); });

    var initialRaw = distancesInput.value
      .split(",")
      .map(function (s) { return parseFloat(s.trim()); })
      .filter(function (n) { return !isNaN(n) && n > 0; });
    var savedPaces = (pacesDataInput.value || "").split(",").map(function (s) { return s.trim(); });
    ensurePaceRowCount(initialRaw.length, savedPaces.length === initialRaw.length ? savedPaces : null);
    updatePaceRowTags(initialRaw);

    var savedCycles = (cyclesDataInput.value || "").split(",").map(function (s) { return s.trim(); });
    ensureCycleRowCount(initialRaw.length, savedCycles.length === initialRaw.length ? savedCycles : null);
    updateCycleRowTags(initialRaw);

    updateRecoveryModeUI();
    syncPresetPressed();
    recalc();
  })();

  /* ============================================================
     GOAL RACE TIMES  →  suggested training paces (VDOT method)
     ============================================================ */

  (function goalTimesTool() {
    var RACES = [
      { id: "goal-5k", distance: 5000 },
      { id: "goal-10k", distance: 10000 },
      { id: "goal-half", distance: 21097.5 },
      { id: "goal-full", distance: 42195 },
    ];

    var emptyMsg = document.getElementById("goal-empty-msg");
    var paceGrid = document.getElementById("goal-pace-grid");

    function recalc() {
      var vdots = [];
      RACES.forEach(function (r) {
        var input = document.getElementById(r.id);
        var raw = input.value.trim();
        if (raw === "") {
          markValid(input, true);
          return;
        }
        var t = parseTime(raw);
        if (t == null || t <= 0) {
          markValid(input, false);
          return;
        }
        markValid(input, true);
        vdots.push(vdotFromPerformance(r.distance, t));
      });

      if (vdots.length === 0) {
        emptyMsg.hidden = false;
        paceGrid.hidden = true;
        return;
      }

      var vdot = vdots.reduce(function (a, b) { return a + b; }, 0) / vdots.length;
      emptyMsg.hidden = true;
      paceGrid.hidden = false;

      VDOT_ZONES.forEach(function (z) {
        var secPerKm = paceFromVdotAndPercent(vdot, z.pct);
        var kmEl = document.getElementById("goal-pace-" + z.key);
        if (kmEl) kmEl.textContent = formatDuration(secPerKm) + " /km";
      });
    }

    RACES.forEach(function (r) {
      var input = document.getElementById(r.id);
      input.addEventListener("input", function () {
        recalc();
        saveState();
      });
    });

    Array.prototype.slice.call(document.querySelectorAll(".copy-btn[data-copy]")).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var el = document.getElementById(btn.dataset.copy);
        var text = el ? el.textContent.replace(/\s*\/km$/, "") : "";
        if (!text || text === "—") return;
        var restoreLabel = "Copy";
        function flash() {
          btn.textContent = "Copied";
          btn.classList.add("copied");
          setTimeout(function () {
            btn.textContent = restoreLabel;
            btn.classList.remove("copied");
          }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(flash, flash);
        } else {
          flash();
        }
      });
    });

    recalc();
  })();

  /* ============================================================
     PACE CALCULATOR  (any two of distance/time/pace -> the third)
     ============================================================ */

  (function paceCalcTool() {
    var solveBtns = Array.prototype.slice.call(document.querySelectorAll('#pc-solve-mode button[data-solve]'));
    var distanceWrap = document.getElementById("pc-distance-wrap");
    var distanceSel = document.getElementById("pc-distance");
    var distanceCustomWrap = document.getElementById("pc-distance-custom-wrap");
    var distanceCustom = document.getElementById("pc-distance-custom");
    var timeWrap = document.getElementById("pc-time-wrap");
    var timeInput = document.getElementById("pc-time");
    var paceWrap = document.getElementById("pc-pace-wrap");
    var paceInput = document.getElementById("pc-pace");

    var tileDistance = document.getElementById("pc-tile-distance");
    var tileTime = document.getElementById("pc-tile-time");
    var tilePace = document.getElementById("pc-tile-pace");
    var outDistance = document.getElementById("pc-out-distance");
    var outTime = document.getElementById("pc-out-time");
    var outPace = document.getElementById("pc-out-pace");
    var outLaps = document.getElementById("pc-out-laps");

    var paceField = createPaceField(paceInput);
    var solveMode = "time";

    function currentDistance() {
      if (distanceSel.value === "custom") {
        var v = parseFloat(distanceCustom.value);
        return v > 0 ? v : null;
      }
      return parseFloat(distanceSel.value);
    }

    function updateDistanceUI() {
      distanceCustomWrap.hidden = distanceSel.value !== "custom";
    }

    function updateModeUI() {
      distanceWrap.hidden = solveMode === "distance";
      timeWrap.hidden = solveMode === "time";
      paceWrap.hidden = solveMode === "pace";
      solveBtns.forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.solve === solveMode ? "true" : "false");
      });
      [tileDistance, tileTime, tilePace].forEach(function (t) { t.classList.remove("primary"); });
      (solveMode === "distance" ? tileDistance : solveMode === "time" ? tileTime : tilePace).classList.add("primary");
    }

    function clearOutputs() {
      outDistance.textContent = "—";
      outTime.textContent = "—";
      outPace.textContent = "—";
      outLaps.textContent = "—";
    }

    function recalc() {
      setError("pc-error", "");

      var distance = solveMode === "distance" ? null : currentDistance();
      if (solveMode !== "distance") markValid(distanceCustom, distanceSel.value !== "custom" || distance != null);

      var timeSec = solveMode === "time" ? null : parseTime(timeInput.value);
      if (solveMode !== "time") markValid(timeInput, timeSec != null && timeSec > 0);

      var paceOk = solveMode === "pace" ? true : paceField.sync(false);
      var paceSecPerKm = paceField.secPerKm;

      if (solveMode === "time") {
        if (!(distance > 0) || !paceOk || paceSecPerKm == null) { clearOutputs(); return; }
        var timeResult = paceSecPerKm * (distance / 1000);
        outTime.textContent = formatDuration(timeResult, timeResult >= 3600);
        outDistance.textContent = formatDistance(distance);
        outPace.textContent = formatDuration(paceSecPerKm);
        outLaps.textContent = trimZeros((distance / 400).toFixed(2)) + " laps";
      } else if (solveMode === "pace") {
        if (!(distance > 0) || timeSec == null) { clearOutputs(); return; }
        var paceResult = timeSec / (distance / 1000);
        outPace.textContent = formatDuration(paceResult);
        outDistance.textContent = formatDistance(distance);
        outTime.textContent = formatDuration(timeSec, timeSec >= 3600);
        outLaps.textContent = trimZeros((distance / 400).toFixed(2)) + " laps";
      } else {
        if (timeSec == null || !paceOk || paceSecPerKm == null || paceSecPerKm <= 0) { clearOutputs(); return; }
        var distResult = (timeSec / paceSecPerKm) * 1000;
        outDistance.textContent = formatDistance(distResult);
        outTime.textContent = formatDuration(timeSec, timeSec >= 3600);
        outPace.textContent = formatDuration(paceSecPerKm);
        outLaps.textContent = trimZeros((distResult / 400).toFixed(2)) + " laps";
      }
    }

    solveBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        solveMode = btn.dataset.solve;
        updateModeUI();
        recalc();
        saveState();
      });
    });
    distanceSel.addEventListener("change", function () {
      updateDistanceUI();
      recalc();
      saveState();
    });
    [distanceCustom, timeInput, paceInput].forEach(function (el) {
      el.addEventListener("input", function () {
        recalc();
        saveState();
      });
    });

    updateDistanceUI();
    updateModeUI();
    recalc();
  })();

  /* ============================================================
     RACE PREDICTOR  (Riegel's formula)
     ============================================================ */

  (function racePredictorTool() {
    var TARGET_DISTANCES = [
      { label: "1500 m", m: 1500 },
      { label: "3000 m", m: 3000 },
      { label: "5000 m", m: 5000 },
      { label: "10,000 m", m: 10000 },
      { label: "15,000 m", m: 15000 },
      { label: "Half marathon", m: 21097.5 },
      { label: "Marathon", m: 42195 },
    ];

    var distanceSel = document.getElementById("rp-distance");
    var distanceCustomWrap = document.getElementById("rp-distance-custom-wrap");
    var distanceCustom = document.getElementById("rp-distance-custom");
    var timeInput = document.getElementById("rp-time");
    var outTableBody = document.querySelector("#rp-out-table tbody");

    function currentDistance() {
      if (distanceSel.value === "custom") {
        var v = parseFloat(distanceCustom.value);
        return v > 0 ? v : null;
      }
      return parseFloat(distanceSel.value);
    }

    function updateDistanceUI() {
      distanceCustomWrap.hidden = distanceSel.value !== "custom";
    }

    function recalc() {
      setError("rp-error", "");
      var distance = currentDistance();
      markValid(distanceCustom, distanceSel.value !== "custom" || distance != null);
      var timeSec = parseTime(timeInput.value);
      markValid(timeInput, timeSec != null && timeSec > 0);

      if (!(distance > 0) || timeSec == null || timeSec <= 0) {
        outTableBody.innerHTML = "";
        return;
      }

      var rows = "";
      TARGET_DISTANCES.forEach(function (t) {
        var predicted = timeSec * Math.pow(t.m / distance, 1.06);
        var pace = predicted / (t.m / 1000);
        var isRef = Math.abs(t.m - distance) < 1;
        rows +=
          "<tr><td>" + t.label + (isRef ? " — yours" : "") + "</td>" +
          "<td>" + formatDuration(predicted, predicted >= 3600) + "</td>" +
          "<td>" + formatDuration(pace) + "</td></tr>";
      });
      outTableBody.innerHTML = rows;
    }

    distanceSel.addEventListener("change", function () {
      updateDistanceUI();
      recalc();
      saveState();
    });
    [distanceCustom, timeInput].forEach(function (el) {
      el.addEventListener("input", function () {
        recalc();
        saveState();
      });
    });

    updateDistanceUI();
    recalc();
  })();

  /* ============================================================
     EVEN SPLITS
     ============================================================ */

  (function evenSplitsTool() {
    var distanceSel = document.getElementById("sp-distance");
    var distanceCustomWrap = document.getElementById("sp-distance-custom-wrap");
    var distanceCustom = document.getElementById("sp-distance-custom");
    var timeInput = document.getElementById("sp-time");
    var splitSel = document.getElementById("sp-splitdist");
    var splitCustomWrap = document.getElementById("sp-splitdist-custom-wrap");
    var splitCustom = document.getElementById("sp-splitdist-custom");
    var outPace = document.getElementById("sp-out-pace");
    var outCount = document.getElementById("sp-out-count");
    var outTableBody = document.querySelector("#sp-out-table tbody");

    function currentDistance() {
      if (distanceSel.value === "custom") {
        var v = parseFloat(distanceCustom.value);
        return v > 0 ? v : null;
      }
      return parseFloat(distanceSel.value);
    }

    function currentSplitDist() {
      if (splitSel.value === "custom") {
        var v = parseFloat(splitCustom.value);
        return v > 0 ? v : null;
      }
      return parseFloat(splitSel.value);
    }

    function updateUI() {
      distanceCustomWrap.hidden = distanceSel.value !== "custom";
      splitCustomWrap.hidden = splitSel.value !== "custom";
    }

    function recalc() {
      setError("sp-error", "");
      var distance = currentDistance();
      markValid(distanceCustom, distanceSel.value !== "custom" || distance != null);
      var timeSec = parseTime(timeInput.value);
      markValid(timeInput, timeSec != null && timeSec > 0);
      var splitDist = currentSplitDist();
      markValid(splitCustom, splitSel.value !== "custom" || splitDist != null);

      if (!(distance > 0) || timeSec == null || timeSec <= 0 || !(splitDist > 0)) {
        outPace.textContent = "—";
        outCount.textContent = "—";
        outTableBody.innerHTML = "";
        return;
      }

      var paceSecPerKm = timeSec / (distance / 1000);
      outPace.textContent = formatDuration(paceSecPerKm) + " /km";

      var fullSplits = Math.floor(distance / splitDist + 1e-9);
      var remainder = distance - fullSplits * splitDist;
      var splitTime = paceSecPerKm * (splitDist / 1000);

      var rows = "";
      var cumTime = 0;
      var splitCount = 0;
      for (var i = 1; i <= fullSplits; i++) {
        cumTime += splitTime;
        splitCount++;
        rows +=
          "<tr><td>" + i + "</td><td>" + formatDistance(splitDist) + "</td>" +
          "<td>" + formatDuration(splitTime) + "</td><td>" + formatDuration(cumTime, cumTime >= 3600) + "</td></tr>";
      }
      if (remainder > 0.5) {
        var remTime = paceSecPerKm * (remainder / 1000);
        cumTime += remTime;
        splitCount++;
        rows +=
          "<tr><td>" + splitCount + "</td><td>" + formatDistance(remainder) + "</td>" +
          "<td>" + formatDuration(remTime) + "</td><td>" + formatDuration(cumTime, cumTime >= 3600) + "</td></tr>";
      }
      rows += '<tr><td>Total</td><td>' + formatDistance(distance) + "</td><td>—</td><td>" + formatDuration(timeSec, timeSec >= 3600) + "</td></tr>";
      outTableBody.innerHTML = rows;
      outCount.textContent = String(splitCount);
    }

    distanceSel.addEventListener("change", function () {
      updateUI();
      recalc();
      saveState();
    });
    splitSel.addEventListener("change", function () {
      updateUI();
      recalc();
      saveState();
    });
    [distanceCustom, timeInput, splitCustom].forEach(function (el) {
      el.addEventListener("input", function () {
        recalc();
        saveState();
      });
    });

    updateUI();
    recalc();
  })();

})();
