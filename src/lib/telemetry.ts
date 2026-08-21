// Azure Application Insights telemetry wrapper.
//
// Telemetry is OPT-IN. Nothing is constructed, no SDK is loaded, and no
// request leaves the machine until the user turns it on in Settings. The
// previous behaviour was the opposite -- on by default, with no UI to turn
// it off -- which is not a defensible default for a developer tool.
//
// The identifier is a random install UUID kept in the preferences store, not
// a hardware ID. The old code sent the `machine-uid` value as the App
// Insights *authenticated user* id, which is a stable hardware fingerprint
// that survives reinstalls and correlates the same machine across anything
// else that reads it. An install UUID is resettable: clearing preferences or
// reinstalling produces a new one, and it says nothing about the machine.

import { ApplicationInsights } from '@microsoft/applicationinsights-web';
import { loadKvStore } from './host';

const PREFS_STORE = 'preferences.json';

/** Preference key holding the user's opt-in choice. Read by App.vue on boot. */
export const TELEMETRY_ENABLED_KEY = 'telemetryEnabled';

/** Preference key holding the random per-install identifier. */
const INSTALL_ID_KEY = 'telemetryInstallId';

const CONNECTION_STRING = 'InstrumentationKey=70b098b2-fcae-4834-867f-69554662910c;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=d2f5a78f-257e-4748-bd25-509258a27bd2';

let appInsights: ApplicationInsights | null = null;
// Opt-in: stays false until a stored preference or an explicit call says
// otherwise, so an early track* call before init cannot send anything.
let isEnabled = false;

function randomUuid(): string {
  const c = globalThis.crypto;
  // `randomUUID` needs a secure context, which the Tauri custom scheme is
  // not guaranteed to be on every platform; fall back to random bytes.
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Read the install id, generating and persisting one on first use. */
async function getOrCreateInstallId(): Promise<string | null> {
  try {
    const prefs = await loadKvStore(PREFS_STORE);
    const existing = await prefs.get<string>(INSTALL_ID_KEY);
    if (existing) return existing;
    const fresh = randomUuid();
    await prefs.set(INSTALL_ID_KEY, fresh);
    await prefs.save();
    return fresh;
  } catch (e) {
    // An unwritable store is not a reason to fail telemetry; report without
    // a stable id rather than falling back to anything machine-derived.
    console.warn('Failed to read/create install id:', e);
    return null;
  }
}

/** Construct and start the SDK. Only ever called when the user has opted in. */
async function startSdk(): Promise<void> {
  if (appInsights) return;
  const installId = await getOrCreateInstallId();

  appInsights = new ApplicationInsights({
    config: {
      connectionString: CONNECTION_STRING,
      enableAutoRouteTracking: false, // Not needed for desktop app
      disableFetchTracking: true,     // Reduce noise from API calls
      disableAjaxTracking: true,      // Reduce noise
      autoTrackPageVisitTime: false,  // Not applicable for desktop
      enableCorsCorrelation: false,   // Not needed
    }
  });

  appInsights.loadAppInsights();
  if (installId) {
    appInsights.setAuthenticatedUserContext(installId);
  }
  appInsights.trackPageView({ name: 'AppLaunch' });
}

/**
 * Tear the SDK down so that turning telemetry off actually stops traffic.
 *
 * Setting a flag is not enough: once `loadAppInsights()` has run the SDK owns
 * its own timers and unload handlers and can still beacon on its own
 * schedule. App Insights also advises against reusing an instance after
 * unload, so the reference is dropped and a fresh one is built on re-enable.
 *
 * Note that `unload()` flushes whatever is already queued as it tears down --
 * verified by measurement, and it happens with or without an explicit
 * `flush()` first. So events recorded while the user was still opted in may
 * be sent during shutdown. Nothing new is collected afterwards. The
 * user-facing copy says exactly this rather than promising silence.
 */
function stopSdk(): void {
  if (!appInsights) return;
  const ai = appInsights;
  appInsights = null;
  try {
    ai.unload();
  } catch (e) {
    console.warn('Failed to unload telemetry:', e);
  }
}

/**
 * Initialize telemetry from the stored preference.
 *
 * @param enabled The user's opt-in choice. Defaults to `false` -- callers
 *   that cannot determine a preference must not get telemetry by accident.
 */
export async function initTelemetry(enabled: boolean = false) {
  isEnabled = enabled;
  if (!enabled) return;
  try {
    await startSdk();
  } catch (e) {
    console.warn('Failed to initialize telemetry:', e);
    appInsights = null;
  }
}

/**
 * Turn telemetry on or off at runtime and persist the choice.
 *
 * Enabling starts the SDK if it is not already running, so the Settings
 * toggle takes effect immediately rather than at next launch.
 */
export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  isEnabled = enabled;
  try {
    const prefs = await loadKvStore(PREFS_STORE);
    await prefs.set(TELEMETRY_ENABLED_KEY, enabled);
    await prefs.save();
  } catch (e) {
    console.warn('Failed to persist telemetry preference:', e);
  }

  if (enabled) {
    try {
      await startSdk();
    } catch (e) {
      console.warn('Failed to start telemetry:', e);
      appInsights = null;
    }
  } else {
    stopSdk();
  }
}

/**
 * Track a custom event
 */
export function trackEvent(name: string, properties?: Record<string, string>) {
  if (!isEnabled || !appInsights) return;

  try {
    appInsights.trackEvent({ name }, properties);
  } catch (e) {
    console.warn('Failed to track event:', e);
  }
}

/**
 * Track an exception/error
 */
export function trackError(error: Error, properties?: Record<string, string>) {
  if (!isEnabled || !appInsights) return;

  try {
    appInsights.trackException({ exception: error }, properties);
  } catch (e) {
    console.warn('Failed to track error:', e);
  }
}

/**
 * Track a metric value
 */
export function trackMetric(name: string, value: number, properties?: Record<string, string>) {
  if (!isEnabled || !appInsights) return;

  try {
    appInsights.trackMetric({ name, average: value }, properties);
  } catch (e) {
    console.warn('Failed to track metric:', e);
  }
}

/**
 * Check whether telemetry is currently enabled
 */
export function isTelemetryEnabled(): boolean {
  return isEnabled;
}
