using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Microsoft.UI.Xaml;

namespace DshWsxPanel;

public abstract class ObservableObject : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Raise(name);
        return true;
    }

    protected void Raise([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>
/// 明细行。它们只在卡片重建时整体替换，所以是简单不可变对象。
///
/// 每个都带一份 <see cref="PanelMetrics"/>：这些行渲染在嵌套 DataTemplate 里，
/// DataContext 是自己而不是卡片，所以 <c>{Binding Metrics.…}</c> 必须在**自己**身上
/// 找得到 Metrics —— 这是参考 HUD 已经踩过的同一个点（ColumnDefinition 拿不到
/// DataContext，模板内的元素也只能看到自己的 DataContext）。
/// </summary>

/// <summary>一个挂载点的用量条。</summary>
public sealed class DiskBarVm
{
    public required PanelMetrics Metrics { get; init; }
    public required string Mount { get; init; }
    public required string Text { get; init; }
    public required double Percent { get; init; }
    /// <summary>用量 ≥ 90% 时亮一个警告图标（颜色走主题资源，所以只能靠开关 Visibility）。</summary>
    public required Visibility DangerVisibility { get; init; }
}

/// <summary>一块 GPU 的一行。</summary>
public sealed class GpuLineVm
{
    public required PanelMetrics Metrics { get; init; }
    public required string Title { get; init; }
    public required string Text { get; init; }
}

/// <summary>一个进程的一行（top-N）。</summary>
public sealed class ProcRowVm
{
    public required PanelMetrics Metrics { get; init; }
    public required string Pid { get; init; }
    public required string Cpu { get; init; }
    public required string User { get; init; }
    public required string Command { get; init; }
}

// ======================================================================
// 一张目标卡片
// ======================================================================

/// <summary>
/// 单个目标（一台主机 / 一个 WSL 发行版）的展示模型。
///
/// 这里是「按档位取舍内容」真正发生的地方：PanelMetrics 只给出**允许**显示
/// 多少行，具体取前几个、要不要显示这一块，由这里决定。
/// 卡片按 id 复用，每秒刷新时不重建对象，避免列表抖动。
/// </summary>
public sealed class TargetCardVm : ObservableObject
{
    private TargetState? _source;

    /// <summary>
    /// 渲染这张卡片要用的尺寸表。
    ///
    /// **必须挂在卡片自己身上**：卡片的 DataTemplate 里 DataContext 是 TargetCardVm，
    /// 而模板里到处是 <c>{Binding Metrics.…}</c>（宽度、内边距、字号、各列列宽）。
    /// 漏掉这个属性时绑定会**静默失败**，症状非常有迷惑性：
    ///   * <c>Width="{Binding Metrics.CardWidth}"</c> 落空 → 宽度退回「内容自然宽度」，
    ///     卡片只占窗口约 68%，右侧一大片空白（用户报的「错位」）；
    ///   * <c>ProcPidWidth/ProcCpuWidth/ProcUserWidth</c> 落空 → 进程表各列按内容宽度排，
    ///     看起来就是 user 列参差不齐；
    ///   * 所有 <c>FontSize="{Binding Metrics.…}"</c> 落空 → 字号退回默认值，
    ///     分档缩放等于没生效。
    /// 这个实例是**与面板共享的同一个对象**（尺寸表是原地改的），
    /// 所以只要挂上去一次，之后档位变化会自动通过 PropertyChanged 通知到绑定。
    /// </summary>
    public PanelMetrics Metrics { get; private set; }

    public TargetCardVm(PanelMetrics metrics) => Metrics = metrics;

    public string Id { get; private set; } = "";

    // ---- 身份 ----
    public string Name { get => _name; private set => Set(ref _name, value); }
    private string _name = "";

    public string KindBadge { get => _kindBadge; private set => Set(ref _kindBadge, value); }
    private string _kindBadge = "";

    public string HostText { get => _hostText; private set => Set(ref _hostText, value); }
    private string _hostText = "";

    public string StatusLabel { get => _statusLabel; private set => Set(ref _statusLabel, value); }
    private string _statusLabel = "";

    // 状态点的颜色必须来自主题资源（浅色/深色下都要可读），而 {ThemeResource}
    // 没法绑定。所以画四个同位置的圆点，各用一条固定的主题资源，用 Visibility 选一个 ——
    // 这样配色 100% 由 WinUI 主题决定，代码里一个色值都不写。
    public Visibility OnlineDotVisibility { get => _onlineDot; private set => Set(ref _onlineDot, value); }
    private Visibility _onlineDot = Visibility.Collapsed;
    public Visibility OfflineDotVisibility { get => _offlineDot; private set => Set(ref _offlineDot, value); }
    private Visibility _offlineDot = Visibility.Collapsed;
    public Visibility ProbingDotVisibility { get => _probingDot; private set => Set(ref _probingDot, value); }
    private Visibility _probingDot = Visibility.Collapsed;
    public Visibility UnknownDotVisibility { get => _unknownDot; private set => Set(ref _unknownDot, value); }
    private Visibility _unknownDot = Visibility.Collapsed;

    public string LatencyText { get => _latencyText; private set => Set(ref _latencyText, value); }
    private string _latencyText = "—";

    /// <summary>距上次探测过了多久。这是「数据有多旧」的唯一线索，所以每秒都刷。</summary>
    public string ProbeAgeText { get => _probeAgeText; private set => Set(ref _probeAgeText, value); }
    private string _probeAgeText = "从未探测";

    /// <summary>WSL 冷启动（把发行版从停机状态拉起来，18–88s）时给一个解释性角标。</summary>
    public Visibility WokeVisibility { get => _woke; private set => Set(ref _woke, value); }
    private Visibility _woke = Visibility.Collapsed;

    // 两种目标类型给不同的角标底色，用主题资源区分，代码里不出现色值。
    public Visibility WslBadgeVisibility { get => _wslBadge; private set => Set(ref _wslBadge, value); }
    private Visibility _wslBadge = Visibility.Visible;
    public Visibility SshBadgeVisibility { get => _sshBadge; private set => Set(ref _sshBadge, value); }
    private Visibility _sshBadge = Visibility.Collapsed;

    public string ErrorText { get => _errorText; private set => Set(ref _errorText, value); }
    private string _errorText = "";
    public Visibility ErrorVisibility { get => _errorVisibility; private set => Set(ref _errorVisibility, value); }
    private Visibility _errorVisibility = Visibility.Collapsed;

    // ---- 指标 ----
    public Visibility MetricsVisibility { get => _metricsVisibility; private set => Set(ref _metricsVisibility, value); }
    private Visibility _metricsVisibility = Visibility.Collapsed;

    public Visibility CpuVisibility { get => _cpuVisibility; private set => Set(ref _cpuVisibility, value); }
    private Visibility _cpuVisibility = Visibility.Collapsed;
    public string CpuText { get => _cpuText; private set => Set(ref _cpuText, value); }
    private string _cpuText = "—";
    public string LoadText { get => _loadText; private set => Set(ref _loadText, value); }
    private string _loadText = "";

    public Visibility MemVisibility { get => _memVisibility; private set => Set(ref _memVisibility, value); }
    private Visibility _memVisibility = Visibility.Collapsed;
    public string MemText { get => _memText; private set => Set(ref _memText, value); }
    private string _memText = "—";
    public string MemPercentText { get => _memPercentText; private set => Set(ref _memPercentText, value); }
    private string _memPercentText = "";
    public double MemPercent { get => _memPercent; private set => Set(ref _memPercent, value); }
    private double _memPercent;

    public Visibility SwapVisibility { get => _swapVisibility; private set => Set(ref _swapVisibility, value); }
    private Visibility _swapVisibility = Visibility.Collapsed;
    public string SwapText { get => _swapText; private set => Set(ref _swapText, value); }
    private string _swapText = "";

    public Visibility DisksVisibility { get => _disksVisibility; private set => Set(ref _disksVisibility, value); }
    private Visibility _disksVisibility = Visibility.Collapsed;
    public IReadOnlyList<DiskBarVm> Disks { get => _disks; private set => Set(ref _disks, value); }
    private IReadOnlyList<DiskBarVm> _disks = Array.Empty<DiskBarVm>();

    public Visibility GpusVisibility { get => _gpusVisibility; private set => Set(ref _gpusVisibility, value); }
    private Visibility _gpusVisibility = Visibility.Collapsed;
    public IReadOnlyList<GpuLineVm> Gpus { get => _gpus; private set => Set(ref _gpus, value); }
    private IReadOnlyList<GpuLineVm> _gpus = Array.Empty<GpuLineVm>();

    public Visibility DockerVisibility { get => _dockerVisibility; private set => Set(ref _dockerVisibility, value); }
    private Visibility _dockerVisibility = Visibility.Collapsed;
    public string DockerText { get => _dockerText; private set => Set(ref _dockerText, value); }
    private string _dockerText = "";

    public Visibility ProcessesVisibility { get => _processesVisibility; private set => Set(ref _processesVisibility, value); }
    private Visibility _processesVisibility = Visibility.Collapsed;
    public string ProcHeaderText { get => _procHeaderText; private set => Set(ref _procHeaderText, value); }
    private string _procHeaderText = "";
    public IReadOnlyList<ProcRowVm> Processes { get => _processes; private set => Set(ref _processes, value); }
    private IReadOnlyList<ProcRowVm> _processes = Array.Empty<ProcRowVm>();

    public Visibility ServicesVisibility { get => _servicesVisibility; private set => Set(ref _servicesVisibility, value); }
    private Visibility _servicesVisibility = Visibility.Collapsed;
    public string ServicesText { get => _servicesText; private set => Set(ref _servicesText, value); }
    private string _servicesText = "";

    public string FactsText { get => _factsText; private set => Set(ref _factsText, value); }
    private string _factsText = "";
    public Visibility FactsVisibility { get => _factsVisibility; private set => Set(ref _factsVisibility, value); }
    private Visibility _factsVisibility = Visibility.Collapsed;

    public string NoMetricsText { get => _noMetricsText; private set => Set(ref _noMetricsText, value); }
    private string _noMetricsText = "";
    public Visibility NoMetricsVisibility { get => _noMetricsVisibility; private set => Set(ref _noMetricsVisibility, value); }
    private Visibility _noMetricsVisibility = Visibility.Collapsed;

    // ------------------------------------------------------------------

    public void Update(TargetState target, PanelMetrics metrics, long now, bool compact)
    {
        _source = target;
        // 兜一层：万一有人用别的方式构造了卡片，也要在这里把共享的尺寸表接上，
        // 并主动通知绑定重新取值（否则它会一直用那个占位的默认实例）。
        if (!ReferenceEquals(Metrics, metrics))
        {
            Metrics = metrics;
            Raise(nameof(Metrics));
        }
        Id = target.Id;

        Name = string.IsNullOrWhiteSpace(target.Name) ? target.Id : target.Name;
        KindBadge = target.Kind == TargetKind.Wsl ? "WSL" : target.Kind == TargetKind.Ssh ? "SSH" : target.Kind.ToUpperInvariant();
        HostText = BuildHostText(target);
        StatusLabel = target.Status switch
        {
            TargetStatus.Online => "在线",
            TargetStatus.Offline => "离线",
            TargetStatus.Probing => "探测中",
            _ => "未探测",
        };

        OnlineDotVisibility = Show(target.Status == TargetStatus.Online);
        OfflineDotVisibility = Show(target.Status == TargetStatus.Offline);
        ProbingDotVisibility = Show(target.Status == TargetStatus.Probing);
        UnknownDotVisibility = Show(target.Status is not (TargetStatus.Online or TargetStatus.Offline or TargetStatus.Probing));

        // 只有在线才有「延迟」这个概念；离线时显示延迟是误导。
        LatencyText = target.Status == TargetStatus.Online ? Format.Latency(target.LatencyMs) : "—";
        ProbeAgeText = target.LastProbeAt is long at && at > 0
            ? Format.Age(now - at) + " 前"
            : "从未探测";

        WokeVisibility = Show(target.Woke == true);
        WslBadgeVisibility = Show(target.Kind == TargetKind.Wsl);
        SshBadgeVisibility = Show(target.Kind == TargetKind.Ssh);

        ErrorText = target.Error ?? "";
        // 离线一定有话说；在线但带了 error 字段（比如采集阶段局部失败）也显示。
        ErrorVisibility = Show(!string.IsNullOrWhiteSpace(target.Error)
            && target.Status != TargetStatus.Probing);

        BuildMetrics(target, metrics, compact);
    }

    /// <summary>档位或精简开关变了：用缓存的源数据重算一遍，不必等下一份快照。</summary>
    public void Reapply(PanelMetrics metrics, long now, bool compact)
    {
        if (_source is null) return;
        Update(_source, metrics, now, compact);
    }

    /// <summary>只刷「活」文本（探测时间），不重建集合 —— 由 250ms 的秒表调用。</summary>
    public void RefreshLive(long now)
    {
        if (_source?.LastProbeAt is long at && at > 0)
        {
            ProbeAgeText = Format.Age(now - at) + " 前";
        }
    }

    private static string BuildHostText(TargetState t)
    {
        string host = t.Host ?? "";
        if (t.Kind == TargetKind.Ssh)
        {
            if (!string.IsNullOrWhiteSpace(t.User)) host = t.User + "@" + host;
            // 22 是默认端口，写出来只是噪声。
            if (t.Port is int port && port > 0 && port != 22) host += ":" + port;
        }
        if (string.IsNullOrWhiteSpace(host))
        {
            host = t.Facts?.Distro ?? t.Facts?.Hostname ?? "";
        }
        return host;
    }

    private void BuildMetrics(TargetState t, PanelMetrics m, bool compact)
    {
        var metrics = t.Metrics;

        // 精简模式在档位之上再压一层：它是用户主动按的，应该立刻看出差别。
        int procRows = compact ? Math.Min(3, m.ProcessRows) : m.ProcessRows;
        int diskRows = compact ? Math.Min(3, m.DiskRows) : m.DiskRows;
        bool wantFacts = m.ShowFacts && !compact;
        bool wantServices = m.ShowServices && !compact;

        // ---- facts 行 ----
        var f = t.Facts;
        FactsText = f is null ? "" : Format.Join(
            f.Os,
            string.IsNullOrWhiteSpace(f.Kernel) ? null : "内核 " + f.Kernel,
            f.CpuModel is { Length: > 0 } model
                ? model + (f.CpuCount is int cores ? $" ×{cores}" : "")
                : null,
            string.IsNullOrWhiteSpace(f.Arch) ? null : f.Arch,
            f.UptimeSec is long up ? "运行 " + Format.Uptime(up) : null);
        FactsVisibility = Show(wantFacts && FactsText.Length > 0);

        if (metrics is null)
        {
            MetricsVisibility = Visibility.Collapsed;
            // 在线但拿不到指标，和「离线」是两件事，要说清楚，不能什么都不画。
            NoMetricsText = t.Status == TargetStatus.Online ? "这次探测没有采到指标" : "";
            NoMetricsVisibility = Show(t.Status == TargetStatus.Online);
            return;
        }

        // ---- CPU ----
        var cpu = metrics.Cpu;
        CpuText = Format.Percent(cpu?.UsagePercent);
        LoadText = cpu is null ? "" : "load " + Format.Load(cpu.Load1, cpu.Load5, cpu.Load15);
        CpuVisibility = Show(cpu is not null);

        // ---- 内存 ----
        var mem = metrics.Memory;
        // 用量百分比：优先用插件给的，没有再自己算（避免两边口径不一致时显示空白）。
        double? memPercent = mem?.UsagePercent;
        if (memPercent is null && mem?.UsedBytes is long used && mem.TotalBytes is long total && total > 0)
        {
            memPercent = used * 100.0 / total;
        }
        MemText = mem is null ? "" : Format.BytesPair(mem.UsedBytes, mem.TotalBytes);
        MemPercentText = Format.Percent(memPercent);
        // ProgressBar.Value 绑这个；夹到 0..100，坏数据也不至于把条画到框外。
        MemPercent = Math.Clamp(memPercent ?? 0, 0, 100);
        MemVisibility = Show(mem is not null && (mem.UsedBytes is not null || mem.TotalBytes is not null));

        SwapText = mem?.SwapTotalBytes is long swapTotal && swapTotal > 0
            ? "swap " + Format.BytesPair(mem!.SwapUsedBytes, swapTotal)
            : "";
        SwapVisibility = Show(SwapText.Length > 0);

        // ---- 磁盘 ----
        var disks = new List<DiskBarVm>();
        if (m.ShowDisks && metrics.Disks is { Count: > 0 })
        {
            foreach (var disk in metrics.Disks.Take(diskRows))
            {
                double? pct = disk.UsagePercent;
                if (pct is null && disk.TotalBytes is long dt && dt > 0 && disk.UsedBytes is long du)
                {
                    pct = du * 100.0 / dt;
                }
                double clamped = Math.Clamp(pct ?? 0, 0, 100);
                disks.Add(new DiskBarVm
                {
                    Metrics = m,
                    Mount = disk.Mount,
                    Text = $"{Format.BytesPair(disk.UsedBytes, disk.TotalBytes)} · {Format.Percent(pct)}",
                    Percent = clamped,
                    DangerVisibility = Show(pct >= 90),
                });
            }
        }
        Disks = disks;
        DisksVisibility = Show(disks.Count > 0);

        // ---- GPU ----
        var gpus = new List<GpuLineVm>();
        if (m.ShowGpus && metrics.Gpus is { Count: > 0 })
        {
            foreach (var gpu in metrics.Gpus.Take(m.GpuRows))
            {
                string title = "GPU" + (gpu.Index is int idx ? " " + idx : "");
                if (!string.IsNullOrWhiteSpace(gpu.Name)) title += " · " + gpu.Name;
                gpus.Add(new GpuLineVm
                {
                    Metrics = m,
                    Title = title,
                    Text = Format.Join(
                        gpu.UtilizationPercent is null ? null : "util " + Format.Percent(gpu.UtilizationPercent),
                        gpu.MemoryUsedBytes is not null || gpu.MemoryTotalBytes is not null
                            ? Format.BytesPair(gpu.MemoryUsedBytes, gpu.MemoryTotalBytes)
                            : null,
                        gpu.TemperatureC is double temp ? temp.ToString("0") + "°C" : null),
                });
            }
        }
        Gpus = gpus;
        GpusVisibility = Show(gpus.Count > 0);

        // ---- docker ----
        // docker 为 null 表示「这台机器没有 docker CLI」，和「docker 空闲」不是一回事，
        // 所以这两种情况给不同的文案，也正因为如此才有 available 这个字段。
        var docker = metrics.Docker;
        if (m.ShowDocker && docker is not null)
        {
            DockerText = docker.Available == false
                ? Format.Join("docker 不可用", docker.Error)
                : Format.Join(
                    $"docker {docker.Running ?? 0} 运行 / {docker.Containers ?? 0} 容器",
                    docker.Paused is > 0 ? $"{docker.Paused} 暂停" : null,
                    docker.Stopped is > 0 ? $"{docker.Stopped} 停止" : null,
                    docker.Images is not null ? $"{docker.Images} 镜像" : null,
                    string.IsNullOrWhiteSpace(docker.Version) ? null : "v" + docker.Version);
            DockerVisibility = Show(DockerText.Length > 0);
        }
        else
        {
            DockerText = "";
            DockerVisibility = Visibility.Collapsed;
        }

        // ---- 进程 top-N ----
        var procs = new List<ProcRowVm>();
        var list = metrics.Processes?.TopCpu is { Count: > 0 } topCpu
            ? topCpu
            : metrics.Processes?.TopMem;
        if (m.ShowProcesses && list is { Count: > 0 })
        {
            foreach (var p in list.Take(procRows))
            {
                procs.Add(new ProcRowVm
                {
                    Metrics = m,
                    Pid = p.Pid?.ToString() ?? "—",
                    Cpu = Format.Percent(p.CpuPercent),
                    User = p.User ?? "",
                    Command = p.Command ?? "",
                });
            }
        }
        Processes = procs;
        ProcessesVisibility = Show(procs.Count > 0);
        ProcHeaderText = procs.Count > 0
            ? $"进程 · top {procs.Count}" + (metrics.Processes?.Total is int totalN ? $" / 共 {totalN}" : "")
            : "";

        // ---- systemd 服务 ----
        var services = new List<string>();
        if (wantServices && metrics.Services is { Count: > 0 })
        {
            foreach (var svc in metrics.Services.Take(m.ServiceRows))
            {
                if (string.IsNullOrWhiteSpace(svc.Name)) continue;
                services.Add(string.IsNullOrWhiteSpace(svc.Active) ? svc.Name! : $"{svc.Name} {svc.Active}");
            }
        }
        ServicesText = services.Count > 0 ? "服务 " + string.Join(" · ", services) : "";
        ServicesVisibility = Show(ServicesText.Length > 0);

        // ---- 整块指标区的开关 ----
        bool hasAny = CpuVisibility == Visibility.Visible
            || MemVisibility == Visibility.Visible
            || DisksVisibility == Visibility.Visible
            || GpusVisibility == Visibility.Visible
            || DockerVisibility == Visibility.Visible
            || ProcessesVisibility == Visibility.Visible
            || ServicesVisibility == Visibility.Visible;

        MetricsVisibility = Show(m.ShowMetrics && hasAny);
        NoMetricsText = m.ShowMetrics && !hasAny ? "这次探测没有采到指标" : "";
        NoMetricsVisibility = Show(m.ShowMetrics && !hasAny);
    }

    private static Visibility Show(bool visible) => visible ? Visibility.Visible : Visibility.Collapsed;
}

// ======================================================================
// 面板整体
// ======================================================================

/// <summary>
/// 整块面板的展示模型：头部摘要、错误条、状态栏、目标卡片集合。
///
/// 卡片按 id 复用并按「失败最前」重排。**不依赖快照自己的顺序** ——
/// 参考 HUD 记录过一个实测到的坑：手工构造的快照顺序一变，
/// 「只显示前 N 个」就会把最该看见的那条挤出去。这里自己再排一次，
/// 来源顺序怎么变都不会让离线的目标沉底。
/// </summary>
public sealed class PanelViewModel : ObservableObject
{
    private readonly Dictionary<string, TargetCardVm> _cards = new(StringComparer.Ordinal);
    private bool _compact;
    private StatusInfo _status;

    public PanelMetrics Metrics { get; } = new();

    public ObservableCollection<TargetCardVm> Targets { get; } = new();

    /// <summary>精简开关：在尺寸档位之上再压一层（详见 TargetCardVm.BuildMetrics）。</summary>
    public bool Compact
    {
        get => _compact;
        set
        {
            if (Set(ref _compact, value)) RefreshCards();
        }
    }

    // ---- 头部摘要 ----
    public string HeaderText { get => _headerText; private set => Set(ref _headerText, value); }
    private string _headerText = "0 个目标";

    public string FailingText { get => _failingText; private set => Set(ref _failingText, value); }
    private string _failingText = "";
    public Visibility FailingVisibility { get => _failingVisibility; private set => Set(ref _failingVisibility, value); }
    private Visibility _failingVisibility = Visibility.Collapsed;

    public string ProbingText { get => _probingText; private set => Set(ref _probingText, value); }
    private string _probingText = "";
    public Visibility ProbingVisibility { get => _probingVisibility; private set => Set(ref _probingVisibility, value); }
    private Visibility _probingVisibility = Visibility.Collapsed;

    public string DockerSummaryText { get => _dockerSummaryText; private set => Set(ref _dockerSummaryText, value); }
    private string _dockerSummaryText = "";
    public Visibility DockerSummaryVisibility { get => _dockerSummaryVisibility; private set => Set(ref _dockerSummaryVisibility, value); }
    private Visibility _dockerSummaryVisibility = Visibility.Collapsed;

    // ---- 错误条 ----
    public string ErrorStripText { get => _errorStripText; private set => Set(ref _errorStripText, value); }
    private string _errorStripText = "";
    public Visibility ErrorStripVisibility { get => _errorStripVisibility; private set => Set(ref _errorStripVisibility, value); }
    private Visibility _errorStripVisibility = Visibility.Collapsed;

    // ---- 状态栏与空状态 ----
    public string StatusBarText { get => _statusBarText; private set => Set(ref _statusBarText, value); }
    private string _statusBarText = "";
    public string EmptyText { get => _emptyText; private set => Set(ref _emptyText, value); }
    private string _emptyText = "";
    public Visibility EmptyVisibility { get => _emptyVisibility; private set => Set(ref _emptyVisibility, value); }
    private Visibility _emptyVisibility = Visibility.Visible;

    /// <summary>由窗口每次重算 StatusInfo 后调用（含每 250ms 的秒表，用来刷新「更新于 … 前」）。</summary>
    public void SetStatus(StatusInfo status)
    {
        _status = status;
        StatusBarText = StatusText.Line(status);
        RefreshEmpty();
    }

    /// <summary>档位变了：用缓存重算所有卡片，不必等下一份快照。</summary>
    public void RefreshMetrics() => RefreshCards();

    private void RefreshCards()
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var card in Targets) card.Reapply(Metrics, now, Compact);
    }

    /// <summary>秒表：只更新「多久以前探测的」这类活文本，不重建集合。</summary>
    public void RefreshLive(long now)
    {
        foreach (var card in Targets) card.RefreshLive(now);
    }

    public void Apply(PanelSnapshot snapshot, long now)
    {
        // 失败最前，然后在线，再探测中/未探测，组内按名字 —— 和 schema 里
        // 「sorted: errors first, then online, then by name」一致，但这里自己排，
        // 不信任来源顺序。
        var failingIds = new HashSet<string>(
            snapshot.Errors.Where(e => !string.IsNullOrEmpty(e.TargetId)).Select(e => e.TargetId!),
            StringComparer.Ordinal);

        var ordered = snapshot.Targets
            .OrderBy(t => Rank(t, failingIds))
            .ThenBy(t => t.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        // 复用卡片对象：只有顺序真的变了才重建集合，否则每秒 Clear+Add 会让列表抖。
        var incoming = new Dictionary<string, TargetCardVm>(StringComparer.Ordinal);
        foreach (var t in ordered)
        {
            if (!_cards.TryGetValue(t.Id, out var card))
            {
                // 把面板共享的尺寸表交给卡片：模板里全是 {Binding Metrics.…}。
                card = new TargetCardVm(Metrics);
                _cards[t.Id] = card;
            }
            incoming[t.Id] = card;
        }

        foreach (string gone in _cards.Keys.Where(k => !incoming.ContainsKey(k)).ToList())
        {
            _cards.Remove(gone);
        }

        bool sameOrder = Targets.Count == ordered.Count;
        if (sameOrder)
        {
            for (int i = 0; i < ordered.Count; i++)
            {
                if (!ReferenceEquals(Targets[i], incoming[ordered[i].Id]))
                {
                    sameOrder = false;
                    break;
                }
            }
        }
        if (!sameOrder)
        {
            Targets.Clear();
            foreach (var t in ordered) Targets.Add(incoming[t.Id]);
        }

        foreach (var t in ordered)
        {
            incoming[t.Id].Update(t, Metrics, now, Compact);
        }

        // ---- 头部摘要 ----
        // 计数与文案都在 Summary 里（不依赖 WinUI），所以 --dump-status 能原样打印，
        // 脚本可以对「探测中的目标算不算在线」这类判断直接断言。
        var counts = Summary.Count(snapshot);

        HeaderText = Summary.HeaderText(counts);
        FailingText = Summary.FailingText(counts);
        FailingVisibility = counts.Offline > 0 ? Visibility.Visible : Visibility.Collapsed;
        ProbingText = Summary.ProbingText(counts);
        ProbingVisibility = counts.Probing > 0 || counts.Unknown > 0 ? Visibility.Visible : Visibility.Collapsed;
        DockerSummaryText = Summary.DockerSummaryText(counts);
        DockerSummaryVisibility = counts.DockerRunning > 0 ? Visibility.Visible : Visibility.Collapsed;

        // ---- 错误条 ----
        BuildErrorStrip(snapshot.Errors, now);

        RefreshEmpty();
    }

    private static int Rank(TargetState t, HashSet<string> failingIds)
    {
        bool failing = t.Status == TargetStatus.Offline || failingIds.Contains(t.Id);
        if (failing) return 0;
        if (t.Status == TargetStatus.Online) return 1;
        if (t.Status == TargetStatus.Probing) return 2;
        return 3;
    }

    /// <summary>
    /// 错误条：最多列 3 条，其余折成「还有 N 条」。
    /// 错误文本是远程命令的输出，可能很长，所以这里先压成单行再截断 ——
    /// 卡片里已经有完整原文，这里只负责「让你知道有东西挂了」。
    /// </summary>
    private void BuildErrorStrip(List<TargetErrorEntry> errors, long now)
    {
        if (errors.Count == 0)
        {
            ErrorStripText = "";
            ErrorStripVisibility = Visibility.Collapsed;
            return;
        }

        const int MaxShown = 3;
        var lines = new List<string>();
        foreach (var entry in errors.Take(MaxShown))
        {
            string who = !string.IsNullOrWhiteSpace(entry.Name) ? entry.Name!
                       : !string.IsNullOrWhiteSpace(entry.TargetId) ? entry.TargetId!
                       : "未知目标";
            string what = Flatten(entry.Error, 160);
            string when = entry.At is long at && at > 0 ? $"（{Format.Age(now - at)} 前）" : "";
            string count = entry.ConsecutiveFailures is > 1 ? $" 连续 {entry.ConsecutiveFailures} 次" : "";
            lines.Add($"{who}：{what}{when}{count}");
        }
        if (errors.Count > MaxShown) lines.Add($"…还有 {errors.Count - MaxShown} 条");

        ErrorStripText = string.Join("\n", lines);
        ErrorStripVisibility = Visibility.Visible;
    }

    private static string Flatten(string? text, int max)
    {
        string flat = (text ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
        while (flat.Contains("  ", StringComparison.Ordinal)) flat = flat.Replace("  ", " ");
        return flat.Length <= max ? flat : flat[..(max - 1)] + "…";
    }

    private void RefreshEmpty()
    {
        string? text = StatusText.Empty(_status, Targets.Count);
        EmptyText = text ?? "";
        EmptyVisibility = text is null ? Visibility.Collapsed : Visibility.Visible;
    }
}
