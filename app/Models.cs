using System.Text.Json.Serialization;

namespace DshWsxPanel;

// 说明：这些类型逐字段对应 docs/state.schema.json（由 dsh-remote-panel 宿主插件
// 以「临时文件 + rename」原子写出）。字段名与嵌套层级必须和 schema **完全一致**，
// 所以每个属性都显式写了 [JsonPropertyName]，不依赖命名策略。
//
// 可缺省的字段一律用可空类型（long? / double? / string?）：
// 插件侧省略字段时窗口回落到「不显示这一行」，而不是显示 0 —— 后者会把
// 「没有采集到」和「真的是 0」混成一件事。
//
// 反序列化之前，StateValidator 会先对 JSON DOM 做一遍带路径的校验，
// 保证损坏的文档报出**具体字段**而不是静默渲染成空白（见 StateReader.cs）。

public sealed class PanelSnapshot
{
    [JsonPropertyName("schema")] public int Schema { get; set; }
    [JsonPropertyName("generatedAt")] public long GeneratedAt { get; set; }
    [JsonPropertyName("host")] public HostInfo? Host { get; set; }
    [JsonPropertyName("totals")] public TotalsInfo? Totals { get; set; }
    [JsonPropertyName("targets")] public List<TargetState> Targets { get; set; } = new();
    [JsonPropertyName("errors")] public List<TargetErrorEntry> Errors { get; set; } = new();
}

public sealed class HostInfo
{
    [JsonPropertyName("pid")] public int Pid { get; set; }
    [JsonPropertyName("pluginVersion")] public string? PluginVersion { get; set; }
    [JsonPropertyName("stateFile")] public string? StateFile { get; set; }
    [JsonPropertyName("dshHome")] public string? DshHome { get; set; }
    [JsonPropertyName("platform")] public string? Platform { get; set; }
    [JsonPropertyName("startedAt")] public long? StartedAt { get; set; }
    [JsonPropertyName("revision")] public long? Revision { get; set; }
    /// <summary>插件 dispose() 写的最后一帧里为 true —— 这种情况下要显示「宿主已退出」，而不是「心跳丢失」。</summary>
    [JsonPropertyName("stopped")] public bool Stopped { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
}

public sealed class TotalsInfo
{
    [JsonPropertyName("targets")] public int? Targets { get; set; }
    [JsonPropertyName("online")] public int? Online { get; set; }
    [JsonPropertyName("offline")] public int? Offline { get; set; }
    [JsonPropertyName("probing")] public int? Probing { get; set; }
    [JsonPropertyName("unknown")] public int? Unknown { get; set; }
    [JsonPropertyName("dockerRunning")] public int? DockerRunning { get; set; }
}

public sealed class TargetState
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    /// <summary>"wsl" | "ssh"，见 TargetKind。</summary>
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("host")] public string? Host { get; set; }
    [JsonPropertyName("user")] public string? User { get; set; }
    [JsonPropertyName("port")] public int? Port { get; set; }
    [JsonPropertyName("tags")] public List<string>? Tags { get; set; }
    [JsonPropertyName("enabled")] public bool? Enabled { get; set; }
    /// <summary>"online" | "offline" | "probing" | "unknown"，见 TargetStatus。</summary>
    [JsonPropertyName("status")] public string Status { get; set; } = "";
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("latencyMs")] public long? LatencyMs { get; set; }
    [JsonPropertyName("lastProbeAt")] public long? LastProbeAt { get; set; }
    [JsonPropertyName("lastOnlineAt")] public long? LastOnlineAt { get; set; }
    [JsonPropertyName("nextProbeAt")] public long? NextProbeAt { get; set; }
    [JsonPropertyName("consecutiveFailures")] public int? ConsecutiveFailures { get; set; }
    /// <summary>WSL 专用：这次探测把发行版冷启动了（18–88s），面板上要提示。</summary>
    [JsonPropertyName("woke")] public bool? Woke { get; set; }
    [JsonPropertyName("facts")] public TargetFacts? Facts { get; set; }
    [JsonPropertyName("metrics")] public TargetMetrics? Metrics { get; set; }
    [JsonPropertyName("history")] public List<HistorySample>? History { get; set; }
}

public sealed class TargetFacts
{
    [JsonPropertyName("hostname")] public string? Hostname { get; set; }
    [JsonPropertyName("os")] public string? Os { get; set; }
    [JsonPropertyName("kernel")] public string? Kernel { get; set; }
    [JsonPropertyName("arch")] public string? Arch { get; set; }
    [JsonPropertyName("cpuModel")] public string? CpuModel { get; set; }
    [JsonPropertyName("cpuCount")] public int? CpuCount { get; set; }
    [JsonPropertyName("distro")] public string? Distro { get; set; }
    [JsonPropertyName("wsl")] public bool? Wsl { get; set; }
    [JsonPropertyName("uptimeSec")] public long? UptimeSec { get; set; }
}

