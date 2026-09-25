---
"@reddb-io/red-router": minor
---

**Network access setting.** Choose whether RedRouter answers only on this machine (127.0.0.1) or on the whole network (0.0.0.0), and switch back any time.

- **Dashboard:** Profile → Network access shows the address RedRouter is bound to and the LAN URLs other devices can use. "Save and restart" applies a new choice right away when the `red-router` CLI runs the server.
- **Terminal:** `red-router network local`, `red-router network lan`, or `red-router network status`. `--local` and `--expose` set it for a single run.
- **Precedence:** a `--host` flag wins for that run, then the saved choice, then the default. The default is unchanged: the launcher binds 0.0.0.0 and `red-router service` binds 127.0.0.1.
- **Services:** services installed from now on follow the saved choice unless installed with `--host` or `--expose`. Reinstall an existing service (`red-router service install`) to make it follow the saved choice.
