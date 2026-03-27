"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const dns = require("dns").promises;
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3492);
const STATIC_DIR = path.join(__dirname, "public");
const IS_PACKAGED_APP = Boolean(process.versions.electron && process.resourcesPath && __dirname.includes("app.asar"));
const DATA_ROOT = process.env.MAC_DASHBOARD_DATA_DIR
  || (IS_PACKAGED_APP ? path.join(os.homedir(), "Library", "Application Support", "Mac Sensors Dashboard") : __dirname);
const DATA_DIR = path.join(DATA_ROOT, "data");
const HISTORY_FILE = path.join(DATA_DIR, "telemetry-history.json");
const HISTORY_INTERVAL_MS = 60 * 1000;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 24 * 60 + 30;

fs.mkdirSync(DATA_DIR, { recursive: true });

let previousNetSample = null;
let previousCpuSamples = null;
let previousDiskCounters = null;
let powermetricsCache = {
  timestampMs: 0,
  data: null,
  promise: null
};
let environmentCache = {
  timestampMs: 0,
  data: null,
  promise: null
};
let servicesCache = {
  timestampMs: 0,
  data: null,
  promise: null
};
let eventsCache = {
  timestampMs: 0,
  data: null,
  promise: null
};
const dnsReverseCache = new Map();
let persistentHistory = loadPersistentHistory();

async function runCommand(command, args = [], timeout = 4000) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8"
    });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["yes", "true", "1"].includes(normalized)) return true;
    if (["no", "false", "0"].includes(normalized)) return false;
  }
  return null;
}

function formatCommandErrorSafe(value, fallback = null) {
  return value && value.length ? value : fallback;
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function loadPersistentHistory() {
  const raw = safeReadJson(HISTORY_FILE, { samples: [] });
  const samples = Array.isArray(raw?.samples)
    ? raw.samples.filter((sample) => sample && sample.timestamp).slice(-HISTORY_LIMIT)
    : [];
  return { samples };
}

function persistHistoryStore() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(persistentHistory, null, 2));
}

function appendPersistentHistorySample(sample) {
  if (!sample || !sample.timestamp) return;
  const timestampMs = Date.parse(sample.timestamp);
  if (!Number.isFinite(timestampMs)) return;

  const lastSample = persistentHistory.samples[persistentHistory.samples.length - 1];
  const lastMs = lastSample ? Date.parse(lastSample.timestamp) : 0;
  if (lastMs && timestampMs - lastMs < HISTORY_INTERVAL_MS) return;

  persistentHistory.samples.push(sample);
  const cutoff = timestampMs - HISTORY_RETENTION_MS;
  persistentHistory.samples = persistentHistory.samples
    .filter((item) => Date.parse(item.timestamp) >= cutoff)
    .slice(-HISTORY_LIMIT);
  persistHistoryStore();
}

function buildHistoryPayload() {
  const nowMs = Date.now();
  const points = Array.isArray(persistentHistory.samples) ? persistentHistory.samples : [];
  return {
    generatedAt: new Date(nowMs).toISOString(),
    sampleIntervalMinutes: 1,
    windows: {
      hour: points.filter((point) => nowMs - Date.parse(point.timestamp) <= 60 * 60 * 1000),
      day: points.filter((point) => nowMs - Date.parse(point.timestamp) <= 24 * 60 * 60 * 1000)
    }
  };
}

function parseKeyValueColonText(text) {
  const map = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
    if (!match) continue;
    map[match[1].trim()] = match[2].trim();
  }
  return map;
}

function parseIoregProperties(text) {
  const props = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*"([^"]+)"\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    let raw = match[2].trim();
    if (raw.endsWith(",")) raw = raw.slice(0, -1);
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    if (raw === "Yes") raw = true;
    if (raw === "No") raw = false;
    const numeric = Number(raw);
    props[match[1]] = Number.isFinite(numeric) ? numeric : raw;
  }
  return props;
}

function parseVmStat(text) {
  if (!text) return {};
  const lines = text.split("\n").filter(Boolean);
  const first = lines[0] || "";
  const pageSizeMatch = first.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;

  const pages = {};
  for (const line of lines.slice(1)) {
    const m = line.match(/^([^:]+):\s+([0-9.]+)/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    pages[key] = Number(String(m[2]).replace(/\./g, ""));
  }

  const active = pages.pages_active || 0;
  const inactive = pages.pages_inactive || 0;
  const wired = pages.pages_wired_down || 0;
  const speculative = pages.pages_speculative || 0;
  const free = pages.pages_free || 0;
  const compressed = pages.pages_occupied_by_compressor || 0;

  const usedPages = active + inactive + wired + speculative;
  const freePages = free;

  return {
    pageSize,
    usedBytes: usedPages * pageSize,
    freeBytes: freePages * pageSize,
    compressedBytes: compressed * pageSize,
    rawPages: pages
  };
}

function parsePmsetBatt(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const sourceLine = lines[0] || "";
  const batteryLine = lines.find((line) => line.includes("InternalBattery")) || "";

  const sourceMatch = sourceLine.match(/Now drawing from '([^']+)'/i);
  const pctMatch = batteryLine.match(/(\d+)%/);
  const statusMatch = batteryLine.match(/\d+%;\s*([^;]+);/);
  const timeMatch = batteryLine.match(/;\s*([^;]+)\s+remaining/i);
  const presentMatch = batteryLine.match(/present:\s*(true|false)/i);

  return {
    source: sourceMatch ? sourceMatch[1] : null,
    percent: pctMatch ? Number(pctMatch[1]) : null,
    state: statusMatch ? statusMatch[1].trim() : null,
    timeRemaining: timeMatch ? timeMatch[1].trim() : null,
    present: presentMatch ? presentMatch[1].toLowerCase() === "true" : null,
    rawLine: formatCommandErrorSafe(batteryLine, null)
  };
}

function parseTopCpuLine(text) {
  const lines = text.split("\n");
  const cpuLine = [...lines].reverse().find((line) => line.includes("CPU usage:"));
  const loadLine = [...lines].reverse().find((line) => line.startsWith("Load Avg:"));

  let user = null;
  let sys = null;
  let idle = null;
  if (cpuLine) {
    const m = cpuLine.match(/CPU usage:\s*([0-9.]+)% user,\s*([0-9.]+)% sys,\s*([0-9.]+)% idle/i);
    if (m) {
      user = Number(m[1]);
      sys = Number(m[2]);
      idle = Number(m[3]);
    }
  }

  let load = null;
  if (loadLine) {
    const m = loadLine.match(/Load Avg:\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)/i);
    if (m) {
      load = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
  }

  return {
    user,
    sys,
    idle,
    load
  };
}

function parseDf(text) {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  const out = [];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const filesystem = parts[0];
    const blocks = Number(parts[1]);
    const used = Number(parts[2]);
    const available = Number(parts[3]);
    const capacity = parts[4];
    const mountedOn = parts.slice(5).join(" ");
    out.push({
      filesystem,
      mountedOn,
      sizeBytes: Number.isFinite(blocks) ? blocks * 1024 : null,
      usedBytes: Number.isFinite(used) ? used * 1024 : null,
      availBytes: Number.isFinite(available) ? available * 1024 : null,
      capacityPercent: capacity.endsWith("%") ? Number(capacity.slice(0, -1)) : null
    });
  }
  return out;
}

