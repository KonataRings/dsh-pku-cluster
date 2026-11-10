# dsh-pku-cluster

把 **北京大学未名教学二号** 集群接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

侧边栏点一下，输入学号、密码和手机令牌验证码，之后**任意新对话**都能让 agent 直接在集群上提交作业、
上传下载、查看队列——不用再开一个终端反复输密码和 OTP。

```
┌──────────────────────────────────────────────────────────────┐
│  侧边栏  ⋯  连接集群 ●            ← 状态点：绿=已连接          │
│           └─ 点开：学号 / 密码 / OTP / Diagnose               │
└──────────────────────────────────────────────────────────────┘
```

- **一次认证，8 小时复用** — 密码 + OTP 只输一次，之后 `ssh` / `scp` / `rsync` 都走同一条
  OpenSSH ControlMaster 连接。
- **凭据不落盘** — 密码与验证码只经 stdin 交给登录驱动，随后即被丢弃；插件不保存任何密钥。
- **WSL 与 VPN 的桥** — Windows 上 VPN 只接管 Windows 网络栈，WSL2 拿不到路由；插件内置一个
  loopback 中继把这条路补上（详见[工作方式](#工作方式)）。
- **零 Python 依赖** — 登录驱动只用标准库 `pty`，不需要 pip、不需要 `pexpect`。
- **自检** — 面板里 Diagnose 逐项检查环境并给出可执行的修复建议。

---

## 目录

- [适用与不适用](#适用与不适用)
- [前置条件](#前置条件)
- [安装](#安装)
- [运行目标](#运行目标)
- [集群与会话（可并行）](#集群与会话可并行)
- [首次使用](#首次使用)
- [日常使用（`pku` 命令）](#日常使用pku-命令)
- [让 agent 知道怎么用](#让-agent-知道怎么用)
- [配置](#配置)
- [工作方式](#工作方式)
- [文件与卸载](#文件与卸载)
- [排障](#排障)
- [安全与隐私](#安全与隐私)
- [已知限制与兼容性](#已知限制与兼容性)
- [开发](#开发)
- [FAQ](#faq)
- [License](#license)

---

## 适用与不适用

**适合你，如果**：你有北大教学二号上机账号，在 Windows（有 WSL 或没有 WSL 都行）、Linux 或
macOS 上用 DSH，希望 agent 能直接往集群提交作业。

**不适合你，如果**：

- 你要的是**完全没有人工介入**的集群访问。集群明确不支持密钥认证，只能密码 + OTP，
  所以做不到无人值守（这是平台限制，不是插件的取舍）。
- 你要连的是别的学校/别的集群。`loginHost` 可以改，但 `pku` 里的队列命令假设是 CraneSched，
  换集群需要自己核对（见[兼容性](#已知限制与兼容性)）。
- 你想在服务器上无头运行。登录需要浏览器里的 OTP 与人工输入。

---

## 前置条件

| 项目 | 要求 | 说明 |
|---|---|---|
| 集群账号 | 教学二号上机账号 | 学号／工号即账号 |
| OTP | 已在 <https://hpc.pku.edu.cn/authotp/otp> 绑定手机令牌 | FreeOTP、Google Authenticator 等；**手机时间要准** |
| 网络 | 校内网，或校外先连学校 VPN | Windows 上是 iSecSP 客户端 |
| 操作系统 | Windows 11 + WSL2（至少一个发行版），或 Linux / macOS | Windows 上只支持 WSL 目标：原生 ssh 无法复用连接 |
| 工具 | `ssh`、`rsync` | WSL 里通常自带；缺了先 `sudo apt install openssh-client rsync` |
| DSH | 能安装本地插件 | 本插件是宿主 + 客户端两部分 |

---

## 安装

### 从 GitHub（需要机器上装 Git）

```bash
dsh plugin --profile <profile> add git+https://github.com/KonataRings/dsh-pku-cluster.git
```

> pnpm 拉 git 依赖要调用 `git ls-remote`。**没装 Git 会直接失败**（`ERR_PNPM_GIT_RESOLVE_FAILED`），
> 这种情况用下面的压缩包方式。

### 从压缩包（不需要 Git）

```bash
dsh plugin --profile <profile> add https://github.com/KonataRings/dsh-pku-cluster/archive/refs/tags/v0.1.1.tar.gz
```

### 从 npm

```bash
dsh plugin --profile <profile> add dsh-pku-cluster
```

包页：<https://www.npmjs.com/package/dsh-pku-cluster>

### 从本地目录（开发）

```bash
dsh plugin --profile desktop add link:C:\path\to\dsh-pku-cluster
```

装完**完全退出 DSH 再重开**（不是刷新页面）。侧边栏底部、靠近「移动访问」的位置会出现「连接集群」。

升级：重跑一次 `add`（或改版本后重装）；卸载见[文件与卸载](#文件与卸载)。

> 同一个 profile 里不要同时装两个同名插件（相同包名 / 路由 / 客户端模块 id 会冲突）。

---

## 运行目标

页面第一条「运行于」是执行目标，决定的只是**插件在哪里跑 ssh 和 helper 脚本**：

| 平台 | 目标 | 说明 |
|---|---|---|
| Windows | 每个 WSL 发行版 | `wsl.exe -d <发行版>` 里的 `bash` + `python3`；命令复用一条连接 8 小时 |
| Linux / macOS | 本机（唯一） | 系统的 `bash` + `ssh`，行为与 WSL 目标一致 |

- 切换立即生效：页面会重新查一次连接状态。选择记在 `~/.pku-cluster/target.json`，下次打开还是它。
- 停着的发行版也能选，`wsl.exe` 会顺手把它拉起来。

**Windows 上没有「本机」目标，这是有意的**：Win32-OpenSSH 建不出 ControlMaster 控制套接字；
Git for Windows 的 MSYS ssh 能建，却无法把会话交给它（AF_UNIX 不支持传文件描述符，报
`mm_send_fd: sendmsg(2)`）。两者都做不到「一次登录、8 小时复用」，留着只会让每条命令重新输 OTP。
Windows 下请使用 WSL 发行版；一个都没有时，面板会直接提示先安装。

---

## 集群与会话（可并行）

内置四个集群、七个端点：

| 集群 | 登录节点 | 数据传输节点 |
|---|---|---|
| 未名教学二号 | `wmjx2-login.pku.edu.cn` | — |
| 未名一号 | `wm1-login.pku.edu.cn` | `wm1-data.pku.edu.cn` |
| 未名生科一号 | `wmsk1-login.pku.edu.cn` | `wmsk1-data.pku.edu.cn` |
| 未名二号 | `wm2-login.pku.edu.cn` | `wm2-data.pku.edu.cn` |

页面第二条「会话」是一个下拉框，按集群分组列出**每个集群 × 每个端点**（`wm1:login`、`wm1:data`…），
已连接的会话在选项里直接标「已连接」。

- **并行**：一次登录只作用于一个会话，其它会话不受影响。可以同时把未名一号和未名二号的登录节点
  都连上，各自维持 8 小时；WSL 目标下每个会话都有自己的中继端口。
- 账号按会话保存，第一次会从旧的 `config.json` 继承，之后可以逐集群改成不同账号。
- 集群目录在 `~/.pku-cluster/clusters.json`，改完重开面板即生效（删掉的集群不会再出现；
  文件不存在时才用内置列表）：

  ```json
  [
    { "id": "wm1", "label": "未名一号", "login": "wm1-login.pku.edu.cn", "data": "wm1-data.pku.edu.cn" },
    { "id": "lab", "label": "实验室机器", "login": "10.1.2.3", "port": 2222 }
  ]
  ```

---
## 首次使用

1. **连 VPN**（仅校外需要）。Windows 上确认 iSecSP 的 TAP 适配器是 `Up`。
2. 点侧边栏 **连接集群**，第一条选 WSL 发行版，第二条选要登录的会话（集群 × 节点）。
3. 填写：
   - **学号** — 按会话保存在 `~/.pku-cluster/sessions/<集群>-<端点>.json`（不是机密，权限 600）；
   - **密码** — 开卡时的门户密码；
   - **OTP** — 手机令牌里的 6 位数字（只有 30 秒有效，别提前抄）。
4. 点 **Log in**。首次连接会确认主机指纹（插件已用 `StrictHostKeyChecking=accept-new` 自动接受）。
5. 状态点变绿、面板显示 `connected` 即成功。

不确定哪里不对时，点 **Diagnose**，它会逐项告诉你 Python、pty、ssh、端点可达性、学号是否就绪。

---

## 日常使用（`pku` 命令）

登录成功后，agent 和你在 WSL 里都可以用 `~/.pku-cluster/pku`。默认操作**当前选中的会话**，用 `-c` 指定别的：

| 命令 | 作用 |
|---|---|
| `pku -c wm1 status` | 指定会话：`集群` 或 `集群:端点`（如 `wm1:data`） |
| `pku sessions` | 列出注册的会话与账号 |
| `pku status` | 连接是否活着 + 登录节点信息 |
| `pku run '<命令>'` | 在**登录节点**执行命令（只做提交、查看，不要跑计算） |
| `pku push <本地> <远端>` | rsync 上传 |
| `pku pull <远端> <本地>` | rsync 下载 |
| `pku sbatch <脚本> [远端目录]` | 上传脚本并提交作业，默认放到 `~/jobs` |
| `pku jobs` | 看自己的队列（`squeue`，退回 `cqueue`） |
| `pku log <文件> [行数]` | 看作业输出 |
| `pku shell` | 进入交互 shell |
| `pku down` | 断开复用连接 |

`pku` 会自己从会话文件读取地址、端口与学号，所以你**不需要**改 `~/.ssh/config`；反过来，它在 0.2 起**不再受** `~/.ssh/config` 里同名 Host 块的影响（它连的是真实主机名，不是 `pku` 这个别名）。

> rsync，所以 `push` / `pull` / `sbatch` 改用 `scp` 上传。WSL 和 Linux/macOS 目标仍是 bash 版 `pku`。

### 一个完整例子

```bash
# 1) 本地准备脚本
mkdir -p ~/proj && cd ~/proj
cat > job.sh <<'SH'
#!/bin/bash
#SBATCH -J myjob
set -euo pipefail
WORKDIR=/nfs-share/home/<学号>/proj      # 必须写死：调度器会把脚本复制到别处执行
cd "$WORKDIR"
RAW="${SLURM_CPUS_PER_TASK:-4}"; CPUS=$(printf '%.0f' "$RAW")
export OMP_NUM_THREADS="$CPUS" MKL_NUM_THREADS=1
source ~/miniforge3/etc/profile.d/conda.sh
conda activate dmet-minimal
python -u main.py
SH

# 2) 提交（脚本 + 同目录文件都要传）
pku push main.py proj/
pku sbatch job.sh proj/

# 3) 看队列与输出
pku jobs
pku log proj/job.out 80
```

> 两个高频坑：**调度器会复制脚本执行**（所以 `cd` 必须写死绝对路径，别用 `dirname "$0"`）；
> **`SLURM_CPUS_PER_TASK` 是浮点字符串** `"4.00"`，直接给 `OMP_NUM_THREADS` 会让 Intel OpenMP
> 报错 abort。见 [docs/troubleshooting.md](docs/troubleshooting.md)。

---

## 让 agent 知道怎么用

新对话默认不知道这个约定。把下面这段加进 `AGENTS.md`（或做成一个 skill），就能让每个会话都用对：

```markdown
## 集群（北大教学二号）
- 连接：先连 VPN，再在 DSH 侧边栏「连接集群」登录；连接状态用 `pku status` 查。
- 命令（在 WSL 里执行 `~/.pku-cluster/pku`）：
  `status` / `run '<cmd>'` / `push` / `pull` / `sbatch` / `jobs` / `log`。
- 规则：登录节点禁止跑计算，一律 `sbatch`；脚本里写死绝对工作目录；
  `OMP_NUM_THREADS` 必须是整数。
```

加了之后，你可以直接说「在集群上跑一下这个输入」，agent 就会走 `pku push` + `pku sbatch`。

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖，全部可选：

```yaml
- id: pku-cluster
  name: dsh-pku-cluster
  config:
    loginHost: wmjx2-login.pku.edu.cn   # 登录节点（换集群改这里）
    loginPort: 22
    relayPort: 0                        # 0 = 每个会话自动分配；设 2222 可沿用旧防火墙规则
    distro: ''                          # 留空 = 自动取 `wsl -l -q` 的第一个
    autoInstall: true                   # 首次加载时写入 ~/.pku-cluster/*
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `loginHost` | 空 | 额外追加的自定义登录节点；一般改用 `clusters.json` |
| `loginPort` | `22` | SSH 端口 |
| `relayPort` | `0` | `0` = 每个会话由系统分配端口；设为非 0 时优先占用该端口（只可能给第一个会话） |
| `distro` | 空（自动） | **初始**使用的 WSL 发行版名；页面顶部切换后以切换结果为准 |
| `autoInstall` | `true` | 关掉后插件不再写 `~/.pku-cluster/*`（自行维护时用） |

会话文件（`sessions/<集群>-<端点>.json`）里还包含内部字段 `mode`（`relay` / `direct`）、
`relayHost` / `relayPort` 和 `controlPath`，由插件按当前执行目标自动维护。

> `distro` 只是**初始**默认值；页面顶部的选择会覆盖它，并记在 `~/.pku-cluster/target.json`。
> 注意 Windows 上的 `~` 是 Windows 家目录，和 WSL 里的 `~/.pku-cluster` 不是同一个地方：
> `target.json` 属于宿主，`config.json` 属于被选中的那个目标。

> **从 0.1.x 升级**：`config.json` 会一次性迁移成 `wmjx2:login` 会话（保留学号）。中继端口改为
> 按会话动态分配，旧版固定 `2222` 的防火墙规则不再适用；如需保留，把 `relayPort` 设成 `2222`，
> 插件会优先占用它（只可能给第一个会话，其余仍动态分配）。

---

## 工作方式

```
DSH 页面 / 侧边栏
   │  ① 学号 + 密码 + OTP（只在内存里，经 stdin 交给驱动）
   ▼
login.py（WSL 或本机 bash，标准库 pty）
   │  ② 用 pty 应答 "Password:" 与 "Verification Code:"
   ▼
ssh -M -N -f  ──►  ③ 每个会话一条 ControlMaster（复用 8 小时）
   │
   ├─ WSL 目标：连 <中继地址>:<relayPort>  ← 每会话一个中继；NAT 绑 WSL 网卡地址，镜像网络绑 127.0.0.1
   │            └─ ④ 中继在 Windows 侧转发到 loginHost:22，从而穿过 VPN
   └─ Linux / macOS：直连 loginHost:22（VPN 已经作用在本机网络栈上）
```

**为什么 WSL 目标需要那个中继？**

VPN 客户端（iSecSP / Array TAP）只接管 Windows 的网络栈。WSL2 有自己的 NAT，不继承这些路由；
`networkingMode=mirrored` 对点对点 TAP 适配器同样无效——实测 WSL 能拿到与主机相同的源 IP、
`ip neigh` 里网关是 REACHABLE，但 ping 网关失败、22 端口超时，数据包根本没出去。

于是插件在 **WSL 虚拟网卡的 Windows 侧地址**上监听，把连接原样转发到登录节点，WSL 里的 ssh 连这个
本地端口即可。中继只绑定 WSL 网段地址，不监听 `0.0.0.0`，也不对局域网暴露；随插件进程一起启停。

**为什么还要 control socket？** 因为集群不支持密钥认证，每次新连接都要密码 + OTP。
ControlMaster 让「一次认证、多次复用」成为可能，这是在不牺牲二步验证的前提下的最优解。

### 一次登录能维持多久

发布版的连接参数是写死的，不依赖你的 `~/.ssh/config`：

| 参数 | 值 | 含义 |
|---|---|---|
| `ControlPersist` | `8h` | 从**最后一次会话结束**开始计；期间任何 `pku` 调用都会重置计时 |
| `ServerAliveInterval` / `CountMax` | `30s` / `6` | 约 3 分钟收不到回应就判定断开 |
| `TCPKeepAlive` | `yes` | 让中间设备别把空闲连接回收 |
| `ControlPath` | `~/.pku-cluster/cm/%r@%h-%p` | 复用 socket |

**实际寿命 = 下面几项里最短的那个**：

| 事件 | 结果 |
|---|---|
| 8 小时没有任何 `pku` 操作 | master 自动退出，需重新登录 |
| VPN 断开 | master 的 TCP 断开 → 失效 |
| **DSH 退出 / 重启** | **中继在插件进程内，随之关闭 → master 断开** |
| WSL 关闭 / 重启 / Windows 重启 | master 进程消失 → 失效 |
| 平台侧会话策略 | 未知（可能有权踢线），发布版无法覆盖 |

也就是说：**只要 DSH 不重启、WSL 不重启、VPN 不掉，并且 8 小时内用过一次，就能一直用。**
想跨 DSH 重启保留连接，需要把中继做成独立常驻进程——发布版没有内置（见[已知限制](#已知限制与兼容性)）。

---

## 文件与卸载

插件会在你的家目录写这些文件（都在 `~/.pku-cluster/`）：

| 文件 | 权限 | 作用 |
|---|---|---|
| `login.py` | `700` | 登录驱动（标准库 pty，无第三方依赖）；bash 目标使用 |
| `pku` | `700` | 命令行包装器（status/run/push/pull/sbatch…）；bash 目标使用 |
| `sessions/<集群>-<端点>.json` | `600` | 会话参数 + 学号（属于当前目标） |
| `clusters.json` | - | 集群目录（宿主持有） |
| `selected-session.json` | - | 上次选中的会话（宿主持有） |
| `target.json` | - | 页面顶部选中的运行目标（属于宿主） |
| `cm/` | `700` | ControlMaster 的 socket 目录（`ssh -O check/exit` 用它；删掉等于断开复用） |

**卸载**：

```bash
dsh plugin --profile <profile> remove dsh-pku-cluster
rm -rf ~/.pku-cluster        # 可选：连带删除上面三个文件
ssh -O exit pku 2>/dev/null  # 可选：先断开复用连接（如果还在）
```

插件不改你的 `~/.ssh/config`，不写 `AGENTS.md`，也不留计划任务或系统服务。

---

## 排障

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 登录在 `relay` 阶段失败 | VPN 没连 / 中继没起来 | 连 VPN；重启 DSH；面板 Diagnose 看 endpoint 项 |
| 登录在 `password` / `otp` 阶段失败 | 密码错、OTP 过期（30 秒） | 换新验证码重试；确认手机时间准确 |
| 登录在 `connect` 阶段失败 | `loginHost` 不对、VPN 未连、端口被过滤 | 核对主机名；`ping` 通但 22 超时=访问控制，需 VPN |
| 登录报 `no password prompt seen: …` | ssh 没在 pty 上打印提示（0.2 之前缺控制终端），或 ssh 自己先失败 | 0.2 起用 `pty.fork()` 分配控制终端；冒号后面是 ssh 的原话，按它排查 |
| 登录成功但命令超时 | VPN 掉线、中继被回收 | `pku status`；重连 VPN 后重新登录 |
| Diagnose 有红项 | 见每项的 fix 提示 | 按提示安装/修复 |
| 作业报找不到脚本文件 | 调度器复制脚本执行 | 脚本里写死绝对工作目录，提交加 `-D` |
| 作业 OOM / Aborted | `OMP_NUM_THREADS` 被传成 `"4.00"` | 先取整再 export |

更细的「为什么」和确认方法见 [docs/troubleshooting.md](docs/troubleshooting.md)。
报问题时请附上：平台（Windows/Linux/macOS）、DSH 版本、面板 Diagnose 的输出、失败阶段。

---

## 安全与隐私

- **不保存密码与 OTP**：只经 stdin 传给驱动；驱动应答完提示后即丢弃，连接由 OpenSSH 持有。
- **学号不是机密**，但同样按 `600` 存放。
- **HTTP 路由仅接受 loopback**：`req.socket.remoteAddress` 必须是 `127.0.0.1`/`::1`，
  且 `Host` 头必须是 `localhost`/`127.0.0.1`。即使你把 DSH 通过移动访问/LAN 暴露出去，
  这个登录页也不会跟着对外（但仍不建议把 DSH 本身暴露给不可信网络）。
- **中继只绑定 WSL 网卡地址**，不监听 `0.0.0.0`；随插件进程退出而关闭。
- 插件不读取也不修改你的 `~/.ssh` 内容，只依赖系统 `ssh` 客户端。

---

## 已知限制与兼容性

**平台限制**

- 集群**不支持密钥认证**，因此：VPN 重连、连接闲置超时、机器休眠之后，都需要重新登录一次。
- **中继随插件进程启停**：DSH 退出或重启会一并关闭中继，从而断开已建立的 master 连接。
  要跨 DSH 重启保持连接，需要把中继改成独立常驻服务（本版本未内置）。
- **Windows 只能用 WSL 目标**：原生 ssh 无法复用连接，因此插件不提供 Windows 本机目标；
  没有 WSL 发行版时，页面会直接提示先安装。Linux / macOS 的本机模式不受影响。
  的 ssh 能建、但无法把会话交给 master（无 fd passing）。要复用请选 WSL 目标；Linux / macOS 的本机模式
  直接用系统 ssh，不受影响。
- **WSL 镜像网络（`networkingMode=mirrored`）**：没有 vEthernet 适配器，中继改为绑 `127.0.0.1`，
  WSL 侧经 localhost 互通访问它。
- 登录节点不可联网、禁止跑计算；必须 `sbatch` 到计算节点。

**兼容性**

| 环境 | 状态 |
|---|---|
| Windows 11 + WSL2（Ubuntu 20.04） | ✅ 已验证（中继路径） |
| Windows 11 无 WSL 发行版 | ❌ 无可用目标；面板提示先安装 |
| Windows 11 + WSL2（其他发行版） | ⚠️ 预期可用，未实测（取决于 `ip route` 输出） |
| Linux 原生 | ⚠️ 直连路径已实现，未实测 |
| macOS | ⚠️ 未验证 |
| 其他集群 | ⚠️ 改 `loginHost` 即可连上，但 `pku jobs/sbatch` 假设 CraneSched |

**其他**

- 插件不提供模型侧工具（`cluster_*` tool），走的是 WSL 命令 + `AGENTS.md` 约定；
  这样做的好处是不增加首轮工具表长度，代价是需要你写一段说明。
- 页面是英文，文档中英双语；要本地化页面文案可以改 `lib/index.js` 里的 `PAGE`。

---

## 开发

```
dsh-pku-cluster/
├─ lib/
│  ├─ index.js       宿主插件：路由、内置中继、资产安装、页面
│  └─ client.js      客户端模块：侧边栏按钮（sidebar.footer.action）
├─ resources/
│  ├─ login.py       登录驱动（标准库 pty）
│  └─ pku            命令行包装器
├─ docs/
│  └─ troubleshooting.md
├─ cordis.patch.yml
├─ package.json
├─ README.md / README.en.md
├─ CHANGELOG.md
└─ LICENSE
```

本地加载：`dsh plugin --profile <profile> add link:<绝对路径>`，然后重启 DSH。

改动 `lib/index.js` 后建议至少做：

```bash
node --check lib/index.js
node --check lib/client.js
# 用假 ctx 加载插件，验证路由注册 / loopback 守卫 / 中继绑定
node -e "import('file:///abs/path/lib/index.js').then(m=>console.log(m.name, m.inject))"
```

WSL 侧资源可以脱离 DSH 单独验证（用隔离的 HOME，不影响现有环境）：

```bash
T=/tmp/pku-test; mkdir -p "$T/.pku-cluster"
cp resources/login.py resources/pku "$T/.pku-cluster/"
printf '{"mode":"direct","loginHost":"wmjx2-login.pku.edu.cn","user":"<id>"}\n' > "$T/.pku-cluster/config.json"
HOME="$T" python3 "$T/.pku-cluster/login.py" --diagnose
```

欢迎 issue / PR。改协议行为时请一并更新 [CHANGELOG.md](CHANGELOG.md) 与
[docs/troubleshooting.md](docs/troubleshooting.md)。

---

## FAQ

**Q：为什么每次开机都要重新登录？**
A：集群不支持密钥认证，只有密码 + OTP。ControlMaster 复用期是 8 小时，且随 VPN 断线失效。
这是平台限制，不是插件能绕过的。

**Q：OTP 从哪来？**
A：先在 <https://hpc.pku.edu.cn/authotp/otp> 绑定手机令牌（FreeOTP / Google Authenticator），
之后每次登录输入 App 里的 6 位数字。注意手机时间要准，否则码会不对。

**Q：能同时连两个账号吗？**
A：同一个 profile 只能有一个 ControlMaster。换账号：`pku down` → 在面板里改学号 → 重新登录。

**Q：VPN 断了怎么办？**
A：重连 VPN，然后在面板里再登录一次。面板状态点会变红提示。

**Q：密码里有特殊字符会不会出问题？**
A：不会。密码走 stdin 交给 pty，不经过任何 shell 拼接。

**Q：插件会存我的密码吗？**
A：不会。密码和 OTP 只在内存中短暂存在，用于应答 ssh 的两条提示。

**Q：能连别的集群吗？**
A：改 `loginHost`/`loginPort` 可以连上任何「密码 + OTP」的 SSH 集群，但 `pku` 里的
`jobs`/`sbatch` 是按 CraneSched 写的，换 Slurm 需要自己改 `resources/pku`。

**Q：为什么 Windows 要比 Linux 多一层中继？**
A：因为 WSL2 不继承 Windows 的 VPN 路由（见[工作方式](#工作方式)）。Linux/macOS 上 VPN 是
系统级的，不需要这层。

---

## License

[MIT](LICENSE) © 2026 dsh-pku-cluster contributors
