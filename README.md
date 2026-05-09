# beamtalk_watcher

A small monitoring tool written in Beamtalk. Polls HTTP, TCP, and BEAM-process
health checks; routes outbound state-change notifications through a deduping
fan-out router; accepts inbound webhook alerts; and serves a live dashboard
with a JSON API.

See `SPEC.md` for the full design.

## Building

```bash
just build
```

## Testing

```bash
just test
```

## Quickstart

The top-level entry point is the `Watcher` actor (see `src/Watcher.bt`).
Bring it up with default ports (dashboard on `8080`, receiver on `8081`,
no checks, no outbound webhook):

```beamtalk
w := Watcher start
```

Or supply a configuration:

```beamtalk
w := Watcher startWith: #{
  #dashboardPort => 8080,
  #receiverPort  => 8081,
  #webhookUrl    => "https://hooks.example.com/alerts",
  #checks => #(
    #{ #type => #http,    #name => #api,
       #url => "http://localhost:3000/health",
       #interval => 15, #threshold => 2 },
    #{ #type => #tcp,     #name => #postgres,
       #host => "localhost", #port => 5432 },
    #{ #type => #process, #name => #worker,
       #process => #my_worker }
  )
}
```

`#dashboardPort` and `#receiverPort` may be `0` to bind an OS-assigned
ephemeral port (useful in tests). `#interval` defaults to 30 seconds and
`#threshold` to 3 consecutive results before a state transition fires.

Once running:

* `http://localhost:8080/`            — overview page
* `http://localhost:8080/monitors`    — detailed monitor list
* `http://localhost:8080/alerts`      — alert log (newest first)
* `http://localhost:8080/api/status`  — JSON status of all monitors
* `http://localhost:8081/webhook`     — inbound webhook endpoint (POST)

You can keep iterating from the REPL — add more checks, attach extra
notification channels, or query the alert log directly:

```beamtalk
w registry add: (HttpHealthCheck url: "http://localhost:4000/ping")
  name: #ping interval: 10 threshold: 2

w router addChannel: (WebhookChannel url: "https://hooks.slack.com/...")

w alertLog recent: 5
```

Call `w shutdown` to stop the dashboard and receiver and cancel every
monitor's timer.