function parseIfconfig(text, iface) {
  const statusMatch = text.match(/status:\s*(\w+)/i);
  const mtuMatch = text.match(/mtu\s+(\d+)/i);
  const macMatch = text.match(/ether\s+([0-9a-f:]+)/i);
  const ipMatch = text.match(/\sinet\s+([0-9.]+)/i);
  const ipv6Match = text.match(/\sinet6\s+([0-9a-f:]+[%0-9a-z]*)/i);

  return {
    interface: iface,
    status: statusMatch ? statusMatch[1] : null,
    mtu: mtuMatch ? Number(mtuMatch[1]) : null,
    mac: macMatch ? macMatch[1] : null,
    ipv4: ipMatch ? ipMatch[1] : null,
    ipv6: ipv6Match ? ipv6Match[1] : null
  };
}

function pickPrimaryInterface(routeText) {
  const line = routeText.split("\n").find((l) => l.includes("interface:"));
  if (!line) return "en0";
  const match = line.match(/interface:\s*(\w+)/i);
  return match ? match[1] : "en0";
}

function parseNetstatBytes(text, iface) {
  const lines = text.split("\n").filter(Boolean);
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    if (parts[0] !== iface) continue;
    const network = parts[2] || "";
    if (!network.startsWith("<Link#")) continue;
    const inBytes = toNumber(parts[6]);
    const outBytes = toNumber(parts[9]);
    if (inBytes === null || outBytes === null) continue;
    return { inBytes, outBytes };
  }
  return { inBytes: null, outBytes: null };
}

function parsePsTop(text, limit = 10) {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= 1) return [];

  const out = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^\s*(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(.+)$/);
    if (!match) continue;
    out.push({
      pid: Number(match[1]),
      cpuPercent: Number(match[2]),
      memPercent: Number(match[3]),
      command: match[4]
    });
    if (out.length >= limit) break;
  }
  return out;
}

function parseTopProcessStats(text, limit = 24) {
  const lines = String(text || "").split("\n");
  const headerIndexes = lines
    .map((line, index) => (/^\s*PID\s+COMMAND\s+%CPU\s+MEM\s+POWER/i.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const headerIndex = headerIndexes.length ? headerIndexes[headerIndexes.length - 1] : -1;
  if (headerIndex < 0) return [];

  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s+([0-9.]+)\s+([0-9.]+[KMGTP]?[+-]?)\s+([0-9.]+)\s*$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      commandShort: match[2].trim(),
      cpuPercent: Number(match[3]),
      memResident: match[4],
      energyImpact: Number(match[5])
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

function parsePsProcessDetails(text) {
  const lines = String(text || "").split("\n").filter(Boolean);
  if (!lines.length) return [];

  const rows = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      command: match[3].trim()
    });
  }
  return rows;
}

function parseThreadCounts(text) {
  const counts = new Map();
  const lines = String(text || "").split("\n").filter(Boolean);
  for (const line of lines.slice(1)) {
    const match = line.match(/^\S*\s*(\d+)\s/);
    if (!match) continue;
    const pid = Number(match[1]);
    counts.set(pid, (counts.get(pid) || 0) + 1);
  }
  return counts;
}

function parseLsofOpenFiles(text) {
  const rows = String(text || "").split("\n").slice(1).filter(Boolean);
  const byPid = new Map();

  for (const line of rows) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]);
    if (!Number.isFinite(pid)) continue;
    const type = parts[4] || "";
    const name = parts.slice(8).join(" ");
    const current = byPid.get(pid) || { openFiles: 0, openSockets: 0, samplePaths: [] };
    current.openFiles += 1;
    if (["IPv4", "IPv6", "unix"].includes(type)) current.openSockets += 1;
    if (name && current.samplePaths.length < 3 && !current.samplePaths.includes(name)) {
      current.samplePaths.push(name);
    }
    byPid.set(pid, current);
  }

  return byPid;
}

async function collectProcessDetails(processes) {
  const pids = Array.from(new Set((Array.isArray(processes) ? processes : []).map((item) => item?.pid).filter((pid) => Number.isFinite(pid))));
  if (!pids.length) return [];

  const pidList = pids.join(",");
  const [processDetailText, threadText, openFilesText] = await Promise.all([
    runCommand("ps", ["-p", pidList, "-o", "pid=,ppid=,command="], 5000),
    runCommand("ps", ["-M", "-p", pidList], 5000),
    runCommand("/bin/bash", ["-lc", `lsof -nP -p ${pidList} 2>/dev/null || true`], 7000)
  ]);

  const processRows = parsePsProcessDetails(processDetailText);
  const processByPid = new Map(processRows.map((row) => [row.pid, row]));
  const missingParentPids = Array.from(new Set(processRows.map((row) => row.parentPid).filter((pid) => Number.isFinite(pid) && !processByPid.has(pid))));

  if (missingParentPids.length) {
    const parentText = await runCommand("ps", ["-p", missingParentPids.join(","), "-o", "pid=,ppid=,command="], 5000);
    for (const row of parsePsProcessDetails(parentText)) {
      processByPid.set(row.pid, row);
    }
  }

  const threadCounts = parseThreadCounts(threadText);
  const openFilesByPid = parseLsofOpenFiles(openFilesText);

  return processes.map((proc) => {
    const detail = processByPid.get(proc.pid);
    const parentDetail = detail?.parentPid ? processByPid.get(detail.parentPid) : null;
    const openInfo = openFilesByPid.get(proc.pid);
    return {
      ...proc,
      parentPid: detail?.parentPid ?? null,
      parentCommand: parentDetail?.command || null,
      threadCount: threadCounts.get(proc.pid) ?? null,
      openFileCount: openInfo?.openFiles ?? null,
      openSocketCount: openInfo?.openSockets ?? null,
      openSamples: openInfo?.samplePaths ?? []
    };
  });
}

function bytesFromHumanString(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^([0-9.]+)\s*(B|KB|MB|GB|TB|PB)?$/i);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = (match[2] || "B").toUpperCase();
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 };
  const power = powers[unit] ?? 0;
  return Math.round(value * 1024 ** power);
}

function bytesFromCompactUnit(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^([0-9.]+)\s*([KMGTPE]?)(B)?$/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || "").toUpperCase();
  const powers = { "": 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  return Math.round(value * 1024 ** (powers[unit] ?? 0));
}

function collectPerCoreCpuUsage() {
  const cpus = os.cpus();
  if (!Array.isArray(cpus) || !cpus.length) {
    return {
      logical: null,
      perCore: []
    };
  }

  const currentSamples = cpus.map((cpu, index) => {
    const times = cpu.times || {};
    const user = Number(times.user || 0);
    const nice = Number(times.nice || 0);
    const sys = Number(times.sys || 0);
    const idle = Number(times.idle || 0);
    const irq = Number(times.irq || 0);
    return {
      index,
      user,
      nice,
      sys,
      idle,
      irq,
      total: user + nice + sys + idle + irq,
      model: cpu.model || null,
      speedMHz: toNumber(cpu.speed)
    };
  });

  const previousSamples = previousCpuSamples;
  previousCpuSamples = currentSamples;

  if (!previousSamples || previousSamples.length !== currentSamples.length) {
    return {
      logical: currentSamples.length,
      perCore: currentSamples.map((sample) => ({
        index: sample.index,
        usagePercent: null,
        userPercent: null,
        systemPercent: null,
        idlePercent: null,
        speedMHz: sample.speedMHz
      }))
    };
  }

  return {
    logical: currentSamples.length,
    perCore: currentSamples.map((sample, index) => {
      const prev = previousSamples[index];
      const totalDelta = sample.total - prev.total;
      const userDelta = sample.user + sample.nice - (prev.user + prev.nice);
      const sysDelta = sample.sys + sample.irq - (prev.sys + prev.irq);
      const idleDelta = sample.idle - prev.idle;

      if (totalDelta <= 0) {
        return {
          index,
          usagePercent: null,
          userPercent: null,
          systemPercent: null,
          idlePercent: null,
          speedMHz: sample.speedMHz
        };
      }

      const userPercent = (userDelta / totalDelta) * 100;
      const systemPercent = (sysDelta / totalDelta) * 100;
      const idlePercent = (idleDelta / totalDelta) * 100;
      return {
        index,
        usagePercent: 100 - idlePercent,
        userPercent,
        systemPercent,
        idlePercent,
        speedMHz: sample.speedMHz
      };
    })
  };
}

