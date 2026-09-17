/* ============================================================
   De Agony of De Feet — Track Session Pace Planner
   ============================================================ */

(function () {
  "use strict";

  var MI_PER_KM = 1.609344;
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

  /* A pace field pairs a text input with a /KM /MI toggle button.
     Canonical value is always stored as seconds-per-kilometre. */
  function createPaceField(inputEl) {
    var unit = "km";
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
        secPerKm = unit === "km" ? t : t / MI_PER_KM;
        return true;
      },
      toggleUnit: function (btnEl) {
        unit = unit === "km" ? "mi" : "km";
        if (secPerKm != null) {
          var displaySec = unit === "km" ? secPerKm : secPerKm * MI_PER_KM;
          inputEl.value = formatDuration(displaySec);
        }
        btnEl.textContent = "/ " + (unit === "km" ? "KM" : "MI");
        btnEl.dataset.unit = unit;
      },
      get secPerKm() {
        return secPerKm;
      },
    };
  }

  /* ---------------- state persistence ---------------- */

  var PERSIST_IDS = [
    "iv-distance", "iv-distance-custom", "iv-reps", "iv-sets", "iv-reppace",
    "iv-cycle", "iv-recoveryfixed", "iv-setrest", "iv-recoverypace",
    "mf-hardpace-90", "mf-hardpace-60", "mf-hardpace-30", "mf-hardpace-15", "mf-floatpace", "mf-sets", "mf-setrest",
    "df-harddist", "df-floatdist", "df-harddur", "df-floatdur", "df-reps", "df-hardpace", "df-floatpace",
    "lad-distances", "lad-paces-data", "lad-recmode", "lad-ratio", "lad-fixed",
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
    var repPaceUnitBtn = document.getElementById("iv-reppace-unit");
    var repPaceEquiv = document.getElementById("iv-reppace-equiv");
    var recModeBtns = Array.prototype.slice.call(document.querySelectorAll('#iv-form .mode-switch button[data-recmode]'));
    var cycleWrap = document.getElementById("iv-cycle-wrap");
    var cycleInput = document.getElementById("iv-cycle");
    var recoveryFixedWrap = document.getElementById("iv-recoveryfixed-wrap");
    var recoveryFixedInput = document.getElementById("iv-recoveryfixed");
    var setRestInput = document.getElementById("iv-setrest");
    var recoveryPaceInput = document.getElementById("iv-recoverypace");
    var recoveryPaceUnitBtn = document.getElementById("iv-recoverypace-unit");

    var outRecovery = document.getElementById("iv-out-recovery");
    var outRecoveryDist = document.getElementById("iv-out-recovery-dist");
    var outTotalReps = document.getElementById("iv-out-totalreps");
    var outTotalDist = document.getElementById("iv-out-totaldist");
    var outTotalTime = document.getElementById("iv-out-totaltime");
    var outTableBody = document.querySelector("#iv-out-table tbody");
    var groupSummary = document.getElementById("iv-group-summary");
    var groupTableBody = document.querySelector("#iv-group-table tbody");
    var garminStepsEl = document.getElementById("iv-garmin-steps");

    var recoveryField = createPaceField(recoveryPaceInput);
    var repPaceField = createPaceField(repPaceInput);
    var recMode = "cycle";

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
      var distance = currentDistance();
      markValid(distanceCustom, distanceSel.value !== "custom" || distance != null);

      var reps = parseInt(repsInput.value, 10);
      markValid(repsInput, reps >= 1);
      var sets = parseInt(setsInput.value, 10);
      markValid(setsInput, sets >= 1);

      var repPaceOk = repPaceField.sync(false);
      var repTimeSec = repPaceOk && distance > 0 ? repPaceField.secPerKm * (distance / 1000) : null;

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

      var recModeValueOk = recMode === "cycle" ? cycleSec != null : recoveryFixedSec != null;
      if (
        !(distance > 0) || !(reps >= 1) || !(sets >= 1) ||
        repTimeSec == null || !recModeValueOk || setRestSec == null
      ) {
        outRecovery.textContent = "—";
        outRecoveryDist.textContent = "";
        outTotalReps.textContent = "—";
        outTotalDist.textContent = "—";
        outTotalTime.textContent = "—";
        outTableBody.innerHTML = "";
        repPaceEquiv.textContent = "";
        groupTableBody.innerHTML = "";
        groupSummary.textContent = "";
        garminStepsEl.innerHTML = "";
        return;
      }

      var paceKm = repPaceField.secPerKm;
      repPaceEquiv.textContent = "= " + formatDuration(repTimeSec) + " for " + formatDistance(distance);

      if (recMode === "cycle" && cycleSec <= repTimeSec) {
        setError("iv-error", "Cycle time (" + formatDuration(cycleSec) + ") must be longer than the rep time (" + formatDuration(repTimeSec) + ").");
        outRecovery.textContent = "—";
        outRecoveryDist.textContent = "";
        outTotalReps.textContent = "—";
        outTotalDist.textContent = "—";
        outTotalTime.textContent = "—";
        outTableBody.innerHTML = "";
        groupTableBody.innerHTML = "";
        groupSummary.textContent = "";
        garminStepsEl.innerHTML = "";
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

      var rows = "";
      for (var s = 1; s <= sets; s++) {
        rows +=
          "<tr><td>" + s + "</td>" +
          "<td>" + reps + " × " + formatDistance(distance) + "</td>" +
          "<td>" + formatDuration(paceKm) + "</td>" +
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
      groupTableBody.innerHTML = groupRows;

      var garminBlocks = [
        {
          repeat: reps,
          steps: [
            { label: "Interval", detail: garminDetail("Distance", formatDistance(distance), garminPaceRange(paceKm)) },
            { label: "Recovery", detail: garminDetail("Time", formatDuration(recoverySec), recoveryField.secPerKm ? garminPaceRange(recoveryField.secPerKm) : null) },
          ],
        },
      ];
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
    recModeBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        recMode = btn.dataset.recmode;
        updateRecModeUI();
        recalc();
        saveState();
      });
    });
    repPaceUnitBtn.addEventListener("click", function () {
      repPaceField.toggleUnit(repPaceUnitBtn);
      recalc();
      saveState();
    });
    recoveryPaceInput.addEventListener("input", function () {
      recalc();
      saveState();
    });
    recoveryPaceUnitBtn.addEventListener("click", function () {
      recoveryField.toggleUnit(recoveryPaceUnitBtn);
      recalc();
      saveState();
    });

    updateDistanceUI();
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
    var floatUnitBtn = document.getElementById("mf-floatpace-unit");
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
      var unitBtn = document.getElementById("mf-hardpace-" + p.key + "-unit");
      var field = createPaceField(input);
      hardFields[p.key] = field;
      input.addEventListener("input", function () { recalc(); saveState(); });
      unitBtn.addEventListener("click", function () { field.toggleUnit(unitBtn); recalc(); saveState(); });
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
    floatUnitBtn.addEventListener("click", function () { floatField.toggleUnit(floatUnitBtn); recalc(); saveState(); });
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
    var hardPaceUnitBtn = document.getElementById("df-hardpace-unit");
    var floatPaceInput = document.getElementById("df-floatpace");
    var floatPaceUnitBtn = document.getElementById("df-floatpace-unit");

    var outTotalDist = document.getElementById("df-out-totaldist");
    var outTotalTime = document.getElementById("df-out-totaltime");
    var outReps = document.getElementById("df-out-reps");
    var outTableBody = document.querySelector("#df-out-table tbody");
    var groupSummary = document.getElementById("df-group-summary");
    var groupTableBody = document.querySelector("#df-group-table tbody");
    var groupThMetric = document.getElementById("df-group-th-metric");
    var groupThTotal = document.getElementById("df-group-th-total");
    var garminStepsEl = document.getElementById("df-garmin-steps");

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
    hardPaceUnitBtn.addEventListener("click", function () { hardPaceField.toggleUnit(hardPaceUnitBtn); recalc(); saveState(); });
    floatPaceUnitBtn.addEventListener("click", function () { floatPaceField.toggleUnit(floatPaceUnitBtn); recalc(); saveState(); });

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
    var recModeSel = document.getElementById("lad-recmode");
    var ratioWrap = document.getElementById("lad-ratio-wrap");
    var ratioInput = document.getElementById("lad-ratio");
    var fixedWrap = document.getElementById("lad-fixed-wrap");
    var fixedInput = document.getElementById("lad-fixed");

    var outTotalDist = document.getElementById("lad-out-totaldist");
    var outRungs = document.getElementById("lad-out-rungs");
    var outTotalTime = document.getElementById("lad-out-totaltime");
    var outTableBody = document.querySelector("#lad-out-table tbody");
    var groupSummary = document.getElementById("lad-group-summary");
    var groupTheadRow = document.getElementById("lad-group-thead-row");
    var groupTableBody = document.querySelector("#lad-group-table tbody");
    var garminStepsEl = document.getElementById("lad-garmin-steps");

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
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "unit-toggle";
      btn.dataset.unit = "km";
      btn.textContent = "/ KM";
      fieldWrap.appendChild(input);
      fieldWrap.appendChild(btn);
      rowEl.appendChild(tagEl);
      rowEl.appendChild(fieldWrap);
      paceRowsContainer.appendChild(rowEl);
      var field = createPaceField(input);
      input.addEventListener("input", function () { recalc(); saveState(); });
      btn.addEventListener("click", function () { field.toggleUnit(btn); recalc(); saveState(); });
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

    function syncPresetPressed() {
      var current = distancesInput.value.replace(/\s+/g, "");
      presetBtns.forEach(function (btn) {
        btn.setAttribute("aria-pressed", btn.dataset.preset === current ? "true" : "false");
      });
    }

    function updateRecoveryModeUI() {
      var isFixed = recModeSel.value === "fixed";
      ratioWrap.hidden = isFixed;
      fixedWrap.hidden = !isFixed;
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

      var paceOk = true;
      paceRows.forEach(function (r) {
        if (!r.field.sync(false)) paceOk = false;
      });

      var recMode = recModeSel.value;
      var ratio = null, fixedRec = null;
      if (recMode === "ratio") {
        ratio = parseFloat(ratioInput.value);
        markValid(ratioInput, ratio != null && ratio >= 0 && !isNaN(ratio));
      } else {
        fixedRec = parseTime(fixedInput.value);
        markValid(fixedInput, fixedRec != null && fixedRec >= 0);
      }

      if (raw.length === 0) setError("lad-error", "Enter at least one rung distance, e.g. 400,800,1200.");
      else if (!paceOk) setError("lad-error", "Enter a valid pace for every rung.");
      else if (recMode === "ratio" && (ratio == null || isNaN(ratio) || ratio < 0)) setError("lad-error", "Recovery ratio must be zero or greater.");
      else if (recMode === "fixed" && fixedRec == null) setError("lad-error", "Enter a valid fixed recovery time.");

      if (raw.length === 0 || !paceOk || (recMode === "ratio" ? ratio == null || isNaN(ratio) : fixedRec == null)) {
        outTotalDist.textContent = "—";
        outRungs.textContent = "—";
        outTotalTime.textContent = "—";
        outTableBody.innerHTML = "";
        groupTableBody.innerHTML = "";
        groupSummary.textContent = "";
        garminStepsEl.innerHTML = "";
        return;
      }

      var cumDist = 0, cumTime = 0;
      var rows = "";
      raw.forEach(function (dist, i) {
        var paceKm = paceRows[i].field.secPerKm;
        var repTime = paceKm * (dist / 1000);
        var recovery = recMode === "fixed" ? fixedRec : ratio * repTime;
        var isLast = i === raw.length - 1;
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
      });
      outTableBody.innerHTML = rows;
      outTotalDist.textContent = formatDistance(cumDist);
      outRungs.textContent = String(raw.length);
      outTotalTime.textContent = formatDuration(cumTime, cumTime >= 3600);

      groupSummary.textContent =
        "— " + raw.map(formatDistance).join(" - ") +
        (recMode === "fixed" ? ", " + formatDuration(fixedRec) + " recovery" : ", " + ratio + "× rep-time recovery");
      var headHtml = "<th>Pace band</th>";
      raw.forEach(function (dist) { headHtml += "<th>" + formatDistance(dist) + "</th>"; });
      headHtml += "<th>Total</th>";
      groupTheadRow.innerHTML = headHtml;

      var groupRows = "";
      PACE_TIERS.forEach(function (offset) {
        var tierOk = paceRows.every(function (r) { return r.field.secPerKm + offset > 0; });
        if (!tierOk) return;
        var tCum = 0;
        var cellsHtml = "";
        raw.forEach(function (dist, i) {
          var tierPaceKm = paceRows[i].field.secPerKm + offset;
          var tRepTime = tierPaceKm * (dist / 1000);
          var tRecovery = recMode === "fixed" ? fixedRec : ratio * tRepTime;
          var isLast = i === raw.length - 1;
          tCum += tRepTime + (isLast ? 0 : tRecovery);
          cellsHtml += "<td>" + formatDuration(tRepTime) + "</td>";
        });
        var label = (offset > 0 ? "+" : "") + offset + "s/km";
        groupRows +=
          "<tr><td>" + label + "</td>" +
          cellsHtml +
          "<td>" + formatDuration(tCum, tCum >= 3600) + "</td></tr>";
      });
      groupTableBody.innerHTML = groupRows;

      var garminBlocks = [];
      raw.forEach(function (dist, i) {
        var paceKm = paceRows[i].field.secPerKm;
        var repTime = paceKm * (dist / 1000);
        garminBlocks.push({ label: "Rung " + (i + 1), detail: garminDetail("Distance", formatDistance(dist), garminPaceRange(paceKm)) });
        var isLast = i === raw.length - 1;
        if (!isLast) {
          var recovery = recMode === "fixed" ? fixedRec : ratio * repTime;
          garminBlocks.push({ label: "Recovery", detail: garminDetail("Time", formatDuration(recovery), null) });
        }
      });
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

    var initialRaw = distancesInput.value
      .split(",")
      .map(function (s) { return parseFloat(s.trim()); })
      .filter(function (n) { return !isNaN(n) && n > 0; });
    var savedPaces = (pacesDataInput.value || "").split(",").map(function (s) { return s.trim(); });
    ensurePaceRowCount(initialRaw.length, savedPaces.length === initialRaw.length ? savedPaces : null);
    updatePaceRowTags(initialRaw);

    updateRecoveryModeUI();
    syncPresetPressed();
    recalc();
  })();

})();
