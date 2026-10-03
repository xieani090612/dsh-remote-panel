namespace DshWsxPanel;

/// <summary>头部摘要需要的全部计数。</summary>
public readonly record struct SummaryCounts(
    int Total,
    int Online,
    int Offline,
    int Probing,
    int Unknown,
    int DockerRunning);

/// <summary>
/// 头部摘要（「N 个目标 · N 在线 · N 失败 · N 探测中」）的**纯逻辑**部分。
///
/// 刻意不引用任何 WinUI 类型，并且把文案也放在这里，理由有两个：
///   * --dump-status 能把这几行原样打出来，于是「探测中的目标算不算在线」
///     这种判断可以被脚本断言，而不是只能靠盯着截图看（这里确实出过一次 bug：
///     2 个目标都在重新探测时，标题写「0 在线」，而卡片上明明画着上一次的完整指标）；
///   * 窗口和 headless 路径用同一个函数，断言 dump 就等于断言界面。
/// </summary>
public static class Summary
{
    public static SummaryCounts Count(PanelSnapshot snapshot)
    {
        var targets = snapshot.Targets;
        return new SummaryCounts(
            Total: targets.Count,
            Online: targets.Count(CountsAsOnline),
            Offline: targets.Count(t => t.Status == TargetStatus.Offline),
            Probing: targets.Count(t => t.Status == TargetStatus.Probing),
            Unknown: targets.Count(t => t.Status == TargetStatus.Unknown),
            // docker 运行数优先用插件给的总计；没有就自己把各目标加起来。
            DockerRunning: snapshot.Totals?.DockerRunning
                ?? targets.Sum(t => t.Metrics?.Docker?.Running ?? 0));
    }

    /// <summary>
    /// 「在线」的判定：正在重新探测、但**上一次探测成功过**的目标也算在线。
    ///
    /// 「上一次成功过」的证据：lastOnlineAt 有值，或者 metrics 还在
    /// （面板上正渲染着上一次的数据）。理由很直接 —— 卡片上明明画着 CPU/内存/磁盘，
    /// 标题却写「0 在线」，读起来就是「全挂了」。「正在刷新」这件事由
    /// 「· N 探测中」单独表达，不需要靠把在线数扣掉来暗示。
    /// </summary>
    public static bool CountsAsOnline(TargetState t)
        => t.Status == TargetStatus.Online
        || (t.Status == TargetStatus.Probing && (t.LastOnlineAt is > 0 || t.Metrics is not null));

    public static string HeaderText(SummaryCounts c) => $"{c.Total} 个目标 · {c.Online} 在线";

    public static string FailingText(SummaryCounts c) => c.Offline > 0 ? $"· {c.Offline} 失败" : "";

    /// <summary>探测中优先显示；没有正在探测的就退而说明「还有几个从没探测过」。</summary>
    public static string ProbingText(SummaryCounts c)
        => c.Probing > 0 ? $"· {c.Probing} 探测中"
         : c.Unknown > 0 ? $"· {c.Unknown} 未探测"
         : "";

    public static string DockerSummaryText(SummaryCounts c)
        => c.DockerRunning > 0 ? $"· {c.DockerRunning} 容器运行中" : "";
}
