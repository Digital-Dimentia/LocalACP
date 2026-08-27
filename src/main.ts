import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { applyTheme, loadThemePreference } from "./lib/theme";

// Before anything renders: a theme applied after mount flashes the wrong
// palette on every launch.
applyTheme(loadThemePreference());

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.mount("#app");
