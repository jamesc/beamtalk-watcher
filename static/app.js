// Beamtalk Watcher — Dashboard live-update script
// Polls /api/status every 5 seconds and updates the status table.

(function () {
  "use strict";

  var POLL_INTERVAL = 5000;

  function createCell(text) {
    var td = document.createElement("td");
    td.textContent = text;
    return td;
  }

  function updateStatusTable(data) {
    var table = document.querySelector("table");
    if (!table) return;

    var tbody = table.querySelector("tbody");
    if (!tbody) {
      tbody = document.createElement("tbody");
      table.appendChild(tbody);
    }

    // Remove existing body rows
    while (tbody.firstChild) {
      tbody.removeChild(tbody.firstChild);
    }

    // Build new rows from the status data using safe DOM methods
    data.forEach(function (entry) {
      var status = entry.status || "unknown";
      var colorClass =
        status === "ok" ? "green" : status === "fail" ? "red" : "grey";
      var name = entry.name || "";
      var detail =
        entry.lastResult && entry.lastResult.details
          ? entry.lastResult.details
          : "";

      var tr = document.createElement("tr");
      tr.className = colorClass;
      tr.appendChild(createCell(name));
      tr.appendChild(createCell(status));
      tr.appendChild(createCell(detail));
      tbody.appendChild(tr);
    });
  }

  function poll() {
    fetch("/api/status")
      .then(function (resp) {
        return resp.json();
      })
      .then(function (data) {
        updateStatusTable(data);
      })
      .catch(function () {
        // Silently ignore fetch errors — next poll will retry
      });
  }

  // Initial poll on load, then repeat every POLL_INTERVAL ms
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", poll);
  } else {
    poll();
  }

  setInterval(poll, POLL_INTERVAL);
})();
