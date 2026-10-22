/**
 * Built-in balance adapters for gateways we already know.
 *
 * A provider whose configured endpoint belongs to a known gateway gets its
 * balance adapter from here instead of from a hand-written script: the adapter
 * is keyless, carries no credential, names one relative request target and is
 * approved by construction, so the feature works the moment that provider is
 * configured. A saved provider script always wins over a built-in adapter, and
 * a gateway we do not know still needs an explicit script plus endpoint
 * approval.
 * @module dsh-token-monitor/balance-adapters
 */

import { OFFICIAL_BALANCE_SCRIPT } from './balance-script.ts'
import type { BalanceEndpoint } from './balance-storage.ts'

/** fastaitoken usage endpoint: remaining quota plus its unit and activation flag. */
export const FASTAI_BALANCE_SCRIPT = `({
  request: { path: "/v1/usage", method: "GET", auth: "bearer" },
  parse(response) {
    const remaining = response?.remaining ?? response?.quota?.remaining ?? response?.balance;
    const currency = response?.unit ?? response?.quota?.unit ?? "USD";
    return {
      isAvailable: response?.is_active ?? response?.isValid ?? true,
      totalBalance: remaining,
      currency: currency === "credits" ? "credits" : String(currency).toUpperCase()
    };
  }
})`

/**
 * GLM Coding Plan (Zhipu) quota endpoint: rolling CREDIT_LIMIT windows for the
 * 5-hour and weekly credit allowances. The primary balance shows the shortest
 * window's remaining credits; both windows travel as `windows` for the UI.
 */
export const GLM_BALANCE_SCRIPT = `({
  request: { path: "/api/monitor/usage/quota/limit", method: "GET", auth: "bearer" },
  parse(response) {
    const limits = (response?.data?.limits ?? []).filter(item => item && item.type === "CREDIT_LIMIT");
    const unitChar = unit => unit === 3 ? "h" : unit === 4 ? "m" : "w";
    const windows = limits.map(item => ({
      label: item.number + unitChar(item.unit),
      used: item.currentValue ?? 0,
      total: item.usage ?? 0,
      resetAt: item.nextResetTime
    }));
    const primary = windows[0];
    if (!primary) return { isAvailable: false, totalBalance: 0, currency: "credits", windows: [] };
    return {
      isAvailable: true,
      totalBalance: Math.max(primary.total - primary.used, 0),
      currency: "credits",
      windows
    };
  }
})`

/** One keyless adapter bound to the gateway domain that serves it. */
export interface BuiltInBalanceAdapter {
  /** Registrable domain of the provider endpoint, matched on a label boundary. */
  domain: string
  /** Vendor label shown in the settings panel. */
  label: string
  /** Complete keyless adapter source. */
  script: string
  /** The single request target this adapter is approved to use. */
  endpoint: BalanceEndpoint
}

/** Adapters the Host ships and approves itself. */
export const BUILT_IN_BALANCE_ADAPTERS: readonly BuiltInBalanceAdapter[] = Object.freeze([
  {
    domain: 'api.deepseek.com',
    label: 'DeepSeek',
    script: OFFICIAL_BALANCE_SCRIPT,
    endpoint: Object.freeze({ path: '/user/balance', method: 'GET' as const }),
  },
  {
    domain: 'fastaitoken.com',
    label: 'fastaitoken',
    script: FASTAI_BALANCE_SCRIPT,
    endpoint: Object.freeze({ path: '/v1/usage', method: 'GET' as const }),
  },
  {
    domain: 'bigmodel.cn',
    label: 'GLM Coding Plan',
    script: GLM_BALANCE_SCRIPT,
    endpoint: Object.freeze({ path: '/api/monitor/usage/quota/limit', method: 'GET' as const }),
  },
  {
    domain: 'z.ai',
    label: 'GLM Coding Plan',
    script: GLM_BALANCE_SCRIPT,
    endpoint: Object.freeze({ path: '/api/monitor/usage/quota/limit', method: 'GET' as const }),
  },
])

/** Whether one endpoint hostname belongs to a gateway domain on a label boundary. */
function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain)
}

/** Pick the built-in adapter for one configured provider endpoint.
 * @param baseURL Provider endpoint exactly as configured; other hosts match nothing.
 * @returns The adapter serving that host, or undefined for an unknown gateway.
 */
export function builtInBalanceAdapter(baseURL: string): BuiltInBalanceAdapter | undefined {
  let hostname: string
  try {
    hostname = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return undefined
  }
  return BUILT_IN_BALANCE_ADAPTERS.find(adapter => matchesDomain(hostname, adapter.domain))
}
