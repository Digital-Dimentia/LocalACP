import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { applyTheme, loadThemePreference } from "./lib/theme";
import { initLogging } from "./lib/logger";

// Before anything renders: a theme applied after mount flashes the wrong
// palette on every launch.
applyTheme(loadThemePreference());

// Patch the console into the log file before the app mounts, so startup
// failures are captured. Deliberately not awaited: it needs an IPC round-trip
// for the debug flag, and blocking first paint on that is a bad trade.
void initLogging();

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.mount("#app");
