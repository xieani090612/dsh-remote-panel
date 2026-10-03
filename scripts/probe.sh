#!/bin/sh
# ============================================================================
# dsh-remote-panel —— 只读状态采集脚本
# ============================================================================
# 由宿主插件通过 ssh / wsl.exe 以一条命令的形式投喂给远程 POSIX shell，
# 因此这里必须是**完全自包含**的 POSIX sh：不假设 bash、不假设 zsh、
# 不假设 jq、不假设 python3，也不要求任何可写的临时目录。
#
# 输出协议：`@@@SECTION` 行分节，节内是 `key=value` 或每行一条记录。
# 每个节都独立静默失败 —— 少了 gpu 节不影响 cpu 节，解析端按节合并。
#
# 只读：整份脚本不写目标机任何文件（GPU 那段的 mktemp 是唯一例外，
# 且用完即删，失败会静默跳过）。
# ============================================================================

# 完成标记由退出路径上的 trap 负责，而不是写在最后一行。
# 理由：这样即便脚本中途被信号打断、或者某个命令让 shell 提前退出，
# 标记依然会被打印 —— 调用方就能凭「有没有 @@@END」准确区分
# 「跑完了但某项没数据」与「根本没跑完」。反过来，如果只在末尾 echo，
# 一次截断就会让半份数据看起来完全正常。
trap 'echo "@@@END"' EXIT

echo "@@@HOST"
hn=`hostname 2>/dev/null || echo unknown`
printf 'hostname=%s\n' "$hn"
os=""
if [ -r /etc/os-release ]; then
  os=`sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n1 | tr -d '"'`
fi
printf 'os=%s\n' "$os"
printf 'kernel=%s\n' "`uname -r 2>/dev/null`"
printf 'arch=%s\n' "`uname -m 2>/dev/null`"
# WSL 的内核版本串里带 microsoft 标记（例如 5.15.90.1-microsoft-standard-WSL2）。
if uname -r 2>/dev/null | grep -qi microsoft; then
  printf 'wsl=1\n'
else
  printf 'wsl=0\n'
fi
printf 'uptimeSec=%s\n' "`cut -d. -f1 /proc/uptime 2>/dev/null`"

echo "@@@LOAD"
printf 'raw=%s\n' "`cat /proc/loadavg 2>/dev/null`"

echo "@@@CPU"
# 两次采样 /proc/stat，间隔 1 秒：单次快照只能给出开机以来的平均值，
# 对「现在忙不忙」没有意义。
#
# 这里只把两次的**原始计数器**发出去，百分比由 lib/probe.js 算。两个原因：
#   1. 旧版在远程 awk 里算 `db=(u2-i2)-(u1-i1)`，也就是「user 增量 - idle 增量」。
#      这个差值在真机上几乎总是负数（idle 通常远大于 user），被夹到 0 ——
#      于是面板上的 CPU **永远是 0%**。而 0% 看起来完全正常，所以这个 bug
#      活了很久；只有机器真的被 user 时间打满时才偶尔吐出一个偏低的假值。
#   2. 公式搬到 JS 之后可以用固定样本做回归测试；远程 shell 里的算术没法单测。
#
# 字段顺序（POSIX 没规定，但所有 Linux 都是这个顺序）：
#   cpu user nice system idle iowait irq softirq steal guest guest_nice
# 只累加 user..steal 这 8 个：guest/guest_nice 已经包含在 user/nice 里，
# 再加一遍会让分母偏大、百分比偏小。
if [ -r /proc/stat ]; then
  set -- `head -n1 /proc/stat 2>/dev/null`
  total1=$(( ${2:-0} + ${3:-0} + ${4:-0} + ${5:-0} + ${6:-0} + ${7:-0} + ${8:-0} + ${9:-0} ))
  idle1=${5:-0}
  iowait1=${6:-0}
  sleep 1
  set -- `head -n1 /proc/stat 2>/dev/null`
  total2=$(( ${2:-0} + ${3:-0} + ${4:-0} + ${5:-0} + ${6:-0} + ${7:-0} + ${8:-0} + ${9:-0} ))
  idle2=${5:-0}
  iowait2=${6:-0}
  printf 'total1=%s\nidle1=%s\niowait1=%s\ntotal2=%s\nidle2=%s\niowait2=%s\n' \
    "$total1" "$idle1" "$iowait1" "$total2" "$idle2" "$iowait2"