public sealed class TargetMetrics
{
    [JsonPropertyName("cpu")] public CpuMetrics? Cpu { get; set; }
    [JsonPropertyName("memory")] public MemoryMetrics? Memory { get; set; }
    [JsonPropertyName("disks")] public List<DiskMetrics>? Disks { get; set; }
    [JsonPropertyName("gpus")] public List<GpuMetrics>? Gpus { get; set; }
    [JsonPropertyName("docker")] public DockerMetrics? Docker { get; set; }
    [JsonPropertyName("processes")] public ProcessMetrics? Processes { get; set; }
    [JsonPropertyName("services")] public List<ServiceState>? Services { get; set; }
}

public sealed class CpuMetrics
{
    [JsonPropertyName("usagePercent")] public double? UsagePercent { get; set; }
    [JsonPropertyName("load1")] public double? Load1 { get; set; }
    [JsonPropertyName("load5")] public double? Load5 { get; set; }
    [JsonPropertyName("load15")] public double? Load15 { get; set; }
}

public sealed class MemoryMetrics
{
    [JsonPropertyName("totalBytes")] public long? TotalBytes { get; set; }
    [JsonPropertyName("usedBytes")] public long? UsedBytes { get; set; }
    [JsonPropertyName("availableBytes")] public long? AvailableBytes { get; set; }
    [JsonPropertyName("swapTotalBytes")] public long? SwapTotalBytes { get; set; }
    [JsonPropertyName("swapUsedBytes")] public long? SwapUsedBytes { get; set; }
    [JsonPropertyName("usagePercent")] public double? UsagePercent { get; set; }
}

public sealed class DiskMetrics
{
    [JsonPropertyName("mount")] public string Mount { get; set; } = "";
    [JsonPropertyName("fs")] public string? Fs { get; set; }
    [JsonPropertyName("totalBytes")] public long? TotalBytes { get; set; }
    [JsonPropertyName("usedBytes")] public long? UsedBytes { get; set; }
    [JsonPropertyName("availableBytes")] public long? AvailableBytes { get; set; }
    [JsonPropertyName("usagePercent")] public double? UsagePercent { get; set; }
}

public sealed class GpuMetrics
{
    [JsonPropertyName("index")] public int? Index { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("utilizationPercent")] public double? UtilizationPercent { get; set; }
    [JsonPropertyName("memoryTotalBytes")] public long? MemoryTotalBytes { get; set; }
    [JsonPropertyName("memoryUsedBytes")] public long? MemoryUsedBytes { get; set; }
    [JsonPropertyName("temperatureC")] public double? TemperatureC { get; set; }
}

public sealed class DockerMetrics
{
    [JsonPropertyName("available")] public bool? Available { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("containers")] public int? Containers { get; set; }
    [JsonPropertyName("running")] public int? Running { get; set; }
    [JsonPropertyName("paused")] public int? Paused { get; set; }
    [JsonPropertyName("stopped")] public int? Stopped { get; set; }
    [JsonPropertyName("images")] public int? Images { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
}

public sealed class ProcessMetrics
{
    [JsonPropertyName("total")] public int? Total { get; set; }
    [JsonPropertyName("topCpu")] public List<ProcessEntry>? TopCpu { get; set; }
    [JsonPropertyName("topMem")] public List<ProcessEntry>? TopMem { get; set; }
}

public sealed class ProcessEntry
{
    [JsonPropertyName("pid")] public int? Pid { get; set; }
    [JsonPropertyName("user")] public string? User { get; set; }
    [JsonPropertyName("cpuPercent")] public double? CpuPercent { get; set; }
    [JsonPropertyName("memPercent")] public double? MemPercent { get; set; }
    [JsonPropertyName("command")] public string? Command { get; set; }
}

public sealed class ServiceState
{
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("active")] public string? Active { get; set; }
    [JsonPropertyName("sub")] public string? Sub { get; set; }
}

public sealed class HistorySample
{
    [JsonPropertyName("at")] public long? At { get; set; }
    [JsonPropertyName("cpuPercent")] public double? CpuPercent { get; set; }
    [JsonPropertyName("memPercent")] public double? MemPercent { get; set; }
    [JsonPropertyName("latencyMs")] public long? LatencyMs { get; set; }
}

public sealed class TargetErrorEntry
{
    [JsonPropertyName("targetId")] public string? TargetId { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("at")] public long? At { get; set; }
    [JsonPropertyName("consecutiveFailures")] public int? ConsecutiveFailures { get; set; }
}

/// <summary>schema 里 kind / status 两个枚举的取值。集中在这里，UI 与校验器共用一套。</summary>
public static class TargetKind
{
    public const string Wsl = "wsl";
    public const string Ssh = "ssh";
}

public static class TargetStatus
{
    public const string Online = "online";
    public const string Offline = "offline";
    public const string Probing = "probing";
    public const string Unknown = "unknown";
}