function parseMemoryPressure(text) {
  if (!text) return {};

  const freePercentMatch = text.match(/System-wide memory free percentage:\s*(\d+)%/i);
  const swapinsMatch = text.match(/Swapins:\s*([0-9]+)/i);
  const swapoutsMatch = text.match(/Swapouts:\s*([0-9]+)/i);
  const pageinsMatch = text.match(/Pageins:\s*([0-9]+)/i);
  const pageoutsMatch = text.match(/Pageouts:\s*([0-9]+)/i);
  const compressedMatch = text.match(/Pages compressed:\s*([0-9]+)/i);
  const decompressedMatch = text.match(/Pages decompressed:\s*([0-9]+)/i);

  return {
    freePercent: freePercentMatch ? Number(freePercentMatch[1]) : null,
    swapins: swapinsMatch ? Number(swapinsMatch[1]) : null,
    swapouts: swapoutsMatch ? Number(swapoutsMatch[1]) : null,
    pageins: pageinsMatch ? Number(pageinsMatch[1]) : null,
    pageouts: pageoutsMatch ? Number(pageoutsMatch[1]) : null,
    pagesCompressed: compressedMatch ? Number(compressedMatch[1]) : null,
    pagesDecompressed: decompressedMatch ? Number(decompressedMatch[1]) : null
  };
}

function parseSwapUsage(text) {
  if (!text) return {};

  const totalMatch = text.match(/total = ([0-9.]+\s*[KMGTPE]?B?)/i);
  const usedMatch = text.match(/used = ([0-9.]+\s*[KMGTPE]?B?)/i);
  const freeMatch = text.match(/free = ([0-9.]+\s*[KMGTPE]?B?)/i);

  return {
    totalBytes: totalMatch ? bytesFromCompactUnit(totalMatch[1]) : null,
    usedBytes: usedMatch ? bytesFromCompactUnit(usedMatch[1]) : null,
    freeBytes: freeMatch ? bytesFromCompactUnit(freeMatch[1]) : null,
    encrypted: /\(encrypted\)/i.test(text)
  };
}

function parseIostatDisks(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return [];

  const diskNames = lines[0].split(/\s+/).filter((value) => value.startsWith("disk"));
  const values = lines[lines.length - 1].split(/\s+/);
  const disks = [];

  for (let index = 0; index < diskNames.length; index += 1) {
    const offset = index * 3;
    const kbPerTransfer = toNumber(values[offset]);
    const transfers = toNumber(values[offset + 1]);
    const totalMB = toNumber(values[offset + 2]);
    if (kbPerTransfer === null || transfers === null || totalMB === null) continue;
    disks.push({
      name: diskNames[index],
      kbPerTransfer,
      transfers,
      totalMB
    });
  }

  return disks;
}

function computeDiskIoRates(diskCounters, timestampMs) {
  const devices = [];
  const totals = {
    throughputMBps: null,
    iops: null
  };

  if (!Array.isArray(diskCounters) || !diskCounters.length) {
    previousDiskCounters = {
      timestampMs,
      disks: diskCounters
    };
    return { devices, totals };
  }

  if (!previousDiskCounters) {
    previousDiskCounters = {
      timestampMs,
      disks: diskCounters
    };
    return { devices, totals };
  }

  const dt = (timestampMs - previousDiskCounters.timestampMs) / 1000;
  const previousMap = new Map(
    (previousDiskCounters.disks || []).map((disk) => [disk.name, disk])
  );
  let totalThroughput = 0;
  let totalIops = 0;

  for (const disk of diskCounters) {
    const prev = previousMap.get(disk.name);
    if (!prev || dt <= 0) continue;

    const deltaMB = disk.totalMB - prev.totalMB;
    const deltaTransfers = disk.transfers - prev.transfers;
    const throughputMBps = deltaMB >= 0 ? deltaMB / dt : null;
    const iops = deltaTransfers >= 0 ? deltaTransfers / dt : null;

    if (throughputMBps !== null) totalThroughput += throughputMBps;
    if (iops !== null) totalIops += iops;

    devices.push({
      name: disk.name,
      kbPerTransfer: disk.kbPerTransfer,
      throughputMBps,
      iops,
      totalWrittenReadMB: disk.totalMB
    });
  }

  previousDiskCounters = {
    timestampMs,
    disks: diskCounters
  };

  return {
    devices,
    totals: {
      throughputMBps: devices.length ? totalThroughput : null,
      iops: devices.length ? totalIops : null
    }
  };
}

function parseAirportData(text) {
  if (!text) return {};

  const lines = text.split("\n");
  let inEn0 = false;
  let inCurrentNetwork = false;
  let networkName = null;
  const wifi = {
    interface: "en0",
    status: null,
    cardType: null,
    firmwareVersion: null,
    macAddress: null,
    countryCode: null,
    phyMode: null,
    channel: null,
    security: null,
    signalDbm: null,
    noiseDbm: null,
    transmitRateMbps: null,
    mcsIndex: null,
    ssid: null,
    ssidRedacted: false
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, "");
    if (/^\s*en0:\s*$/.test(line)) {
      inEn0 = true;
      inCurrentNetwork = false;
      continue;
    }
    if (inEn0 && /^\s*[a-z]+\d+:\s*$/.test(line) && !/^\s*en0:\s*$/.test(line)) {
      break;
    }
    if (!inEn0) continue;

    if (/^\s*Current Network Information:\s*$/.test(line)) {
      inCurrentNetwork = true;
      continue;
    }
    if (inCurrentNetwork && /^\s*Other Local Wi-Fi Networks:\s*$/.test(line)) {
      inCurrentNetwork = false;
      continue;
    }

    const kv = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
    if (inCurrentNetwork) {
      if (!kv && /^\s+.+:\s*$/.test(line)) {
        networkName = line.trim().replace(/:$/, "");
        if (networkName === "<redacted>") {
          wifi.ssidRedacted = true;
          networkName = null;
        }
        continue;
      }
      if (!kv) continue;
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (key === "PHY Mode") wifi.phyMode = value;
      if (key === "Channel") wifi.channel = value;
      if (key === "Security") wifi.security = value;
      if (key === "Transmit Rate") wifi.transmitRateMbps = toNumber(value);
      if (key === "MCS Index") wifi.mcsIndex = toNumber(value);
      if (key === "Signal / Noise") {
        const signalMatch = value.match(/(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/i);
        if (signalMatch) {
          wifi.signalDbm = Number(signalMatch[1]);
          wifi.noiseDbm = Number(signalMatch[2]);
        }
      }
      continue;
    }

    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (key === "Card Type") wifi.cardType = value;
    if (key === "Firmware Version") wifi.firmwareVersion = value;
    if (key === "MAC Address") wifi.macAddress = value;
    if (key === "Country Code") wifi.countryCode = value;
    if (key === "Status") wifi.status = value;
  }

  wifi.ssid = networkName;
  return wifi;
}

