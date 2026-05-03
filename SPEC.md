# Beamtalk Watcher — Lightweight Monitoring & Webhook System

A monitoring tool that watches services and sends webhook notifications, built entirely in Beamtalk. Serves as a real-world integration test for the language and stdlib — exercising actors, protocols, HTTP client/server, routing, timers, collections, error handling, and hot reload.

## Goals

1. **Exercise Beamtalk broadly** — actors, protocols, value objects, blocks, collections, error handling, timers, HTTP, JSON, hot reload
2. **Ship a useful tool** — something you'd actually run to monitor a handful of services
3. **Drive out stdlib gaps** — if the language can't express something cleanly, that's a finding
4. **Include a web UI** — a real dashboard, not just REPL queries

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Beamtalk Watcher                      │
│                                                         │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────┐  │
│  │   Monitor    │───▶│ Notification │───▶│  Webhook   │  │
│  │  (per check) │    │    Router    │    │  Channel   │  │
│  └─────────────┘    └──────────────┘    └────────────┘  │
│        │                                      │         │
│        ▼                                      ▼         │
│  ┌─────────────┐                     ┌────────────────┐ │
│  │   Check     │                     │    Webhook     │ │
│  │  Registry   │                     │   Receiver     │ │
│  └─────────────┘                     └────────────────┘ │
│        │                                      │         │
│        ▼                                      ▼         │
│  ┌─────────────┐                     ┌────────────────┐ │
│  │  Dashboard  │◀────────────────────│   Alert Log    │ │
│  │  (Web UI)   │                     │                │ │
│  └─────────────┘                     └────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Components

### 1. Health Check Protocol

A protocol defining the interface for all check types.

```beamtalk
Protocol define: HealthCheck
  "A check that can be run against a target and returns a CheckResult."
  check => "Run the check, return a CheckResult"
  name => "Human-readable name for this check"
  target => "The thing being checked (URL, process name, etc.)"
```

#### Check Implementations

**HttpHealthCheck** — GET a URL, verify status code and optional body match.

```beamtalk
Value subclass: HttpHealthCheck
  state: url = ""
  state: expectedStatus = 200
  state: bodyContains = nil
  state: timeout = 5000

  // Factory
  url: aUrl => self new: #{ #url => aUrl }

  // HealthCheck protocol
  check =>
    result := HTTPClient request: "GET" url: self.url options: #{
      #timeout => self.timeout
    }
    result
      ifOk: [:resp |
        statusOk := resp status == self.expectedStatus
        bodyOk := self.bodyContains == nil
          ifTrue: [true]
          ifFalse: [resp body includes: self.bodyContains]
        (statusOk and: bodyOk)
          ifTrue: [CheckResult ok: self name details: "HTTP " ++ resp status printString]
          ifFalse: [CheckResult fail: self name
            details: "Expected " ++ self.expectedStatus printString
              ++ ", got " ++ resp status printString]
      ]
      ifError: [:err |
        CheckResult fail: self name details: err printString
      ]

  name => "HTTP " ++ self.url
  target => self.url
```

**TcpPortCheck** — verify a TCP port is accepting connections.

```beamtalk
Value subclass: TcpPortCheck
  state: host = "localhost"
  state: port = 0
  state: timeout = 3000

  host: aHost port: aPort => self new: #{ #host => aHost, #port => aPort }

  check =>
    // Use Erlang gen_tcp:connect/3 via FFI
    result := TCP connect: self.host port: self.port timeout: self.timeout
    result
      ifOk: [:sock |
        TCP close: sock
        CheckResult ok: self name details: "Port open"
      ]
      ifError: [:err |
        CheckResult fail: self name details: err printString
      ]

  name => "TCP " ++ self.host ++ ":" ++ self.port printString
  target => self.host ++ ":" ++ self.port printString
```

**ProcessCheck** — verify a named BEAM process is alive.

```beamtalk
Value subclass: ProcessCheck
  state: processName = nil

  name: aName => self new: #{ #processName => aName }

  check =>
    (Process isAlive: self.processName)
      ifTrue: [CheckResult ok: self name details: "Process alive"]
      ifFalse: [CheckResult fail: self name details: "Process not found"]

  name => "Process " ++ self.processName printString
  target => self.processName printString
```

