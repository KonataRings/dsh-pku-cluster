# dsh-pku-cluster

Bring the **Peking University Weiming Teaching-2** cluster into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Click the sidebar entry once, enter your account id, password and one-time code, and from then on
any conversation can submit jobs, move files and read logs on the cluster — without opening a
terminal and retyping the password and OTP every few minutes.

```
┌──────────────────────────────────────────────────────────────┐
│  sidebar  ⋯  Connect cluster ●     ← dot: green = connected   │
│             └─ opens: id / password / OTP / Diagnose         │
└──────────────────────────────────────────────────────────────┘
```

- **One login, eight hours of reuse** — password + OTP once, then `ssh` / `scp` / `rsync` ride
  the same OpenSSH ControlMaster.
- **No stored credentials** — password and OTP travel over stdin to a driver and are discarded;
  the plugin keeps no keys.
- **Bridges WSL and the Windows VPN** — the VPN only affects the Windows stack; WSL2 does not
  inherit its routes. The plugin runs a loopback relay to close that gap
  (see [How it works](#how-it-works)).
- **No Python dependencies** — the driver uses only the standard library (`pty`); no pip,
  no `pexpect`.
- **Self-check** — Diagnose verifies the environment and prints a fix for each failure.

---

## Contents

- [Scope](#scope)
- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Daily use (`pku`)](#daily-use-pku)
- [Telling the agent about it](#telling-the-agent-about-it)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Files and uninstall](#files-and-uninstall)
- [Troubleshooting](#troubleshooting)
- [Security and privacy](#security-and-privacy)
- [Limitations and compatibility](#limitations-and-compatibility)
- [Development](#development)
- [FAQ](#faq)
- [License](#license)

---

## Scope

**For you if** you have a PKU Teaching-2 account, run DSH on Windows (WSL2) or Linux/macOS, and
want an agent that can submit jobs for you.

**Not for you if**

- you need fully unattended access — the cluster offers no key authentication, only password + OTP,
  so a human must log in (platform limitation, not a design choice here);
- you want a different cluster — `loginHost` is configurable, but the queue commands in `pku`
  assume CraneSched (see [compatibility](#limitations-and-compatibility));
- you want to run headless on a server — logging in needs an OTP entered by a human.

---

## Requirements

| Item | Requirement | Notes |
|---|---|---|
| Account | PKU Teaching-2 login | your student/staff id |
| OTP | bound at <https://hpc.pku.edu.cn/authotp/otp> | FreeOTP, Google Authenticator…; the phone clock must be accurate |
| Network | campus network, or the university VPN when off campus | iSecSP on Windows |
| OS | Windows 11 + WSL2, or Linux / macOS | on Windows a WSL2 distro is required (the plugin picks the first from `wsl -l -q`) |
| Tools | `ssh`, `rsync` | usually present in WSL; `sudo apt install openssh-client rsync` if not |
| DSH | able to install local plugins | host + client parts |

---

## Install

### From GitHub (requires Git on the machine)

```bash
dsh plugin --profile <profile> add git+https://github.com/KonataRings/dsh-pku-cluster.git
```

> pnpm shells out to `git ls-remote` for git dependencies. **Without Git installed this fails**
> (`ERR_PNPM_GIT_RESOLVE_FAILED`) — use the tarball form below instead.

### From a tarball (no Git needed)

```bash
dsh plugin --profile <profile> add https://github.com/KonataRings/dsh-pku-cluster/archive/refs/tags/v0.1.1.tar.gz
```

### From npm (not published yet)

```bash
dsh plugin --profile <profile> add dsh-pku-cluster
```

### From a local checkout

```bash
dsh plugin --profile desktop add link:/abs/path/to/dsh-pku-cluster
```

Fully restart DSH afterwards (a page refresh is not enough). The "Connect cluster" button appears
at the bottom of the sidebar, next to "Mobile access".

Upgrade by re-running `add`; to remove, see [Files and uninstall](#files-and-uninstall).

> Do not install two copies of this plugin into one profile — package name, route prefix and the
> client module id would collide.

---

## First run

1. **Connect the VPN** (off campus only). On Windows make sure the iSecSP TAP adapter is `Up`.
2. Click **Connect cluster** in the sidebar.
3. Fill in:
   - **Account id** — stored in `~/.pku-cluster/config.json` (not a secret; mode `600`);
   - **Password** — the portal password from account creation;
   - **One-time code** — the 6 digits from your authenticator (valid for 30 s only).
4. Press **Log in**. The first connection accepts the host key automatically
   (`StrictHostKeyChecking=accept-new`).
5. The dot turns green and the panel shows `connected`.

Press **Diagnose** whenever something looks off — it checks Python, pty, ssh, endpoint
reachability and the account id, with a concrete fix per failure.

---

## Daily use (`pku`)

Once logged in, both you and the agent can use `~/.pku-cluster/pku` inside WSL:

| Command | Purpose |
|---|---|
| `pku status` | connection state + login node |
| `pku run '<command>'` | run on the **login node** (submit/inspect only — no heavy compute) |
| `pku push <local> <remote>` | rsync upload |
| `pku pull <remote> <local>` | rsync download |
| `pku sbatch <script> [remote_dir]` | upload and submit a job (defaults to `~/jobs`) |
| `pku jobs` | your queue (`squeue`, falling back to `cqueue`) |
| `pku log <file> [lines]` | tail a job log |
| `pku shell` | interactive shell |
| `pku down` | drop the multiplexed connection |

`pku` reads host, port and account id from `config.json`, so **you never edit `~/.ssh/config`**.

### End-to-end example

```bash
mkdir -p ~/proj && cd ~/proj
cat > job.sh <<'SH'
#!/bin/bash
#SBATCH -J myjob
set -euo pipefail
WORKDIR=/nfs-share/home/<id>/proj      # hardcode it: the scheduler copies the script elsewhere
cd "$WORKDIR"
RAW="${SLURM_CPUS_PER_TASK:-4}"; CPUS=$(printf '%.0f' "$RAW")
export OMP_NUM_THREADS="$CPUS" MKL_NUM_THREADS=1
source ~/miniforge3/etc/profile.d/conda.sh
conda activate dmet-minimal
python -u main.py
SH

pku push main.py proj/
pku sbatch job.sh proj/
pku jobs
pku log proj/job.out 80
```

> Two pitfalls worth remembering: the scheduler **copies the script** before running it (so `cd`
> must be absolute, never `dirname "$0"`), and **`SLURM_CPUS_PER_TASK` is a float string** like
> `"4.00"` — exporting it straight to `OMP_NUM_THREADS` makes Intel OpenMP abort.
> Details in [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Telling the agent about it

New conversations do not know this convention. Add this to `AGENTS.md` (or wrap it in a skill):

```markdown
## Cluster (PKU Teaching-2)
- Connect the VPN, then log in from the DSH sidebar ("Connect cluster"); check with `pku status`.
- Commands (run `~/.pku-cluster/pku` inside WSL):
  `status` / `run '<cmd>'` / `push` / `pull` / `sbatch` / `jobs` / `log`.
- Rules: no compute on the login node — always `sbatch`; hardcode the working directory in job
  scripts; `OMP_NUM_THREADS` must be an integer.
```

Then "run this input on the cluster" is enough for the agent to do `pku push` + `pku sbatch`.

---

## Configuration

Override in the profile's `cordis.patch.yml`; every field is optional:

```yaml
- id: pku-cluster
  name: dsh-pku-cluster
  config:
    loginHost: wmjx2-login.pku.edu.cn   # login node (change this for another cluster)
    loginPort: 22
    relayPort: 2222                     # Windows relay port
    distro: ''                          # empty = first distro from `wsl -l -q`
    autoInstall: true                   # write ~/.pku-cluster/* on first load
```

| Field | Default | Meaning |
|---|---|---|
| `loginHost` | `wmjx2-login.pku.edu.cn` | login node hostname or IP |
| `loginPort` | `22` | SSH port |
| `relayPort` | `2222` | Windows loopback relay port; change it if the port is taken |
| `distro` | empty (auto) | WSL distro name, e.g. `Ubuntu-20.04` |
| `autoInstall` | `true` | when false the plugin stops writing `~/.pku-cluster/*` |

The generated `config.json` also carries internal fields: `mode` (`relay` / `direct`, chosen by
platform) and `relayHost` (empty = the WSL default gateway).

---

## How it works

```
DSH page / sidebar
   │  ① account id + password + OTP (stdin only)
   ▼
login.py (inside WSL, or natively)
   │  ② opens a pty and answers "Password:" / "Verification Code:"
   ▼
ssh -M -N -f  ──►  ③ ControlMaster (reused for 8 hours)
   │
   ├─ Windows: connects to <WSL gateway IP>:<relayPort>  ← relay inside the plugin process
   │           └─ ④ the relay forwards to loginHost:22 on the Windows side, through the VPN
   └─ Linux / macOS: connects straight to loginHost:22
```

**Why the relay on Windows.** The VPN client (iSecSP / Array TAP) only takes over the Windows
network stack. WSL2 keeps its own NAT and does not inherit those routes, and
`networkingMode=mirrored` does not help for point-to-point TAP adapters — measured behaviour was:
WSL gets the host's source IP, `ip neigh` shows the gateway as REACHABLE, yet pinging the gateway
fails and port 22 times out, i.e. packets never leave.

So the plugin listens on the **Windows side of the WSL virtual switch** and forwards to the login
node; WSL's ssh connects to that local port. The relay binds only the WSL interface address,
never `0.0.0.0`, and lives inside the plugin process.

**Why a control socket.** The cluster has no key authentication, so every new connection would
need password + OTP. ControlMaster makes "authenticate once, reuse many times" possible — the best
available trade-off without weakening two-factor authentication.

### How long one login lasts

The published build hardcodes its own ssh options; it does not rely on your `~/.ssh/config`:

| Option | Value | Meaning |
|---|---|---|
| `ControlPersist` | `8h` | counted from the end of the **last session**; any `pku` call resets it |
| `ServerAliveInterval` / `CountMax` | `30s` / `6` | declares the connection dead after ~3 minutes of silence |
| `TCPKeepAlive` | `yes` | keeps idle NAT entries from being reaped |
| `ControlPath` | `~/.pku-cluster/cm/%r@%h-%p` | the reuse socket |

**Real lifetime = the shortest of these:**

| Event | Result |
|---|---|
| 8 hours without any `pku` call | the master exits; log in again |
| VPN drops | the master's TCP dies |
| **DSH quits / restarts** | **the relay lives in the plugin process and goes away with it → the master dies** |
| WSL shutdown / reboot | the master process is gone |
| Server-side session policy | unknown; the plugin cannot cover it |

In short: **as long as DSH is not restarted, WSL is not restarted and the VPN stays up — and you
use it at least once every 8 hours — one login keeps working.** Surviving a DSH restart would
require moving the relay into a standalone service, which this build does not ship
(see [limitations](#limitations-and-compatibility)).

---

## Files and uninstall

The plugin writes three files under `~/.pku-cluster/`:

| File | Mode | Purpose |
|---|---|---|
| `login.py` | `700` | login driver (stdlib pty, no third-party packages) |
| `pku` | `700` | command-line helper (`status`/`run`/`push`/`pull`/`sbatch`…) |
| `config.json` | `600` | connection parameters + account id |
| `cm/` | `700` | ControlMaster socket directory (`ssh -O check/exit`); deleting it drops the reuse |

**Uninstall**

```bash
dsh plugin --profile <profile> remove dsh-pku-cluster
rm -rf ~/.pku-cluster          # optional
ssh -O exit pku 2>/dev/null    # optional: drop the multiplexed connection first
```

The plugin does not touch `~/.ssh/config`, does not write `AGENTS.md`, and installs no services or
scheduled tasks.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Login fails at `relay` | VPN down / relay not running | connect the VPN, restart DSH, check Diagnose |
| Login fails at `password` / `otp` | wrong password, expired OTP (30 s) | use a fresh code; verify the phone clock |
| Login fails at `connect` | wrong `loginHost`, no VPN, filtered port | check the host; ping works but 22 times out = access control, use the VPN |
| Commands time out after login | VPN dropped, relay gone | `pku status`; reconnect and log in again |
| A Diagnose item is red | see its `fix` text | follow it |
| Job cannot find its script | the scheduler copies scripts | hardcode the working directory, pass `-D` |
| Job aborts / OOM | `OMP_NUM_THREADS` is `"4.00"` | truncate to an integer before exporting |

Deeper explanations live in [docs/troubleshooting.md](docs/troubleshooting.md).
When reporting a bug, include: platform, DSH version, the Diagnose output and the failing stage.

---

## Security and privacy

- **Passwords and OTPs are never stored** — they go over stdin to the driver, are consumed for the
  two ssh prompts, and dropped. The connection is owned by OpenSSH.
- The account id is not a secret, but it is still written with mode `600`.
- **Every HTTP route accepts loopback only**: the remote address must be `127.0.0.1` / `::1` and
  the `Host` header must be `localhost` / `127.0.0.1`. Exposing DSH over the LAN therefore does not
  expose this login panel (exposing DSH itself is still a bad idea).
- The Windows relay binds the WSL interface address only and stops with the plugin process.
- The plugin never reads or modifies `~/.ssh`; it relies on the system `ssh` client.

---

## Limitations and compatibility

**Platform limits**

- No key authentication: after a VPN reconnect, an idle timeout or a suspend, you log in again.
- **The relay lives inside the plugin process**: quitting or restarting DSH tears it down and the
  established master connection dies with it. Surviving a DSH restart would need the relay to run
  as a standalone service, which this build does not ship.
- The login node has no internet access and must not run compute — use `sbatch`.

**Compatibility**

| Environment | Status |
|---|---|
| Windows 11 + WSL2 (Ubuntu 20.04) | ✅ tested (relay path) |
| Windows 11 + WSL2 (other distros) | ⚠️ expected to work, untested |
| Linux native | ⚠️ direct path implemented, untested |
| macOS | ⚠️ untested |
| Other clusters | ⚠️ change `loginHost`; `pku jobs`/`sbatch` assume CraneSched |

**Other**

- No model-facing tools (`cluster_*`); access goes through WSL commands plus an `AGENTS.md`
  convention. This keeps the first-turn tool table short, at the cost of one paragraph of setup.
- The panel UI is English; documentation is bilingual. Localising the page means editing `PAGE`
  in `lib/index.js`.

---

## Development

```
dsh-pku-cluster/
├─ lib/
│  ├─ index.js       host plugin: routes, built-in relay, asset install, page
│  └─ client.js      client module: sidebar button (sidebar.footer.action)
├─ resources/
│  ├─ login.py       login driver (stdlib pty)
│  └─ pku            command-line helper
├─ docs/
│  └─ troubleshooting.md
├─ cordis.patch.yml
├─ package.json
├─ README.md / README.en.md
├─ CHANGELOG.md
└─ LICENSE
```

Load locally with `dsh plugin --profile <profile> add link:<abs path>`, then restart DSH.

After touching `lib/index.js`, at minimum:

```bash
node --check lib/index.js
node --check lib/client.js
node -e "import('file:///abs/path/lib/index.js').then(m=>console.log(m.name, m.inject))"
```

The WSL-side resources can be tested standalone with an isolated HOME:

```bash
T=/tmp/pku-test; mkdir -p "$T/.pku-cluster"
cp resources/login.py resources/pku "$T/.pku-cluster/"
printf '{"mode":"direct","loginHost":"wmjx2-login.pku.edu.cn","user":"<id>"}\n' > "$T/.pku-cluster/config.json"
HOME="$T" python3 "$T/.pku-cluster/login.py" --diagnose
```

Issues and PRs welcome. Behaviour changes should also update [CHANGELOG.md](CHANGELOG.md) and
[docs/troubleshooting.md](docs/troubleshooting.md).

---

## FAQ

**Why do I have to log in again after a reboot?**
The cluster has no key authentication — only password + OTP. The ControlMaster lives 8 hours and
dies with the VPN. That is a platform limitation.

**Where does the OTP come from?**
Bind a phone token at <https://hpc.pku.edu.cn/authotp/otp> (FreeOTP / Google Authenticator); enter
the 6 digits at login. The phone clock must be accurate.

**Can I use two accounts at once?**
No — one ControlMaster per profile. `pku down`, change the id in the panel, log in again.

**What happens when the VPN drops?**
Reconnect it and log in again; the panel dot turns red.

**Do special characters in my password break anything?**
No. The password travels over stdin to a pty and never goes through a shell.

**Does the plugin store my password?**
No. Password and OTP exist only briefly in memory to answer ssh's two prompts.

**Can I point it at another cluster?**
`loginHost` / `loginPort` work for any password + OTP SSH host, but `pku jobs`/`sbatch` assume
CraneSched; adapt `resources/pku` for Slurm.

**Why does Windows need a relay and Linux does not?**
WSL2 does not inherit the Windows VPN routes (see [How it works](#how-it-works)); on Linux/macOS
the VPN is system-wide.

---

## License

[MIT](LICENSE) © 2026 dsh-pku-cluster contributors