function parseNetstatConnections(text) {
  const summary = {
    establishedCount: 0,
    listenCount: 0,
    udpCount: 0,
    timeWaitCount: 0,
    otherStates: {},
    sample: []
  };
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (!/^(tcp|udp)/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;

    const protocol = parts[0];
    const localAddress = parts[3] || null;
    const remoteAddress = parts[4] || null;
    const state = protocol.startsWith("tcp") ? (parts[5] || null) : null;

    if (protocol.startsWith("udp")) {
      summary.udpCount += 1;
      continue;
    }

    if (state === "ESTABLISHED") summary.establishedCount += 1;
    else if (state === "LISTEN") summary.listenCount += 1;
    else if (state === "TIME_WAIT") summary.timeWaitCount += 1;
    else if (state) summary.otherStates[state] = (summary.otherStates[state] || 0) + 1;

    if (state === "ESTABLISHED" && summary.sample.length < 8) {
      summary.sample.push({
        protocol,
        localAddress,
        remoteAddress,
        state
      });
    }
  }

  return summary;
}

function parseLsofConnections(text, limit = 8) {
  const rows = [];
  const lines = text.split("\n").slice(1).filter(Boolean);

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const protocolIndex = parts.findIndex((part) => part === "TCP" || part === "UDP");
    if (protocolIndex < 0 || protocolIndex + 1 >= parts.length) continue;

    const command = parts[0];
    const pid = Number(parts[1]);
    const protocol = parts[protocolIndex];
    const endpoint = parts[protocolIndex + 1];
    const stateToken = parts[parts.length - 1];
    const [localAddress, remoteAddress] = endpoint.split("->");

    rows.push({
      process: command.replace(/\\x20/g, " "),
      pid: Number.isFinite(pid) ? pid : null,
      protocol,
      localAddress: localAddress || null,
      remoteAddress: remoteAddress || null,
      state: /^\(.+\)$/.test(stateToken) ? stateToken.slice(1, -1) : null
    });
    if (rows.length >= limit) break;
  }

  return rows;
}

function parsePowermetrics(text) {
  if (!text) {
    return {
      available: false,
      enabled: false,
      reason: "No powermetrics output"
    };
  }

  const getValue = (regex) => {
    const match = text.match(regex);
    return match ? Number(match[1]) : null;
  };

  return {
    available: true,
    enabled: true,
    cpuPowerMw: getValue(/CPU Power:\s*([0-9.]+)\s*mW/i),
    gpuPowerMw: getValue(/GPU Power:\s*([0-9.]+)\s*mW/i),
    anePowerMw: getValue(/ANE Power:\s*([0-9.]+)\s*mW/i),
    cpuAverageFrequencyMHz: getValue(/CPU Average frequency as fraction of nominal:\s*[0-9.]+%\s*\(([0-9.]+)\s*MHz\)/i),
    pClusterFrequencyMHz: getValue(/P-Cluster HW active frequency:\s*([0-9.]+)\s*MHz/i),
    eClusterFrequencyMHz: getValue(/E-Cluster HW active frequency:\s*([0-9.]+)\s*MHz/i),
    rawExcerpt: text.split("\n").slice(0, 12).join("\n")
  };
}

async function collectPowermetrics() {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot) {
    return {
      available: false,
      enabled: false,
      reason: "Start the server with sudo to enable powermetrics"
    };
  }

  const nowMs = Date.now();
  if (powermetricsCache.data && nowMs - powermetricsCache.timestampMs < 15000) {
    return powermetricsCache.data;
  }
  if (powermetricsCache.promise) {
    return powermetricsCache.promise;
  }

  powermetricsCache.promise = (async () => {
    const output = await runCommand("powermetrics", ["--samplers", "cpu_power", "-n", "1"], 12000);
    const parsed = parsePowermetrics(output);
    powermetricsCache.data = parsed;
    powermetricsCache.timestampMs = Date.now();
    powermetricsCache.promise = null;
    return parsed;
  })().catch((error) => {
    powermetricsCache.promise = null;
    return {
      available: false,
      enabled: true,
      reason: error instanceof Error ? error.message : "powermetrics failed"
    };
  });

  return powermetricsCache.promise;
}

function parseSimpleStatus(text, expectedPrefix) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (!expectedPrefix) return value;
  return value.replace(new RegExp(`^${expectedPrefix}\\s*`, "i"), "").trim();
}

function parseWhoUsers(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const sessions = lines.map((line) => {
    const parts = line.split(/\s+/);
    return {
      user: parts[0] || null,
      terminal: parts[1] || null,
      loginAt: parts.slice(2).join(" ") || null
    };
  });
  const uniqueUsers = [...new Set(sessions.map((session) => session.user).filter(Boolean))];
  return {
    count: sessions.length,
    users: uniqueUsers,
    sessions
  };
}

function parseHardwareInventory(text) {
  const lines = String(text || "").split("\n");
  const inventory = {
    graphics: {
      gpuName: null,
      gpuCoreCount: null,
      metalSupport: null,
      displays: []
    },
    bluetooth: {
      state: null,
      chipset: null,
      discoverable: null,
      pairedDevices: []
    },
    audio: {
      devices: [],
      defaultInput: null,
      defaultOutput: null,
      defaultSystemOutput: null
    }
  };

  let section = null;
  let inDisplays = false;
  let inBluetoothNotConnected = false;
  let inAudioDevices = false;
  let currentDisplay = null;
  let currentBluetoothDevice = null;
  let currentAudioDevice = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, "");
    const trimmed = line.trim();

    if (trimmed === "Graphics/Displays:") {
      section = "graphics";
      inDisplays = false;
      continue;
    }
    if (trimmed === "Bluetooth:") {
      section = "bluetooth";
      inBluetoothNotConnected = false;
      continue;
    }
    if (trimmed === "Audio:") {
      section = "audio";
      inAudioDevices = false;
      continue;
    }

    if (section === "graphics") {
      if (/^\s{4,}Displays:\s*$/.test(line)) {
        inDisplays = true;
        continue;
      }
      const kv = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
      if (inDisplays && /^\s{8,}[^:]+:\s*$/.test(line)) {
        currentDisplay = trimmed.replace(/:$/, "");
        inventory.graphics.displays.push({ name: currentDisplay });
        continue;
      }
      if (kv) {
        const key = kv[1].trim();
        const value = kv[2].trim();
        if (!inventory.graphics.gpuName && key === "Chipset Model") inventory.graphics.gpuName = value;
        if (key === "Total Number of Cores") inventory.graphics.gpuCoreCount = toNumber(value);
        if (key === "Metal Support") inventory.graphics.metalSupport = value;
      }
      continue;
    }

    if (section === "bluetooth") {
      if (/^\s*Not Connected:\s*$/.test(trimmed)) {
        inBluetoothNotConnected = true;
        continue;
      }
      const kv = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
      if (inBluetoothNotConnected && /^\s{10,}[^:]+:\s*$/.test(line)) {
        currentBluetoothDevice = trimmed.replace(/:$/, "");
        inventory.bluetooth.pairedDevices.push({ name: currentBluetoothDevice });
        continue;
      }
      if (kv) {
        const key = kv[1].trim();
        const value = kv[2].trim();
        if (key === "State") inventory.bluetooth.state = value;
        if (key === "Chipset") inventory.bluetooth.chipset = value;
        if (key === "Discoverable") inventory.bluetooth.discoverable = value;
      }
      continue;
    }

    if (section === "audio") {
      if (/^\s*Devices:\s*$/.test(trimmed)) {
        inAudioDevices = true;
        continue;
      }
      if (inAudioDevices && /^\s{8,}[^:]+:\s*$/.test(line)) {
        currentAudioDevice = trimmed.replace(/:$/, "");
        inventory.audio.devices.push({ name: currentAudioDevice });
        continue;
      }
      const kv = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
      if (!kv || !currentAudioDevice) continue;
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (value !== "Yes") continue;
      if (key === "Default Input Device") inventory.audio.defaultInput = currentAudioDevice;
      if (key === "Default Output Device") inventory.audio.defaultOutput = currentAudioDevice;
      if (key === "Default System Output Device") inventory.audio.defaultSystemOutput = currentAudioDevice;
    }
  }

  return inventory;
}

