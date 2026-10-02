import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import axios from "axios";

function normalizedHostname(value) {
  return String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
}

function mappedIpv4Address(value) {
  const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hexadecimal = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexadecimal) return null;
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function isPrivateAddress(address) {
  const value = normalizedHostname(address);
  const version = net.isIP(value);
  if (version === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 88 && c === 99 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (version === 6) {
    const mapped = mappedIpv4Address(value);
    if (mapped) return isPrivateAddress(mapped);
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value)) return true;
    if (value.startsWith("ff")) return true;
    if (value.startsWith("2001:db8:")) return true;
    return false;
  }
  return true;
}

async function publicAddressesFor(url) {
  const hostname = normalizedHostname(url.hostname);
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`Health-check host resolved to a non-public address: ${hostname}`);
  }
  return addresses;
}

async function assertDeployableEndpoint(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Deployment endpoint must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Deployment endpoint credentials are not allowed.");
  const hostname = normalizedHostname(url.hostname);
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isAwsHost = hostname.endsWith(".amazonaws.com") || hostname.endsWith(".cloudfront.net");
  const isAwsAlb = hostname.endsWith(".elb.amazonaws.com") || hostname.endsWith(".elb.amazonaws.com.cn");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !isAwsAlb && process.env.ALLOW_HTTP_DEPLOYMENT_HEALTHCHECK !== "true") {
    throw new Error("Production deployment endpoints must use HTTPS or AWS ALB.");
  }
  if (process.env.NODE_ENV === "production" && isLocal) {
    throw new Error("Local deployment endpoints are not allowed in production.");
  }
  if (process.env.NODE_ENV === "production" && url.port && !["80", "443"].includes(url.port)) {
    throw new Error("Production health checks are limited to the standard HTTP(S) ports.");
  }
  if (!isAwsHost && !isLocal && process.env.ALLOW_CUSTOM_HEALTH_HOSTS !== "true") {
    throw new Error(`Health-check host is not allowed: ${hostname}`);
  }
  if (process.env.NODE_ENV === "production") await publicAddressesFor(url);
  return url;
}

function pinnedAgent(url, addresses) {
  const lookup = (_hostname, options, callback) => {
    const resolvedCallback = typeof options === "function" ? options : callback;
    const requested = typeof options === "function" ? {} : options || {};
    if (requested.all) {
      resolvedCallback(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }
    const selected = addresses[0];
    resolvedCallback(null, selected.address, selected.family);
  };
  return url.protocol === "https:"
    ? new https.Agent({ lookup, keepAlive: false })
    : new http.Agent({ lookup, keepAlive: false });
}

export async function probeEndpoint(endpoint, options = {}) {
  const baseUrl = await assertDeployableEndpoint(endpoint);
  if (options.path) {
    const healthPath = String(options.path).startsWith("/") ? options.path : `/${options.path}`;
    baseUrl.pathname = healthPath;
    baseUrl.search = "";
  }
  const attempts = Math.max(1, Number(options.attempts || 5));
  const timeout = Math.max(1000, Number(options.timeoutMs || 10_000));
  const maxRedirects = Math.min(5, Math.max(0, Number(options.maxRedirects ?? 5)));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      let currentUrl = baseUrl;
      let response;
      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        const addresses = process.env.NODE_ENV === "production" ? await publicAddressesFor(currentUrl) : null;
        const agent = addresses ? pinnedAgent(currentUrl, addresses) : (
          currentUrl.protocol === "https:"
            ? new https.Agent({ family: 4, keepAlive: false })
            : new http.Agent({ family: 4, keepAlive: false })
        );
        try {
          response = await axios.get(currentUrl.toString(), {
            timeout,
            maxRedirects: 0,
            proxy: false,
            responseType: "stream",
            // Any non-5xx answer means the app is up: APIs often 404 on "/" and dashboards 401/302.
            validateStatus: (status) => status >= 200 && status < 500,
            headers: { "User-Agent": "SkyForge-HealthProbe/1.0" },
            ...(currentUrl.protocol === "https:" ? { httpsAgent: agent } : { httpAgent: agent }),
          });
        } catch (error) {
          agent?.destroy();
          throw error;
        }
        // Only headers/status are needed. Destroy the body immediately so a
        // deployed application cannot exhaust worker memory with a large page.
        response.data?.on?.("error", () => {});
        response.data?.destroy?.();
        agent?.destroy();
        if (response.status < 300 || response.status >= 400 || !response.headers.location) break;
        if (redirectCount === maxRedirects) throw new Error(`Endpoint exceeded ${maxRedirects} redirects.`);
        const nextUrl = new URL(response.headers.location, currentUrl);
        // A redirect elsewhere (HTTPS upgrade, external login) already proves the app answered.
        if (nextUrl.hostname !== currentUrl.hostname) break;
        currentUrl = await assertDeployableEndpoint(nextUrl.toString());
      }
      return {
        healthy: true,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        endpoint: currentUrl.toString(),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * attempt, 10000)));
    }
  }

  throw new Error(`Health check failed for ${baseUrl.hostname}: ${lastError?.message || "unknown error"}`);
}

/**
 * A new load balancer's hostname takes a few minutes to appear in DNS, and some resolvers cache
 * the "not found" answer meanwhile. Waits until the endpoint resolves (or the timeout passes).
 */
export async function waitForDnsResolution(endpoint, { timeoutMs = 6 * 60_000, onWait } = {}) {
  const { hostname } = new URL(endpoint);
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  while (Date.now() < deadline) {
    try {
      await dns.lookup(hostname);
      return true;
    } catch (error) {
      if (!["ENOTFOUND", "EAI_AGAIN", "ESERVFAIL"].includes(error.code)) throw error;
      if (!notified) onWait?.();
      notified = true;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  return false;
}