### 2. CheckResult — Value Object

Immutable result of a single health check execution.

```beamtalk
sealed Value subclass: CheckResult
  state: status = #unknown    // #ok | #fail | #unknown
  state: checkName = ""
  state: details = ""
  state: timestamp = nil      // DateTime or epoch ms

  ok: name details: details =>
    self new: #{ #status => #ok, #checkName => name,
                 #details => details, #timestamp => DateTime now }

  fail: name details: details =>
    self new: #{ #status => #fail, #checkName => name,
                 #details => details, #timestamp => DateTime now }

  isOk => self.status == #ok
  isFail => self.status == #fail
```

### 3. Monitor — Actor (one per check)

Runs a health check on a timer, tracks state transitions, detects flapping.

```beamtalk
Actor subclass: Monitor
  state: check = nil              // HealthCheck implementor
  state: interval = 30            // seconds between checks
  state: threshold = 3            // consecutive failures before alerting
  state: currentStatus = #unknown // #ok | #fail | #unknown
  state: consecutiveFailures = 0
  state: consecutiveRecoveries = 0
  state: lastResult = nil
  state: listener = nil           // actor to notify on state change
  state: history = #()            // ring buffer of recent results

  // Factory
  check: aCheck interval: secs threshold: n listener: anActor =>
    self spawnWith: #{
      #check => aCheck,
      #interval => secs,
      #threshold => n,
      #listener => anActor
    }

  // Start periodic checks
  start =>
    self runCheck
    Timer every: (self.interval * 1000) do: [self runCheck]

  // Execute one check cycle
  runCheck =>
    result := self.check check
    previousStatus := self.currentStatus
    self.lastResult := result
    self.history := (self.history copyWith: result) last: 50

    result isOk
      ifTrue: [
        self.consecutiveFailures := 0
        self.consecutiveRecoveries := self.consecutiveRecoveries + 1
        (self.currentStatus == #fail and: self.consecutiveRecoveries >= self.threshold)
          ifTrue: [
            self.currentStatus := #ok
            self.consecutiveRecoveries := 0
            self notify: #recovered from: previousStatus
          ]
      ]
      ifFalse: [
        self.consecutiveRecoveries := 0
        self.consecutiveFailures := self.consecutiveFailures + 1
        (self.currentStatus != #fail and: self.consecutiveFailures >= self.threshold)
          ifTrue: [
            self.currentStatus := #fail
            self notify: #alert from: previousStatus
          ]
      ]

  // Notify listener of state change
  notify: type from: previousStatus =>
    self.listener handleEvent: (MonitorEvent
      type: type
      monitor: self
      check: self.check
      result: self.lastResult
      previousStatus: previousStatus)

  // Query interface
  status => self.currentStatus
  checkName => self.check name
  lastResult => self.lastResult
  history => self.history
```

### 4. MonitorEvent — Value Object

```beamtalk
sealed Value subclass: MonitorEvent
  state: type = #unknown          // #alert | #recovered
  state: monitor = nil
  state: check = nil
  state: result = nil
  state: previousStatus = #unknown
  state: timestamp = nil

  type: t monitor: m check: c result: r previousStatus: ps =>
    self new: #{
      #type => t, #monitor => m, #check => c,
      #result => r, #previousStatus => ps,
      #timestamp => DateTime now
    }

  isAlert => self.type == #alert
  isRecovery => self.type == #recovered
```

### 5. NotificationRouter — Actor

Receives MonitorEvents, applies rules, fans out to channels.

```beamtalk
Actor subclass: NotificationRouter
  state: channels = #()          // array of WebhookChannel actors
  state: rules = #()             // array of routing rules (future)
  state: recentEvents = #()      // ring buffer for dedup

  addChannel: channel =>
    self.channels := self.channels copyWith: channel

  removeChannel: channel =>
    self.channels := self.channels reject: [:c | c == channel]

  handleEvent: event =>
    // Dedup: skip if same check+type within last 60s
    isDuplicate := self.recentEvents anySatisfy: [:e |
      e check name == event check name
        and: e type == event type
        and: (DateTime now - e timestamp) < 60
    ]
    isDuplicate ifFalse: [
      self.recentEvents := (self.recentEvents copyWith: event) last: 100
      self.channels do: [:channel |
        channel deliver: event
      ]
    ]
```