function parsePeripheralInventory(text) {
  const lines = String(text || "").split("\n");
  const peripherals = {
    thunderbolt: {
      busCount: 0,
      connectedDevices: [],
      ports: []
    },
    usb: {
      devices: []
    }
  };

  let section = null;
  let currentBus = null;
  let currentPort = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, "");
    const trimmed = line.trim();

    if (trimmed === "Thunderbolt/USB4:") {
      section = "thunderbolt";
      continue;
    }
    if (trimmed === "USB:") {
      section = "usb";
      continue;
    }

    if (section === "thunderbolt") {
      if (/^\s*Thunderbolt\/USB4 Bus \d+:\s*$/.test(trimmed)) {
        peripherals.thunderbolt.busCount += 1;
        currentBus = { name: trimmed.replace(/:$/, ""), ports: [] };
        continue;
      }
      if (/^\s*Port:\s*$/.test(trimmed)) {
        currentPort = { status: null, speed: null, receptacle: null };
        if (currentBus) currentBus.ports.push(currentPort);
        continue;
      }
      const kv = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
      if (!kv) continue;
      const key = kv[1].trim();
      const value = kv[2].trim();

      if (currentPort) {
        if (key === "Status") currentPort.status = value;
        if (key === "Speed") currentPort.speed = value;
        if (key === "Receptacle") currentPort.receptacle = value;
      }

      if (key === "Device Name" && value !== "MacBook Air" && value !== "MacBook Pro") {
        peripherals.thunderbolt.connectedDevices.push(value);
      }
      continue;
    }

    if (section === "usb") {
      if (/^\s{4,}[^:]+:\s*$/.test(line) && !/^\s*USB:/.test(trimmed)) {
        const name = trimmed.replace(/:$/, "");
        if (name && !name.startsWith("USB ")) {
          peripherals.usb.devices.push(name);
        }
      }
    }
  }

  return peripherals;
}

function parseSoftwareUpdateHistory(text) {
  const lines = String(text || "").split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const rows = [];
  for (const line of lines.slice(2)) {
    const match = line.match(/^(.*?)\s{2,}(\S+)\s{2,}(.*)$/);
    if (!match) continue;
    rows.push({
      name: match[1].trim(),
      version: match[2].trim(),
      installedAt: match[3].trim()
    });
  }
  return rows;
}

function parseSoftwareUpdateList(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return {
      status: "unknown",
      updates: [],
      raw: null
    };
  }
  if (/No new software available/i.test(trimmed)) {
    return {
      status: "up-to-date",
      updates: [],
      raw: trimmed
    };
  }

  const lines = trimmed.split("\n");
  const updates = [];
  let current = null;

  for (const line of lines) {
    const labelMatch = line.match(/^\s*\*\s+Label:\s+(.+?)\s*$/);
    if (labelMatch) {
      if (current) updates.push(current);
      current = {
        label: labelMatch[1].trim(),
        title: null,
        version: null,
        size: null,
        recommended: false,
        action: null
      };
      continue;
    }

    if (!current) continue;
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const titleMatch = trimmedLine.match(/^Title:\s*(.*?),\s*Version:\s*([^,]+),\s*Size:\s*(.+?)(,|$)/i);
    if (titleMatch) {
      current.title = titleMatch[1].trim();
      current.version = titleMatch[2].trim();
      current.size = titleMatch[3].trim();
    }
    if (/recommended/i.test(trimmedLine)) current.recommended = true;
    const actionMatch = trimmedLine.match(/Action:\s*(.+)$/i);
    if (actionMatch) current.action = actionMatch[1].trim();
  }

  if (current) updates.push(current);

  return {
    status: updates.length ? "updates-available" : "unknown",
    updates,
    raw: trimmed
  };
}

function parseListeningServices(text) {
  const lines = String(text || "").split("\n").slice(1).filter(Boolean);
  const services = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const protocolIndex = parts.findIndex((part) => part === "TCP" || part === "UDP");
    if (protocolIndex < 0 || protocolIndex + 1 >= parts.length) continue;

    const command = parts[0].replace(/\\x20/g, " ");
    const pid = Number(parts[1]);
    const endpoint = parts[protocolIndex + 1];
    const stateToken = parts[parts.length - 1];

    services.push({
      process: command,
      pid: Number.isFinite(pid) ? pid : null,
      endpoint,
      state: /^\(.+\)$/.test(stateToken) ? stateToken.slice(1, -1) : null
    });
  }

  const publicServices = services.filter((item) => item.endpoint && !item.endpoint.startsWith("127.0.0.1"));
  const localOnly = services.filter((item) => item.endpoint && item.endpoint.startsWith("127.0.0.1"));

  return {
    count: services.length,
    publicCount: publicServices.length,
    localOnlyCount: localOnly.length,
    sample: services.slice(0, 12)
  };
}

function parseNettopProcesses(text, limit = 8) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const rows = [];
  for (const line of lines) {
    if (line.startsWith(",state")) continue;
    const parts = line.split(",");
    if (parts.length < 4) continue;

    const label = (parts[0] || "").trim();
    const state = (parts[1] || "").trim() || null;
    const bytesIn = toNumber(parts[2]);
    const bytesOut = toNumber(parts[3]);
    if (!label) continue;

    const pidMatch = label.match(/\.(\d+)$/);
    const pid = pidMatch ? Number(pidMatch[1]) : null;
    const process = pidMatch ? label.slice(0, -pidMatch[0].length) : label;

    rows.push({
      process,
      pid,
      state,
      bytesIn,
      bytesOut,
      totalBytes: (bytesIn || 0) + (bytesOut || 0)
    });
  }

  return rows
    .filter((row) => row.totalBytes > 0)
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, limit);
}

function extractHostFromEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) return null;
  if (value.startsWith("[")) {
    const endIndex = value.indexOf("]");
    return endIndex > 0 ? value.slice(1, endIndex) : value;
  }
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) return value;
  const host = value.slice(0, lastColon);
  return host || value;
}

