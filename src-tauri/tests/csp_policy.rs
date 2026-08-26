//! Invariants for the webview Content-Security-Policy in `tauri.conf.json`.
//!
//! The policy started life as `"csp": null`, which makes Tauri inject no CSP
//! header at all -- inline script, `eval`, remote script loads and outbound
//! connections to any origin all permitted, with `__TAURI_INTERNALS__.invoke()`
//! sitting in the same context. That is the layer deciding whether an XSS in
//! agent-supplied markdown is contained or owns the machine, so a silent
//! regression to `null`, or a stray `'unsafe-eval'` added to quiet a console
//! error, must break the build rather than ship.
//!
//! These are static assertions about the config. They cannot tell you the app
//! still works under the policy -- that needs a desktop run.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

fn policy(kind: &str) -> HashMap<String, Vec<String>> {
    let conf = fs::read_to_string(repo_root().join("src-tauri/tauri.conf.json"))
        .expect("tauri.conf.json is readable");
    let conf: serde_json::Value =
        serde_json::from_str(&conf).expect("tauri.conf.json is valid JSON");
    let raw = conf["app"]["security"][kind].as_str().unwrap_or_else(|| {
        panic!(
            "app.security.{kind} must be a CSP string, found {}. \
             A null or missing policy disables CSP for the whole webview.",
            conf["app"]["security"][kind]
        )
    });
    parse(raw)
}

/// Split a policy into directive -> source list. Directive names are
/// case-insensitive per CSP3; source expressions are not.
fn parse(raw: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in raw.split(';') {
        let mut parts = chunk.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let name = name.to_ascii_lowercase();
        assert!(
            !out.contains_key(&name),
            "directive `{name}` appears twice; browsers honour only the first \
             and silently drop the rest"
        );
        out.insert(name, parts.map(str::to_string).collect());
    }
    out
}

fn sources<'a>(p: &'a HashMap<String, Vec<String>>, directive: &str) -> &'a [String] {
    p.get(directive)
        .unwrap_or_else(|| panic!("policy is missing the `{directive}` directive"))
}

fn assert_has(p: &HashMap<String, Vec<String>>, directive: &str, source: &str, why: &str) {
    let got = sources(p, directive);
    assert!(
        got.iter().any(|s| s == source),
        "`{directive}` must allow `{source}` -- {why}. Found: {got:?}"
    );
}

#[test]
fn production_policy_locks_down_script_execution() {
    let p = policy("csp");

    assert_eq!(
        sources(&p, "default-src"),
        ["'self'"],
        "everything not named explicitly should fall back to same-origin only"
    );
    assert_eq!(
        sources(&p, "script-src"),
        ["'self'"],
        "the app ships one bundled module script and needs nothing else. \
         `'unsafe-inline'` or `'unsafe-eval'` here hands an injected string \
         the same reach as the app itself"
    );
}

#[test]
fn production_policy_closes_the_structural_directives() {
    let p = policy("csp");
    for directive in ["object-src", "frame-src", "frame-ancestors", "form-action"] {
        assert_eq!(
            sources(&p, directive),
            ["'none'"],
            "`{directive}` has no legitimate use here; leaving it open gives \
             injected markup a way out (plugin, nested browsing context, or a \
             POST of whatever it can read)"
        );
    }
    assert_eq!(
        sources(&p, "base-uri"),
        ["'self'"],
        "an injected <base> would otherwise re-point every relative URL in the app"
    );
}

/// Every source in `connect-src` is load-bearing: drop one and the feature it
/// serves fails at runtime, usually with nothing but a console line to say so.
#[test]
fn production_policy_still_permits_what_the_app_actually_talks_to() {
    let p = policy("csp");

    // Tauri's IPC is a real fetch() to a custom scheme, not postMessage:
    // ipc://localhost on macOS/Linux/iOS, http://ipc.localhost on
    // Windows/Android. Losing these breaks every command in the app.
    assert_has(&p, "connect-src", "ipc:", "Tauri IPC on macOS/Linux/iOS");
    assert_has(&p, "connect-src", "http://ipc.localhost", "Tauri IPC on Windows/Android");

    // Remote agents (src/lib/transport/websocket.ts).
    assert_has(&p, "connect-src", "ws:", "WebSocket transport to a local agent");
    assert_has(&p, "connect-src", "wss:", "WebSocket transport to a remote agent");

    for origin in telemetry_origins() {
        assert_has(
            &p,
            "connect-src",
            &origin,
            "App Insights endpoint from the connection string in src/lib/telemetry.ts",
        );
    }
}

/// `connect-src` is the exfiltration directive: it decides where injected
/// script can send what it reads. Named origins only -- a bare scheme source
/// would allow every host on the internet.
#[test]
fn production_connect_src_names_origins_rather_than_whole_schemes() {
    let p = policy("csp");
    for source in sources(&p, "connect-src") {
        assert!(
            source != "https:" && source != "http:",
            "`connect-src` allows the bare scheme `{source}`, which permits any \
             host. List the specific origins instead"
        );
    }
}

/// Tauri falls back to the production policy in dev when `devCsp` is absent
/// (`manager::csp`), and a strict policy alone breaks `tauri dev` -- Vite's
/// HMR client needs inline script, eval, and a socket back to the dev server.
/// The relaxation is deliberate, but it must not relax the structural
/// directives, or dev builds stop exercising the shape of the real policy.
#[test]
fn dev_policy_relaxes_only_what_hmr_needs() {
    let dev = policy("devCsp");
    let prod = policy("csp");

    assert_ne!(
        dev, prod,
        "devCsp duplicating csp means one of them is wrong: either dev cannot \
         run HMR, or production is as loose as dev"
    );
    for directive in ["object-src", "frame-src", "frame-ancestors", "form-action"] {
        assert_eq!(
            sources(&dev, directive),
            ["'none'"],
            "`{directive}` must stay closed in dev too"
        );
    }
    assert_eq!(sources(&dev, "base-uri"), ["'self'"]);
}

/// The two App Insights origins in the policy are a copy of what the SDK
/// derives from its connection string. Read them back out of the frontend so
/// that changing the endpoint there fails here instead of at runtime, where it
/// would look like telemetry silently not working.
fn telemetry_origins() -> Vec<String> {
    let src = fs::read_to_string(repo_root().join("src/lib/telemetry.ts"))
        .expect("src/lib/telemetry.ts is readable");
    let line = src
        .lines()
        .find(|l| l.contains("CONNECTION_STRING"))
        .expect("telemetry.ts still defines CONNECTION_STRING");

    let origins: Vec<String> = line
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            if !matches!(key.trim(), "IngestionEndpoint" | "LiveEndpoint") {
                return None;
            }
            Some(value.trim().trim_end_matches('/').to_string())
        })
        .collect();

    assert_eq!(
        origins.len(),
        2,
        "expected an IngestionEndpoint and a LiveEndpoint in the App Insights \
         connection string, parsed: {origins:?}"
    );
    origins
}
