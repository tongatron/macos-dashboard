const fmtNum = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 });
const HISTORY_LIMIT = 70;

const history = {
  cpu: [],
  mem: [],
  batt: [],
  rxMbps: [],
  txMbps: []
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "n/d";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${fmtNum.format(value)} ${units[index]}`;
}

function fmtRate(bytesPerSec) {
  if (bytesPerSec === null || bytesPerSec === undefined) return "n/d";
  return `${fmtBytes(bytesPerSec)}/s`;
}

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/d";
  return `${fmtNum.format(value)}%`;
}

function fmtUptime(seconds) {
  if (!Number.isFinite(seconds)) return "n/d";
  const total = Math.floor(seconds);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${d}g ${h}h ${m}m`;
}

function fmtNumber(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/d";
  return `${fmtNum.format(value)}${suffix}`;
}

function shortCommand(command) {
  if (!command) return "-";
  if (command.length <= 52) return command;
  return `${command.slice(0, 49)}...`;
}

function renderMetricRows(targetId, rows) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = rows
    .filter((row) => row && row[0])
    .map(
      ([label, value]) =>
        `<div class="metric-row"><span class="muted">${label}</span><strong class="mono">${value ?? "n/d"}</strong></div>`
    )
    .join("");
}

function pushHistory(key, value) {
  const safe = Number.isFinite(value) ? Number(value) : 0;
  history[key].push(safe);
  if (history[key].length > HISTORY_LIMIT) {
    history[key].shift();
  }
}