### 6. WebhookChannel — Actor

Delivers events as JSON POST requests with retry and backoff.

```beamtalk
Actor subclass: WebhookChannel
  state: url = ""
  state: headers = #()           // extra headers (auth tokens, etc.)
  state: maxRetries = 3
  state: retryDelay = 1000       // ms, doubles each retry
  state: pendingCount = 0

  url: aUrl => self spawnWith: #{ #url => aUrl }
  url: aUrl headers: hdrs => self spawnWith: #{ #url => aUrl, #headers => hdrs }

  deliver: event =>
    payload := self buildPayload: event
    self sendWithRetry: payload attempt: 1

  sendWithRetry: payload attempt: n =>
    result := HTTPClient post: self.url body: payload
    result
      ifOk: [:resp |
        resp ok ifFalse: [
          n < self.maxRetries ifTrue: [
            delay := self.retryDelay * (2 raisedTo: n - 1)
            Timer after: delay do: [self sendWithRetry: payload attempt: n + 1]
          ]
        ]
      ]
      ifError: [:err |
        n < self.maxRetries ifTrue: [
          delay := self.retryDelay * (2 raisedTo: n - 1)
          Timer after: delay do: [self sendWithRetry: payload attempt: n + 1]
        ]
      ]

  buildPayload: event =>
    Json encode: #{
      #type => event type printString,
      #check => event check name,
      #target => event check target,
      #status => event result status printString,
      #details => event result details,
      #previousStatus => event previousStatus printString,
      #timestamp => event timestamp printString
    }

  pending => self.pendingCount
```

### 7. WebhookReceiver — Actor (HTTP server)

Accepts incoming webhook POSTs and stores them in the AlertLog.

```beamtalk
Actor subclass: WebhookReceiver
  state: server = nil
  state: alertLog = nil
  state: port = 0

  start: aPort alertLog: anAlertLog =>
    receiver := self spawnWith: #{ #port => aPort, #alertLog => anAlertLog }
    router := HTTPRouter build: [:r |
      r post: "/webhook" handler: [:req | receiver handleWebhook: req]
      r get: "/health" handler: [:req |
        HTTPResponse new: #{ #status => 200, #body => "{\"status\":\"ok\"}" }
      ]
    ]
    receiver startServer: router
    receiver

  handleWebhook: req =>
    payload := req body
    // Parse and validate
    result := Json decode: payload
    result
      ifOk: [:data |
        self.alertLog record: (Alert fromWebhook: data)
        HTTPResponse new: #{ #status => 202, #body => "{\"accepted\":true}" }
      ]
      ifError: [:err |
        HTTPResponse new: #{
          #status => 400,
          #body => "{\"error\":\"invalid JSON\"}"
        }
      ]

  startServer: router =>
    self.server := HTTPServer start: self.port handler: router
    self.port := self.server port   // resolve ephemeral port

  port => self.port
```

### 8. AlertLog — Actor

Stores received alerts, queryable for dashboard and REPL.

```beamtalk
Actor subclass: AlertLog
  state: alerts = #()            // all alerts, newest first
  state: maxSize = 1000

  record: alert =>
    self.alerts := (#(alert) ++ self.alerts) first: self.maxSize

  recent: n =>
    self.alerts first: n

  forCheck: checkName =>
    self.alerts select: [:a | a checkName == checkName]

  since: timestamp =>
    self.alerts select: [:a | a timestamp >= timestamp]

  count => self.alerts size

  clear => self.alerts := #()
```

### 9. Alert — Value Object

```beamtalk
sealed Value subclass: Alert
  state: type = ""
  state: checkName = ""
  state: target = ""
  state: status = ""
  state: details = ""
  state: previousStatus = ""
  state: timestamp = nil
  state: receivedAt = nil

  fromWebhook: data =>
    self new: #{
      #type => data at: "type",
      #checkName => data at: "check",
      #target => data at: "target",
      #status => data at: "status",
      #details => data at: "details",
      #previousStatus => data at: "previousStatus",
      #timestamp => data at: "timestamp",
      #receivedAt => DateTime now
    }

  isAlert => self.type == "alert"
  isRecovery => self.type == "recovered"
```

