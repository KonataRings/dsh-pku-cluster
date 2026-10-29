# 排障与设计说明

这份文档记录的是开发/自测时真实遇到、且**换台机器还会再遇到**的问题，以及背后的原因。
症状速查表在 [README](../README.md#排障)，这里给的是「为什么」和「怎么确认」。

---

## 1. 校外连不上：ICMP 通，但 22 端口超时

**现象**

```
ping wmjx2-login.pku.edu.cn      # 通，~27 ms，0% 丢包
TCP 22  -> 超时
TCP 443 -> 超时
```

**含义**：主机活着、路由可达，端口在校外被**丢包**（不是拒绝）。这是校园网访问控制，
不是密码问题，也不是客户端问题。校内网或学校 VPN 才通。

**确认**：`Test-NetConnection <host> -Port 22` / `nc -vz <host> 22`；再对比 ping。

---

## 2. Windows：WSL 连不到集群

**现象**：Windows 里 `ssh` 正常（能拿到 `SSH-2.0-OpenSSH_7.4`），WSL 里同目标 22 端口超时，
但 WSL 访问普通外网正常。

**原因**：WSL2 默认 NAT，有自己的网络栈；Windows VPN 客户端（iSecSP / Array TAP）
装的 TAP 路由不作用于它。

**试过但无效**：`networkingMode=mirrored`（Windows 11 22H2+）。

- WSL 拿到与主机相同的源 IP、路由正确；
- `ip neigh` 里网关是 REACHABLE；
- 但 ping 网关失败、22 端口仍然超时 —— 数据包根本没出去。

结论：mirrored 对点对点 TAP 适配器无效。

**方案**：在 Windows 侧监听 WSL 虚拟网卡的地址，把连接转发到登录节点，WSL 的 ssh 连这个本地端口。
本插件把中继做在宿主进程里（不再另起脚本），绑定 WSL 网卡地址而非 `0.0.0.0`。

**注意**：中继解析目标时**必须强制 IPv4**。用主机名时 Node 会先解析到 IPv6，
而 Windows 到该 IPv6 不通，表现为「TCP 握手成功但永远等不到 banner」。

---

## 3. 中继进程被回收

**现象**：面板显示未连接，登录时报 `connect to host 172.30.x.1 port 2222: ...`，
但 VPN 的 TAP 明明是 Up。

**原因**：早期版本的 `cluster-relay.js` 是独立进程，从 DSH 的进程树里启动，
DSH 退出时被一起回收。

**现状**：中继已内置到插件进程，随插件加载启动、随插件卸载关闭；面板 Diagnose 里的
`endpoint ...: reachable` 一项会直接告诉你在不在。

---

## 4. 作业脚本报「找不到文件」

**现象**

```
python: can't open file '/home/crane/craned/scripts/adc_h2o.py': [Errno 2] No such file or directory
```

**原因**：CraneSched 把提交的脚本复制到 `/home/crane/craned/scripts/` 再执行，
脚本里 `cd "$(dirname "$0")"` 指向的是调度器目录。

**解法**：脚本里写死绝对工作目录，提交时再加 `-D <workdir>`：

```bash
WORKDIR=/nfs-share/home/<你的学号>/<项目>
cd "$WORKDIR"
```

---

## 5. 作业 OOM / Aborted

**现象**

```
OMP: Warning #234: OMP_NUM_THREADS: Invalid symbols found. Check the value "4.00".
OMP: Error #101: Out of heap memory.
... Aborted (core dumped)
```

**原因**：CraneSched 传的 `SLURM_CPUS_PER_TASK` 是浮点字符串 `"4.00"`，
直接 `export OMP_NUM_THREADS="$SLURM_CPUS_PER_TASK"` 会让 Intel OpenMP 解析失败并 abort。

**解法**

```bash
RAW="${SLURM_CPUS_PER_TASK:-${CRANE_CPUS_PER_TASK:-4}}"
CPUS=$(printf '%.0f' "$RAW"); case "$CPUS" in ''|0|*[!0-9]*) CPUS=4 ;; esac
export OMP_NUM_THREADS="$CPUS"
export MKL_NUM_THREADS=1
```

---

## 6. 调度器不是 Slurm

`sinfo -o ...` 报 `unknown shorthand flag: 'o'`、`squeue -o` 报 `invalid format specifier: i` ——
因为 `sinfo/squeue/sbatch` 是 `cwrapper` 兼容层，转发给 **CraneSched**。
原生命令是 `cinfo` / `cqueue` / `cbatch`。

---

## 7. 版本差异不影响数值结果（自测参考）

集群 `dmet-minimal`：Python 3.11 / pyscf 2.13.1 / adcc 0.17.0；本机 pyscf 2.14.0。
同一算例（H₂O/6-31G，ADC(2) 四个单重态）两边能级差 < 1e-4 eV，SCF 能量差 ~1e-13 Eh。

| 态 | 激发能 |
|---|---|
| S1 | 8.3260 eV |
| S2 | 10.6375 eV |
| S3 | 10.7940 eV |
| S4 | 13.3136 eV |

---

## 8. 登录节点限制

- 登录节点**不可联网**、**禁止跑计算**；计算一律 `sbatch` 到计算节点。
- 家目录有配额，大文件放临时/并行存储前先确认路径。

---

## 9. 认证模型（决定了所有限制）

- 平台**不支持密钥认证**（官方文档：「平台现不支持密钥方式登录认证」）。
- 只能 密码 + OTP；OTP 在 `https://hpc.pku.edu.cn/authotp/otp` 绑定，30 秒有效。
- 因此无法做到完全免人工登录：VPN 重连或连接超时后需要重新登录一次。
- **不要**把密码和 TOTP 密钥存盘自动生成验证码——等于把二步验证永久落地，泄露一次即失守。