function createPolyline(series, min, max, width, height, pad) {
  if (!Array.isArray(series) || !series.length) return "";
  const span = max - min || 1;
  const points = series
    .map((value, index) => {
      const x = pad + (index / Math.max(series.length - 1, 1)) * (width - pad * 2);
      const y = pad + (1 - (value - min) / span) * (height - pad * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return points;
}

function renderSparkline(svgId, seriesList, options = {}) {
  const el = document.getElementById(svgId);
  if (!el) return;

  const width = 220;
  const height = 64;
  const pad = 4;
  const lines = Array.isArray(seriesList[0]) ? seriesList : [seriesList];
  const palette = options.colors || ["#57b6ff"];

  let max = options.max;
  let min = options.min;
  if (max === undefined || min === undefined) {
    let localMax = 1;
    let localMin = 0;
    for (const line of lines) {
      for (const value of line) {
        if (value > localMax) localMax = value;
        if (value < localMin) localMin = value;
      }
    }
    max = options.max ?? localMax;
    min = options.min ?? localMin;
  }

  const grid = [0.25, 0.5, 0.75]
    .map((r) => {
      const y = (height * r).toFixed(2);
      return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(150,180,205,0.12)" stroke-width="1" />`;
    })
    .join("");

  const paths = lines
    .map((line, i) => {
      const points = createPolyline(line, min, max, width, height, pad);
      if (!points) return "";
      return `<polyline points="${points}" fill="none" stroke="${palette[i] || palette[0]}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />`;
    })
    .join("");

  el.innerHTML = `${grid}${paths}`;
}

function renderTimeline(svgId, seriesList, options = {}) {
  const el = document.getElementById(svgId);
  if (!el) return;

  const width = 640;
  const height = 86;
  const pad = 5;
  const lines = Array.isArray(seriesList[0]) ? seriesList : [seriesList];
  const colors = options.colors || ["#3df8cf"];

  let max = options.max;
  let min = options.min;
  if (max === undefined || min === undefined) {
    let computedMax = 1;
    let computedMin = 0;
    for (const line of lines) {
      for (const value of line) {
        if (value > computedMax) computedMax = value;
        if (value < computedMin) computedMin = value;
      }
    }
    max = options.max ?? computedMax;
    min = options.min ?? computedMin;
  }

  const grid = [0.2, 0.4, 0.6, 0.8]
    .map((r) => {
      const y = (height * r).toFixed(2);
      return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(150,180,205,0.11)" stroke-width="1" />`;
    })
    .join("");

  const paths = lines
    .map((line, index) => {
      const points = createPolyline(line, min, max, width, height, pad);
      if (!points) return "";
      return `<polyline points="${points}" fill="none" stroke="${colors[index] || colors[0]}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />`;
    })
    .join("");

  el.innerHTML = `${grid}${paths}`;
}

function setGauge(id, percent, label) {
  const gauge = document.getElementById(id);
  if (!gauge) return;
  gauge.style.setProperty("--p", String(clamp(percent, 0, 100)));
  const span = gauge.querySelector("span");
  if (span) span.textContent = label;
}

function renderSystemQuick(data, cpuBusy, memUsedPct, rxMbps, txMbps) {
  const el = document.getElementById("system-quick");
  const rows = [
    ["Modello", data?.hardware?.modelName || "n/d"],
    ["Chip", data?.hardware?.chip || "n/d"],
    ["OS", data?.system?.osName && data?.system?.osVersion ? `${data.system.osName} ${data.system.osVersion}` : "n/d"],
    ["Uptime", fmtUptime(data?.system?.uptimeSeconds)],
    ["Core", data?.hardware?.totalCores || data?.cpu?.cores?.logical || "n/d"],
    ["CPU Busy", fmtPct(cpuBusy)],
    ["RAM Used", fmtPct(memUsedPct)],
    ["Interfaccia", data?.network?.primaryInterface || "n/d"],
    ["IPv4", data?.network?.ipv4 || "n/d"],
    ["Net Live", `${fmtNum.format(rxMbps)} / ${fmtNum.format(txMbps)} Mbps`]
  ];

  el.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span class="muted">${k}</span><strong class="mono">${v}</strong></div>`)
    .join("");
}

function renderSensorPills(data) {
  const el = document.getElementById("sensor-compact");
  const battery = data?.power?.battery || {};
  const pills = [
    `Batt ${battery.percent ?? "n/d"}%`,
    `Cycle ${battery.cycleCount ?? "n/d"}`,
    `Temp ${battery.temperatureC != null ? `${battery.temperatureC}C` : "n/d"}`,
    `Volt ${battery.voltageMv != null ? `${battery.voltageMv}mV` : "n/d"}`,
    `Amp ${battery.amperageMa != null ? `${battery.amperageMa}mA` : "n/d"}`,
    `Power ${data?.power?.source || "n/d"}`,
    `${battery.isCharging ? "Charging" : "Not Charging"}`
  ];

  el.innerHTML = pills.map((pill) => `<span class="pill">${pill}</span>`).join("");
}

function renderPills(targetId, items) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) {
    el.innerHTML = '<span class="pill">n/d</span>';
    return;
  }
  el.innerHTML = list.map((item) => `<span class="pill">${item}</span>`).join("");
}

function renderStorage(storageList) {
  const el = document.getElementById("storage-bars");
  if (!el) return;

  const volumes = Array.isArray(storageList?.volumes) ? storageList.volumes : [];
  const usable = volumes
    .filter((disk) => disk && disk.capacityPercent != null && disk.sizeBytes > 1024 ** 3)
    .slice(0, 6);

  if (!usable.length) {
    el.innerHTML = '<p class="muted mono">Nessun dato storage</p>';
    return;
  }

  el.innerHTML = usable
    .map((disk) => {
      const pct = clamp(Number(disk.capacityPercent) || 0, 0, 100);
      return `
        <div class="storage-item">
          <div class="head">
            <span class="mono muted">${disk.mountedOn}</span>
            <strong class="mono">${fmtPct(pct)}</strong>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <small class="mono muted">${fmtBytes(disk.usedBytes)} / ${fmtBytes(disk.sizeBytes)}</small>
        </div>
      `;
    })
    .join("");
}

function renderProcesses(processes) {
  const body = document.getElementById("proc-body");
  if (!body) return;
  const rows = (Array.isArray(processes) ? processes : []).slice(0, 8);

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="mono muted">Nessun dato processi</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map((proc) => {
      const parentLabel = proc.parentCommand ? shortCommand(proc.parentCommand) : proc.parentPid != null ? `PID ${proc.parentPid}` : "n/d";
      const openLabel = proc.openFileCount != null ? fmtNumber(proc.openFileCount) : "n/d";
      const socketLabel = proc.openSocketCount != null ? fmtNumber(proc.openSocketCount) : "n/d";
      const sampleLabel = Array.isArray(proc.openSamples) && proc.openSamples.length ? shortCommand(proc.openSamples[0]) : "";
      return `
      <tr>
        <td class="mono">${proc.pid}</td>
        <td class="mono">${fmtPct(proc.cpuPercent)}<div class="cell-sub">E ${proc.energyImpact != null ? fmtNumber(proc.energyImpact) : "n/d"}</div></td>
        <td class="mono">${fmtPct(proc.memPercent)}<div class="cell-sub">Net ${proc.netTotalBytes != null ? fmtBytes(proc.netTotalBytes) : "n/d"}</div></td>
        <td class="mono">${proc.threadCount != null ? fmtNumber(proc.threadCount) : "n/d"}</td>
        <td class="mono">${openLabel}<div class="cell-sub">sock ${socketLabel}</div></td>
        <td><div class="proc-main mono">${shortCommand(proc.command)}</div><div class="cell-sub">Parent ${parentLabel}</div>${sampleLabel ? `<div class="cell-sub">Open ${sampleLabel}</div>` : ""}</td>
      </tr>
    `;
    })
    .join("");
}
function renderCoreGrid(perCore) {
  const el = document.getElementById("cpu-core-grid");
  if (!el) return;
  const cores = (Array.isArray(perCore) ? perCore : []).slice(0, 8);

  if (!cores.length) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = cores
    .map((core) => {
      const usage = clamp(Number(core.usagePercent || 0), 0, 100);
      return `
        <div class="core-item">
          <div class="head">
            <span class="muted mono">Core ${core.index + 1}</span>
          </div>
          <div class="core-value mono">${fmtPct(core.usagePercent)}</div>
          <div class="mini-track"><div class="mini-fill" style="width:${usage}%"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderPowerMetrics(powermetrics) {
  if (!powermetrics?.available) {
    renderMetricRows("power-metrics", [["powermetrics", powermetrics?.reason || "Non disponibile"]]);
    return;
  }

  renderMetricRows("power-metrics", [
    ["CPU Power", fmtNumber(powermetrics.cpuPowerMw, " mW")],
    ["GPU Power", fmtNumber(powermetrics.gpuPowerMw, " mW")],
    ["ANE Power", fmtNumber(powermetrics.anePowerMw, " mW")],
    ["CPU Avg Freq", fmtNumber(powermetrics.cpuAverageFrequencyMHz, " MHz")],
    ["P Cluster", fmtNumber(powermetrics.pClusterFrequencyMHz, " MHz")],
    ["E Cluster", fmtNumber(powermetrics.eClusterFrequencyMHz, " MHz")]
  ]);
}

function renderConnections(network) {
  const activityEl = document.getElementById("conn-list");
  const sampleEl = document.getElementById("conn-sample");
  if (!activityEl) return;

  const activityRows = Array.isArray(network?.topProcesses) ? network.topProcesses.slice(0, 5) : [];
  if (!activityRows.length) {
    activityEl.innerHTML = '<div class="conn-item"><div class="top"><span class="muted">Nessuna attivita rete</span></div></div>';
  } else {
    activityEl.innerHTML = activityRows
      .map(
        (row) => `
          <div class="conn-item">
            <div class="top">
              <strong class="mono">${row.process || "proc"}</strong>
              <span class="mono muted">${row.pid != null ? `PID ${row.pid}` : row.state || ""}</span>
            </div>
            <div class="bottom mono">RX ${fmtBytes(row.bytesIn)} · TX ${fmtBytes(row.bytesOut)} · Tot ${fmtBytes(row.totalBytes)}</div>
          </div>
        `
      )
      .join("");
  }

  if (!sampleEl) return;
  const sampleRows = Array.isArray(network?.connections?.processes) ? network.connections.processes.slice(0, 4) : [];
  if (!sampleRows.length) {
    sampleEl.innerHTML = '<div class="conn-item"><div class="top"><span class="muted">Nessuna connessione attiva</span></div></div>';
    return;
  }

  sampleEl.innerHTML = sampleRows
    .map(
      (row) => `
        <div class="conn-item">
          <div class="top">
            <strong class="mono">${row.process || "proc"}</strong>
            <span class="mono muted">${row.state || row.protocol || ""}</span>
          </div>
          <div class="bottom mono">${row.remoteAddress || row.localAddress || "n/d"}</div>
        </div>
      `
    )
    .join("");
}

function renderInventory(environment) {
  const inventory = environment?.inventory || {};
  const peripherals = environment?.peripherals || {};
  const graphics = inventory.graphics || {};
  const bluetooth = inventory.bluetooth || {};
  const audio = inventory.audio || {};
  const thunderbolt = peripherals.thunderbolt || {};
  const usb = peripherals.usb || {};

  renderMetricRows("inventory-summary", [
    ["GPU", graphics.gpuName || "n/d"],
    ["GPU Cores", fmtNumber(graphics.gpuCoreCount)],
    ["Metal", graphics.metalSupport || "n/d"],
    ["Display Count", fmtNumber(Array.isArray(graphics.displays) ? graphics.displays.length : 0)],
    ["Bluetooth", bluetooth.state || "n/d"],
    ["Paired BT", fmtNumber(Array.isArray(bluetooth.pairedDevices) ? bluetooth.pairedDevices.length : 0)],
    ["Audio Devices", fmtNumber(Array.isArray(audio.devices) ? audio.devices.length : 0)],
    ["Default Out", audio.defaultOutput || audio.defaultSystemOutput || "n/d"]
  ]);

  renderMetricRows("peripheral-summary", [
    ["TB Buses", fmtNumber(thunderbolt.busCount)],
    ["TB Devices", fmtNumber(Array.isArray(thunderbolt.connectedDevices) ? thunderbolt.connectedDevices.length : 0)],
    ["USB Devices", fmtNumber(Array.isArray(usb.devices) ? usb.devices.length : 0)],
    [
      "TB Ports Ready",
      fmtNumber(
        Array.isArray(thunderbolt.ports)
          ? thunderbolt.ports.filter((item) => String(item.status || "").toLowerCase().includes("no device")).length
          : 0
      )
    ]
  ]);

  renderPills("inventory-pills", [
    ...(Array.isArray(graphics.displays) ? graphics.displays.slice(0, 3).map((item) => `Display ${item.name}`) : []),
    ...(Array.isArray(thunderbolt.connectedDevices)
      ? thunderbolt.connectedDevices.slice(0, 3).map((item) => `TB ${item}`)
      : []),
    ...(Array.isArray(usb.devices) ? usb.devices.slice(0, 3).map((item) => `USB ${item}`) : []),
    ...(Array.isArray(bluetooth.pairedDevices)
      ? bluetooth.pairedDevices.slice(0, 4).map((item) => `BT ${item.name}`)
      : []),
    ...(Array.isArray(audio.devices) ? audio.devices.slice(0, 3).map((item) => `Audio ${item.name}`) : [])
  ]);
}

function renderSecurity(environment) {
  const security = environment?.security || {};
  const sessions = environment?.sessions || {};

  renderMetricRows("security-summary", [
    ["FileVault", security.fileVault || "n/d"],
    ["Gatekeeper", security.gatekeeper || "n/d"],
    ["SIP", security.sip || "n/d"],
    ["Firewall", security.firewall || "n/d"],
    ["Sessioni", fmtNumber(sessions.count)],
    ["Utenti", Array.isArray(sessions.users) && sessions.users.length ? sessions.users.join(", ") : "n/d"]
  ]);

  renderPills(
    "session-pills",
    Array.isArray(sessions.sessions)
      ? sessions.sessions.slice(0, 6).map((session) => `${session.user || "user"} @ ${session.terminal || "tty"}`)
      : []
  );
}

function renderSoftware(environment) {
  const software = environment?.software || {};
  const available = software.available || {};
  const history = Array.isArray(software.history) ? software.history : [];

  renderMetricRows("software-summary", [
    ["Status", available.status || "unknown"],
    ["Updates", fmtNumber(Array.isArray(available.updates) ? available.updates.length : 0)],
    [
      "Top Update",
      Array.isArray(available.updates) && available.updates.length
        ? available.updates[0].title || available.updates[0].label || "update"
        : "n/d"
    ],
    ["Recent History", fmtNumber(history.length)]
  ]);

  renderPills(
    "software-pills",
    history.slice(0, 5).map((item) => `${item.name} ${item.version}`)
  );
}

function renderServices(services) {
  const data = services || {};
  renderMetricRows("services-summary", [
    ["Listening", fmtNumber(data.count)],
    ["Public", fmtNumber(data.publicCount)],
    ["Local Only", fmtNumber(data.localOnlyCount)],
    ["Sample", fmtNumber(Array.isArray(data.sample) ? data.sample.length : 0)]
  ]);

  renderPills(
    "services-pills",
    Array.isArray(data.sample)
      ? data.sample.slice(0, 6).map((item) => `${item.process} ${item.endpoint}`)
      : []
  );
}

function renderAlerts(alerts) {
  const el = document.getElementById("alert-list");
  if (!el) return;
  const rows = Array.isArray(alerts) ? alerts : [];
  if (!rows.length) {
    el.innerHTML = '<span class="pill alert ok">No critical alerts</span>';
    return;
  }

  el.innerHTML = rows
    .map((item) => `<span class="pill alert ${item.severity || "warn"}">${item.label}: ${item.detail}</span>`)
    .join("");
}

function renderRemoteTargets(remoteTargets) {
  const hostEl = document.getElementById("remote-hosts");
  const domainEl = document.getElementById("remote-domains");
  const hosts = Array.isArray(remoteTargets?.hosts) ? remoteTargets.hosts : [];
  const domains = Array.isArray(remoteTargets?.domains) ? remoteTargets.domains : [];

  if (hostEl) {
    hostEl.innerHTML = hosts.length
      ? hosts
          .map(
            (item) => `
              <div class="conn-item">
                <div class="top">
                  <strong class="mono">${item.hostname || item.host}</strong>
                  <span class="mono muted">${fmtNumber(item.connectionCount)} conn</span>
                </div>
                <div class="bottom mono">${item.host}${item.sampleProcess ? ` · ${item.sampleProcess}` : ""}</div>
              </div>
            `
          )
          .join("")
      : '<div class="conn-item"><div class="top"><span class="muted">Nessun host remoto</span></div></div>';
  }

  if (domainEl) {
    domainEl.innerHTML = domains.length
      ? domains.map((item) => `<span class="pill">${item.domain} · ${fmtNumber(item.connectionCount)}</span>`).join("")
      : '<span class="pill">n/d</span>';
  }
}

function renderPersistentHistory(historyData) {
  const hour = Array.isArray(historyData?.windows?.hour) ? historyData.windows.hour : [];
  const day = Array.isArray(historyData?.windows?.day) ? historyData.windows.day : [];
  const hourCpu = hour.map((point) => Number(point.cpuBusy || 0));
  const hourMem = hour.map((point) => Number(point.memUsedPct || 0));
  const hourBatt = hour.map((point) => Number(point.battPct || 0));
  const dayCpu = day.map((point) => Number(point.cpuBusy || 0));
  const dayMem = day.map((point) => Number(point.memUsedPct || 0));
  const dayBatt = day.map((point) => Number(point.battPct || 0));

  renderTimeline("hist-1h", [hourCpu, hourMem, hourBatt], {
    min: 0,
    max: 100,
    colors: ["#2d6a4f", "#2b6cb0", "#b7791f"]
  });
  renderTimeline("hist-24h", [dayCpu, dayMem, dayBatt], {
    min: 0,
    max: 100,
    colors: ["#2d6a4f", "#2b6cb0", "#b7791f"]
  });

  const hourLast = hour[hour.length - 1];
  const dayLast = day[day.length - 1];
  const historyMeta = document.getElementById("history-meta");
  const hourNow = document.getElementById("hist-1h-now");
  const dayNow = document.getElementById("hist-24h-now");

  if (historyMeta) historyMeta.textContent = `${historyData?.sampleIntervalMinutes || 1}m samples`;
  if (hourNow) {
    hourNow.textContent = hourLast
      ? `CPU ${fmtPct(hourLast.cpuBusy)} · RAM ${fmtPct(hourLast.memUsedPct)} · Batt ${fmtPct(hourLast.battPct)}`
      : "n/d";
  }
  if (dayNow) {
    dayNow.textContent = dayLast
      ? `CPU ${fmtPct(dayLast.cpuBusy)} · RAM ${fmtPct(dayLast.memUsedPct)} · Batt ${fmtPct(dayLast.battPct)}`
      : "n/d";
  }
}

function renderEventHistory(events) {
  const powerEl = document.getElementById("power-event-list");
  const crashEl = document.getElementById("crash-report-list");
  const powerEvents = Array.isArray(events?.power) ? events.power : [];
  const crashes = Array.isArray(events?.crashes) ? events.crashes : [];

  if (powerEl) {
    powerEl.innerHTML = powerEvents.length
      ? powerEvents
          .slice(0, 6)
          .map(
            (item) => `
              <div class="conn-item">
                <div class="top">
                  <strong class="mono">${item.type}</strong>
                  <span class="mono muted">${item.timestamp.slice(11, 19)}</span>
                </div>
                <div class="bottom mono">${item.detail}</div>
              </div>
            `
          )
          .join("")
      : '<div class="conn-item"><div class="top"><span class="muted">Nessun evento power recente</span></div></div>';
  }

  if (crashEl) {
    crashEl.innerHTML = crashes.length
      ? crashes
          .slice(0, 6)
          .map(
            (item) => `
              <div class="conn-item">
                <div class="top">
                  <strong class="mono">${item.appName || item.fileName}</strong>
                  <span class="mono muted">${String(item.timestamp).slice(11, 19)}</span>
                </div>
                <div class="bottom mono">${item.responsibleProc || item.fileName}${item.bugType ? ` · bug ${item.bugType}` : ""}</div>
              </div>
            `
          )
          .join("")
      : '<div class="conn-item"><div class="top"><span class="muted">Nessun crash report recente</span></div></div>';
  }
}

function renderThermalChip(data) {
  const chip = document.getElementById("thermal-chip");
  const notes = data?.power?.thermal?.notes || [];
  const hasWarning = Boolean(data?.power?.thermal?.isWarning);

  chip.className = "chip";
  if (hasWarning) {
    chip.classList.add("danger");
    chip.textContent = "Thermal Alert";
    return;
  }

  const hasOnlyNoMsg = notes.some((line) => /\bno\b/i.test(String(line)));
  if (hasOnlyNoMsg) {
    chip.classList.add("ok");
    chip.textContent = "Thermal OK";
  } else {
    chip.classList.add("warn");
    chip.textContent = "Thermal Check";
  }
}

function render(data, historyData) {
  const hostName = document.getElementById("host-name");
  const rigLine = document.getElementById("rig-line");
  const lastUpdate = document.getElementById("last-update");

  const cpuBusy = clamp((data?.cpu?.usage?.userPercent || 0) + (data?.cpu?.usage?.systemPercent || 0), 0, 100);
  const memUsedPct =
    data?.memory?.usedBytes && data?.memory?.totalBytes
      ? clamp((data.memory.usedBytes / data.memory.totalBytes) * 100, 0, 100)
      : 0;
  const battPct = clamp(Number(data?.power?.battery?.percent || 0), 0, 100);
  const wifi = data?.network?.wifi || {};
  const connections = data?.network?.connections || {};
  const storageState = data?.storage || {};
  const memoryPressure = data?.memory?.pressure || {};
  const swap = data?.memory?.swap || {};
  const environment = data?.environment || {};
  const services = data?.services || {};

  const rxBps = Number(data?.network?.rxRateBps || 0);
  const txBps = Number(data?.network?.txRateBps || 0);
  const rxMbps = Math.max(0, (rxBps * 8) / 1_000_000);
  const txMbps = Math.max(0, (txBps * 8) / 1_000_000);

  pushHistory("cpu", cpuBusy);
  pushHistory("mem", memUsedPct);
  pushHistory("batt", battPct);
  pushHistory("rxMbps", rxMbps);
  pushHistory("txMbps", txMbps);

  hostName.textContent = data?.system?.hostname || "Mac";
  rigLine.textContent = [
    data?.hardware?.modelName,
    data?.hardware?.chip,
    data?.system?.osVersion ? `macOS ${data.system.osVersion}` : null,
    data?.network?.primaryInterface ? `IF ${data.network.primaryInterface}` : null
  ]
    .filter(Boolean)
    .join(" | ");

  lastUpdate.textContent = `Update: ${new Date(data.timestamp).toLocaleTimeString("it-IT")}`;

  setGauge("cpu-gauge", cpuBusy, fmtPct(cpuBusy));
  setGauge("mem-gauge", memUsedPct, fmtPct(memUsedPct));
  setGauge("batt-gauge", battPct, fmtPct(battPct));

  document.getElementById("cpu-meta").textContent = `Load ${
    data?.system?.loadAvg?.[0] != null ? fmtNum.format(data.system.loadAvg[0]) : "n/d"
  }`;
  document.getElementById("mem-meta").textContent = `${fmtBytes(data?.memory?.usedBytes)} / ${fmtBytes(
    data?.memory?.totalBytes
  )}`;
  document.getElementById("batt-meta").textContent = `${data?.power?.battery?.state || "n/d"} | ${
    data?.power?.source || "n/d"
  }`;
  document.getElementById("net-meta").textContent = `${wifi.phyMode || data?.network?.ipv4 || "n/d"}`;
  document.getElementById("net-rx").textContent = fmtRate(rxBps);
  document.getElementById("net-tx").textContent = fmtRate(txBps);

  renderSparkline("cpu-spark", history.cpu, { min: 0, max: 100, colors: ["#2d6a4f"] });
  renderSparkline("mem-spark", history.mem, { min: 0, max: 100, colors: ["#2b6cb0"] });
  renderSparkline("batt-spark", history.batt, { min: 0, max: 100, colors: ["#b7791f"] });

  const netMax = Math.max(1, ...history.rxMbps, ...history.txMbps);
  renderSparkline("net-spark", [history.rxMbps, history.txMbps], {
    min: 0,
    max: netMax,
    colors: ["#0f766e", "#b45309"]
  });

  renderTimeline("tl-cpu", history.cpu, { min: 0, max: 100, colors: ["#2d6a4f"] });
  renderTimeline("tl-mem", history.mem, { min: 0, max: 100, colors: ["#2b6cb0"] });
  renderTimeline("tl-net", [history.rxMbps, history.txMbps], {
    min: 0,
    max: netMax,
    colors: ["#0f766e", "#b45309"]
  });

  document.getElementById("tl-cpu-now").textContent = fmtPct(cpuBusy);
  document.getElementById("tl-mem-now").textContent = fmtPct(memUsedPct);
  document.getElementById("tl-net-now").textContent = `${fmtNum.format(rxMbps)} / ${fmtNum.format(txMbps)} Mbps`;

  renderSystemQuick(data, cpuBusy, memUsedPct, rxMbps, txMbps);
  renderSensorPills(data);
  renderAlerts(data?.alerts);
  renderRemoteTargets(data?.network?.remoteTargets);
  renderPersistentHistory(historyData);
  renderEventHistory(data?.events);
  renderThermalChip(data);
  renderStorage(storageState);
  renderProcesses(data?.processes);
  renderConnections(data?.network);
  renderCoreGrid(data?.cpu?.cores?.perCore);
  renderPowerMetrics(data?.power?.powermetrics);
  renderInventory(environment);
  renderSecurity(environment);
  renderSoftware(environment);
  renderServices(services);

  renderMetricRows("mem-extra", [
    ["Free", fmtPct(memoryPressure.freePercent)],
    ["Swap Used", fmtBytes(swap.usedBytes)],
    ["Swap Total", fmtBytes(swap.totalBytes)],
    ["Pageouts", fmtNumber(memoryPressure.pageouts)]
  ]);

  renderMetricRows("battery-extra", [
    ["Condition", data?.power?.battery?.condition || "n/d"],
    ["Cycles", fmtNumber(data?.power?.battery?.cycleCount)],
    ["Temp", data?.power?.battery?.temperatureC != null ? `${fmtNum.format(data.power.battery.temperatureC)} C` : "n/d"],
    ["Charger", fmtNumber(data?.power?.battery?.chargerWatt, " W")]
  ]);

  renderMetricRows("net-extra", [
    ["Wi-Fi", wifi.status || "n/d"],
    ["Channel", wifi.channel || "n/d"],
    ["Signal", wifi.signalDbm != null ? `${wifi.signalDbm} dBm` : "n/d"],
    ["Noise", wifi.noiseDbm != null ? `${wifi.noiseDbm} dBm` : "n/d"],
    ["Rate", fmtNumber(wifi.transmitRateMbps, " Mbps")],
    ["TCP EST", fmtNumber(connections.establishedCount)],
    ["Top Net Proc", data?.network?.topProcesses?.[0]?.process || "n/d"]
  ]);

  renderMetricRows("disk-io", [
    ["Throughput", fmtNumber(storageState?.io?.totals?.throughputMBps, " MB/s")],
    ["IOPS", fmtNumber(storageState?.io?.totals?.iops)],
    ["Disk 0", storageState?.io?.devices?.[0]?.throughputMBps != null ? `${fmtNum.format(storageState.io.devices[0].throughputMBps)} MB/s` : "n/d"],
    ["Disk 4", storageState?.io?.devices?.[1]?.throughputMBps != null ? `${fmtNum.format(storageState.io.devices[1].throughputMBps)} MB/s` : "n/d"]
  ]);
}

async function fetchSnapshot() {
  const response = await fetch("/api/snapshot", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchPersistentHistory() {
  const response = await fetch("/api/history", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function update(refreshStatusEl) {
  try {
    const [data, historyData] = await Promise.all([fetchSnapshot(), fetchPersistentHistory().catch(() => null)]);
    render(data, historyData);
    refreshStatusEl.textContent = "Auto refresh: 3s";
  } catch (error) {
    refreshStatusEl.textContent = `Errore: ${error instanceof Error ? error.message : "sconosciuto"}`;
  }
}

function init() {
  const refreshBtn = document.getElementById("refresh-btn");
  const refreshStatusEl = document.getElementById("refresh-status");

  refreshBtn.addEventListener("click", () => update(refreshStatusEl));

  update(refreshStatusEl);
  setInterval(() => update(refreshStatusEl), 3000);
}

init();