### 10. CheckRegistry — Actor

Central registry managing all active monitors. Entry point for REPL interaction and dashboard queries.

```beamtalk
Actor subclass: CheckRegistry
  state: monitors = #{}          // name → Monitor actor
  state: router = nil            // NotificationRouter

  start: aRouter =>
    self spawnWith: #{ #router => aRouter }

  add: check name: name interval: secs threshold: n =>
    monitor := Monitor
      check: check
      interval: secs
      threshold: n
      listener: self.router
    self.monitors := self.monitors at: name put: monitor
    monitor start
    monitor

  remove: name =>
    monitor := self.monitors at: name
    monitor stop
    self.monitors := self.monitors removeKey: name

  status =>
    self.monitors collect: [:name :monitor |
      #{ #name => name, #status => monitor status,
         #lastResult => monitor lastResult }
    ]

  monitor: name => self.monitors at: name

  names => self.monitors keys
```

### 11. Dashboard — Web UI

A server-rendered HTML dashboard showing monitor status, alert history, and live updates via polling.

```beamtalk
Actor subclass: Dashboard
  state: server = nil
  state: registry = nil
  state: alertLog = nil
  state: port = 0

  start: aPort registry: reg alertLog: log =>
    dash := self spawnWith: #{
      #port => aPort, #registry => reg, #alertLog => log
    }
    router := HTTPRouter build: [:r |
      // Pages
      r get: "/" handler: [:req | dash renderIndex: req]
      r get: "/monitors" handler: [:req | dash renderMonitors: req]
      r get: "/alerts" handler: [:req | dash renderAlerts: req]

      // API (JSON, for polling/live updates)
      r get: "/api/status" handler: [:req | dash apiStatus: req]
      r get: "/api/alerts" handler: [:req | dash apiAlerts: req]
      r get: "/api/monitors/:name" handler: [:req | dash apiMonitor: req]

      // Static assets
      r get: "/static/*path" handler: [:req | dash serveStatic: req]
    ]
    dash startServer: router
    dash
```

#### Dashboard Pages

| Route | Purpose |
|-------|---------|
| `GET /` | Overview — all monitors with current status (green/red/grey) |
| `GET /monitors` | Detailed monitor list with history sparklines |
| `GET /alerts` | Alert log, newest first, filterable by check name |
| `GET /api/status` | JSON status of all monitors (for JS polling) |
| `GET /api/alerts` | JSON alert list (for JS polling) |
| `GET /api/monitors/:name` | JSON detail for single monitor with history |
| `GET /static/*path` | CSS, JS, favicon |

#### HTML Rendering