function isNumericHost(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function isPrivateHost(host) {
  return /^(127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd|fe80:)/i.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function extractDomain(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  if (isNumericHost(host) || host.endsWith(".local")) return host;
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  const secondLevel = parts[parts.length - 2];
  const topLevel = parts[parts.length - 1];
  if (["co", "com", "org", "net", "gov", "ac"].includes(secondLevel) && topLevel.length === 2 && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

async function resolveHostLabel(host) {
  const value = String(host || "").trim();
  if (!value) return null;
  if (!isNumericHost(value)) return value;

  const cached = dnsReverseCache.get(value);
  const nowMs = Date.now();
  if (cached && nowMs - cached.timestampMs < 6 * 60 * 60 * 1000) {
    return cached.hostname;
  }

  try {
    const names = await dns.reverse(value);
    const hostname = Array.isArray(names) && names.length ? names[0] : value;
    dnsReverseCache.set(value, { hostname, timestampMs: nowMs });
    return hostname;
  } catch {
    dnsReverseCache.set(value, { hostname: value, timestampMs: nowMs });
    return value;
  }
}

async function summarizeRemoteTargets(connections, limit = 6) {
  const rows = Array.isArray(connections) ? connections : [];
  const hostMap = new Map();

  for (const row of rows) {
    const host = extractHostFromEndpoint(row?.remoteAddress);
    if (!host || isPrivateHost(host)) continue;
    const key = host.toLowerCase();
    const current = hostMap.get(key) || {
      host,
      connectionCount: 0,
      processes: new Set(),
      sampleProcess: row?.process || null
    };
    current.connectionCount += 1;
    if (row?.process) current.processes.add(row.process);
    hostMap.set(key, current);
  }

  const topHosts = [...hostMap.values()]
    .sort((a, b) => b.connectionCount - a.connectionCount)
    .slice(0, limit);

  const resolvedHosts = await Promise.all(
    topHosts.map(async (item) => {
      const hostname = await resolveHostLabel(item.host);
      return {
        host: item.host,
        hostname,
        domain: extractDomain(hostname || item.host),
        connectionCount: item.connectionCount,
        processCount: item.processes.size,
        sampleProcess: item.sampleProcess
      };
    })
  );

  const domainMap = new Map();
  for (const item of resolvedHosts) {
    const domain = item.domain || item.hostname || item.host;
    const current = domainMap.get(domain) || { domain, connectionCount: 0, hosts: 0 };
    current.connectionCount += item.connectionCount;
    current.hosts += 1;
    domainMap.set(domain, current);
  }

  return {
    hosts: resolvedHosts,
    domains: [...domainMap.values()].sort((a, b) => b.connectionCount - a.connectionCount).slice(0, limit)
  };
}

function parsePmsetEventLog(text, limit = 12) {
  const lines = String(text || "").split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const events = [];

  for (const line of lines) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+([^	]+)	?(.*)$/);
    if (!match) continue;
    const eventType = match[2].trim();
    const detail = match[3].trim();
    const normalized = eventType.toLowerCase();
    if (!["sleep", "wake", "darkwake", "shutdowncause", "restart"].includes(normalized) && !/entering sleep|wake from|shutdown cause|restart/i.test(detail)) {
      continue;
    }
    events.push({
      timestamp: match[1],
      type: eventType,
      detail
    });
  }

  return events.slice(-limit).reverse();
}

function readCrashReportsFromDir(dirPath, limit = 8) {
  try {
    const files = fs.readdirSync(dirPath)
      .filter((name) => name.endsWith('.ips'))
      .map((name) => ({
        name,
        fullPath: path.join(dirPath, name),
        mtimeMs: fs.statSync(path.join(dirPath, name)).mtimeMs
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);

    return files.map((file) => {
      const firstLine = (fs.readFileSync(file.fullPath, 'utf8').split('\n')[0] || '').trim();
      let payload = {};
      try {
        payload = JSON.parse(firstLine);
      } catch {
        payload = {};
      }
      return {
        fileName: file.name,
        timestamp: payload.timestamp || new Date(file.mtimeMs).toISOString(),
        appName: payload.app_name || payload.name || file.name,
        incidentId: payload.incident_id || null,
        bugType: payload.bug_type || null,
        responsibleProc: payload.responsibleProc || payload.app_name || null
      };
    });
  } catch {
    return [];
  }
}

function collectCrashReports(limit = 8) {
  const homeDir = os.homedir();
  const sources = [
    path.join(homeDir, 'Library', 'Logs', 'DiagnosticReports'),
    path.join('/Library', 'Logs', 'DiagnosticReports')
  ];
  const rows = sources.flatMap((dirPath) => readCrashReportsFromDir(dirPath, limit));
  const seen = new Set();
  return rows
    .filter((item) => {
      const key = `${item.fileName}:${item.timestamp}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);
}

async function collectEventHistory() {
  const nowMs = Date.now();
  if (eventsCache.data && nowMs - eventsCache.timestampMs < 120000) {
    return eventsCache.data;
  }
  if (eventsCache.promise) {
    return eventsCache.promise;
  }

  eventsCache.promise = (async () => {
    const pmsetLogText = await runCommand('/bin/bash', [
      '-lc',
      "pmset -g log | rg -i '\t(Sleep|Wake|DarkWake|ShutdownCause|Restart)|Entering Sleep|Wake from|DarkWake from|DarkWake to FullWake|Shutdown cause' | tail -n 80"
    ], 12000);
    const data = {
      power: parsePmsetEventLog(pmsetLogText, 12),
      crashes: collectCrashReports(8)
    };
    eventsCache.data = data;
    eventsCache.timestampMs = Date.now();
    eventsCache.promise = null;
    return data;
  })().catch((error) => {
    eventsCache.promise = null;
    return {
      power: [],
      crashes: [],
      error: error instanceof Error ? error.message : String(error)
    };
  });

  return eventsCache.promise;
}

function computeAlerts(snapshot) {
  const alerts = [];
  const cpuBusy = Number(snapshot?.cpu?.usage?.userPercent || 0) + Number(snapshot?.cpu?.usage?.systemPercent || 0);
  const memoryTotal = Number(snapshot?.memory?.totalBytes || 0);
  const memoryUsed = Number(snapshot?.memory?.usedBytes || 0);
  const memoryUsedPct = memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0;
  const swapUsed = Number(snapshot?.memory?.swap?.usedBytes || 0);
  const rxMbps = Math.max(0, (Number(snapshot?.network?.rxRateBps || 0) * 8) / 1_000_000);
  const txMbps = Math.max(0, (Number(snapshot?.network?.txRateBps || 0) * 8) / 1_000_000);

  if (cpuBusy >= 90) alerts.push({ severity: "danger", label: "CPU critica", detail: `${cpuBusy.toFixed(1)}% busy` });
  else if (cpuBusy >= 75) alerts.push({ severity: "warn", label: "CPU alta", detail: `${cpuBusy.toFixed(1)}% busy` });

  if (memoryUsedPct >= 90) alerts.push({ severity: "danger", label: "RAM quasi piena", detail: `${memoryUsedPct.toFixed(1)}% in uso` });
  else if (memoryUsedPct >= 80) alerts.push({ severity: "warn", label: "RAM alta", detail: `${memoryUsedPct.toFixed(1)}% in uso` });

  if (swapUsed >= 4 * 1024 ** 3) alerts.push({ severity: "danger", label: "Swap elevato", detail: `${(swapUsed / 1024 ** 3).toFixed(1)} GB` });
  else if (swapUsed >= 1 * 1024 ** 3) alerts.push({ severity: "warn", label: "Swap attivo", detail: `${(swapUsed / 1024 ** 3).toFixed(1)} GB` });

  if (Math.max(rxMbps, txMbps) >= 500) alerts.push({ severity: "danger", label: "Traffico rete elevato", detail: `${Math.max(rxMbps, txMbps).toFixed(1)} Mbps` });
  else if (Math.max(rxMbps, txMbps) >= 150) alerts.push({ severity: "warn", label: "Traffico rete alto", detail: `${Math.max(rxMbps, txMbps).toFixed(1)} Mbps` });

  if (snapshot?.power?.thermal?.isWarning) alerts.push({ severity: "danger", label: "Thermal warning", detail: "Verifica temperature e carico" });

  return alerts.slice(0, 6);
}

async function collectEnvironmentInfo() {
  const nowMs = Date.now();
  if (environmentCache.data && nowMs - environmentCache.timestampMs < 300000) {
    return environmentCache.data;
  }
  if (environmentCache.promise) {
    return environmentCache.promise;
  }

  environmentCache.promise = (async () => {
    const [
      fileVaultText,
      gatekeeperText,
      sipText,
      firewallText,
      whoText,
      hardwareInventoryText,
      peripheralInventoryText,
      softwareUpdateHistoryText,
      softwareUpdateListText
    ] = await Promise.all([
      runCommand("fdesetup", ["status"]),
      runCommand("spctl", ["--status"]),
      runCommand("csrutil", ["status"]),
      runCommand("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]),
      runCommand("who"),
      runCommand("system_profiler", ["SPDisplaysDataType", "SPBluetoothDataType", "SPAudioDataType"], 8000),
      runCommand("system_profiler", ["SPUSBDataType", "SPThunderboltDataType"], 8000),
      runCommand("softwareupdate", ["--history"], 12000),
      runCommand("softwareupdate", ["--list", "--no-scan"], 10000)
    ]);

    const data = {
      security: {
        fileVault: parseSimpleStatus(fileVaultText, "FileVault is"),
        gatekeeper: parseSimpleStatus(gatekeeperText, ""),
        sip: parseSimpleStatus(sipText, "System Integrity Protection status:"),
        firewall: parseSimpleStatus(firewallText, "Firewall is")
      },
      sessions: parseWhoUsers(whoText),
      inventory: parseHardwareInventory(hardwareInventoryText),
      peripherals: parsePeripheralInventory(peripheralInventoryText),
      software: {
        available: parseSoftwareUpdateList(softwareUpdateListText),
        history: parseSoftwareUpdateHistory(softwareUpdateHistoryText).slice(0, 8)
      }
    };

    environmentCache.data = data;
    environmentCache.timestampMs = Date.now();
    environmentCache.promise = null;
    return data;
  })().catch((error) => {
    environmentCache.promise = null;
    return {
      security: {
        fileVault: null,
        gatekeeper: null,
        sip: null,
        firewall: null,
        error: error instanceof Error ? error.message : String(error)
      },
      sessions: {
        count: 0,
        users: [],
        sessions: []
      },
      inventory: {
        graphics: { gpuName: null, gpuCoreCount: null, metalSupport: null, displays: [] },
        bluetooth: { state: null, chipset: null, discoverable: null, pairedDevices: [] },
        audio: { devices: [], defaultInput: null, defaultOutput: null, defaultSystemOutput: null }
      },
      peripherals: {
        thunderbolt: { busCount: 0, connectedDevices: [], ports: [] },
        usb: { devices: [] }
      },
      software: {
        available: { status: "unknown", updates: [], raw: null },
        history: []
      }
    };
  });

  return environmentCache.promise;
}

async function collectServicesInfo() {
  const nowMs = Date.now();
  if (servicesCache.data && nowMs - servicesCache.timestampMs < 30000) {
    return servicesCache.data;
  }
  if (servicesCache.promise) {
    return servicesCache.promise;
  }

  servicesCache.promise = (async () => {
    const listenText = await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], 5000);
    const data = parseListeningServices(listenText);
    servicesCache.data = data;
    servicesCache.timestampMs = Date.now();
    servicesCache.promise = null;
    return data;
  })().catch((error) => {
    servicesCache.promise = null;
    return {
      count: 0,
      publicCount: 0,
      localOnlyCount: 0,
      sample: [],
      error: error instanceof Error ? error.message : String(error)
    };
  });

  return servicesCache.promise;
}

async function collectSnapshot() {
  const [
    swVersText,
    hardwareText,
    powerText,
    pmsetBattText,
    pmsetThermText,
    ioregBatteryText,
    vmStatText,
    memoryPressureText,
    swapUsageText,
    topText,
    dfText,
    iostatText,
    wifiText,
    routeText,
    psText,
    netstatText,    lsofConnectionsText,
    nettopText,
    powermetrics,
    environmentInfo,
    servicesInfo,
    eventHistory
  ] = await Promise.all([
    runCommand("sw_vers"),
    runCommand("system_profiler", ["SPHardwareDataType"], 6000),
    runCommand("system_profiler", ["SPPowerDataType"], 6000),
    runCommand("pmset", ["-g", "batt"]),
    runCommand("pmset", ["-g", "therm"]),
    runCommand("ioreg", ["-rc", "AppleSmartBattery"]),
    runCommand("vm_stat"),
    runCommand("memory_pressure"),
    runCommand("sysctl", ["vm.swapusage"]),
    runCommand("top", ["-l", "2", "-n", "24", "-stats", "pid,command,cpu,mem,power", "-o", "cpu"], 7000),
    runCommand("df", ["-kP"]),
    runCommand("iostat", ["-Id"]),
    runCommand("system_profiler", ["SPAirPortDataType"], 6000),
    runCommand("route", ["-n", "get", "default"]),
    runCommand("ps", ["-A", "-r", "-o", "pid,%cpu,%mem,comm"]),
    runCommand("netstat", ["-an"]),
    runCommand("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED"]),
    runCommand("nettop", ["-L", "1", "-x", "-J", "bytes_in,bytes_out,state", "-P", "-n"], 6000),
    collectPowermetrics(),
    collectEnvironmentInfo(),
    collectServicesInfo(),
    collectEventHistory()
  ]);

  const swVers = parseKeyValueColonText(swVersText);
  const hw = parseKeyValueColonText(hardwareText);
  const power = parseKeyValueColonText(powerText);
  const batt = parsePmsetBatt(pmsetBattText);
  const thermLines = pmsetThermText.split("\n").map((line) => line.trim()).filter(Boolean);
  const ioregBattery = parseIoregProperties(ioregBatteryText);
  const vm = parseVmStat(vmStatText);
  const memoryPressure = parseMemoryPressure(memoryPressureText);
  const swapUsage = parseSwapUsage(swapUsageText);
  const top = parseTopCpuLine(topText);
  const topProcessStats = parseTopProcessStats(topText, 24);
  const storage = parseDf(dfText);
  const diskCounters = parseIostatDisks(iostatText);
  const primaryInterface = pickPrimaryInterface(routeText);
  const cpuCores = collectPerCoreCpuUsage();
  const wifi = parseAirportData(wifiText);
  const connectionSummary = parseNetstatConnections(netstatText);
  const activeConnectionProcesses = parseLsofConnections(lsofConnectionsText, 64);
  const topNetworkProcesses = parseNettopProcesses(nettopText, 8);
  const remoteTargets = await summarizeRemoteTargets(activeConnectionProcesses, 6);

  const ifconfigText = await runCommand("ifconfig", [primaryInterface]);
  const ifaceInfo = parseIfconfig(ifconfigText, primaryInterface);

  const nowMs = Date.now();
  const networkCounterText = await runCommand("netstat", ["-ib"]);
  const networkCounters = parseNetstatBytes(networkCounterText, primaryInterface);
  const diskIo = computeDiskIoRates(diskCounters, nowMs);

  let rxRateBps = null;
  let txRateBps = null;
  if (
    previousNetSample &&
    networkCounters.inBytes !== null &&
    networkCounters.outBytes !== null &&
    previousNetSample.inBytes !== null &&
    previousNetSample.outBytes !== null
  ) {
    const dt = (nowMs - previousNetSample.timestampMs) / 1000;
    if (dt > 0) {
      rxRateBps = Math.max(0, (networkCounters.inBytes - previousNetSample.inBytes) / dt);
      txRateBps = Math.max(0, (networkCounters.outBytes - previousNetSample.outBytes) / dt);
    }
  }

  previousNetSample = {
    timestampMs: nowMs,
    inBytes: networkCounters.inBytes,
    outBytes: networkCounters.outBytes
  };

  const memTotalBytes = bytesFromHumanString(hw.Memory || "") || os.totalmem();

  const batteryTempRaw = toNumber(ioregBattery.Temperature);
  const batteryTempC = batteryTempRaw === null ? null : Number(((batteryTempRaw / 10) - 273.15).toFixed(1));

  const powerByPid = new Map(topProcessStats.map((item) => [item.pid, item]));
  const networkByPid = new Map(topNetworkProcesses.filter((item) => item.pid !== null).map((item) => [item.pid, item]));
  const topProcessesBase = parsePsTop(psText, 10).map((proc) => {
    const energy = powerByPid.get(proc.pid);
    const network = networkByPid.get(proc.pid);
    return {
      ...proc,
      energyImpact: energy?.energyImpact ?? null,
      commandShort: energy?.commandShort ?? null,
      netRxBytes: network?.bytesIn ?? null,
      netTxBytes: network?.bytesOut ?? null,
      netTotalBytes: network?.totalBytes ?? null
    };
  });
  const topProcesses = await collectProcessDetails(topProcessesBase);

  const cycleCount = toNumber(power["Cycle Count"]) ?? toNumber(ioregBattery.CycleCount);
  const maxCapacityPercent =
    toNumber(String(power["Maximum Capacity"] || "").replace("%", "")) ?? toNumber(ioregBattery.MaxCapacity);
  const thermalWarningLines = thermLines.filter((line) =>
    /warning|limit|thrott|critical|hot|performance|cpu power status/i.test(line)
  );
  const hasThermalWarning = thermalWarningLines.some((line) => !/\bno\b/i.test(line));

  const snapshot = {
    timestamp: new Date(nowMs).toISOString(),
    system: {
      hostname: os.hostname(),
      osName: swVers.ProductName || os.type(),
      osVersion: swVers.ProductVersion || os.release(),
      osBuild: swVers.BuildVersion || null,
      kernel: os.release(),
      arch: os.arch(),
      uptimeSeconds: os.uptime(),
      loadAvg: top.load || os.loadavg()
    },
    hardware: {
      modelName: hw["Model Name"] || null,
      modelIdentifier: hw["Model Identifier"] || null,
      modelNumber: hw["Model Number"] || null,
      chip: hw.Chip || null,
      totalCores: hw["Total Number of Cores"] || null,
      memoryBytes: memTotalBytes
    },
    cpu: {
      usage: {
        userPercent: top.user,
        systemPercent: top.sys,
        idlePercent: top.idle
      },
      cores: cpuCores
    },
    memory: {
      totalBytes: memTotalBytes,
      usedBytes: vm.usedBytes || null,
      freeBytes: vm.freeBytes || null,
      compressedBytes: vm.compressedBytes || null,
      pageSize: vm.pageSize || null,
      pressure: memoryPressure,
      swap: swapUsage
    },
    power: {
      source: batt.source,
      battery: {
        present: batt.present,
        percent: batt.percent,
        state: batt.state,
        timeRemaining: batt.timeRemaining,
        cycleCount,
        condition: power.Condition || null,
        maxCapacityPercent,
        isCharging: toBoolean(ioregBattery.IsCharging),
        externalConnected: toBoolean(ioregBattery.ExternalConnected),
        fullyCharged: toBoolean(ioregBattery.FullyCharged),
        amperageMa: toNumber(ioregBattery.Amperage),
        voltageMv: toNumber(ioregBattery.Voltage),
        temperatureRaw: batteryTempRaw,
        temperatureC: batteryTempC,
        chargerWatt: toNumber(power["Wattage (W)"])
      },
      thermal: {
        notes: thermLines,
        isWarning: hasThermalWarning
      },
      powermetrics
    },
    storage: {
      volumes: storage,
      io: diskIo
    },
    network: {
      primaryInterface,
      status: ifaceInfo.status,
      mtu: ifaceInfo.mtu,
      mac: ifaceInfo.mac,
      ipv4: ifaceInfo.ipv4,
      ipv6: ifaceInfo.ipv6,
      inBytes: networkCounters.inBytes,
      outBytes: networkCounters.outBytes,
      rxRateBps,
      txRateBps,
      wifi,
      connections: {
        ...connectionSummary,
        processes: activeConnectionProcesses.slice(0, 12)
      },
      topProcesses: topNetworkProcesses,
      remoteTargets
    },
    environment: environmentInfo,
    services: servicesInfo,
    events: eventHistory,
    processes: topProcesses,
    sensors: {
      battery: {
        CurrentCapacity: toNumber(ioregBattery.CurrentCapacity),
        MaxCapacity: toNumber(ioregBattery.MaxCapacity),
        DesignCapacity: toNumber(ioregBattery.DesignCapacity),
        CycleCount: toNumber(ioregBattery.CycleCount),
        Temperature: toNumber(ioregBattery.Temperature),
        Voltage: toNumber(ioregBattery.Voltage),
        Amperage: toNumber(ioregBattery.Amperage),
        InstantAmperage: toNumber(ioregBattery.InstantAmperage),
        ExternalConnected: ioregBattery.ExternalConnected,
        IsCharging: ioregBattery.IsCharging,
        FullyCharged: ioregBattery.FullyCharged
      }
    }
  };

  snapshot.alerts = computeAlerts(snapshot);
  appendPersistentHistorySample({
    timestamp: snapshot.timestamp,
    cpuBusy: Number((Number(snapshot.cpu.usage.userPercent || 0) + Number(snapshot.cpu.usage.systemPercent || 0)).toFixed(2)),
    memUsedPct: snapshot.memory.totalBytes ? Number((((snapshot.memory.usedBytes || 0) / snapshot.memory.totalBytes) * 100).toFixed(2)) : 0,
    battPct: Number(snapshot.power.battery.percent || 0),
    rxMbps: Number((((snapshot.network.rxRateBps || 0) * 8) / 1000000).toFixed(3)),
    txMbps: Number((((snapshot.network.txRateBps || 0) * 8) / 1000000).toFixed(3))
  });

  return snapshot;
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };

    res.writeHead(200, {
      "Content-Type": typeMap[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/snapshot") {
      try {
        const data = await collectSnapshot();
        sendJson(res, 200, data);
      } catch (error) {
        sendJson(res, 500, {
          error: "snapshot_failed",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, now: new Date().toISOString() });
      return;
    }

    if (requestUrl.pathname === "/api/history") {
      sendJson(res, 200, buildHistoryPayload());
      return;
    }

    const safePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const filePath = path.normalize(path.join(STATIC_DIR, safePath));

    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    sendFile(res, filePath);
  });
}

async function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? PORT);
  const host = options.host || "127.0.0.1";
  const server = createAppServer();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : port;

  return {
    server,
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`
  };
}

async function stopServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

module.exports = {
  collectSnapshot,
  createAppServer,
  startServer,
  stopServer
};

if (require.main === module) {
  startServer({ port: PORT, host: "127.0.0.1" })
    .then(({ url }) => {
      console.log(`Mac dashboard disponibile su ${url}`);
    })
    .catch((error) => {
      console.error("Avvio server fallito:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