fi

echo "@@@CPUINFO"
printf 'model=%s\n' "`sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n1`"
printf 'count=%s\n' "`getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null`"

echo "@@@MEM"
# 直接从 /proc/meminfo 读 kB 值：`free` 的输出列名和单位在不同发行版上不一致。
awk '
  /^MemTotal:/      {t=$2}
  /^MemAvailable:/  {a=$2}
  /^MemFree:/       {f=$2}
  /^Buffers:/       {b=$2}
  /^Cached:/        {c=$2}
  /^SwapTotal:/     {st=$2}
  /^SwapFree:/      {sf=$2}
  END {
    if (t>0) {
      avail = (a>0) ? a : (f+b+c)
      used = t-avail; if (used<0) used=0
      printf "totalBytes=%d\n", t*1024
      printf "availableBytes=%d\n", avail*1024
      printf "usedBytes=%d\n", used*1024
      printf "usagePercent=%.1f\n", used/t*100
    }
    if (st>0) { printf "swapTotalBytes=%d\n", st*1024; printf "swapUsedBytes=%d\n", (st-sf)*1024 }
  }
' /proc/meminfo 2>/dev/null

echo "@@@DISK"
# 只留真实文件系统：tmpfs/overlay/squashfs 这类伪文件系统（/proc、/sys、snap 挂载）
# 会撑爆列表且毫无运维价值。`/` 与 `/mnt/*`（含 /mnt/c）保留。
df -kP 2>/dev/null | awk '
  NR>1 && $6 ~ /^\// {
    fs=$1
    if (fs ~ /^(tmpfs|devtmpfs|overlay|squashfs|none|udev|ramfs|proc|sysfs|cgroup|devpts|mqueue|shm|nsfs|tracefs|debugfs|securityfs|pstore|bpf|configfs|fusectl|hugetlbfs|autofs|binfmt_misc)$/) next
    total=$2*1024; used=$3*1024; avail=$4*1024
    printf "%s|%s|%d|%d|%d\n", $6, fs, total, used, avail
  }
'

echo "@@@GPU"
# 有 nvidia-smi 就查；GPU 名里可能含逗号，所以用 `-` 分隔并限制 split 次数。
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu \
    --format=csv,noheader,nounits 2>/dev/null | head -n8 | awk -F',' '{
      gsub(/^[ \t]+|[ \t]+$/, "", $1); gsub(/^[ \t]+|[ \t]+$/, "", $2)
      printf "%s|%s|%s|%s|%s|%s\n", $1, $2, $3, $4*1048576, $5*1048576, $6
    }'
fi

echo "@@@DOCKER"
if command -v docker >/dev/null 2>&1; then
  printf 'available=1\n'
  printf 'version=%s\n' "`docker version --format '{{.Server.Version}}' 2>/dev/null`"
  # `docker ps -a` 需要权限；失败时留空，由解析端区分「没装 docker」与「没权限」。
  docker info --format '{{.Containers}}|{{.ContainersRunning}}|{{.ContainersPaused}}|{{.ContainersStopped}}|{{.Images}}' 2>/dev/null \
    | awk -F'|' 'NF>=5 { printf "counts=%s\n", $0 }'
else
  printf 'available=0\n'
fi

echo "@@@PROC"
printf 'total=%s\n' "`ls -1 /proc 2>/dev/null | grep -c '^[0-9]'`"
ps -eo pid=,user=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -n5 | awk '{
  cmd=""; for(i=5;i<=NF;i++) cmd = cmd (i>5?" ":"") $i
  printf "topCpu|%s|%s|%s|%s|%s\n", $1, $2, $3, $4, cmd
}'
ps -eo pid=,user=,pcpu=,pmem=,comm= --sort=-pmem 2>/dev/null | head -n5 | awk '{
  cmd=""; for(i=5;i<=NF;i++) cmd = cmd (i>5?" ":"") $i
  printf "topMem|%s|%s|%s|%s|%s\n", $1, $2, $3, $4, cmd
}'

echo "@@@SVC"
# Ubuntu 的 systemd 在容器/WSL 里可能不可用，所以先探测再决定是否查。
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl list-units --type=service --state=running --no-legend --no-pager --plain 2>/dev/null \
    | head -n12 | awk '{ printf "svc|%s|%s|%s\n", $1, $3, $4 }'
fi

exit 0