Server-side HTML generation using string concatenation (Beamtalk's `++`). No template engine needed for a dashboard this simple — a few helper methods keep it clean:

```beamtalk
  renderIndex: req =>
    statuses := self.registry status
    rows := statuses collect: [:s |
      color := s at: #status == #ok ifTrue: ["green"] ifFalse: ["red"]
      "<tr class=\"" ++ color ++ "\">"
        ++ "<td>" ++ (s at: #name) ++ "</td>"
        ++ "<td>" ++ (s at: #status) printString ++ "</td>"
        ++ "</tr>"
    ]
    body := self layout: "Watcher" content: (
      "<h1>Beamtalk Watcher</h1>"
      ++ "<table>" ++ (rows join: "") ++ "</table>"
    )
    HTTPResponse new: #{
      #status => 200,
      #headers => #(#("content-type", "text/html; charset=utf-8")),
      #body => body
    }

  layout: title content: content =>
    "<!DOCTYPE html><html><head>"
      ++ "<meta charset=\"utf-8\">"
      ++ "<title>" ++ title ++ "</title>"
      ++ "<link rel=\"stylesheet\" href=\"/static/style.css\">"
      ++ "</head><body>"
      ++ content
      ++ "<script src=\"/static/app.js\"></script>"
      ++ "</body></html>"
```

#### Live Updates

The dashboard JS polls `/api/status` every 5 seconds and updates the DOM. Simple and dependency-free — no websocket complexity needed for a monitoring dashboard with 5-30 second check intervals.

```javascript
// static/app.js
setInterval(async () => {
  const resp = await fetch('/api/status');
  const data = await resp.json();
  updateStatusTable(data);
}, 5000);
```

### 12. Watcher — Top-level Application

Wires everything together. Entry point for `beamtalk run Watcher start`.

```beamtalk
Actor subclass: Watcher
  state: registry = nil
  state: router = nil
  state: alertLog = nil
  state: receiver = nil
  state: dashboard = nil
  state: config = #{}

  start =>
    self startWith: self defaultConfig

  startWith: config =>
    watcher := self spawn

    // Core infrastructure
    watcher.alertLog := AlertLog spawn
    watcher.router := NotificationRouter spawn
    watcher.registry := CheckRegistry start: watcher.router

    // Webhook channel (where to send alerts)
    webhookUrl := config at: #webhookUrl ifAbsent: [nil]
    webhookUrl ifNotNil: [
      channel := WebhookChannel url: webhookUrl
      watcher.router addChannel: channel
    ]

    // Webhook receiver (accept incoming webhooks)
    receiverPort := config at: #receiverPort ifAbsent: [8081]
    watcher.receiver := WebhookReceiver start: receiverPort alertLog: watcher.alertLog

    // Dashboard
    dashPort := config at: #dashboardPort ifAbsent: [8080]
    watcher.dashboard := Dashboard start: dashPort
      registry: watcher.registry
      alertLog: watcher.alertLog

    // Register configured checks
    checks := config at: #checks ifAbsent: [#()]
    checks do: [:checkConfig |
      watcher addCheckFromConfig: checkConfig
    ]

    watcher

  addCheckFromConfig: config =>
    type := config at: #type
    check := type == #http
      ifTrue: [HttpHealthCheck url: (config at: #url)]
      ifFalse: [type == #tcp
        ifTrue: [TcpPortCheck host: (config at: #host) port: (config at: #port)]
        ifFalse: [ProcessCheck name: (config at: #process)]
      ]
    self.registry add: check
      name: (config at: #name)
      interval: (config at: #interval ifAbsent: [30])
      threshold: (config at: #threshold ifAbsent: [3])

  defaultConfig => #{
    #dashboardPort => 8080,
    #receiverPort => 8081,
    #webhookUrl => nil,
    #checks => #()
  }
```

## REPL Usage

The system is fully interactive from the REPL:

```beamtalk
// Start with defaults
w := Watcher start

// Add checks interactively
w registry add: (HttpHealthCheck url: "http://localhost:3000/health")
  name: "api" interval: 15 threshold: 2

w registry add: (TcpPortCheck host: "localhost" port: 5432)
  name: "postgres" interval: 30 threshold: 3

// Add a webhook channel
w router addChannel: (WebhookChannel url: "https://hooks.slack.com/...")

// Query status
w registry status
// => #(#{ #name => "api", #status => #ok, ... }, ...)

// Check alert history
w alertLog recent: 5

// Hot reload a class after editing
:reload Monitor
```

## Project Structure

```
beamtalk-watcher/
├── beamtalk.toml              # Project manifest
├── src/
│   ├── Watcher.bt             # Top-level application actor
│   ├── CheckRegistry.bt       # Monitor registry
│   ├── Monitor.bt             # Per-check monitor actor
│   ├── MonitorEvent.bt        # State change event value object
│   ├── CheckResult.bt         # Check result value object
│   ├── Alert.bt               # Received alert value object
│   ├── checks/
│   │   ├── HealthCheck.bt     # Protocol definition
│   │   ├── HttpHealthCheck.bt
│   │   ├── TcpPortCheck.bt
│   │   └── ProcessCheck.bt
│   ├── notifications/
│   │   ├── NotificationRouter.bt
│   │   └── WebhookChannel.bt
│   ├── receiver/
│   │   ├── WebhookReceiver.bt
│   │   └── AlertLog.bt
│   └── dashboard/
│       └── Dashboard.bt
├── static/
│   ├── style.css
│   └── app.js
├── test/
│   ├── monitor_test.bt
│   ├── check_result_test.bt
│   ├── http_health_check_test.bt
│   ├── notification_router_test.bt
│   ├── webhook_channel_test.bt
│   ├── webhook_receiver_test.bt
│   ├── alert_log_test.bt
│   ├── check_registry_test.bt
│   └── dashboard_test.bt
└── README.md
```

## Stdlib Coverage Matrix

| Stdlib Feature | Where Exercised |
|----------------|-----------------|
| Actor spawn/state/stop | Monitor, CheckRegistry, NotificationRouter, WebhookChannel, AlertLog |
| Actor timers | Monitor (periodic checks), WebhookChannel (retry backoff) |
| Hot reload | Reload any component via REPL without restarting |
| Protocol | HealthCheck protocol, multiple implementations |
| Value objects (sealed) | CheckResult, MonitorEvent, Alert |
| HTTPServer + HTTPRouter | Dashboard, WebhookReceiver |
| HTTPClient | HttpHealthCheck, WebhookChannel |
| HTTPRequest/HTTPResponse | All HTTP handlers |
| JSON encode/decode | WebhookChannel (encode), WebhookReceiver (decode) |
| Collections (Array) | History ring buffers, status lists |
| Collections (Dictionary/Map) | Config, status maps, alert data |
| String concatenation (++) | HTML rendering, log messages |
| Blocks/closures | Router handlers, collection transforms, timer callbacks |
| Result handling | HTTPClient responses, JSON parsing |
| Error handling | Network failures, parse errors, missing checks |
| DateTime | Timestamps on results, alerts, dedup windows |
| Symbols | Status enums (#ok, #fail, #alert, #recovered) |

## Potential Stdlib Gaps to Watch

These may need stdlib work — confirm during implementation:

| Gap | Needed For | Workaround |
|-----|-----------|------------|
| `TCP connect` / `gen_tcp` FFI | TcpPortCheck | Erlang FFI call |
| `Timer every:do:` on actors | Monitor periodic checks | May need `send_after` pattern |
| `DateTime now` / arithmetic | Timestamps, dedup windows | Erlang `os:system_time/1` FFI |
| `Json encode:` / `Json decode:` | Webhook payloads | Check if stdlib has JSON support |
| Ring buffer / bounded collections | History limits | `(array copyWith: item) last: N` |
| Static file serving | Dashboard CSS/JS | Read file, set content-type manually |
| `String includes:` | Body match in HttpHealthCheck | May need to confirm method name |

## Test Strategy

Every component gets a BUnit TestCase. Tests use `beamtalk_http_test_server` pattern for HTTP assertions.

| Test | What It Covers |
|------|---------------|
| `check_result_test` | Value object creation, status predicates |
| `http_health_check_test` | HTTP check against test server, success/failure/timeout |
| `monitor_test` | State transitions, threshold logic, flapping detection |
| `notification_router_test` | Event routing, dedup within window |
| `webhook_channel_test` | JSON payload format, retry on failure |
| `webhook_receiver_test` | POST acceptance, JSON validation, 400 on bad input |
| `alert_log_test` | Recording, querying, size limits |
| `check_registry_test` | Add/remove monitors, status aggregation |
| `dashboard_test` | HTTP routes return 200, JSON API returns valid data |

## Implementation Order

Build bottom-up, testing each layer before moving up:

1. **Value objects**: CheckResult, MonitorEvent, Alert
2. **HealthCheck protocol + HttpHealthCheck** (exercises Protocol, HTTPClient)
3. **Monitor actor** (exercises timers, state transitions)
4. **CheckRegistry** (exercises collections, actor management)
5. **NotificationRouter + WebhookChannel** (exercises HTTP POST, retry, JSON)
6. **WebhookReceiver + AlertLog** (exercises HTTPServer, HTTPRouter, JSON decode)
7. **Dashboard** (exercises HTML rendering, API routes, static serving)
8. **Watcher** (top-level wiring, config)
9. **TcpPortCheck, ProcessCheck** (additional check types)
